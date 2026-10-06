import { Database } from 'bun:sqlite';
import { openSync, readSync, closeSync, realpathSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inside, immutable } from './archive';
import { json, string, number } from './model';
import { openIndex, pruneEvents, type SessionRow, type ItemRow } from './db';
import { search } from './search';
import { startTelemetry } from './telemetry';
import { dashboardProblem, managementKey, redactionSecrets, startAuthPoller } from './auth';
import { ingestFriction } from './friction';
import { health, problems, parseRetryWindow } from './insights';
import { seedFixtures } from './fixtures';
import type { FiltersResponse, SessionDetail, RawRecordResponse } from './api';
import { sanitize } from './telemetry/events';

async function background(task: () => void | Promise<void>, warning: string) {
  try {
    await task();
  } catch {
    console.warn(warning);
  }
}

export function startIndexer(
  db: Database,
  root: string,
  destination: string,
  launch: () => { exited: Promise<number>; kill(): void } = () =>
    Bun.spawn({
      cmd: [process.execPath, fileURLToPath(new URL('./index.ts', import.meta.url))],
      env: { ...env, ARCHIVE_ROOT: root, INDEX_PATH: destination, CPA_INDEX_KEYS_STDIN: '1' },
      stdin: new Blob([JSON.stringify(redactionSecrets(db, ''))]),
      stdout: 'inherit',
      stderr: 'inherit',
    }),
  env = process.env
) {
  let running = false,
    stopped = false;
  let child: ReturnType<typeof launch> | undefined;
  const run = async () => {
    if (running || stopped) return;
    running = true;
    try {
      child = launch();
      const status = await child.exited;
      if (stopped) return;
      if (status !== 0) throw new Error('Indexer failed');
      seedFixtures(db, root);
    } catch {
      if (!stopped) {
        console.warn('Indexing failed');
        await background(
          () => dashboardProblem(db, 'other', 'index_failed'),
          'Index failure could not be stored'
        );
      }
    } finally {
      child = undefined;
      running = false;
    }
  };
  return {
    run,
    stop: () => {
      stopped = true;
      child?.kill();
    },
  };
}

export function rawRecord(
  root: string,
  pointerText: string,
  key = managementKey(),
  secrets: string[] = []
): unknown {
  const p = json(pointerText),
    path = inside(root, string(p.file));
  if (p.kind === 'jsonl') {
    const offset = number(p.offset),
      length = number(p.length);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0)
      throw new Error('Invalid byte pointer');
    const fd = openSync(path, 'r');
    try {
      const buffer = Buffer.alloc(length);
      const read = readSync(fd, buffer, 0, length, offset);
      if (read !== length) throw new Error('Archive record was truncated');
      return sanitize(json(buffer.toString('utf8')), [key, ...secrets], true);
    } finally {
      closeSync(fd);
    }
  }
  if (
    p.kind !== 'sqlite' ||
    !(
      (p.table === 'part' && p.column === 'id') ||
      (p.table === 'projection_thread_messages' && p.column === 'message_id')
    )
  )
    throw new Error('Invalid SQLite pointer');
  const db = immutable(path);
  try {
    const row = db.query(`SELECT * FROM ${p.table} WHERE ${p.column}=?`).get(string(p.key));
    if (!row) throw new Error('Raw record no longer exists');
    return sanitize(row, [key, ...secrets], true);
  } finally {
    db.close();
  }
}
export function handler(
  db: Database,
  root: string,
  assets = resolve('./dist'),
  retryWindow = 35000,
  loadKey = managementKey
) {
  const respond = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname !== '/' && url.pathname !== '/healthz' && !url.pathname.startsWith('/api/'))
      return new Response('Not found', { status: 404 });
    if (request.method !== 'GET')
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    try {
      if (url.pathname === '/healthz') return new Response('ok');
      if (url.pathname === '/api/health' || url.pathname === '/api/problems') {
        try {
          return Response.json(
            url.pathname === '/api/health'
              ? health(db, url.searchParams.get('window'))
              : problems(db, url.searchParams.get('window'), Date.now(), retryWindow)
          );
        } catch (error) {
          if (error instanceof Error && error.message.startsWith('Window must'))
            return Response.json({ error: error.message }, { status: 400 });
          throw error;
        }
      }
      if (url.pathname === '/api/search') return Response.json(search(db, url.searchParams));
      if (url.pathname === '/api/filters') {
        const response: FiltersResponse = {
          hosts: db
            .query<{ host: string }, []>('SELECT DISTINCT host FROM session ORDER BY host')
            .all()
            .map((r) => r.host),
          models: db
            .query<{ model: string }, []>(
              "SELECT DISTINCT model FROM session WHERE model<>'' ORDER BY model"
            )
            .all()
            .map((r) => r.model),
        };
        return Response.json(response);
      }
      const detail = /^\/api\/sessions\/(\d+)$/.exec(url.pathname);
      if (detail) {
        const session = db
          .query<SessionRow, [number]>('SELECT * FROM session WHERE id=?')
          .get(Number(detail[1]));
        if (!session) return Response.json({ error: 'Session not found' }, { status: 404 });
        const items = db
          .query<ItemRow, [number]>('SELECT * FROM item WHERE sessionId=? ORDER BY seq')
          .all(session.id)
          .map(({ pointer: _pointer, ...i }) => i);
        const response: SessionDetail = { session, items };
        return Response.json(response);
      }
      const raw = /^\/api\/items\/(\d+)\/raw$/.exec(url.pathname);
      if (raw) {
        const row = db
          .query<{ pointer: string }, [number]>('SELECT pointer FROM item WHERE id=?')
          .get(Number(raw[1]));
        if (!row) return Response.json({ error: 'Item not found' }, { status: 404 });
        let key = '';
        try {
          key = loadKey();
        } catch {
          // Serve history with pattern/client-key redaction when the key file is unavailable.
        }
        const response: RawRecordResponse = {
          record: rawRecord(root, row.pointer, key, redactionSecrets(db, key)),
        };
        return Response.json(response);
      }
      if (url.pathname.startsWith('/api/'))
        return Response.json({ error: 'Not found' }, { status: 404 });
      if (url.pathname !== '/') return new Response('Not found', { status: 404 });
      const file = Bun.file(resolve(assets, 'index.html'));
      if (!(await file.exists())) return new Response('Build the UI first', { status: 503 });
      return new Response(file, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-cache',
          // The single-file Vite build contains inline scripts and styles. Management
          // requests can target a user-configured proxy origin.
          'Content-Security-Policy':
            "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' http: https: ws: wss:; img-src 'self' data:; font-src 'self' data:; frame-ancestors 'none'",
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Request failed';
      if (url.pathname === '/api/search') return Response.json({ error: message }, { status: 400 });
      console.error(message);
      return Response.json({ error: 'Archive record unavailable' }, { status: 500 });
    }
  };
  return async (request: Request) => {
    const response = await respond(request);
    if (/^\/api(?:\/|$)/.test(new URL(request.url).pathname))
      response.headers.set('Cache-Control', 'no-store');
    return response;
  };
}
export function startDashboard(env = process.env) {
  const retryWindow = parseRetryWindow(env.CPA_RETRY_WINDOW_SECONDS);
  const destination = resolve(env.INDEX_PATH || './data/index.sqlite');
  const db = openIndex(destination, 250);
  const indexedRoot = db
    .query<{ value: string }, [string]>('SELECT value FROM setting WHERE key=?')
    .get('archiveRoot')?.value;
  const configuredRoot = env.ARCHIVE_ROOT && resolve(env.ARCHIVE_ROOT);
  const root = configuredRoot
    ? existsSync(configuredRoot)
      ? realpathSync(configuredRoot)
      : configuredRoot
    : indexedRoot || resolve('./fixtures/archive');
  if (indexedRoot && indexedRoot !== root) {
    db.close();
    throw new Error('INDEX_PATH belongs to a different ARCHIVE_ROOT; use a new index path');
  }
  const loadKey = () => managementKey(env);
  const server = Bun.serve({
    hostname: env.BIND_HOST || '127.0.0.1',
    port: Number(env.PORT || 3000),
    fetch: handler(db, root, undefined, retryWindow, loadKey),
  });
  console.log(`Dashboard: ${server.url}`);
  const indexer = startIndexer(db, root, destination, undefined, env);
  const addr = env.CPA_RESP_ADDR;
  const stops: (() => void)[] = [indexer.stop];
  if (!indexedRoot) void indexer.run();
  else void background(() => seedFixtures(db, root), 'Fixture ingestion failed');
  const prune = () => background(() => pruneEvents(db), 'Event pruning failed');
  void prune();
  const pruneTimer = setInterval(() => void prune(), 3600000);
  stops.push(() => clearInterval(pruneTimer));
  if (addr) {
    try {
      stops.push(startTelemetry(db, addr, loadKey));
    } catch {
      void background(
        () => dashboardProblem(db, 'auth', 'telemetry_configuration_failed'),
        'Telemetry configuration failure could not be stored'
      );
      console.warn('Telemetry could not start; check address and management key configuration');
    }
  }
  if (env.CPA_BASE_URL && (env.CPA_MANAGEMENT_KEY_FILE || env.CPA_MANAGEMENT_KEY))
    stops.push(startAuthPoller(db, env.CPA_BASE_URL, loadKey));
  if (env.FRICTION_PATHS) {
    const paths = env.FRICTION_PATHS;
    const ingest = () => background(() => ingestFriction(db, paths), 'Friction ingestion failed');
    void ingest();
    const timer = setInterval(() => void ingest(), 60000);
    stops.push(() => clearInterval(timer));
  }
  if (env.INDEX_INTERVAL_MINUTES) {
    const minutes = Number(env.INDEX_INTERVAL_MINUTES);
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes * 60000 > 2147483647)
      throw new Error('INDEX_INTERVAL_MINUTES must be positive and at most 35791');
    const timer = setInterval(
      () => void background(indexer.run, 'Index scheduling failed'),
      minutes * 60000
    );
    stops.push(() => clearInterval(timer));
  }
  return () => {
    stops.forEach((stop) => stop());
    server.stop(true);
    db.close();
  };
}
if (import.meta.main) {
  const stop = startDashboard();
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.on(signal, () => {
      stop();
      process.exit(0);
    });
}
