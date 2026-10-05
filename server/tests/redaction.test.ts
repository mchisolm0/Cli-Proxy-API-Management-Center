import { expect, test, spyOn } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, linkSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { buildIndex } from '../index';
import { codex, claude, opencode, t3 } from '../parsers';
import { openIndex, type ItemRow } from '../db';
import { managementKey, fetchClientKeys, pollAuth, redactionSecrets } from '../auth';
import { redactText, sanitize } from '../telemetry/events';
import { handler, rawRecord, startDashboard, startIndexer } from '../server';

const secrets = [
  'fixture-management',
  'bearer-fixture',
  'header-fixture',
  'management-header-fixture',
  'sk-test-fixture-12345678901234567890',
  'sk-ant-test-fixture-12345678901234567890',
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
    const file = join(snapshot, '.claude/projects/-home-mcc-code-sk-tools/session.jsonl');
    const index = join(temp, 'index.sqlite'),
      keyFile = join(temp, 'key');
    mkdirSync(join(snapshot, '.claude/projects/-home-mcc-code-sk-tools'), { recursive: true });
    writeFileSync(
      join(snapshot, 'manifest.json'),
      JSON.stringify({
        completed_at: '2026-10-05T12:00:00Z',
        sources: [{ path: '.codex', status: 'collected' }],
      })
    );
    const original =
      [
        {
          type: 'ai-title',
          sessionId: 'fixture-session',
          cwd: '/home/mcc/code/sk-tools',
          gitBranch: 'sk-tools',
          aiTitle: 'Fixture',
        },
        {
          type: 'user',
          sessionId: 'fixture-session',
          timestamp: '2026-10-05T12:00:00Z',
          message: { content: body },
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
    expect(db.query('SELECT cwd,branch FROM session').get()).toEqual({
      cwd: '/home/mcc/code/sk-tools',
      branch: 'sk-tools',
    });
    const row = db.query<ItemRow, []>('SELECT * FROM item LIMIT 1').get()!;
    expect(row.pointer).toContain('-home-mcc-code-sk-tools');
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

test('text rules cover realistic headers, env, YAML, mixed and escaped JSON without rewriting prose', () => {
  const secret = 'fixture-client-1234567890';
  for (const snippet of [
    `curl -H 'X-Goog-Api-Key: ${secret}' https://example.invalid`,
    `GET /v1/generate?key=${secret}&model=test`,
    `export OPENAI_API_KEY=${secret}`,
    `cat config.yaml\napi-keys:\n  - ${secret}\n  - "another-client-1234567890"`.replaceAll(
      '\\n',
      '\n'
    ),
    `api-keys: ["${secret}", another-client-1234567890]`,
    `Output:\n{ "api_key" : "${secret}", "count": 9007199254740993 }`,
    `Output: {"apiKey":"${secret}","api-key":"${secret}","token":"${secret}","client_secret":"${secret}"}`,
    String.raw`Output: {\"access_token\":\"${secret}\"}`,
    String.raw`Output: {\"access_token\":\"prefix\\\"${secret}\"}`,
    String.raw`Output: {"api_key":"prefix\"${secret}"}`,
    `Authorization: Basic ${Buffer.from('fixture:password').toString('base64')}`,
    `password=${secret} token: ${secret} client-secret: '${secret}'`,
  ]) {
    const result = redactText(snippet);
    expect(result).not.toContain(secret);
    expect(result).toContain('[redacted]');
    expect(redactText(result)).toBe(result);
  }
  const prose =
    'Use a Bearer token to authenticate. A key is required. token = value\n/home/mcc/code/sk-tools\n{"count": 9007199254740993, "spacing":  2}';
  expect(redactText(prose)).toBe(prose);
  for (const prefix of ['sk-', 'sk-ant-']) {
    expect(redactText(prefix + 'x'.repeat(19))).toBe(prefix + 'x'.repeat(19));
    expect(redactText(prefix + 'x'.repeat(20))).toBe('[redacted]');
  }
  const formatted = '{\n  "count": 9007199254740993,\n  "api_key": "fixture-secret"\n}\n';
  expect(redactText(formatted)).toBe(formatted.replace('fixture-secret', '[redacted]'));
  const location = '/home/mcc/code/sk-' + 'x'.repeat(24);
  expect(
    sanitize(
      {
        cwd: location,
        repo: location,
        branch: location,
        pointer: { file: location },
        body: location,
      },
      [],
      true
    )
  ).toEqual({
    cwd: location,
    repo: location,
    branch: location,
    pointer: { file: location },
    body: '/home/mcc/code/[redacted]',
  });
});

test('legacy cache rows miss once and a new snapshot sharing a file writes no cache rows', () => {
  const temp = mkdtempSync('/tmp/pool-cache-writes-');
  const root = join(temp, 'archive'),
    index = join(temp, 'index.sqlite');
  const first = join(root, 'host/2026-10-05T120000Z');
  const second = join(root, 'host/2026-10-06T120000Z');
  const file = '.codex/sessions/session.jsonl';
  let db: Database | undefined;
  try {
    mkdirSync(join(first, '.codex/sessions'), { recursive: true });
    writeFileSync(
      join(first, 'manifest.json'),
      JSON.stringify({ completed_at: '2026-10-05T12:00:00Z', sources: [] })
    );
    writeFileSync(
      join(first, file),
      JSON.stringify({ type: 'session_meta', payload: { id: 'shared' } })
    );
    expect(buildIndex(root, index).parsedFiles).toBe(1);
    db = openIndex(index);
    db.run(
      "UPDATE file_cache SET signature=substr(signature,4); UPDATE snapshot SET signature='legacy'"
    );
    expect(buildIndex(root, index).parsedFiles).toBe(1);
    expect(buildIndex(root, index).parsedFiles).toBe(0);
    db.run(
      'CREATE TABLE cache_writes(signature TEXT); CREATE TRIGGER cache_insert AFTER INSERT ON file_cache BEGIN INSERT INTO cache_writes VALUES(new.signature); END; CREATE TRIGGER cache_update AFTER UPDATE ON file_cache BEGIN INSERT INTO cache_writes VALUES(new.signature); END'
    );
    mkdirSync(join(second, '.codex/sessions'), { recursive: true });
    linkSync(join(first, file), join(second, file));
    writeFileSync(
      join(second, 'manifest.json'),
      JSON.stringify({ completed_at: '2026-10-06T12:00:00Z', sources: [] })
    );
    expect(buildIndex(root, index)).toEqual({
      snapshots: 1,
      skippedSnapshots: 1,
      parsedFiles: 0,
      skippedFiles: 2,
    });
    expect(db.query('SELECT * FROM cache_writes').all()).toEqual([]);
  } finally {
    db?.close();
    rmSync(temp, { recursive: true, force: true });
  }
});

test('unreadable management keys leave indexing and raw history available with one problem', async () => {
  const temp = mkdtempSync('/tmp/pool-key-unavailable-');
  const root = join(temp, 'archive'),
    index = join(temp, 'index.sqlite');
  const snapshot = join(root, 'host/2026-10-05T120000Z');
  const loadKey = () => managementKey({ CPA_MANAGEMENT_KEY_FILE: join(temp, 'missing') });
  let db: Database | undefined;
  try {
    mkdirSync(join(snapshot, '.codex/sessions'), { recursive: true });
    writeFileSync(
      join(snapshot, 'manifest.json'),
      JSON.stringify({ completed_at: '2026-10-05T12:00:00Z', sources: [] })
    );
    writeFileSync(
      join(snapshot, '.codex/sessions/session.jsonl'),
      [
        { type: 'session_meta', payload: { id: 'available' } },
        {
          type: 'event_msg',
          payload: {
            type: 'user_message',
            message: 'Authorization: Basic Zml4dHVyZTpwYXNzd29yZA==',
          },
        },
      ]
        .map((value) => JSON.stringify(value))
        .join('\n')
    );
    expect(buildIndex(root, index, loadKey).parsedFiles).toBe(1);
    expect(buildIndex(root, index, loadKey).skippedSnapshots).toBe(1);
    db = openIndex(index);
    expect(db.query('SELECT code FROM dashboard_event').all()).toEqual([
      { code: 'redaction_key_unavailable' },
    ]);
    expect(db.query<{ body: string }, []>('SELECT body FROM item').get()?.body).toContain(
      '[redacted]'
    );
    const item = db.query<ItemRow, []>('SELECT * FROM item').get()!;
    const response = await handler(
      db,
      root,
      undefined,
      undefined,
      loadKey
    )(new Request(`http://synthetic.invalid/api/items/${item.id}/raw`));
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).not.toContain('Zml4dHVyZTpwYXNzd29yZA==');
  } finally {
    db?.close();
    rmSync(temp, { recursive: true, force: true });
  }
});

test('auth polls refresh client-key secrets in memory for raw responses and indexing', async () => {
  const temp = mkdtempSync('/tmp/pool-client-keys-');
  const db = openIndex(join(temp, 'index.sqlite'));
  let client = 'fixture-first-client';
  let calls = 0;
  const fetcher: typeof fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      calls++;
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fixture-management');
      expect(init?.redirect).toBe('error');
      if (String(input).endsWith('/config'))
        return Response.json({
          access: { 'api-keys': [client] },
          'api-keys': { codex: [{ keys: [{ 'api-key': 'upstream-fixture' }] }] },
        });
      expect(String(input)).toBe('http://synthetic.invalid/v8/management/credentials');
      return Response.json({
        files: [{ name: 'fixture-account', provider: 'codex', status_message: client }],
      });
    },
    { preconnect: () => {} }
  );
  try {
    expect(
      await fetchClientKeys('http://synthetic.invalid', 'fixture-management', fetcher)
    ).toEqual([client]);
    await pollAuth(db, 'http://synthetic.invalid', () => 'fixture-management', fetcher);
    expect(redactionSecrets(db, 'fixture-management')).toEqual(['fixture-management', client]);
    const snapshot = join(temp, 'archive/host/2026-10-05T120000Z');
    mkdirSync(join(snapshot, '.codex/sessions'), { recursive: true });
    writeFileSync(
      join(snapshot, 'manifest.json'),
      JSON.stringify({ completed_at: '2026-10-05T12:00:00Z', sources: [] })
    );
    writeFileSync(
      join(snapshot, '.codex/sessions/session.jsonl'),
      [
        { type: 'session_meta', payload: { id: 'client-secret' } },
        {
          type: 'event_msg',
          payload: { type: 'user_message', message: `Plain credential ${client}` },
        },
      ]
        .map((value) => JSON.stringify(value))
        .join('\n')
    );
    const destination = join(temp, 'index.sqlite');
    buildIndex(
      join(temp, 'archive'),
      destination,
      () => 'fixture-management',
      redactionSecrets(db, '')
    );
    const indexed = openIndex(destination);
    try {
      expect(indexed.query<{ body: string }, []>('SELECT body FROM item').get()?.body).toBe(
        'Plain credential [redacted]'
      );
      expect(JSON.stringify(indexed.query('SELECT payload FROM file_cache').all())).not.toContain(
        client
      );
    } finally {
      indexed.close();
    }
    // A raw record may contain an unlabelled client key, including one rotated since indexing.
    client = 'fixture-rotated-client';
    await pollAuth(db, 'http://synthetic.invalid', () => 'fixture-management', fetcher);
    expect(calls).toBe(5);
    const record = JSON.stringify({ text: `Plain credential ${client}` });
    writeFileSync(join(temp, 'raw.jsonl'), record);
    db.query(
      "INSERT INTO item(sessionId,seq,time,role,tool,callId,body,bodyLength,pointer) VALUES(1,0,0,'user','','','',0,?)"
    ).run(
      JSON.stringify({
        kind: 'jsonl',
        file: 'raw.jsonl',
        offset: 0,
        length: Buffer.byteLength(record),
      })
    );
    const item = db.query<ItemRow, []>('SELECT * FROM item ORDER BY id DESC LIMIT 1').get()!;
    const response = await handler(
      db,
      temp,
      undefined,
      undefined,
      () => 'fixture-management'
    )(new Request(`http://synthetic.invalid/api/items/${item.id}/raw`));
    expect(await response.json()).toEqual({ record: { text: 'Plain credential [redacted]' } });
    const failed: typeof fetch = Object.assign(
      async (input: string | URL | Request) => {
        if (String(input).endsWith('/config')) throw new Error(client);
        return Response.json({ files: [] });
      },
      { preconnect: () => {} }
    );
    await pollAuth(db, 'http://synthetic.invalid', () => 'fixture-management', failed);
    expect(redactionSecrets(db, '')).toContain(client);
    expect(db.query('SELECT code FROM dashboard_event').all()).toEqual([
      { code: 'redaction_keys_refresh_failed' },
    ]);
    for (const table of ['auth_state', 'auth_state_event', 'dashboard_event'])
      expect(JSON.stringify(db.query(`SELECT * FROM ${table}`).all())).not.toContain(client);
  } finally {
    db.close();
    rmSync(temp, { recursive: true, force: true });
  }
});
