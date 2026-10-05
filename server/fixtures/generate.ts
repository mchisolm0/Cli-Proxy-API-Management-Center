import { Database } from 'bun:sqlite';
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  symlinkSync,
  linkSync,
  statSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { files } from '../archive';

export const first = '2026-09-30T120000Z';
export const second = '2026-10-01T120000Z';
const home = '/home/synthetic';
function write(path: string, value: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}
function jsonl(path: string, records: unknown[]) {
  write(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
function database(path: string, schema: string) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.run(schema);
  return db;
}

export function generate(root: string) {
  root = resolve(root);
  if (existsSync(root) && !existsSync(join(root, '.synthetic-fixtures')))
    throw new Error('Refusing to replace an archive without the synthetic fixture marker');
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  write(join(root, '.synthetic-fixtures'), 'Synthetic test data only\n');
  for (const host of ['mac', 'linux']) {
    for (const [n, stamp] of [first, second].entries()) {
      const base = join(root, host, stamp),
        time = `2026-${n ? '10-01' : '09-30'}T10:00:00.000Z`;
      const ts = Date.parse(time),
        snapshotTs = time.replace('10:00', '12:00');
      const meta = {
        id: 'codex-main',
        cwd: `${home}/projects/dotfiles`,
        model_provider: 'synthetic-provider',
        timestamp: time,
        git: {
          repository_url: 'https://example.invalid/matthew/dotfiles',
          branch: 'main',
        },
      };
      const record = (type: string, payload: unknown, ordinal = 20) => ({
        type,
        timestamp: time,
        ordinal,
        payload,
      });
      const codexPath = join(base, '.codex/sessions/2026/09/30/rollout-main.jsonl');
      const records = [
        record('session_meta', meta),
        record('turn_context', { model: 'gpt-synthetic' }),
        record('event_msg', {
          type: 'user_message',
          message: 'Search the archive for lunar otters 🦦',
        }),
        record('event_msg', {
          type: 'item_completed',
          item: {
            type: 'UserMessage',
            content: [{ text: 'Search the archive for lunar otters 🦦' }],
          },
        }),
        record('response_item', {
          type: 'function_call',
          name: 'rg',
          arguments: '{"pattern":"lunar otters"}',
          call_id: 'call-search',
        }),
        record('response_item', {
          type: 'function_call_output',
          call_id: 'call-search',
          output: 'Found ' + 'synthetic output '.repeat(300),
        }),
        record('response_item', {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'The archive contains lunar otters.' }],
        }),
        record('event_msg', {
          type: 'item_completed',
          item: {
            type: 'AgentMessage',
            text: 'The archive contains lunar otters.',
          },
        }),
        record('event_msg', {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 100,
              output_tokens: 50,
              total_tokens: 150,
            },
          },
        }),
      ];
      if (n)
        records.push(
          record('event_msg', {
            type: 'user_message',
            message: 'Latest snapshot update',
          })
        );
      jsonl(codexPath, records);
      const forkFile = '.codex/sessions/2026/09/30/rollout-fork.jsonl';
      if (n) {
        mkdirSync(dirname(join(base, forkFile)), { recursive: true });
        linkSync(join(root, host, first, forkFile), join(base, forkFile));
      } else
        jsonl(join(base, forkFile), [
          record('session_meta', {
            ...meta,
            id: 'codex-fork',
            forked_from_id: 'codex-main',
            subagent_history_start_ordinal: 10,
          }),
          record(
            'event_msg',
            {
              type: 'user_message',
              message: 'Inherited parent text must be skipped',
            },
            2
          ),
          record(
            'event_msg',
            {
              type: 'user_message',
              message: 'Fork asks about constellation maps',
            },
            10
          ),
          record(
            'response_item',
            {
              type: 'custom_tool_call',
              name: 'apply_patch',
              input: 'synthetic patch',
              call_id: 'patch-1',
            },
            11
          ),
          record(
            'response_item',
            {
              type: 'custom_tool_call_output',
              output: 'Done',
              call_id: 'patch-1',
            },
            12
          ),
        ]);
      const state = database(
        join(base, '.codex/state_5.sqlite'),
        'CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,model TEXT,git_branch TEXT);'
      );
      state
        .query('INSERT INTO threads VALUES(?,?,?,?)')
        .run('codex-main', 'Native archive search title', 'gpt-synthetic', 'main');
      state.close();
      const claudeRecords = [
        {
          type: 'ai-title',
          sessionId: 'claude-main',
          aiTitle: 'Audit the fixture archive',
        },
        {
          type: 'user',
          sessionId: 'claude-main',
          cwd: `${home}/projects/plato`,
          gitBranch: 'archive',
          timestamp: time,
          message: {
            content: [{ type: 'text', text: 'Explain the nebula index' }],
          },
        },
        {
          type: 'user',
          sessionId: 'claude-main',
          timestamp: time,
          isMeta: true,
          message: { content: 'Injected synthetic context' },
        },
        {
          type: 'assistant',
          sessionId: 'claude-main',
          timestamp: time,
          message: {
            id: 'claude-message-1',
            model: 'claude-synthetic',
            usage: {
              input_tokens: 80,
              output_tokens: 20,
              cache_read_input_tokens: 10,
            },
            content: [
              { type: 'thinking', thinking: 'Check the indexes' },
              { type: 'text', text: 'Use a nebula index.' },
            ],
          },
        },
        {
          type: 'assistant',
          sessionId: 'claude-main',
          timestamp: time,
          message: {
            id: 'claude-message-1',
            model: 'claude-synthetic',
            usage: {
              input_tokens: 80,
              output_tokens: 20,
              cache_read_input_tokens: 10,
            },
            content: [
              {
                type: 'tool_use',
                id: 'claude-tool',
                name: 'Read',
                input: { file: 'fixture.txt' },
              },
            ],
          },
        },
        {
          type: 'user',
          sessionId: 'claude-main',
          timestamp: time,
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'claude-tool',
                content: [{ type: 'text', text: 'Fixture text' }],
              },
            ],
          },
        },
      ];
      jsonl(join(base, '.claude/projects/synthetic/claude-main.jsonl'), claudeRecords);
      jsonl(join(base, '.claude/projects/synthetic/claude-main/subagents/agent-review.jsonl'), [
        {
          type: 'user',
          sessionId: 'claude-main',
          agentId: 'review',
          timestamp: time,
          message: { content: 'Review the star catalog' },
        },
      ]);
      if (!n)
        jsonl(join(base, '.claude/projects/synthetic/pruned.jsonl'), [
          {
            type: 'user',
            sessionId: 'claude-pruned',
            timestamp: time,
            message: { content: 'Keep this pruned session searchable' },
          },
        ]);
      const oc = database(
        join(base, '.local/share/opencode/opencode.db'),
        `
        CREATE TABLE session(id TEXT PRIMARY KEY,title TEXT,directory TEXT,parent_id TEXT,time_created INTEGER,time_updated INTEGER);
        CREATE TABLE message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,data TEXT);
        CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,session_id TEXT,time_created INTEGER,data TEXT);`
      );
      oc.query('INSERT INTO session VALUES(?,?,?,?,?,?)').run(
        'oc-main',
        'Compare galaxy caches',
        `${home}/projects/expo`,
        null,
        ts,
        ts
      );
      oc.query('INSERT INTO message VALUES(?,?,?,?)').run(
        'oc-message',
        'oc-main',
        ts,
        JSON.stringify({
          role: 'assistant',
          modelID: 'open-synthetic',
          providerID: 'fixture',
          tokens: { input: 30, output: 20, cache: { read: 5 } },
        })
      );
      oc.query('INSERT INTO part VALUES(?,?,?,?,?)').run(
        'oc-text',
        'oc-message',
        'oc-main',
        ts,
        JSON.stringify({
          type: 'text',
          text: 'A galaxy cache needs an index.',
        })
      );
      oc.query('INSERT INTO part VALUES(?,?,?,?,?)').run(
        'oc-tool',
        'oc-message',
        'oc-main',
        ts + 1,
        JSON.stringify({
          type: 'tool',
          tool: 'bash',
          callID: 'oc-call',
          state: { input: { command: 'echo synthetic' }, output: 'synthetic' },
        })
      );
      oc.close();
      const t3 = database(
        join(base, '.t3/userdata/state.sqlite'),
        `
        CREATE TABLE projection_threads(thread_id TEXT PRIMARY KEY,title TEXT,worktree_path TEXT,branch TEXT,model_selection_json TEXT,created_at TEXT,updated_at TEXT,deleted_at TEXT);
        CREATE TABLE provider_session_runtime(thread_id TEXT PRIMARY KEY,provider_name TEXT,resume_cursor_json TEXT);
        CREATE TABLE projection_thread_messages(message_id TEXT PRIMARY KEY,thread_id TEXT,role TEXT,text TEXT,created_at TEXT);`
      );
      for (const [id, title] of [
        ['t3-linked', 'Find lunar otters'],
        ['t3-orphan', 'Plan a comet dashboard'],
      ]) {
        t3.query('INSERT INTO projection_threads VALUES(?,?,?,?,?,?,?,NULL)').run(
          id!,
          title!,
          `${home}/projects/dotfiles`,
          'dashboard',
          JSON.stringify({ model: 'gpt-synthetic', instanceId: 'fixture' }),
          time,
          time
        );
        t3.query('INSERT INTO projection_thread_messages VALUES(?,?,?,?,?)').run(
          `${id}-message`,
          id!,
          'user',
          id === 't3-linked' ? 'Duplicated native content' : 'Build a comet dashboard',
          time
        );
      }
      t3.query('INSERT INTO provider_session_runtime VALUES(?,?,?)').run(
        't3-linked',
        'codex',
        JSON.stringify({ threadId: 'codex-main' })
      );
      t3.close();
      symlinkSync(
        '/path-that-must-never-be-read',
        join(base, '.claude/projects/synthetic/ignored.jsonl')
      );
      const copied = files(base),
        sqlite = copied.filter((f) => f.endsWith('.sqlite') || f.endsWith('.db'));
      const sources = [
        '.codex/sessions',
        '.codex/archived_sessions',
        '.codex/history.jsonl',
        '.claude/projects',
        '.claude/sessions',
        '.claude/file-history',
        '.claude/paste-cache',
        '.claude/plans',
        '.claude/history.jsonl',
        '.local/share/opencode/storage',
        '.local/share/opencode/snapshot',
        '.local/share/opencode/tool-output',
        '.local/share/opencode/opencode.db',
        '.t3/userdata/attachments',
        '.t3/userdata/browser-artifacts',
        '.t3/userdata/screenshots',
        '.t3/userdata/state.sqlite',
        '.codex/state_5.sqlite',
      ];
      const manifest = {
        started_at: snapshotTs,
        completed_at: snapshotTs,
        source_home: home,
        sources: sources.map((path) => {
          if (!existsSync(join(base, path))) return { path, status: 'missing' };
          const selected = copied.filter(
            (f) => f === join(base, path) || f.startsWith(join(base, path) + '/')
          );
          return {
            path,
            status: 'collected',
            files: selected.length,
            bytes: selected.reduce((sum, f) => sum + statSync(f).size, 0),
            symlinks: path === '.claude/projects' ? 1 : 0,
          };
        }),
        files: copied.length,
        bytes: copied.reduce((sum, f) => sum + statSync(f).size, 0),
        symlinks: 1,
        sqlite_checks: sqlite.map((f) => ({
          source: f.slice(base.length + 1),
          integrity_check: 'ok',
          removed: [],
        })),
        excluded_paths: [],
        referenced_files: [],
        policy: {
          included_sources: sources,
          excluded: [
            'Native auth/settings/config stores outside the source allowlist',
            '.codex/shell_snapshots',
            'Native database WAL, SHM, and journal sidecars',
          ],
          emptied_sqlite_tables: {
            codex: ['remote_control_enrollments'],
            opencode: [
              'account',
              'account_state',
              'control_account',
              'credential',
              'session_share',
            ],
            t3: ['auth_sessions', 'auth_pairing_links'],
            claude: [],
          },
          cleared_sqlite_columns: ['opencode.session.share_url'],
          limitations: [
            'Run text, tool output, attachments, and checkpoint blobs may contain secrets.',
            'Symlink targets and arbitrary project directories are not collected. Explicit file attachments are copied individually.',
            'Files and databases have individual consistency checks, not one shared point in time.',
          ],
        },
      };
      // Completion marker is always written last.
      write(join(base, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    }
    jsonl(join(root, host, '2026-10-02T120000Z/.codex/sessions/unfinished.jsonl'), [
      { type: 'session_meta', payload: { id: 'incomplete' } },
    ]);
    symlinkSync(second, join(root, host, 'latest'));
  }
  const now = Date.now(),
    stamp = (minutes: number) => new Date(now - minutes * 60000).toISOString();
  const auth = (name: string, provider: string) => ({
    name: `${name}.json`,
    auth_index: name,
    provider,
    type: provider,
    status: 'active',
    status_message: '',
    disabled: false,
    unavailable: false,
    cooldowns: [],
    quota: { observed_at: stamp(1), signals: { remaining: '80%' } },
    last_refresh: stamp(30),
  });
  const initial = [
    auth('codex-primary', 'codex'),
    auth('codex-secondary', 'codex'),
    auth('claude-primary', 'claude'),
  ];
  const final = initial.map((a, i) =>
    i === 1
      ? {
          ...a,
          status: 'error',
          unavailable: true,
          status_message: 'quota',
          next_retry_after: new Date(now + 600000).toISOString(),
          cooldowns: [
            {
              scope: 'model',
              model_key: 'gpt-synthetic',
              reason: 'quota',
              retry_at: new Date(now + 600000).toISOString(),
              remaining_seconds: 600,
              http_status: 429,
            },
          ],
          quota: { observed_at: stamp(1), signals: { remaining: '0%' } },
        }
      : a
  );
  const usage = Array.from({ length: 36 }, (_, i) => {
    const provider = i % 3 ? 'codex' : 'claude',
      failed = i % 8 === 0;
    return {
      timestamp: stamp(40 - i),
      provider,
      model: provider === 'codex' ? 'gpt-synthetic' : 'claude-synthetic',
      auth_index:
        provider === 'codex' ? (i % 2 ? 'codex-primary' : 'codex-secondary') : 'claude-primary',
      request_id: `synthetic-request-${i}`,
      session_id: 'codex-main',
      endpoint: i % 2 ? 'GET /v1/responses' : 'POST /v1/messages',
      executor_type: i % 2 ? 'CodexWebsocketsExecutor' : 'ClaudeExecutor',
      latency_ms: 250 + i * 90,
      ttft_ms: i % 5 ? 30 + i * 10 : 0,
      failed,
      fail: {
        status_code: failed ? 429 : 200,
        body: failed ? '{"error":{"code":"rate_limit","message":"quota exhausted"}}' : '',
      },
      tokens: { input_tokens: 80, output_tokens: 20, total_tokens: 100 },
      token_breakdown: {
        schema_version: 2,
        quality: 'complete',
        total_tokens: 100,
        input: {
          total_tokens: 80,
          uncached_tokens: 60,
          cache_read_tokens: 20,
          cache_write_tokens: 0,
        },
        output: {
          total_tokens: 20,
          non_reasoning_tokens: 15,
          reasoning_tokens: 5,
        },
        unclassified_tokens: 0,
      },
    };
  });
  // One failed attempt is followed by a successful attempt for the same request.
  usage.push({
    ...usage[8]!,
    timestamp: new Date(
      Date.parse(usage[8]!.timestamp) + usage[8]!.latency_ms + 1000
    ).toISOString(),
    auth_index: 'codex-primary',
    failed: false,
    fail: { status_code: 200, body: '' },
  });
  const errors = [
    {
      status_code: 401,
      code: 'invalid_grant',
      body: 'Credential refresh rejected',
    },
    {
      status_code: 429,
      code: 'rate_limit',
      body: 'Credential quota exhausted',
    },
    {
      status_code: 502,
      code: 'upstream_error',
      body: 'Provider temporarily unavailable',
    },
    {
      status_code: 500,
      code: 'transient_transport',
      body: 'Connection closed',
    },
  ].flatMap((error, i) =>
    Array.from({ length: i + 1 }, (_, n) => ({
      ...error,
      timestamp: stamp(10 - n),
      provider: 'codex',
      model: 'gpt-synthetic',
      auth_index: 'codex-secondary',
      retryable: true,
      auth_status: {
        status: 'error',
        unavailable: true,
        disabled: false,
        status_message: error.code,
      },
    }))
  );
  write(
    join(root, '.dashboard-friction.md'),
    `\n## ${stamp(20)}\n\n### Expected\n\n    A synthetic formatter is available\n\n### Actual\n\n    Formatter was missing at /tmp/synthetic-a\n\n### fleet doctor --agent --json\n\n    {"synthetic_doctor_blob":true}\n\n## ${stamp(15)}\n\n### Expected\n\n    A synthetic formatter is available\n\n### Actual\n\n    Formatter was missing at /tmp/synthetic-b\n\n## ${stamp(8)}\n\n### Expected\n\n    synthetic: bash completes successfully\n\n### Actual\n\n    Automatic observation: exit-9; event ${'a'.repeat(64)}. Tool input and output omitted.\n\n## ${stamp(5)}\n\n### Expected\n\n    synthetic: bash completes successfully\n\n### Actual\n\n    Automatic observation: exit-9; event ${'b'.repeat(64)}. Tool input and output omitted.\n`
  );
  write(
    join(root, '.dashboard-fixtures.json'),
    JSON.stringify(
      {
        usage,
        errors,
        authResponses: [
          { observed_at: stamp(25), files: initial },
          { observed_at: stamp(1), files: final },
        ],
        friction: '.dashboard-friction.md',
      },
      null,
      2
    )
  );
  return root;
}
if (import.meta.main) console.log(`Synthetic archive: ${generate('./fixtures/archive')}`);
