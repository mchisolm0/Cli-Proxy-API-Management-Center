import { createConnection, type Socket } from "node:net";
import type { Database } from "bun:sqlite";
import { RespDecoder, command } from "./resp";
import { telemetryTables, appendEvent, sanitize } from "./events";
import { json, object } from "../model";
import {
  authTables,
  managementRetryAt,
  managementRejected,
  managementAccepted,
} from "../auth";

export function startTelemetry(
  db: Database,
  address: string,
  loadKey: () => string,
  options: {
    retryMinMs?: number;
    retryMaxMs?: number;
    warn?: (message: string) => void;
    connect?: (options: { host: string; port: number }) => Socket;
  } = {},
) {
  const match = /^(\[[^\]]+\]|[^:\s]+):(\d+)$/.exec(address);
  if (!match)
    throw new Error(
      "Telemetry requires CPA_RESP_ADDR=host:port and CPA_MANAGEMENT_KEY",
    );
  const host = match[1]!.replace(/^\[|\]$/g, ""),
    port = Number(match[2]);
  if (port < 1 || port > 65535) throw new Error("Invalid RESP port");
  telemetryTables(db);
  authTables(db);
  const warn = options.warn || console.warn;
  const stops: (() => void)[] = [];
  const authenticated = new Set<string>();
  // ponytail: pending records are volatile; use a durable queue if shutdown replay is needed.
  const pending: {
    channel: "usage" | "errors";
    payload: string;
    received: number;
  }[] = [];
  let writeRetry: ReturnType<typeof setTimeout> | undefined;
  let writeDelay = 1000,
    overflow = false;
  const drain = (retry = true) => {
    writeRetry = undefined;
    while (pending.length) {
      const record = pending[0]!;
      try {
        appendEvent(db, record.channel, record.payload, record.received);
        writeDelay = 1000;
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          typeof error.code === "string" &&
          error.code.startsWith("SQLITE_BUSY")
        ) {
          if (retry) {
            writeRetry = setTimeout(drain, writeDelay);
            writeDelay = Math.min(writeDelay * 2, 10000);
          }
          return;
        }
        warn(`Telemetry ${record.channel}: record could not be stored`);
      }
      pending.shift();
    }
    overflow = false;
  };
  // The proxy supports exactly one subscribed channel per TCP connection.
  for (const channel of ["usage", "errors"] as const) {
    let stopped = false,
      socket: Socket | undefined,
      retry: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const minimum = options.retryMinMs || 250,
      maximum = options.retryMaxMs || 30000;
    let delay = minimum;
    const connect = () => {
      if (stopped) return;
      const pause = managementRetryAt(db) - Date.now();
      if (pause > 0) {
        retry = setTimeout(connect, pause);
        return;
      }
      let key: string, connection: Socket;
      try {
        key = loadKey();
        if (!key) throw new Error("Missing management key");
        connection = (options.connect || createConnection)({ host, port });
      } catch {
        warn(`Telemetry ${channel}: connection configuration failed`);
        retry = setTimeout(connect, delay);
        delay = Math.min(delay * 2, maximum);
        return;
      }
      const decoder = new RespDecoder();
      let authed = false;
      socket = connection;
      connection.setTimeout(45000, () => connection.destroy());
      connection.on("connect", () => {
        try {
          connection.write(command("AUTH", key));
        } catch {
          connection.destroy();
        }
      });
      connection.on("data", (chunk) => {
        if (stopped) return;
        try {
          for (const response of decoder.push(chunk)) {
            if (
              (typeof response === "object" &&
              response !== null &&
              !Array.isArray(response) &&
              "error" in response) ||
              (!authed && response !== "OK")
            ) {
              if (!authed) {
                authenticated.clear();
                try {
                  managementRejected(db, "telemetry", "telemetry_auth_rejected");
                } catch {
                  warn(`Telemetry ${channel}: auth rejection could not be stored`);
                }
              }
              // Do not log proxy responses, which could echo credentials.
              warn(`Telemetry ${channel}: RESP rejected the command`);
              connection.destroy();
              break;
            }
            if (!authed) {
              authed = true;
              authenticated.add(channel);
              if (authenticated.size === 2) managementAccepted(db, "telemetry");
              connection.write(command("SUBSCRIBE", channel));
            } else if (
              Array.isArray(response) &&
              response[0] === "subscribe" &&
              response[1] === channel
            ) {
              delay = minimum;
              heartbeat = setInterval(
                () => {
                  try {
                    connection.write(command("PING"));
                  } catch {
                    connection.destroy();
                  }
                },
                15000,
              );
            } else if (
              Array.isArray(response) &&
              response[0] === "message" &&
              response[1] === channel &&
              typeof response[2] === "string"
            ) {
              try {
                const event = object(sanitize(json(response[2]), [key]));
                if (channel === "usage") {
                  delete event.source;
                  delete event.response_headers;
                }
                if (pending.length === 10000) {
                  pending.shift();
                  if (!overflow) {
                    warn("Telemetry: pending buffer full; dropping oldest records");
                    overflow = true;
                  }
                }
                pending.push({
                  channel,
                  payload: JSON.stringify(event),
                  received: Date.now(),
                });
                if (!writeRetry) drain();
              } catch {
                warn(`Telemetry ${channel}: record could not be stored`);
              }
            }
          }
        } catch {
          warn(`Telemetry ${channel}: invalid RESP stream`);
          connection.destroy();
        }
      });
      connection.on("error", () =>
        warn(`Telemetry ${channel}: connection failed`),
      );
      connection.on("close", () => {
        authenticated.delete(channel);
        clearInterval(heartbeat);
        if (stopped) return;
        retry = setTimeout(
          connect,
          Math.max(delay, managementRetryAt(db) - Date.now()),
        );
        delay = Math.min(delay * 2, maximum);
      });
    };
    connect();
    stops.push(() => {
      stopped = true;
      clearTimeout(retry);
      clearInterval(heartbeat);
      socket?.destroy();
    });
  }
  return () => {
    stops.forEach((stop) => stop());
    clearTimeout(writeRetry);
    drain(false);
    pending.length = 0;
  };
}
