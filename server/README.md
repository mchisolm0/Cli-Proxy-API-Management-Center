# History server

A dashboard for [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI): search archived Codex, Claude Code, OpenCode and T3 Code sessions, see provider and credential health, and rank problems by cause (auth, quota, upstream, transport).

It runs beside an unmodified CLIProxyAPI and reads its usage and error pub/sub streams and `/v8/management/credentials`. It does not proxy model traffic. Session history comes from an archive of native client records, not from the gateway, so it includes tool calls and sessions that never touched the proxy.

## Credits

Built for and against [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI), whose payload contracts it follows (see How it works). The management panel shipped with it, [Cli-Proxy-API-Management-Center](https://github.com/router-for-me/Cli-Proxy-API-Management-Center), was the starting point for deciding what a dashboard should show. This server was copied from [mchisolm0/cpa-dashboard](https://github.com/mchisolm0/cpa-dashboard) and integrated into the CPAMC fork. Deployment and the v8 contract comparison are documented in [FORK.md](../FORK.md).

## Quick start

```sh
bun install --frozen-lockfile
bun run build
bun run server:fixtures   # synthetic archive, telemetry and friction
bun run server:index
bun run server:start
```

Open http://127.0.0.1:3000. The server serves the fork's single-file `dist/index.html`. In Sessions, `/` searches, `j`/`k` select, Enter opens, and Esc closes. Quote phrases in search. Times use UTC. Frontend route wiring belongs to the shell integration.

## Deploy

Route exactly `/`, `/api/*`, and `/healthz` to this server. Route everything else to CLIProxyAPI unchanged, including management requests and `/v1` WebSockets. Other paths return 404 here. No external UI assets are required. The dashboard has no login, and transcripts can contain secrets. Keep it on a private network or behind authentication.

Telemetry needs `observability.usage.usage-statistics-enabled: true` and `management.secret-key` in the v8 proxy config. Remote connections may need `management.allow-remote: true`. Queue retention is `observability.usage.redis-usage-queue-retention-seconds`; subscribers have no replay.

## Archive layout

`ARCHIVE_ROOT` holds read-only snapshots at `<host>/<UTC timestamp>/`, each a copy of the native client stores relative to that machine's home directory:

- `.codex/sessions/**/*.jsonl`, `.codex/state_*.sqlite`
- `.claude/projects/**/*.jsonl`
- `.local/share/opencode/opencode.db`
- `.t3/userdata/state.sqlite`

Each snapshot needs a `manifest.json` written last, with `completed_at` (ISO time) and `sources` (`[{ "path", "status": "collected" | "missing" }]`). Copy SQLite databases with the online backup API rather than copying live files. Snapshots without a manifest are skipped. `bun run server:fixtures` generates a complete example.

## Configuration

| Variable                  | Default               | Purpose                                                        |
| ------------------------- | --------------------- | -------------------------------------------------------------- |
| `ARCHIVE_ROOT`            | `./fixtures/archive`  | Read-only `<host>/<timestamp>/` collector snapshots            |
| `INDEX_PATH`              | `./data/index.sqlite` | Writable index and event history                               |
| `BIND_HOST`               | `127.0.0.1`           | HTTP listener                                                  |
| `PORT`                    | `3000`                | HTTP port                                                      |
| `CPA_RESP_ADDR`           | unset                 | Opt-in telemetry, `host:port` or `[IPv6]:port`                 |
| `CPA_RETRY_WINDOW_SECONDS` | `35`                 | Positive retry-correlation window after an attempt ends        |
| `CPA_BASE_URL`            | unset                 | Auth-files polling every 60s when a key is configured          |
| `CPA_MANAGEMENT_KEY_FILE` | unset                 | Preferred key source, trimmed and readable by the service user |
| `CPA_MANAGEMENT_KEY`      | unset                 | Key fallback when no file is configured                        |
| `FRICTION_PATHS`          | unset                 | Colon-separated Markdown files/directories, read every 60s     |
| `INDEX_INTERVAL_MINUTES`  | unset                 | Positive incremental indexing interval; off by default         |

Key-file errors never fall back to the environment key. Key files are re-read on every auth poll and telemetry connection. Keys are never logged or stored. Auth polls send `Authorization: Bearer`, reject redirects, time out after 15s, and turn failures into dashboard problems. Management AUTH rejections pause telemetry and auth polling for at least ten minutes; repeated rejections create one problem until authentication recovers. Last successful states remain visible with observation times. Missing credentials become `removed`; null cooldowns mean unknown scheduler state. Quota readings, refresh times and retry deadlines update current state without creating transitions. Quota observations are passive signals, separate from scheduler cooldowns.

## How it works

Health shows provider totals and credential rows: auth state, quota, retry/refresh/observation times, upstream requests, failure rate, p50/p95 latency and TTFT, tokens, transport split, and error classes. Windows are `1h`, `24h`, `7d`, default `24h`. Requests count usage records, including retries and additional-model usage. Percentiles use nearest rank; zero TTFT is excluded. Tokens prefer the v2 canonical total. Error-channel and failed-usage counts stay separate because they cannot reliably be deduplicated.

Problems groups by source/provider/model/class/code, ranked by count then recency. Selecting a row shows five sanitized examples, a suggested fix, and up to 20 matching indexed sessions. Session totals deduplicate indexed native/T3 aliases and include unmatched raw IDs; details show `N + M unindexed`, and capped indexed lists show `+N more`. Auth problems count newly introduced issues in transitions. Friction groups normalized expected/actual text; event hashes and varying paths do not split groups. Doctor blobs and historical-import metadata are omitted. Re-reading files does not duplicate entries.

CPA v7.3.9 and v8.0.15 emit upstream attempts, not definitive client-completion records. Websocket turns share a `request_id`. v8 also adds `trace_id` and per-attempt `execution_id`. Correlation prefers `trace_id`, falling back to `request_id`, and never groups by `execution_id`. A later attempt with that correlation ID counts as a retry only when it starts within 35 seconds after the failed attempt ends, using `timestamp + latency_ms`. Set `CPA_RETRY_WINDOW_SECONDS` to match longer proxy backoffs; startup rejects values that are not finite and positive. An unmatched failed usage record becomes an **inferred final** after `max(60s, retry window + 5s)` from receipt. Missing IDs, tied timestamps, and recent attempts stay unresolved. Later retries can revise this inference. Error records have no request/session IDs and remain uncorrelated attempts; `retryable` does not prove a retry or a final failure. Classification uses the event's code, HTTP status and body; credential quota cannot classify an attempt. Same-model quota can clarify 403 responses.

CPA source contracts:

- `internal/redisqueue/plugin.go`: usage identity, `failed`, `fail.status_code/body`, `latency_ms`, `ttft_ms`, tokens, `endpoint`, `executor_type`.
- `internal/runtime/executor/helps/usage_helpers.go`: per-attempt reporting, TTFT fallback, and usage `source` may contain an API key, so the dashboard drops it.
- `sdk/cliproxy/auth/error_events.go` and `conductor_cooldown.go`: errors and auth/model retry state, published after state updates.
- `internal/api/handlers/management/auth_files.go` and `sdk/cliproxy/auth/cooldown_view.go`: identity/status, quota observations, cooldown scopes/models/reasons/deadlines, and last refresh.
- `internal/api/handlers/management/handler.go`: Bearer authentication; remote access requires `allow-remote-management`.
- `internal/api/redis_queue_protocol.go` and `internal/redisqueue/queue.go`: pub/sub framing, refresh control messages, no replay.

Telemetry uses separate SUBSCRIBE connections with reconnect backoff and heartbeats, drops usage `source` and `response_headers`, strips credential fields recursively, sanitizes JSON error bodies, and redacts the management key. Disconnected events are lost. SQLite lock contention buffers up to 10,000 sanitized records, dropping the oldest with one warning per overflow episode. Write retries back off from 1s to 10s and reset after success. Shutdown attempts one drain before closing SQLite; any remaining records are lost. Event history older than eight days is pruned at startup and hourly; current auth state is retained. Deleting the index deletes event history. Health/Problems aggregate the selected window in memory. The server uses a 250ms SQLite busy timeout; timer failures are caught and retried at the next interval. Initial and periodic indexing run in a child process without overlap, parsing before a short `BEGIN IMMEDIATE` transaction per snapshot. The server starts with an empty index while initial indexing runs. Failed indexing creates an `index_failed` problem without exiting.

Indexing tracks manifest/file identity and reuses unchanged hard-linked files. Sessions update by host/client/native ID; pruned sessions retain their last-seen pointer. T3 metadata overlays linked native sessions. Symlinks are ignored; malformed records leave the snapshot and its cache unchanged. Search bodies cap at 8,192 characters, or 2,048 for tools; raw records resolve byte offsets or immutable SQLite keys.

API: `GET /api/health?window=24h`, `/api/problems?window=24h`, `/healthz`, `/api/search?q=&client=&host=&model=&cwd=&from=&to=&offset=`, `/api/filters`, `/api/sessions/:id`, `/api/items/:id/raw`. Search pages contain up to 100 sessions. `/healthz` checks HTTP liveness. The marked synthetic archive includes telemetry, auth and both friction formats; `start` ingests them once per generation without enabling live subscribers. Use a fresh index when resetting fixture history.

## Development

```sh
bun test
bun run server:type-check
bun run build
docker build -t ai-pool .
docker run --rm -p 127.0.0.1:3000:3000 \
  -v /path/to/archive:/archive:ro -v ai-pool-index:/index ai-pool
```

The image builds the UI and runs as UID/GID 1000. Its healthcheck uses `PORT` with a 30s start period. Mount a root-owned compose secret readable by that user and set `CPA_MANAGEMENT_KEY_FILE=/run/secrets/cpa_management_key`; archive/friction mounts should be read-only. The index volume must be writable by UID 1000. HTTP has no authentication; use loopback or an authenticated private gateway. Fixtures and tests need no live system.
