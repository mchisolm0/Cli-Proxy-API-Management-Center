import { expect, test, spyOn } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, linkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from 'bun:sqlite';
import { buildIndex } from '../index';
import { codex, claude, opencode, t3, codexMetadata } from '../parsers';
import { openIndex, type ItemRow } from '../db';
import {
  managementKey,
  fetchClientKeys,
  pollAuth,
  redactionSecrets,
  managementRetryAt,
} from '../auth';
import { redactText, redactIndexedText, sanitize } from '../telemetry/events';
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

test('Claude Read file objects are sanitized through the raw HTTP route', async () => {
  const root = mkdtempSync('/tmp/pool-read-result-');
  const db = openIndex(':memory:');
  const clientKey = 'fixture-client-read-123456';
  const record = {
    toolUseResult: {
      file: { filePath: '/code/.env', content: `plain ${clientKey}` },
    },
    file: '/code/sk-' + 'x'.repeat(24),
    pointer: { file: '/code/.env' },
  };
  try {
    const fetcher: typeof fetch = Object.assign(
      async (input: string | URL | Request) =>
        Response.json(
          String(input).endsWith('/config')
            ? { access: { 'api-keys': [clientKey] } }
            : { files: [] }
        ),
      { preconnect: () => {} }
    );
    await pollAuth(db, 'http://synthetic.invalid', () => 'fixture-management', fetcher);
    const text = JSON.stringify(record);
    writeFileSync(join(root, 'read.jsonl'), text);
    db.run(
      "INSERT INTO session VALUES(1,'test','claude','read','','','','','','',0,0,0,'','root','','',0,1)"
    );
    db.query(
      "INSERT INTO item(sessionId,seq,time,role,tool,callId,body,bodyLength,pointer) VALUES(1,0,0,'tool_result','','','',0,?)"
    ).run(
      JSON.stringify({
        kind: 'jsonl',
        file: 'read.jsonl',
        offset: 0,
        length: Buffer.byteLength(text),
      })
    );
    const response = await handler(
      db,
      root,
      undefined,
      undefined,
      () => ''
    )(new Request('http://synthetic.invalid/api/items/1/raw'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      record: {
        ...record,
        toolUseResult: { file: { filePath: '/code/.env', content: 'plain [redacted]' } },
      },
    });
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('short exact-match keys and existing markers do not damage ordinary transcript text', () => {
  const text = 'a token is redacted: [redacted]';
  expect(redactText(text, ['a', 'token', 'redacted', '[redacted]', 'placeholder'])).toBe(text);
  expect(redactText('fixture-client-secret [redacted]', ['fixture-client-secret'])).toBe(
    '[redacted] [redacted]'
  );
});

test('generic key/token values preserve code and prose, and quoted values stop at newlines', () => {
  for (const text of [
    'const key = providerKeyFor(model)',
    'const access_token = providerTokenFor(model)',
    '"key":"Enter"',
    'key: "a long ordinary sentence"',
    "key: 'it is\na normal transcript, don't swallow it'",
    'token: "long-ordinary-identifier"',
  ]) {
    expect(redactText(text)).toBe(text);
  }
  expect(sanitize({ key: 'Enter', token: 'providerKeyFor' }, [], true)).toEqual({
    key: 'Enter',
    token: 'providerKeyFor',
  });
  expect(redactText(`"key":"use sk-${'x'.repeat(24)}"`)).toBe('"key":"use [redacted]"');
  expect(sanitize({ PGPASSWORD: 'short' }, [], true)).toEqual({ PGPASSWORD: '[redacted]' });
  expect(redactText('Headers: {"Cookie":"a=b; c=d","count":123}')).toBe(
    'Headers: {"Cookie":"[redacted]","count":123}'
  );
  expect(redactText(String.raw`{\"Cookie\":\"a=b; c=d\",\"count\":123}`)).toBe(
    String.raw`{\"Cookie\":\"[redacted]\",\"count\":123}`
  );
  expect(redactText('[{"Cookie":"a=b"},{"Cookie":"c=d","Set-Cookie":"e=f"}]')).toBe(
    '[{"Cookie":"[redacted]"},{"Cookie":"[redacted]","Set-Cookie":"[redacted]"}]'
  );
  const text = "password: 'short\nordinary text, don't swallow it'";
  expect(redactText(text)).not.toContain('short');
  expect(redactText(text)).toContain("\nordinary text, don't swallow it'");
  for (const text of [
    'OPENAI_API_KEY=fixture-1234567890',
    'aws_secret_access_key = fixture-1234567890',
    'client-secret: "short"',
    'key=fixture-1234567890',
    'token="fixture-1234567890"',
    'PGPASSWORD=short',
    'PGPASSWORD=s!mple#pass',
    'X-Management-Key: short',
    'Authorization: Bearer short',
    'Cookie: session=short; other=fixture\nordinary line',
    'ghp_' + 'x'.repeat(36),
    'github_pat_' + 'x'.repeat(82),
    'postgresql://user:short@localhost/db',
    'redis://user:p%40ss@localhost:6379',
  ]) {
    const safe = redactText(text);
    expect(safe).not.toBe(text);
    expect(safe).toContain('[redacted]');
    expect(redactText(safe)).toBe(safe);
  }
});

test('redaction scans adversarial inputs and a 100 KB transcript within a generous wall-clock bound', () => {
  // Deterministic base64url, including many underscores and no assignment delimiter.
  const blob = Buffer.from(Array.from({ length: 3840 }, (_, i) => (i * 71 + 255) % 256)).toString(
    'base64url'
  );
  const identifier = Array.from({ length: 40 }, (_, i) => `part${i}`).join('_');
  const transcript = ('ordinary code: const key = providerKeyFor(model); ' + blob + '\n')
    .repeat(21)
    .slice(0, 100 * 1024);
  // Measure the complete scans without allowing the 25 ms budget to hide slow patterns.
  const now = spyOn(performance, 'now').mockReturnValue(0);
  try {
    for (const text of [
      blob,
      identifier,
      transcript,
      '_'.repeat(5120),
      'a-'.repeat(5120),
      'api-keys: ['.repeat(5000),
      'eyJ-'.repeat(25 * 1024),
      'eyJ-'.repeat(25 * 1024) + '.incomplete',
      '-----BEGIN PRIVATE KEY-----\n'.repeat(4000),
    ]) {
      const started = process.hrtime.bigint();
      const safe = redactText(text);
      expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(500);
      if (!text.startsWith('api-keys: [') && !text.startsWith('-----BEGIN'))
        expect(safe).toBe(text);
    }
  } finally {
    now.mockRestore();
  }
});

test('redaction discards the entire body when its time or size budget is exceeded', () => {
  const now = spyOn(performance, 'now');
  let elapsed = 0;
  now.mockImplementation(() => (elapsed += 30));
  try {
    expect(redactIndexedText('ordinary prose '.repeat(80000))).toStartWith('ordinary prose ');
    expect(redactText('ordinary text fixture-client-secret', ['fixture-client-secret'])).toBe(
      '[redacted]'
    );
  } finally {
    now.mockRestore();
  }
  expect(redactText('x'.repeat(1024 * 1024 + 1))).toBe('[redacted]');
});

test('all native parsers redact bodies before truncation can leave a partial secret', () => {
  const root = mkdtempSync('/tmp/pool-redaction-boundary-');
  const secret = 'fixture-management-boundary-key';
  const text = 'x'.repeat(8185) + secret + ' ordinary prose'.repeat(80000);
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

test('native titles, T3 links and Codex threads metadata are redacted before indexing or caching', () => {
  const temp = mkdtempSync('/tmp/pool-secret-titles-');
  const root = join(temp, 'archive');
  const snapshot = join(root, 'host/2026-10-05T120000Z');
  const clientKey = 'fixture-title-client-123456';
  const title = `Help with ${clientKey} and sk-${'x'.repeat(24)}`;
  const expected = 'Help with [redacted] and [redacted]';
  const paths = {
    claude: '.claude/projects/project/session.jsonl',
    codex: '.codex/sessions/session.jsonl',
    metadata: '.codex/state_5.sqlite',
    open: '.local/share/opencode/opencode.db',
    t3: '.t3/userdata/state.sqlite',
  };
  try {
    for (const file of Object.values(paths))
      mkdirSync(join(snapshot, file, '..'), { recursive: true });
    writeFileSync(
      join(snapshot, 'manifest.json'),
      JSON.stringify({ completed_at: '2026-10-05T12:00:00Z', sources: [] })
    );
    writeFileSync(
      join(snapshot, paths.claude),
      JSON.stringify({ type: 'ai-title', sessionId: 'claude', aiTitle: title })
    );
    writeFileSync(
      join(snapshot, paths.codex),
      JSON.stringify({ type: 'session_meta', payload: { id: 'codex' } })
    );
    const metadata = new Database(join(snapshot, paths.metadata));
    metadata.run('CREATE TABLE threads(id TEXT, title TEXT, name TEXT, first_user_message TEXT)');
    metadata.query('INSERT INTO threads VALUES(?,?,?,?)').run('codex', title, title, clientKey);
    metadata.close();
    const open = new Database(join(snapshot, paths.open));
    open.run(
      'CREATE TABLE session(id TEXT, title TEXT); CREATE TABLE message(id TEXT, session_id TEXT, time_created INTEGER)'
    );
    open.query('INSERT INTO session VALUES(?,?)').run('open', title);
    open.close();
    const t = new Database(join(snapshot, paths.t3));
    t.run(
      'CREATE TABLE projection_threads(thread_id TEXT,title TEXT); CREATE TABLE provider_session_runtime(thread_id TEXT,provider_name TEXT,resume_cursor_json TEXT); CREATE TABLE projection_thread_messages(message_id TEXT,thread_id TEXT,created_at INTEGER)'
    );
    t.query('INSERT INTO projection_threads VALUES(?,?)').run('linked', title);
    t.query('INSERT INTO projection_threads VALUES(?,?)').run('t3-only', title);
    t.query('INSERT INTO provider_session_runtime VALUES(?,?,?)').run(
      'linked',
      'claudeAgent',
      JSON.stringify({ resume: 'claude' })
    );
    t.close();
    expect(claude(join(snapshot, paths.claude), paths.claude, [clientKey]).sessions[0]?.title).toBe(
      expected
    );
    expect(opencode(join(snapshot, paths.open), paths.open, [clientKey]).sessions[0]?.title).toBe(
      expected
    );
    const parsed = t3(join(snapshot, paths.t3), paths.t3, [clientKey]);
    expect(parsed.links[0]?.title).toBe(expected);
    expect(parsed.sessions.every((s) => s.title === expected)).toBe(true);
    expect(
      JSON.stringify(codexMetadata(join(snapshot, paths.metadata), [clientKey]))
    ).not.toContain(clientKey);
    const index = join(temp, 'index.sqlite');
    buildIndex(root, index, () => '', [clientKey]);
    const db = openIndex(index);
    try {
      expect(db.query('SELECT title FROM session ORDER BY client').all()).toEqual(
        Array.from({ length: 4 }, () => ({ title: expected }))
      );
      expect(db.query('SELECT title FROM native_overlay').get()).toEqual({ title: expected });
      for (const table of ['session', 'native_overlay', 'file_cache']) {
        const stored = JSON.stringify(db.query(`SELECT * FROM ${table}`).all());
        expect(stored).not.toContain(clientKey);
        expect(stored).not.toContain('sk-' + 'x'.repeat(24));
      }
    } finally {
      db.close();
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
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

test('background indexing passes the current client keys through stdin, including during backoff', async () => {
  const db = openIndex(':memory:');
  let client = 'fixture-client-before-backoff';
  const fetcher: typeof fetch = Object.assign(
    async (input: string | URL | Request) =>
      Response.json(
        String(input).endsWith('/config') ? { access: { 'api-keys': [client] } } : { files: [] }
      ),
    { preconnect: () => {} }
  );
  await pollAuth(db, 'http://synthetic.invalid', () => 'fixture-management', fetcher);
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
        CPA_INDEX_KEYS_STDIN: '1',
      },
    });
    const firstLaunch: unknown = spawn.mock.calls[0]?.[0];
    const stdin =
      firstLaunch && typeof firstLaunch === 'object' && 'stdin' in firstLaunch
        ? firstLaunch.stdin
        : undefined;
    expect(stdin).toBeInstanceOf(Blob);
    expect(JSON.parse(await (stdin as Blob).text())).toEqual(['', client]);
    client = 'fixture-rotated-before-backoff';
    await pollAuth(db, 'http://synthetic.invalid', () => 'fixture-management', fetcher);
    const rejected: typeof fetch = Object.assign(async () => new Response(null, { status: 401 }), {
      preconnect: () => {},
    });
    await pollAuth(db, 'http://synthetic.invalid', () => 'stale-key', rejected);
    expect(managementRetryAt(db)).toBeGreaterThan(Date.now());
    await indexer.run();
    const nextLaunch: unknown = spawn.mock.calls[1]?.[0];
    const next =
      nextLaunch && typeof nextLaunch === 'object' && 'stdin' in nextLaunch
        ? nextLaunch.stdin
        : undefined;
    expect(JSON.parse(await (next as Blob).text())).toEqual(['', client]);
  } finally {
    indexer.stop();
    spawn.mockRestore();
    db.close();
  }
});

test('real indexer children never request management config, even with a stale key during backoff', async () => {
  const temp = mkdtempSync('/tmp/pool-child-no-auth-');
  const root = join(temp, 'archive');
  const snapshot = join(root, 'host/2026-10-05T120000Z');
  const destination = join(temp, 'index.sqlite');
  const db = openIndex(destination);
  const client = 'fixture-child-client-123456';
  const requestLog = join(temp, 'management-request');
  const guard = join(temp, 'no-management-fetch.ts');
  writeFileSync(
    guard,
    `import { writeFileSync } from 'node:fs';
    globalThis.fetch = () => {
      writeFileSync(${JSON.stringify(requestLog)}, 'unexpected management request');
      throw new Error('Indexer must not authenticate');
    };`
  );
  const env = {
    CPA_BASE_URL: 'http://synthetic.invalid',
    CPA_MANAGEMENT_KEY_FILE: join(temp, 'key'),
    ARCHIVE_ROOT: root,
    INDEX_PATH: destination,
  };
  const indexer = startIndexer(db, root, destination, undefined, env);
  try {
    mkdirSync(join(snapshot, '.codex/sessions'), { recursive: true });
    writeFileSync(
      join(snapshot, 'manifest.json'),
      JSON.stringify({ completed_at: '2026-10-05T12:00:00Z', sources: [] })
    );
    writeFileSync(
      join(snapshot, '.codex/sessions/session.jsonl'),
      [
        { type: 'session_meta', payload: { id: 'child' } },
        { type: 'event_msg', payload: { type: 'user_message', message: `plain ${client}` } },
      ]
        .map((record) => JSON.stringify(record))
        .join('\n')
    );
    writeFileSync(env.CPA_MANAGEMENT_KEY_FILE, 'fixture-stale-management');
    const fetcher: typeof fetch = Object.assign(
      async (input: string | URL | Request) =>
        Response.json(
          String(input).endsWith('/config') ? { access: { 'api-keys': [client] } } : { files: [] }
        ),
      { preconnect: () => {} }
    );
    await pollAuth(db, 'http://synthetic.invalid', () => 'fixture-management', fetcher);
    const rejected: typeof fetch = Object.assign(async () => new Response(null, { status: 401 }), {
      preconnect: () => {},
    });
    await pollAuth(db, 'http://synthetic.invalid', () => 'stale-key', rejected);
    expect(managementRetryAt(db)).toBeGreaterThan(Date.now());
    await indexer.run();
    expect(db.query('SELECT body FROM item').get()).toEqual({ body: 'plain [redacted]' });
    expect(JSON.stringify(db.query('SELECT payload FROM file_cache').all())).not.toContain(client);
    expect(db.query("SELECT * FROM dashboard_event WHERE code='index_failed'").all()).toEqual([]);
    // Direct CLI indexing also never authenticates or waits for an interactive stdin.
    const standalone = Bun.spawn({
      cmd: [
        process.execPath,
        '--preload',
        guard,
        fileURLToPath(new URL('../index.ts', import.meta.url)),
      ],
      env,
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'pipe',
    });
    expect(await standalone.exited).toBe(0);
    expect(await Bun.file(requestLog).exists()).toBe(false);
  } finally {
    indexer.stop();
    db.close();
    rmSync(temp, { recursive: true, force: true });
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
    const token = prefix + 'x'.repeat(24);
    expect(redactText(`/code/${token} identifier_${token} word${token}`)).toBe(
      `/code/${token} identifier_${token} word${token}`
    );
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
    body: location,
  });
});

test('superseded cache rows are deleted once after success and shared files write no cache rows', () => {
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
      "UPDATE file_cache SET signature='r3:' || substr(signature,4); UPDATE snapshot SET signature='legacy'; DELETE FROM setting WHERE key='cachePrefix'"
    );
    expect(buildIndex(root, index).parsedFiles).toBe(1);
    expect(db.query("SELECT * FROM file_cache WHERE signature NOT LIKE 'r4:%'").all()).toEqual([]);
    // Cleanup is a once-per-version migration, not a repeated table scan.
    db.run(
      "CREATE TABLE cache_deletes(signature TEXT); CREATE TRIGGER cache_delete AFTER DELETE ON file_cache BEGIN INSERT INTO cache_deletes VALUES(old.signature); END; INSERT INTO file_cache VALUES('legacy-after-migration','{}')"
    );
    expect(buildIndex(root, index).parsedFiles).toBe(0);
    expect(db.query('SELECT * FROM cache_deletes').all()).toEqual([]);
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

test('a failed index run leaves superseded cache rows until a successful migration', () => {
  const temp = mkdtempSync('/tmp/pool-cache-migration-');
  const root = join(temp, 'archive');
  const snapshot = join(root, 'host/2026-10-05T120000Z');
  const index = join(temp, 'index.sqlite');
  const db = openIndex(index);
  try {
    mkdirSync(join(snapshot, '.codex/sessions'), { recursive: true });
    writeFileSync(
      join(snapshot, 'manifest.json'),
      JSON.stringify({ completed_at: '2026-10-05T12:00:00Z', sources: [] })
    );
    const file = join(snapshot, '.codex/sessions/session.jsonl');
    writeFileSync(file, '{}');
    db.query('INSERT INTO file_cache VALUES(?,?)').run('r3:old', '{}');
    expect(() => buildIndex(root, index)).toThrow('Missing Codex session id');
    expect(db.query('SELECT signature FROM file_cache').all()).toEqual([{ signature: 'r3:old' }]);
    expect(db.query("SELECT * FROM setting WHERE key='cachePrefix'").get()).toBeNull();
    writeFileSync(file, JSON.stringify({ type: 'session_meta', payload: { id: 'fixed' } }));
    expect(buildIndex(root, index).parsedFiles).toBe(1);
    expect(db.query("SELECT * FROM file_cache WHERE signature NOT LIKE 'r4:%'").all()).toEqual([]);
    expect(db.query("SELECT value FROM setting WHERE key='cachePrefix'").get()).toEqual({
      value: 'r4:',
    });
  } finally {
    db.close();
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
    await pollAuth(db, 'http://synthetic.invalid', () => 'fixture-management', failed);
    expect(redactionSecrets(db, '')).toContain(client);
    expect(db.query('SELECT code FROM dashboard_event').all()).toEqual([
      { code: 'redaction_keys_refresh_failed' },
    ]);
    await pollAuth(db, 'http://synthetic.invalid', () => 'fixture-management', fetcher);
    await pollAuth(db, 'http://synthetic.invalid', () => 'fixture-management', failed);
    expect(db.query('SELECT code FROM dashboard_event').all()).toEqual([
      { code: 'redaction_keys_refresh_failed' },
      { code: 'redaction_keys_refresh_failed' },
    ]);
    for (const table of ['auth_state', 'auth_state_event', 'dashboard_event'])
      expect(JSON.stringify(db.query(`SELECT * FROM ${table}`).all())).not.toContain(client);
  } finally {
    db.close();
    rmSync(temp, { recursive: true, force: true });
  }
});

test('camelCase and suffixed credential names redact text and raw fields, preserving code values', () => {
  for (const name of [
    'accessToken',
    'refreshToken',
    'authToken',
    'secretAccessKey',
    'privateKey',
    'clientSecret',
    'apiKey',
    'sessionToken',
    'SECRET_KEY_BASE',
    'API_KEY_PROD',
  ]) {
    for (const text of [
      `${name}=short`,
      `{"${name}":"short"}`,
      String.raw`{\"${name}\":\"short\"}`,
    ]) {
      expect(redactText(text)).toBe(text.replace('short', '[redacted]'));
    }
    expect(sanitize({ [name]: 'short' }, [], true)).toEqual({ [name]: '[redacted]' });
    expect(sanitize({ [name]: 'short' })).toEqual({});
    expect(redactText(`The ${name}: short`)).toBe(`The ${name}: [redacted]`);
    expect(redactText(`${name}=string`)).toBe(`${name}=[redacted]`);
    expect(redactText(`${name}: "string"`)).toBe(`${name}: "[redacted]"`);
    expect(redactText(`${name}: "process.env.X"`)).toBe(`${name}: "[redacted]"`);
    const code = `${name} = providerKeyFor(model)`;
    expect(redactText(code)).toBe(code);
  }
});

test('standalone JWT, PEM, Google, GitHub, GitLab and Slack formats redact without labels', () => {
  const tokens = [
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmaXh0dXJlIn0.c3ludGhldGlj',
    'AIza' + 'x'.repeat(35),
    ...['ghp_', 'gho_', 'ghs_', 'ghu_', 'ghr_'].map((prefix) => prefix + 'x'.repeat(36)),
    'github_pat_' + 'x'.repeat(22),
    'glpat-' + 'x'.repeat(20),
    ...['xoxa-', 'xoxb-', 'xoxp-', 'xoxo-', 'xoxs-', 'xoxr-'].map(
      (prefix) => prefix + '1234567890-fixture'
    ),
  ];
  for (const token of tokens) {
    const text = `my token ${token} ends here`;
    expect(redactText(text)).toBe('my token [redacted] ends here');
    expect(redactText(`my token ${token}.`)).toBe('my token [redacted].');
    expect(redactText(redactText(text))).toBe(redactText(text));
    expect(redactText(`/code/${token} identifier_${token}`)).toBe(
      `/code/${token} identifier_${token}`
    );
  }
  for (const label of [
    'PRIVATE KEY',
    'RSA PRIVATE KEY',
    'EC PRIVATE KEY',
    'ENCRYPTED PRIVATE KEY',
  ]) {
    const pem = `-----BEGIN ${label}-----\nZml4dHVyZQ==\n-----END ${label}-----`;
    expect(redactText(`before\n${pem}\nafter`)).toBe('before\n[redacted]\nafter');
    expect(redactText(JSON.stringify({ text: pem }))).toBe('{"text":"[redacted]"}');
  }
  expect(redactText('-----BEGIN PRIVATE KEY-----\nunfinished')).toBe('[redacted]');
});

test('CLI credential flags and indented YAML scalar values redact with their layout intact', () => {
  for (const flag of ['--api-key ', '--token ', '--password ', '-p']) {
    expect(redactText(`command ${flag}short --other keep`)).toBe(
      `command ${flag}[redacted] --other keep`
    );
    expect(redactText(`${flag}"short"`)).toBe(`${flag}"[redacted]"`);
  }
  for (const scalar of ['', '|', '|-', '>+', '|2', '|2-', '|-2']) {
    const text = `outer:\n  privateKey: ${scalar}\n    first-secret\n    second-secret\n  ordinary: keep`;
    const expected = `outer:\n  privateKey: ${scalar}\n    [redacted]\n    [redacted]\n  ordinary: keep`;
    expect(redactText(text)).toBe(expected);
    expect(redactText(expected)).toBe(expected);
  }
  expect(redactText('password:\n  short\nordinary: keep')).toBe(
    'password:\n  [redacted]\nordinary: keep'
  );
});

test('cheap code, path and prose exclusions preserve noncredential values', () => {
  for (const text of [
    'primary_key=True',
    'password: string,',
    'apiKey: process.env.X',
    'api_key = os.environ["FIXTURE"]',
    'next_page_token: null',
    'key=/usr/local/x.gpg',
    'The secret: keep going.',
    'The cookie: chocolate chip.',
  ])
    expect(redactText(text)).toBe(text);
});

test('large indexed bodies and repository URLs stay useful and safe in storage and HTTP responses', async () => {
  const temp = mkdtempSync('/tmp/pool-review5-');
  const root = join(temp, 'archive');
  const snapshot = join(root, 'host/2026-10-05T120000Z');
  const file = '.codex/sessions/session.jsonl';
  const destination = join(temp, 'index.sqlite');
  const credential = 'fixture-url-password-123456';
  const remote = `https://x-access-token:${credential}@github.com/o/r.git`;
  const large = (
    `Useful ordinary prose. accessToken=${credential}\n` + 'ordinary prose '.repeat(80000)
  ).slice(0, 1024 * 1024);
  const records = [
    {
      type: 'session_meta',
      payload: {
        id: 'review5',
        git: { repository_url: remote, remote: `https://:${credential}@github.com/o/r.git` },
      },
    },
    { type: 'event_msg', payload: { type: 'user_message', message: large } },
    { type: 'response_item', payload: { type: 'function_call_output', output: large } },
  ];
  let db: Database | undefined;
  try {
    mkdirSync(join(snapshot, '.codex/sessions'), { recursive: true });
    writeFileSync(
      join(snapshot, 'manifest.json'),
      JSON.stringify({ completed_at: '2026-10-05T12:00:00Z', sources: [] })
    );
    const original = records.map((record) => JSON.stringify(record)).join('\n');
    writeFileSync(join(snapshot, file), original);
    buildIndex(root, destination, () => '');
    db = openIndex(destination);
    const items = db.query<ItemRow, []>('SELECT * FROM item ORDER BY seq').all();
    for (const [i, row] of items.entries()) {
      expect(row.body).toStartWith('Useful ordinary prose. accessToken=[redacted]\n');
      expect(row.body.length).toBe(i === 0 ? 8192 : 2048);
    }
    for (const table of ['session', 'session_fts', 'item', 'item_fts', 'file_cache']) {
      const stored = JSON.stringify(db.query(`SELECT * FROM ${table}`).all());
      expect(stored).not.toContain(credential);
    }
    const route = handler(db, root, undefined, undefined, () => '');
    for (const path of ['/api/search', '/api/search?q=Useful', '/api/search?q=github']) {
      const response = await route(new Request(`http://synthetic.invalid${path}`));
      expect(response.status).toBe(200);
      const result = await response.json();
      expect(result).toMatchObject({ total: 1 });
      expect(JSON.stringify(result)).toContain(
        'https://x-access-token:[redacted]@github.com/o/r.git'
      );
      expect(JSON.stringify(result)).not.toContain(credential);
    }
    const raw = rawRecord(
      root,
      JSON.stringify({
        kind: 'jsonl',
        file: `${snapshot.slice(root.length + 1)}/${file}`,
        offset: 0,
        length: Buffer.byteLength(JSON.stringify(records[0])),
      }),
      ''
    );
    expect(raw).toMatchObject({
      payload: {
        git: {
          repository_url: 'https://x-access-token:[redacted]@github.com/o/r.git',
          remote: 'https://:[redacted]@github.com/o/r.git',
        },
      },
    });
    db.query('UPDATE item SET pointer=? WHERE id=?').run(
      JSON.stringify({
        kind: 'jsonl',
        file: `${snapshot.slice(root.length + 1)}/${file}`,
        offset: 0,
        length: Buffer.byteLength(JSON.stringify(records[0])),
      }),
      items[0]!.id
    );
    const response = await route(
      new Request(`http://synthetic.invalid/api/items/${items[0]!.id}/raw`)
    );
    expect(await response.json()).toEqual({ record: raw });
    expect(
      sanitize({ repo: remote, git: remote, remote_url: remote, repository_url: remote }, [], true)
    ).toEqual(
      Object.fromEntries(
        ['repo', 'git', 'remote_url', 'repository_url'].map((name) => [
          name,
          'https://x-access-token:[redacted]@github.com/o/r.git',
        ])
      )
    );
    expect(readFileSync(join(snapshot, file), 'utf8')).toBe(original);
  } finally {
    db?.close();
    rmSync(temp, { recursive: true, force: true });
  }
});
