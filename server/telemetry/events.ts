import type { Database } from "bun:sqlite";
import { json, object, string, number, timestamp } from "../model";

export type ErrorClass =
  "auth" | "quota" | "upstream" | "transport" | "client" | "other";
export function transport(
  event: Record<string, unknown>,
): "websocket" | "http" | "unknown" {
  if (
    /^GET\s+\/v1\/responses(?:\?|$)/i.test(string(event.endpoint)) ||
    string(event.executor_type) === "CodexWebsocketsExecutor"
  )
    return "websocket";
  return string(event.endpoint) ? "http" : "unknown";
}
export function cooldownReason(event: Record<string, unknown>): string {
  const status = object(event.auth_status),
    model = object(status.model);
  return (
    string(object(model.quota).reason) ||
    string(object(status.quota).reason) ||
    string(model.status_message) ||
    string(status.status_message) ||
    string(event.code)
  );
}
export function classify(event: Record<string, unknown>): ErrorClass {
  const code = string(event.code).toLowerCase(),
    body = string(event.body).toLowerCase(),
    status = number(event.status_code);
  // CPA lifecycle errors include client cancellation as well as transport drops.
  if (code === "connection_lifecycle") {
    if (body.includes("context canceled")) return "client";
    return body.includes("context deadline exceeded") ? "upstream" : "transport";
  }
  if (code === "transient_transport") return "transport";
  if (
    [
      "request_scoped",
      "model_not_found",
      "model_not_supported",
      "not_found",
    ].includes(code)
  )
    return "client";
  if (code === "transient_error") return "upstream";
  const hint = `${code} ${body}`;
  if (status === 401) return "auth";
  if (status === 402 || status === 429) return "quota";
  if (status === 403) {
    const model = object(object(event.auth_status).model);
    if (
      (object(model.quota).exceeded === true &&
        string(model.name) !== "" &&
        model.name === event.model) ||
      /quota|rate_limit|payment_required/.test(hint)
    )
      return "quota";
    return /cloudflare/.test(hint) ? "upstream" : "auth";
  }
  if (status >= 500 || status === 408) return "upstream";
  if (status >= 400 && status < 500) return "client";
  if (body.includes("context deadline exceeded")) return "upstream";
  if (
    /unauthorized|invalid_grant|invalid_api_key|authentication|credential_revoked/.test(
      hint,
    )
  )
    return "auth";
  if (/quota|rate_limit|payment_required/.test(hint)) return "quota";
  if (
    /websocket|connection|transport|broken_pipe|eof|tls|network|timeout/.test(
      hint,
    )
  )
    return "transport";
  if (
    /request_scoped|invalid_request|context_length|model_not_found|client/.test(
      code,
    )
  )
    return "client";
  if (/upstream|cloudflare/.test(hint)) return "upstream";
  if (/invalid_request|context_length|model_not_found|client/.test(hint))
    return "client";
  return "other";
}
export function sanitize(value: unknown, secrets: string[] = []): unknown {
  if (Array.isArray(value)) return value.map((v) => sanitize(v, secrets));
  if (typeof value === "string") {
    let text = value;
    for (const secret of secrets)
      if (secret) text = text.replaceAll(secret, "[redacted]");
    const safe = text.replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]");
    try {
      const parsed: unknown = JSON.parse(safe);
      if (parsed !== null && typeof parsed === "object")
        return JSON.stringify(sanitize(parsed, secrets));
    } catch {
      /* Error bodies may be plain text. */
    }
    return safe;
  }
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(object(value))
      .filter(
        ([key]) =>
          !/^(api_key|user_api_key|authorization|x-management-key|management_key|access_token|refresh_token|id_token|password|secret|cookie|set-cookie)$/i.test(
            key,
          ),
      )
      .map(([key, v]) => [key, sanitize(v, secrets)]),
  );
}
export function telemetryTables(db: Database) {
  db.run(`
    CREATE TABLE IF NOT EXISTS usage_event(id INTEGER PRIMARY KEY,received INTEGER NOT NULL,time INTEGER NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,authIndex TEXT NOT NULL,transport TEXT NOT NULL,payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS usage_time ON usage_event(time);
    CREATE TABLE IF NOT EXISTS error_event(id INTEGER PRIMARY KEY,received INTEGER NOT NULL,time INTEGER NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,authIndex TEXT NOT NULL,transport TEXT NOT NULL,category TEXT NOT NULL,status INTEGER NOT NULL,code TEXT NOT NULL,cooldownReason TEXT NOT NULL,payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS error_time ON error_event(time);
  `);
}
export function appendEvent(
  db: Database,
  channel: "usage" | "errors",
  payload: string,
  received = Date.now(),
  secrets: string[] = [],
) {
  const event = object(sanitize(json(payload), secrets));
  // CPA's usage source can be the raw upstream API key.
  if (channel === "usage") {
    delete event.source;
    delete event.response_headers;
  }
  if (
    channel === "usage" &&
    (event.support_refresh === true || event.refresh === true)
  )
    return;
  const time = timestamp(event.timestamp);
  if (!time) throw new Error("Telemetry requires a valid timestamp");
  const common = [
    received,
    time,
    string(event.provider),
    string(event.model),
    string(event.auth_index),
    transport(event),
  ] as const;
  const safe = JSON.stringify(sanitize(event));
  if (channel === "usage")
    db.query(
      "INSERT INTO usage_event(received,time,provider,model,authIndex,transport,payload) VALUES(?,?,?,?,?,?,?)",
    ).run(...common, safe);
  else
    db.query(
      "INSERT INTO error_event(received,time,provider,model,authIndex,transport,category,status,code,cooldownReason,payload) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      ...common,
      classify(event),
      number(event.status_code),
      string(event.code),
      cooldownReason(event),
      safe,
    );
}
