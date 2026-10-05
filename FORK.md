# ai-pool fork

This fork combines [CLI Proxy API Management Center](https://github.com/router-for-me/Cli-Proxy-API-Management-Center) with session history and telemetry from [cpa-dashboard](https://github.com/mchisolm0/cpa-dashboard). It manages [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) v8 and adds:

- Search across archived Codex, Claude Code, OpenCode and T3 Code sessions. Filters, day groups, matching excerpts, tool inputs/outputs, and native raw records.
- Provider and credential health from passive usage/error telemetry and credential polling.
- Ranked problems by auth, quota, upstream, transport, client, or other causes. Sanitized examples, suggested fixes, inferred retry outcomes, and links to indexed sessions.
- A Bun history server and a non-root Docker image serving the single-file management UI.

The history server does not proxy model or management traffic. Shell and route integration are separate frontend work; the page exports are `SessionsPage` and `ProblemsPage`. Session links use the existing hash router, for example `/#/sessions?id=1`.

## Run locally

Use Bun 1.3.14:

```sh
bun install --frozen-lockfile
bun run build
bun run server:fixtures
bun run server:index
bun run server:start
```

Open `http://127.0.0.1:3000/`. Fixtures are marked synthetic and generate no external requests. Leave `CPA_RESP_ADDR` and `CPA_BASE_URL` unset for fixture-only use. Fixture generation writes `./fixtures/archive`; the index defaults to `./data/index.sqlite`. Do not generate fixtures over a real archive. Use a fresh index when resetting synthetic telemetry history.

For an existing archive:

```sh
ARCHIVE_ROOT=/path/to/archive INDEX_PATH=/path/to/index.sqlite bun run server:index
ARCHIVE_ROOT=/path/to/archive INDEX_PATH=/path/to/index.sqlite bun run server:start
```

The server handles `/`, `/api/*`, and `/healthz`. Configure a reverse proxy to send exactly those paths to port 3000 and all other paths to CLIProxyAPI, including `/v8/management/*`, `/v1/*`, and WebSocket upgrades. Hash routes need no HTTP route fallback. The UI build is only `dist/index.html`; no asset routes are required. `bun run dev` runs the management frontend alone; API routing for history during development must come from your local reverse proxy.

History APIs have no built-in authentication. CPAMC's management login does not protect transcripts or `/api/*`. Use loopback or an authenticated private gateway. Indexed bodies, session titles, T3 link titles, cached Codex thread metadata, and raw responses replace known management/client keys of at least 12 characters with `[redacted]`. Exact matches never replace text inside that marker. Client keys come from `access.api-keys` in `GET /v8/management/config`, stay in memory, and refresh on the 60-second auth-poll cadence. The parent passes its current cached client keys to each indexing child through stdin. Indexing children and standalone `server:index` never make management requests. Standalone indexing uses the management key file and pattern rules; it has no poller cache unless keys are supplied as a JSON string array on stdin with `CPA_INDEX_KEYS_STDIN=1`. Raw requests reload the management key file and use the poller's cached client keys. Config read failures retain the last successful keys. Refresh failures create one `redaction_keys_refresh_failed` problem per failure episode, reset by a successful refresh. Unavailable keys leave pattern redaction active. An unreadable management key file creates one `redaction_key_unavailable` problem while indexing continues.

Pattern redaction covers Authorization Bearer/Basic and `x-api-key`, `X-Goog-Api-Key`, and `X-Management-Key` headers with one or more key characters; standalone Bearer tokens of at least 20 characters; and Cookie/Set-Cookie header values through the end of the line, or through the closing quote in JSON. It covers `sk-`/`sk-ant-` keys with at least 20 suffix characters, `ghp_` tokens with at least 36, and `github_pat_` tokens with at least 22. Those standalone key/token patterns leave paths and identifiers alone when preceded by `/` or a word character. URL passwords in `scheme://user:password@host` are redacted. Assignment names include `key`, `token`, `secret`, `password`, `apiKey`/`api_key`/`api-key`, `client_secret`/`client-secret`, and `PGPASSWORD`. Underscore/hyphen prefixes cover env names and OAuth `access_token`/`refresh_token`/`id_token`. Forms include env, YAML, JSON, escaped JSON quotes, and query strings. Explicit credential assignments redact nonempty quoted or unquoted values; quotes never span newlines. Bare `key`/`token` assignments and raw fields require at least 12 characters from the key character set plus a digit or `_+./~%=`, or at least 20 characters with both upper- and lowercase letters. Function-call values and ordinary values such as `"key":"Enter"` remain intact. YAML `api-keys:` scalar lists are also redacted.

Redaction uses forward scans with a 25 ms budget per text body and a maximum input length of 1,048,576 UTF-16 code units. Exceeding either limit replaces the whole body with `[redacted]`. Within those limits it preserves formatting and integer literals, and leaves ordinary prose such as "a Bearer token" alone. Raw location exemptions apply only to string values of known pointer/path, cwd, repo, and branch fields. Objects under `file` or `pointer` are traversed, including Claude Read results at `toolUseResult.file.content`. These rules are heuristics, not a guarantee for every credential format. Native archives remain untouched and can still contain secrets. Telemetry examples also strip credential fields, usage `source`, and response headers.

The `r3:` parser-cache signature forces older snapshots and caches to miss once on reindex. After the first successful full run for this version, superseded cache rows are deleted once; a failed run leaves that cleanup pending. Only newly parsed files are inserted into the cache. Later unchanged snapshots are skipped, so newly learned or rotated exact-match keys do not rewrite existing indexed bodies or titles. Build a fresh `INDEX_PATH` when those must be fully reindexed; this also resets event history. Raw records use current redaction rules whenever served. `/api` responses use `Cache-Control: no-store`; the single-file UI uses `no-cache`.

The first management config write migrates `config.yaml` to v8 format, which earlier backend versions cannot read. Palette inline edits are restricted to an explicit allowlist and labeled as v8 config saves. Lockout-critical settings open the config editor. Pool toggles require confirmation; config toggles disclose the migration. Runtime-only AI Studio websocket credentials open their provider workspace instead of using credential status toggles. Unchanged palette values cannot be saved. Quota refreshes bypass the mutation queue. Intentionally disabled accounts do not generate attention warnings. Per-account re-login requires signing in with the same account; choosing another account adds a credential, as stated before sign-in.

An explicit `ARCHIVE_ROOT` takes precedence over the stored root. If it conflicts with an existing index, startup fails with an instruction to use a new index path, rather than serving pointers from another archive.

## Docker

```sh
docker build -t ai-pool .
docker run --rm -p 127.0.0.1:3000:3000 \
  -v /path/to/archive:/archive:ro \
  -v ai-pool-index:/index \
  ai-pool
```

The runtime uses UID/GID 1000, `BIND_HOST=0.0.0.0`, and `PORT=3000`. Mount the archive read-only and give UID 1000 write access to the index volume. `/healthz` is a liveness check, with a 30-second start period. A Docker `PORT` override also changes the healthcheck URL; publish the corresponding container port.

To collect telemetry, set `CPA_RESP_ADDR` to CLIProxyAPI's RESP-capable listener, `CPA_BASE_URL` to its HTTP origin, and mount a readable management key file at `CPA_MANAGEMENT_KEY_FILE`. These are opt-in. Keep archive, key, and friction mounts read-only. In the backend v8 configuration, enable `observability.usage.usage-statistics-enabled`; configure `management.secret-key` and `management.allow-remote` when needed. Queue retention is `observability.usage.redis-usage-queue-retention-seconds`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `ARCHIVE_ROOT` | `./fixtures/archive`, Docker `/archive` | Read-only native snapshots |
| `INDEX_PATH` | `./data/index.sqlite`, Docker `/index/index.sqlite` | Writable SQLite index and event history |
| `BIND_HOST` | `127.0.0.1`, Docker `0.0.0.0` | Listener address |
| `PORT` | `3000` | Listener port |
| `CPA_RESP_ADDR` | unset | Telemetry `host:port` or `[IPv6]:port` |
| `CPA_BASE_URL` | unset | CLIProxyAPI HTTP origin for credential polling |
| `CPA_MANAGEMENT_KEY_FILE` | unset | Trimmed key file, re-read on polls and reconnects |
| `CPA_MANAGEMENT_KEY` | unset | Key fallback only when no file is configured |
| `INDEX_INTERVAL_MINUTES` | unset | Positive incremental indexing interval |
| `FRICTION_PATHS` | unset | Colon-separated Markdown files/directories |
| `CPA_RETRY_WINDOW_SECONDS` | `35` | Positive retry-correlation window |

Snapshots use `<host>/<UTC timestamp>/manifest.json`, written after collection. Native stores and read-only SQLite backup requirements are described in [server/README.md](server/README.md). SQLite stores eight days of event history; deleting the index also deletes that history. RESP subscribers have no replay, so disconnected telemetry is lost. Retry outcomes remain inference from attempts, including in v8.

## Local backend comparison: v7.3.9 to v8.0.15

The comparison used `/tmp/cpa-src` and `/tmp/cpa-v8`, with no running backend:

| Contract | Difference and handling |
| --- | --- |
| Credential route | v8 adds `GET /v8/management/credentials`, using the same `ListAuthFiles` handler as retained `/v0/management/auth-files`. Polling now uses the v8 route only. |
| Credential response | No field or type changes in `auth_files.go` or `cooldown_view.go`, apart from Go module import versions. Identity/status, refresh/retry dates, nullable cooldowns, and passive quota readings retain their wire shapes. |
| RESP | Queue implementation is identical. Protocol changes only Go import versions. AUTH, single-channel SUBSCRIBE, PING, refresh messages, and no replay are unchanged. |
| Error records | Only Go imports changed. Fields/types, absent request/session IDs, and attempt-based semantics are unchanged. |
| Usage identities | Adds optional `execution_id` and `trace_id`. `request_id` retains its inbound logging ID; `execution_id` is the reporter's per-execution UUID, or a generated UUID. `trace_id` is the parent inbound ID, falling back to `request_id`. Retry correlation uses `trace_id` when present, then `request_id`; it never uses `execution_id`. |
| Usage metadata | Adds `resolved_client_ip`, optional `node_kind`, `is_fork`, and `is_compaction`. These are preserved in sanitized payloads without affecting aggregation. Existing timestamp, latency, TTFT, failure, token, transport, session, and parent-session fields retain their types. |
| Usage reporter | Adds reporter execution/trace IDs and generates a separate execution ID for additional-model records. These still represent attempts, not definitive client completions. |
| Management authentication | Bearer and X-Management-Key, RESP AUTH, remote-access checks, five-failure budget, and 30-minute bans are unchanged. Handler config persistence gains a v8-context flag, unrelated to polling. |
| Auth-state behavior | `conductor_cooldown.go` now preserves terminal unauthorized state through model success/failure, reset, and availability updates; retry/refresh times remain cleared until tokens change. It honors positive Retry-After for model-support/404 cooldowns. Credential-scoped 429 backoff uses credential state, separates credential/model deadlines, and stores the credential backoff level. Existing fields carry these changes; parsing needs no new fields. |
| Auth-state internals | Per-credential mutation locks and `persistLocked` serialize state updates; result handling also updates session affinity after error publication. New disabled-invalid-grant detection is exported. Terminal unauthorized detection now also requires an empty retry deadline. These do not change JSON schemas. |
| Statusless OAuth errors | Invalid-grant detection now accepts absent HTTP status in addition to 400/401. Error publication can then report fallback status 500. Classification treats an explicit `invalid_grant` signal as auth, including OAuth 400, rather than client/upstream. |
| Configuration | `remote-management` moves to `management`. Usage-statistics and queue-retention settings move under `observability.usage`. Environment names for this history server remain unchanged. |

Source files compared: `internal/redisqueue/{plugin,queue,usage_toggle}.go`, `internal/api/{redis_queue_protocol,server_management,server_management_v8}.go`, `sdk/cliproxy/auth/{error_events,cooldown_view,conductor_cooldown}.go`, `internal/api/handlers/management/{auth_files,handler}.go`, and `internal/runtime/executor/helps/usage_helpers.go`.

## Shared history contract

`server/api.ts` stays dependency-free. `historyApi` and its exports retain their names. `SearchResponse` gains optional `snippets`, plain-text excerpts keyed by session ID. All other contract fixes happen in server output: empty failure rates and unobserved timestamps are `0`; missing cooldowns become `[]` at the HTTP boundary; absent quota observations are `null`; quota signals are string-valued; problem session links contain full `SessionSummary` records. Internal auth state still retains nullable cooldowns to distinguish unknown scheduler state.

## Checks

```sh
bun run type-check
bun run server:type-check
bun run server:test
bun run lint
bun run build
bun run verify
```

`bun test` runs both upstream and server tests, plus focused transcript tests. `verify` checks server types before running that full suite, lint, and the UI build; server tests are never silently excluded. The current known upstream failure is `provider model options > gates fields by provider capability`.

Upstream CPAMC and CLIProxyAPI remain credited in their original README and licenses. This fork preserves the upstream single-file build and hash routing. The history implementation is adapted from Matthew Chisolm's cpa-dashboard.
