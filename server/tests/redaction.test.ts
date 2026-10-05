import { expect, test, spyOn } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { buildIndex } from '../index';
import { codex, claude, opencode, t3 } from '../parsers';
import { openIndex, type ItemRow } from '../db';
import { managementKey } from '../auth';
import { sanitize } from '../telemetry/events';
import { handler, rawRecord, startDashboard, startIndexer } from '../server';

const secrets = [
  'fixture-management',
  'bearer-fixture',
  'header-fixture',
  'management-header-fixture',
  'sk-test-fixture',
  'sk-ant-test-fixture',
  'oauth-access-fixture',
  'oauth-refresh-fixture',
  'oauth-id-fixture',
];
const body = `curl -H 'Authorization: Bearer ${secrets[1]}' -H "x-api-key: ${secrets[2]}" -H 'X-Management-Key: ${secrets[3]}'
plain ${secrets[0]} ${secrets[4]} ${secrets[5]}
OAuth: {"access_token":"${secrets[6]}","refresh_token":"${secrets[7]}","id_token":"${secrets[8]}"}
Keep the ordinary transcript text.`;
const assertRedacted = (value: unknown) => {
  const text = JSON.stringify(value);
  for (const secret of secrets) expect(text).not.toContain(secret);
  expect(text).toContain('[redacted]');
};

test('redaction handles commands, nested JSON, key headers and OAuth values with a fixed marker', () => {
  const value = {
    body,
    headers: { 'x-api-key': secrets[2], Authorization: `Bearer ${secrets[1]}` },
    tokens: { access_token: secrets[6], refresh_token: secrets[7], id_token: secrets[8] },
    nested: [JSON.stringify({ body, refresh_token: secrets[7] })],
  };
  const safe = sanitize(value, [secrets[0]!], true);
  assertRedacted(safe);
  expect(safe).toMatchObject({
    tokens: { access_token: '[redacted]', refresh_token: '[redacted]', id_token: '[redacted]' },
  });
  expect(sanitize(safe, [secrets[0]!], true)).toEqual(safe);
  expect(JSON.stringify(safe)).toContain('Keep the ordinary transcript text.');
  expect(sanitize({ api_key: 'fixture', source: 'normal' })).toEqual({ source: 'normal' });
});

test('all native parsers redact bodies before truncation can leave a partial secret', () => {
  const root = mkdtempSync('/tmp/pool-redaction-boundary-');
  const secret = 'fixture-management-boundary-key';
  const text = 'x'.repeat(8185) + secret;
  try {
    const codexFile = join(root, 'codex.jsonl'),
      claudeFile = join(root, 'claude.jsonl');
    writeFileSync(
      codexFile,
      [
        { type: 'session_meta', payload: { id: 'fixture' } },
        { type: 'event_msg', payload: { type: 'user_message', message: text } },
      ]
        .map((record) => JSON.stringify(record))
        .join('\n')
    );
    writeFileSync(
      claudeFile,
      JSON.stringify({ type: 'user', sessionId: 'fixture', message: { content: text } })
    );
    const openFile = join(root, 'open.sqlite'),
      t3File = join(root, 't3.sqlite');
    const open = new Database(openFile);
    open.run(
      'CREATE TABLE session(id TEXT); CREATE TABLE message(id TEXT, session_id TEXT, time_created INTEGER, data TEXT); CREATE TABLE part(id TEXT, message_id TEXT, time_created INTEGER, data TEXT)'
    );
    open.query('INSERT INTO session VALUES(?)').run('fixture');
    open
      .query('INSERT INTO message VALUES(?,?,?,?)')
      .run('message', 'fixture', 0, JSON.stringify({ role: 'user' }));
    open
      .query('INSERT INTO part VALUES(?,?,?,?)')
      .run('part', 'message', 0, JSON.stringify({ type: 'text', text }));
    open.close();
    const t = new Database(t3File);
    t.run(
      'CREATE TABLE projection_threads(thread_id TEXT); CREATE TABLE provider_session_runtime(thread_id TEXT); CREATE TABLE projection_thread_messages(message_id TEXT, thread_id TEXT, created_at INTEGER, role TEXT, text TEXT)'
    );
    t.query('INSERT INTO projection_threads VALUES(?)').run('fixture');
    t.query('INSERT INTO projection_thread_messages VALUES(?,?,?,?,?)').run(
      'message',
      'fixture',
      0,
      'user',
      text
    );
    t.close();
    for (const [parser, file] of [
      [codex, codexFile],
      [claude, claudeFile],
      [opencode, openFile],
      [t3, t3File],
    ] as const) {
      const body = parser(file, file, [secret]).sessions[0]!.items[0]!.body;
      expect(body).not.toContain('fixture');
      expect(body).toContain('[redact');
      expect(body.length).toBe(8192);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('index/cache/snippets and native raw records redact secrets without changing the archive', async () => {
  const temp = mkdtempSync('/tmp/pool-redaction-');
  let db: Database | undefined;
  try {
    const root = join(temp, 'archive'),
      snapshot = join(root, 'host', '2026-10-05T120000Z');
    const file = join(snapshot, '.codex/sessions/session.jsonl');
    const index = join(temp, 'index.sqlite'),
      keyFile = join(temp, 'key');
    mkdirSync(join(snapshot, '.codex/sessions'), { recursive: true });
    writeFileSync(
      join(snapshot, 'manifest.json'),
      JSON.stringify({
        completed_at: '2026-10-05T12:00:00Z',
        sources: [{ path: '.codex', status: 'collected' }],
      })
    );
    const original =
      [
        { type: 'session_meta', payload: { id: 'fixture-session' } },
        {
          type: 'event_msg',
          timestamp: '2026-10-05T12:00:00Z',
          payload: { type: 'user_message', message: body },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join('\n') + '\n';
    writeFileSync(file, original);
    writeFileSync(keyFile, secrets[0]!);
    const loadKey = () => managementKey({ CPA_MANAGEMENT_KEY_FILE: keyFile });
    buildIndex(root, index, loadKey);
    db = openIndex(index);
    assertRedacted(db.query('SELECT body FROM item').all());
    assertRedacted(db.query('SELECT payload FROM file_cache').all());
    const row = db.query<ItemRow, []>('SELECT * FROM item LIMIT 1').get()!;
    assertRedacted(rawRecord(root, row.pointer, loadKey()));
    const fetch = handler(db, root, undefined, undefined, loadKey);
    for (const path of [
      `/api/sessions/${row.sessionId}`,
      '/api/search?q=ordinary',
      `/api/items/${row.id}/raw`,
    ]) {
      const response = await fetch(new Request(`http://synthetic.invalid${path}`));
      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      assertRedacted(await response.json());
    }
    // Raw reads reload the key file, including when the index has not been rebuilt.
    writeFileSync(keyFile, 'rotated-fixture-key');
    const rawFile = join(root, 'rotated.jsonl');
    const record = JSON.stringify({ text: 'rotated-fixture-key' });
    writeFileSync(rawFile, record);
    db.query('UPDATE item SET pointer=? WHERE id=?').run(
      JSON.stringify({
        kind: 'jsonl',
        file: 'rotated.jsonl',
        offset: 0,
        length: Buffer.byteLength(record),
      }),
      row.id
    );
    const rotated = await fetch(new Request(`http://synthetic.invalid/api/items/${row.id}/raw`));
    expect(await rotated.json()).toEqual({ record: { text: '[redacted]' } });
    // SQLite native records can hold serialized JSON in a text column.
    const native = new Database(join(root, 'native.sqlite'));
    native.run('CREATE TABLE part(id TEXT, data TEXT)');
    native
      .query('INSERT INTO part VALUES(?,?)')
      .run('part', JSON.stringify({ body, access_token: secrets[6] }));
    native.close();
    assertRedacted(
      rawRecord(
        root,
        JSON.stringify({
          kind: 'sqlite',
          file: 'native.sqlite',
          table: 'part',
          column: 'id',
          key: 'part',
        }),
        secrets[0]
      )
    );
    expect(readFileSync(file, 'utf8')).toBe(original);
  } finally {
    db?.close();
    rmSync(temp, { recursive: true, force: true });
  }
});

test('all API responses are no-store, including errors, and the single-file UI is no-cache', async () => {
  const root = mkdtempSync('/tmp/pool-cache-');
  const db = openIndex(':memory:');
  try {
    writeFileSync(join(root, 'index.html'), '<html>Fixture</html>');
    const fetch = handler(db, root, root);
    for (const [path, method, status] of [
      ['/api/search', 'GET', 200],
      ['/api/search?client=invalid', 'GET', 400],
      ['/api/sessions/999', 'GET', 404],
      ['/api/unknown', 'GET', 404],
      ['/api/search', 'POST', 405],
      ['/api', 'GET', 404],
    ] as const) {
      const response = await fetch(new Request(`http://synthetic.invalid${path}`, { method }));
      expect(response.status).toBe(status);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
    }
    expect(
      (await fetch(new Request('http://synthetic.invalid/'))).headers.get('Cache-Control')
    ).toBe('no-cache');
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('an explicit archive root cannot be silently replaced by the stored root', () => {
  const root = mkdtempSync('/tmp/pool-root-'),
    path = join(root, 'index.sqlite');
  const db = openIndex(path);
  db.query("INSERT INTO setting VALUES('archiveRoot',?)").run(root);
  db.close();
  const serve = spyOn(Bun, 'serve');
  try {
    expect(() =>
      startDashboard({ INDEX_PATH: path, ARCHIVE_ROOT: join(root, 'another-archive') })
    ).toThrow('different ARCHIVE_ROOT');
    expect(serve).not.toHaveBeenCalled();
  } finally {
    serve.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});

test('background indexing inherits the configured key loader environment', async () => {
  const db = openIndex(':memory:');
  const spawn = spyOn(Bun, 'spawn').mockReturnValue({
    exited: Promise.resolve(0),
    kill: () => {},
  } as ReturnType<typeof Bun.spawn>);
  const indexer = startIndexer(db, '/synthetic', ':memory:', undefined, {
    CPA_MANAGEMENT_KEY_FILE: '/synthetic/key',
  });
  try {
    await indexer.run();
    expect(spawn.mock.calls[0]?.[0]).toMatchObject({
      env: {
        CPA_MANAGEMENT_KEY_FILE: '/synthetic/key',
        ARCHIVE_ROOT: '/synthetic',
        INDEX_PATH: ':memory:',
      },
    });
  } finally {
    indexer.stop();
    spawn.mockRestore();
    db.close();
  }
});
