import { afterAll, beforeAll, describe, expect, test, spyOn } from 'bun:test';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
  copyFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { generate, first, second } from '../fixtures/generate';
import { codex, claude, opencode, t3 } from '../parsers';
import { buildIndex } from '../index';
import { immutable, inside, lines } from '../archive';
import { ftsQuery, search } from '../search';
import { handler, rawRecord } from '../server';
import type { SessionRow, ItemRow } from '../db';
import { json } from '../model';
import { openIndex } from '../db';
import { appendEvent } from '../telemetry/events';

const temp = mkdtempSync('/tmp/fleet-dashboard-test-');
const root = join(temp, 'archive'),
  index = join(temp, 'index.sqlite');
let db: Database;
const file = (relative: string) => join(root, 'mac', first, relative);
const codexFile = '.codex/sessions/2026/09/30/rollout-main.jsonl';
beforeAll(() => {
  generate(root);
  buildIndex(root, index);
  db = new Database(index, { strict: true });
});
afterAll(() => {
  db?.close();
  rmSync(temp, { recursive: true, force: true });
});

describe('native parsers', () => {
  test('Codex dedupes completed events, pairs tools, truncates bodies, and uses final totals', () => {
    const s = codex(file(codexFile), codexFile).sessions[0]!;
    expect(s.items.map((i) => i.role)).toEqual(['user', 'tool_call', 'tool_result', 'assistant']);
    expect(s.items[1]!.callId).toBe(s.items[2]!.callId);
    expect(s.items[2]!.body.length).toBe(2048);
    expect(s.items[2]!.bodyLength).toBeGreaterThan(2048);
    expect(s.tokens).toBe(150);
    expect(s.model).toBe('gpt-synthetic');
    const raw = rawRecord(
      root,
      JSON.stringify({
        ...s.items[0]!.pointer,
        file: join('mac', first, codexFile),
      })
    );
    expect(JSON.stringify(raw)).toContain('🦦');
    const reordered = join(temp, 'reordered-codex.jsonl');
    const records = readFileSync(file(codexFile), 'utf8').trim().split('\n');
    [records[6], records[7]] = [records[7]!, records[6]!];
    writeFileSync(reordered, records.join('\n') + '\n');
    expect(codex(reordered, codexFile).sessions[0]!.items.map((i) => i.role)).toEqual(
      s.items.map((i) => i.role)
    );
  });
  test('Codex fork skips replayed parent history and preserves custom tool pairing', () => {
    const f = '.codex/sessions/2026/09/30/rollout-fork.jsonl';
    const s = codex(file(f), f).sessions[0]!;
    expect(s.kind).toBe('fork');
    expect(s.parentId).toBe('codex-main');
    expect(s.items).toHaveLength(3);
    expect(s.items.some((i) => i.body.includes('Inherited'))).toBe(false);
    expect(s.items[1]!.callId).toBe(s.items[2]!.callId);
  });
  test('Claude counts message usage once, keeps injected context and thinking, and identifies subagents', () => {
    const f = '.claude/projects/synthetic/claude-main.jsonl';
    const s = claude(file(f), f).sessions[0]!;
    expect(s.tokens).toBe(110);
    expect(s.title).toBe('Audit the fixture archive');
    expect(s.items.map((i) => i.role)).toEqual([
      'user',
      'system',
      'thinking',
      'assistant',
      'tool_call',
      'tool_result',
    ]);
    expect(s.items[4]!.callId).toBe(s.items[5]!.callId);
    const sub = '.claude/projects/synthetic/claude-main/subagents/agent-review.jsonl';
    const agent = claude(file(sub), sub).sessions[0]!;
    expect(agent.nativeId).toBe('claude-main/review');
    expect(agent.parentId).toBe('claude-main');
    expect(agent.kind).toBe('subagent');
  });
  test('OpenCode parses message tokens and tool state with raw row pointers', () => {
    const f = '.local/share/opencode/opencode.db';
    const s = opencode(file(f), f).sessions[0]!;
    expect(s.model).toBe('open-synthetic');
    expect(s.tokens).toBe(55);
    expect(s.items.map((i) => i.role)).toEqual(['assistant', 'tool_call', 'tool_result']);
    const raw = rawRecord(
      root,
      JSON.stringify({ ...s.items[1]!.pointer, file: join('mac', first, f) })
    );
    expect(JSON.stringify(raw)).toContain('oc-tool');
  });
  test('T3 retains orphan messages and emits native links for overlay', () => {
    const f = '.t3/userdata/state.sqlite';
    const parsed = t3(file(f), f);
    expect(parsed.links).toEqual([
      {
        client: 'codex',
        nativeId: 'codex-main',
        title: 'Find lunar otters',
        branch: 'dashboard',
        threadId: 't3-linked',
      },
    ]);
    const s = parsed.sessions.find((s) => s.nativeId === 't3-orphan')!;
    expect(s.items[0]!.body).toBe('Build a comet dashboard');
    expect(
      JSON.stringify(
        rawRecord(
          root,
          JSON.stringify({
            ...s.items[0]!.pointer,
            file: join('mac', first, f),
          })
        )
      )
    ).toContain('t3-orphan-message');
  });
  test('immutable SQLite rejects writes and leaves the snapshot unchanged', () => {
    const path = file('.t3/userdata/state.sqlite'),
      before = readFileSync(path);
    const source = immutable(path);
    try {
      expect(() => source.run('DELETE FROM projection_threads')).toThrow();
    } finally {
      source.close();
    }
    expect(readFileSync(path)).toEqual(before);
  });
  test('JSON boundary rejects malformed and non-object records; byte pointers handle CRLF and final lines', () => {
    expect(() => json('[]')).toThrow('Expected JSON object');
    const path = join(temp, 'unicode.jsonl');
    const firstLine = JSON.stringify({ text: '🦦' }),
      lastLine = JSON.stringify({ text: 'last' });
    writeFileSync(path, firstLine + '\r\n' + lastLine);
    const records = [...lines(path)];
    expect(records[1]!.offset).toBe(Buffer.byteLength(firstLine) + 2);
    expect(records[1]!.length).toBe(Buffer.byteLength(lastLine));
    writeFileSync(path, '{broken}');
    expect(() => [...lines(path)]).toThrow('Invalid JSONL');
  });
});
describe('index and API', () => {
  test('indexing survives another connection committing while an uncached file is parsed', () => {
    const archive = join(temp, 'concurrent-archive'),
      snapshot = join(archive, 'test', first),
      destination = join(temp, 'concurrent.sqlite'),
      writer = openIndex(destination);
    mkdirSync(join(snapshot, '.codex/sessions'), { recursive: true });
    writeFileSync(
      join(snapshot, 'manifest.json'),
      JSON.stringify({
        completed_at: '2026-10-01T12:00:00Z',
        sources: [{ path: '.codex', status: 'collected' }],
      })
    );
    const record = JSON.stringify({
      type: 'session_meta',
      payload: { id: 'concurrent-session' },
    });
    writeFileSync(join(snapshot, '.codex/sessions/session.jsonl'), record);
    const parse = JSON.parse;
    let committed = false;
    const parser = spyOn(JSON, 'parse').mockImplementation((text: string) => {
      const result: unknown = parse(text);
      if (text === record && !committed) {
        appendEvent(writer, 'usage', JSON.stringify({ timestamp: Date.now() }));
        committed = true;
      }
      return result;
    });
    try {
      expect(buildIndex(archive, destination).snapshots).toBe(1);
      expect(committed).toBe(true);
      expect(writer.query('SELECT * FROM usage_event').all()).toHaveLength(1);
      expect(writer.query('SELECT * FROM file_cache').all()).toHaveLength(1);
      expect(writer.query('SELECT * FROM session').all()).toHaveLength(1);
      // Parsing failures must not persist the good file's pending cache row either.
      writeFileSync(
        join(snapshot, '.codex/sessions/session.jsonl'),
        record + '\n' + JSON.stringify({ type: 'turn_context' })
      );
      writeFileSync(join(snapshot, '.codex/sessions/z-broken.jsonl'), '{broken}');
      expect(() => buildIndex(archive, destination)).toThrow('Invalid JSONL');
      expect(writer.query('SELECT * FROM file_cache').all()).toHaveLength(1);
      expect(writer.query('SELECT * FROM snapshot').all()).toHaveLength(1);
    } finally {
      parser.mockRestore();
      writer.close();
    }
  });
  test('new T3 overlays survive native pruning and later changes to older snapshots', () => {
    const archive = generate(join(temp, 'overlay-archive')),
      destination = join(temp, 'overlay.sqlite');
    buildIndex(archive, destination);
    const third = join(archive, 'mac', '2026-10-03T120000Z');
    const t3File = '.t3/userdata/state.sqlite';
    mkdirSync(join(third, '.t3/userdata'), { recursive: true });
    copyFileSync(join(archive, 'mac', second, t3File), join(third, t3File));
    const latest = new Database(join(third, t3File));
    latest
      .query("UPDATE projection_threads SET title='Newest T3 title' WHERE thread_id='t3-linked'")
      .run();
    latest.close();
    const manifest = json(readFileSync(join(archive, 'mac', second, 'manifest.json'), 'utf8'));
    manifest.completed_at = '2026-10-03T12:00:00Z';
    manifest.sources = [{ path: t3File, status: 'collected' }];
    writeFileSync(join(third, 'manifest.json'), JSON.stringify(manifest));
    buildIndex(archive, destination);
    const older = new Database(join(archive, 'mac', first, t3File));
    older
      .query("UPDATE projection_threads SET title='Old stale title' WHERE thread_id='t3-linked'")
      .run();
    older.close();
    buildIndex(archive, destination);
    const derived = new Database(destination);
    try {
      const s = derived
        .query<SessionRow, []>("SELECT * FROM session WHERE host='mac' AND nativeId='codex-main'")
        .get()!;
      expect(s.title).toBe('Newest T3 title');
      expect(s.snapshot).toBe(join('mac', second));
    } finally {
      derived.close();
    }
  });
  test('dedupes snapshots per host, overlays T3 and keeps newest and last-seen pointers', () => {
    expect(db.query<{ n: number }, []>('SELECT count(*) n FROM session').get()!.n).toBe(14);
    const latest = db
      .query<SessionRow, [string]>("SELECT * FROM session WHERE host='mac' AND nativeId=?")
      .get('codex-main')!;
    expect(latest.snapshot).toBe(join('mac', second));
    expect(latest.title).toBe('Find lunar otters');
    expect(latest.branch).toBe('dashboard');
    expect(latest.t3ThreadId).toBe('t3-linked');
    const pruned = db
      .query<SessionRow, [string]>("SELECT * FROM session WHERE host='mac' AND nativeId=?")
      .get('claude-pruned')!;
    expect(pruned.snapshot).toBe(join('mac', first));
    expect(search(db, new URLSearchParams({ q: 'Duplicated native content' })).total).toBe(0);
    expect(search(db, new URLSearchParams({ q: 'Latest snapshot update' })).total).toBe(2);
    const row = db
      .query<ItemRow, [number]>(
        "SELECT * FROM item WHERE sessionId=? AND role='user' ORDER BY seq LIMIT 1"
      )
      .get(latest.id)!;
    expect(json(row.pointer).file).toBe(join('mac', second, codexFile));
  });
  test('ignores incomplete snapshots and latest symlink', () => {
    expect(db.query<{ n: number }, []>('SELECT count(*) n FROM snapshot').get()!.n).toBe(4);
    expect(db.query("SELECT id FROM session WHERE nativeId='incomplete'").get()).toBeNull();
  });
  test('unchanged manifests and files skip all parsing; changed file reindexes only that file', () => {
    const unchanged = buildIndex(root, index);
    expect(unchanged).toEqual({
      snapshots: 0,
      skippedSnapshots: 4,
      parsedFiles: 0,
      skippedFiles: 30,
    });
    const changed = join(root, 'mac', second, codexFile);
    writeFileSync(
      changed,
      readFileSync(changed, 'utf8') +
        JSON.stringify({
          type: 'event_msg',
          timestamp: '2026-10-01T11:00:00Z',
          payload: {
            type: 'user_message',
            message: 'A changed file adds quasars',
          },
        }) +
        '\n'
    );
    const update = buildIndex(root, index);
    expect(update.snapshots).toBe(1);
    expect(update.parsedFiles).toBe(1);
    expect(update.skippedFiles).toBe(29);
    expect(search(db, new URLSearchParams({ q: 'quasars' })).total).toBe(1);
    // Changed older snapshots cannot overwrite a newer session pointer.
    const older = file(codexFile);
    writeFileSync(
      older,
      readFileSync(older, 'utf8') +
        JSON.stringify({
          type: 'event_msg',
          payload: { type: 'user_message', message: 'older changed snapshot' },
        }) +
        '\n'
    );
    buildIndex(root, index);
    const row = db
      .query<SessionRow, []>("SELECT * FROM session WHERE host='mac' AND nativeId='codex-main'")
      .get()!;
    expect(row.snapshot).toBe(join('mac', second));
    expect(search(db, new URLSearchParams({ q: 'quasars' })).total).toBe(1);
  });
  test('FTS uses literal terms and phrases and rejects operator and SQL injection', () => {
    expect(ftsQuery('lunar "otters in space"')).toBe('"lunar" AND "otters in space"');
    expect(ftsQuery('foo OR bar*')).toBe('"foo" AND "OR" AND "bar*"');
    expect(ftsQuery('"unclosed')).toBe('"unclosed"');
    expect(ftsQuery('"" ***')).toBe('');
    expect(search(db, new URLSearchParams({ q: '"lunar otters"' })).total).toBe(2);
    expect(search(db, new URLSearchParams({ q: 'lunar OR nebula' })).total).toBe(0);
    expect(() =>
      search(db, new URLSearchParams({ q: "'); DROP TABLE session; --" }))
    ).not.toThrow();
    expect(search(db, new URLSearchParams()).total).toBe(14);
  });
  test('search combines client, host, model, repo substring and inclusive UTC date filters', () => {
    expect(
      search(
        db,
        new URLSearchParams({
          q: '"lunar otters"',
          client: 'codex',
          host: 'mac',
          model: 'gpt-synthetic',
          cwd: 'DOTFILES',
          from: '2026-10-01',
          to: '2026-10-01',
        })
      ).total
    ).toBe(1);
    expect(search(db, new URLSearchParams({ q: 'lunar', from: '2026-10-02' })).total).toBe(0);
    expect(() => search(db, new URLSearchParams({ from: '2026-02-30' }))).toThrow('Invalid date');
  });
  test('API returns ordered details and full raw records, rejects traversal and missing items', async () => {
    const assets = join(temp, 'dist');
    mkdirSync(assets);
    writeFileSync(join(assets, 'index.html'), '<html>Synthetic UI</html>');
    const fetch = handler(db, root, assets);
    const response = await fetch(new Request('http://localhost/api/search?host=mac'));
    expect(response.status).toBe(200);
    const session = db
      .query<SessionRow, []>("SELECT * FROM session WHERE host='mac' AND nativeId='codex-main'")
      .get()!;
    const detail = await fetch(new Request(`http://localhost/api/sessions/${session.id}`));
    const data = (await detail.json()) as { items: Omit<ItemRow, 'pointer'>[] };
    expect(data.items.map((i) => i.seq)).toEqual(data.items.map((_, n) => n));
    const tool = data.items.find((i) => i.role === 'tool_result')!;
    const raw = await fetch(new Request(`http://localhost/api/items/${tool.id}/raw`));
    expect((await raw.text()).length).toBeGreaterThan(2048);
    expect((await fetch(new Request('http://localhost/api/items/999999/raw'))).status).toBe(404);
    expect((await fetch(new Request('http://localhost/api/search?client=invalid'))).status).toBe(
      400
    );
    expect(await (await fetch(new Request('http://localhost/'))).text()).toContain('Synthetic UI');
    expect(() => inside(root, '../index.sqlite')).toThrow('escapes root');
    symlinkSync(index, join(root, 'outside.sqlite'));
    expect(() => inside(root, 'outside.sqlite')).toThrow('escapes root');
  });
});
