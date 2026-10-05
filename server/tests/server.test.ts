import { expect, test, spyOn } from "bun:test";
import {
  mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openIndex } from "../src/db";
import { handler, startIndexer, startDashboard } from "../src/server";
import { startAuthPoller } from "../src/auth";
import { appendEvent } from "../src/telemetry/events";
import type { Problem } from "../src/insights";

test("startup validates the retry window before opening the index and retains its value for requests", async () => {
  const root = mkdtempSync(join(tmpdir(), "dashboard-retry-window-")),
    path = join(root, "index.sqlite");
  const listen = spyOn(Bun, "serve").mockReturnValue({
    url: new URL("http://synthetic.invalid"), stop: () => {},
  } as ReturnType<typeof Bun.serve>);
  let stop: (() => void) | undefined;
  try {
    for (const value of ["", " ", "0", "-1", "NaN", "Infinity", "1e309", "1e308"])
      expect(() => startDashboard({
        INDEX_PATH: path, CPA_RETRY_WINDOW_SECONDS: value,
      })).toThrow("CPA_RETRY_WINDOW_SECONDS must be a finite positive number");
    expect(listen).not.toHaveBeenCalled();
    expect(existsSync(path)).toBe(false);
    const db = openIndex(path);
    try {
      db.query("INSERT INTO setting VALUES('archiveRoot',?)").run(root);
      const now = Date.now();
      appendEvent(
        db,
        "usage",
        JSON.stringify({
          timestamp: now - 120000, request_id: "long-backoff", failed: true,
        }),
        now - 70000,
      );
      const env = { INDEX_PATH: path, CPA_RETRY_WINDOW_SECONDS: "90" };
      stop = startDashboard(env);
      env.CPA_RETRY_WINDOW_SECONDS = "invalid-after-startup";
      const { fetch } = listen.mock.calls[0]![0] as {
        fetch: (request: Request) => Promise<Response>;
      };
      const response = await fetch(
        new Request("http://synthetic.invalid/api/problems?window=1h"),
      );
      expect(response.status).toBe(200);
      const data = await response.json() as { problems: Problem[] };
      expect(data.problems[0]?.unresolvedAttempts).toBe(1);
      expect(data.problems[0]?.inferredFinalFailures).toBe(0);
    } finally {
      db.close();
    }
  } finally {
    stop?.();
    listen.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("server timers contain held-write-lock failures and recover on their next run", async () => {
  const root = mkdtempSync(join(tmpdir(), "dashboard-timer-lock-")),
    path = join(root, "index.sqlite"),
    friction = join(root, "friction.md"),
    observer = openIndex(path, 250),
    locker = openIndex(path);
  observer.query("INSERT INTO setting VALUES('archiveRoot',?)").run(root);
  const report = (time: number) =>
    `## ${new Date(time).toISOString()}\n### Expected\nWorks\n### Actual\nFailed\n`;
  writeFileSync(friction, report(Date.now()));
  const callbacks = new Map<number, () => void>(),
    interval = setInterval;
  const timers = spyOn(globalThis, "setInterval").mockImplementation(
    ((callback: () => void, ms?: number) => {
      callbacks.set(ms || 0, callback);
      return interval(() => {}, 3600000);
    }) as typeof setInterval,
  );
  const listen = spyOn(Bun, "serve").mockReturnValue({
    url: new URL("http://synthetic.invalid"),
    stop: () => {},
  } as ReturnType<typeof Bun.serve>);
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const launch = spyOn(Bun, "spawn").mockImplementation(() => {
    throw new Error("Synthetic index launch failure");
  });
  let stop: (() => void) | undefined,
    stopAuth: (() => void) | undefined;
  try {
    stop = startDashboard({
      INDEX_PATH: path,
      FRICTION_PATHS: friction,
      INDEX_INTERVAL_MINUTES: "2",
    });
    observer.query(
      "INSERT INTO dashboard_event(time,category,code,payload) VALUES(0,'other','expired','{}')",
    ).run();
    writeFileSync(friction, report(Date.now() + 1));
    locker.run("BEGIN IMMEDIATE");
    for (const ms of [3600000, 60000, 120000]) {
      expect(callbacks.has(ms)).toBe(true);
      expect(() => callbacks.get(ms)!()).not.toThrow();
    }
    const failed: typeof fetch = Object.assign(
      async () => new Response(null, { status: 503 }),
      { preconnect: () => {} },
    );
    stopAuth = startAuthPoller(
      observer,
      "http://synthetic.invalid",
      () => "synthetic-key",
      { fetcher: failed, intervalMs: 5 },
    );
    await Bun.sleep(0);
    expect(warn.mock.calls.map(([message]) => message)).toEqual(
      expect.arrayContaining([
        "Event pruning failed",
        "Friction ingestion failed",
        "Index failure could not be stored",
        "Auth poll could not be stored",
      ]),
    );
    const { fetch: serve } = listen.mock.calls[0]![0] as {
      fetch: (request: Request) => Promise<Response>;
    };
    expect(
      (await serve(new Request("http://synthetic.invalid/healthz"))).status,
    ).toBe(200);
    locker.run("COMMIT");
    for (const ms of [3600000, 60000, 120000, 5]) callbacks.get(ms)!();
    await Bun.sleep(0);
    expect(
      observer.query("SELECT * FROM dashboard_event WHERE code='expired'").get(),
    ).toBeNull();
    expect(
      observer.query("SELECT * FROM dashboard_event WHERE code='index_failed'").get(),
    ).not.toBeNull();
    expect(
      observer.query("SELECT * FROM dashboard_event WHERE code='auth_poll_http_503'").get(),
    ).not.toBeNull();
    expect(observer.query("SELECT * FROM friction_event").all()).toHaveLength(2);
  } finally {
    if (locker.inTransaction) locker.run("ROLLBACK");
    stopAuth?.();
    stop?.();
    launch.mockRestore();
    warn.mockRestore();
    listen.mockRestore();
    timers.mockRestore();
    locker.close();
    observer.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("background indexing does not block HTTP, overlapping runs skip, and failed exits become problems", async () => {
  const db = openIndex(":memory:");
  let launches = 0;
  const indexer = startIndexer(
    db,
    "/missing-synthetic-root",
    ":memory:",
    () => {
      launches++;
      return Bun.spawn({
        cmd: [process.execPath, "-e", "await Bun.sleep(100); process.exit(7)"],
        stdout: "ignore",
        stderr: "ignore",
      });
    },
  );
  try {
    const running = indexer.run();
    await indexer.run();
    expect(launches).toBe(1);
    const fetch = handler(db, "/missing-synthetic-root");
    expect(
      (await fetch(new Request("http://synthetic.invalid/healthz"))).status,
    ).toBe(200);
    const response = await fetch(
      new Request("http://synthetic.invalid/api/search"),
    );
    expect(await response.json()).toEqual({ sessions: [], total: 0 });
    expect(db.query("SELECT * FROM dashboard_event").all()).toHaveLength(0);
    await running;
    expect(
      db.query<{ code: string }, []>("SELECT code FROM dashboard_event").get()
        ?.code,
    ).toBe("index_failed");
    await indexer.run();
    expect(launches).toBe(2);
  } finally {
    indexer.stop();
    db.close();
  }
});

test("index child receives the configured archive and index paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "dashboard-index-child-"));
  const path = join(root, "index.sqlite"),
    db = openIndex(path);
  const indexer = startIndexer(db, root, path);
  try {
    await indexer.run();
    expect(
      db
        .query<{ value: string }, []>(
          "SELECT value FROM setting WHERE key='archiveRoot'",
        )
        .get()?.value,
    ).toBe(root);
    expect(db.query("SELECT * FROM dashboard_event").all()).toHaveLength(0);
  } finally {
    indexer.stop();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("startup serves an empty index even when the initial index child fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "dashboard-startup-"));
  const server = {
    url: new URL("http://synthetic.invalid"),
    stop: () => {},
  } as ReturnType<typeof Bun.serve>;
  const listen = spyOn(Bun, "serve").mockReturnValue(server);
  let stop: (() => void) | undefined;
  try {
    stop = startDashboard({
      ARCHIVE_ROOT: join(root, "absent"),
      INDEX_PATH: join(root, "index.sqlite"),
    });
    const { fetch } = listen.mock.calls[0]![0] as {
      fetch: (request: Request) => Promise<Response>;
    };
    expect(
      (await fetch(new Request("http://synthetic.invalid/healthz"))).status,
    ).toBe(200);
    expect(
      await (
        await fetch(new Request("http://synthetic.invalid/api/search"))
      ).json(),
    ).toEqual({ sessions: [], total: 0 });
    const db = openIndex(join(root, "index.sqlite"));
    try {
      const deadline = Date.now() + 2000;
      while (
        !db
          .query("SELECT * FROM dashboard_event WHERE code='index_failed'")
          .get() &&
        Date.now() < deadline
      )
        await Bun.sleep(10);
      expect(
        db
          .query("SELECT * FROM dashboard_event WHERE code='index_failed'")
          .get(),
      ).not.toBeNull();
      expect(
        (await fetch(new Request("http://synthetic.invalid/healthz"))).status,
      ).toBe(200);
    } finally {
      db.close();
    }
  } finally {
    stop?.();
    listen.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
test("Docker healthcheck uses PORT and gives the server a start period", async () => {
  const dockerfile = readFileSync("Dockerfile", "utf8");
  expect(dockerfile).toContain("--start-period=30s");
  const code = /HEALTHCHECK .* CMD bun -e '([^']+)'/.exec(dockerfile)?.[1];
  if (!code) throw new Error("Missing Bun healthcheck");
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      "-e",
      `globalThis.fetch = async (url) => { if (url !== "http://127.0.0.1:3199/healthz") throw new Error("Wrong healthcheck port"); return new Response("ok"); }; ${code}`,
    ],
    env: { PORT: "3199" },
    stdout: "ignore",
    stderr: "inherit",
  });
  expect(await child.exited).toBe(0);
});
