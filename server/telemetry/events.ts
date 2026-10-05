import type { Database } from 'bun:sqlite';
import { json, object, string, number, timestamp } from '../model';

export type ErrorClass = 'auth' | 'quota' | 'upstream' | 'transport' | 'client' | 'other';
export function transport(event: Record<string, unknown>): 'websocket' | 'http' | 'unknown' {
  if (
    /^GET\s+\/v1\/responses(?:\?|$)/i.test(string(event.endpoint)) ||
    string(event.executor_type) === 'CodexWebsocketsExecutor'
  )
    return 'websocket';
  return string(event.endpoint) ? 'http' : 'unknown';
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
  if (code === 'connection_lifecycle') {
    if (body.includes('context canceled')) return 'client';
    return body.includes('context deadline exceeded') ? 'upstream' : 'transport';
  }
  if (code === 'transient_transport') return 'transport';
  if (['request_scoped', 'model_not_found', 'model_not_supported', 'not_found'].includes(code))
    return 'client';
  if (code === 'transient_error') return 'upstream';
  // v8 recognizes invalid_grant even without an HTTP status. Error events then
  // use 500 as their fallback status, but the credential still needs re-authentication.
  if (code === 'invalid_grant' || /\binvalid_grant\b/.test(body)) return 'auth';
  const hint = `${code} ${body}`;
  if (status === 401) return 'auth';
  if (status === 402 || status === 429) return 'quota';
  if (status === 403) {
    const model = object(object(event.auth_status).model);
    if (
      (object(model.quota).exceeded === true &&
        string(model.name) !== '' &&
        model.name === event.model) ||
      /quota|rate_limit|payment_required/.test(hint)
    )
      return 'quota';
    return /cloudflare/.test(hint) ? 'upstream' : 'auth';
  }
  if (status >= 500 || status === 408) return 'upstream';
  if (status >= 400 && status < 500) return 'client';
  if (body.includes('context deadline exceeded')) return 'upstream';
  if (/unauthorized|invalid_grant|invalid_api_key|authentication|credential_revoked/.test(hint))
    return 'auth';
  if (/quota|rate_limit|payment_required/.test(hint)) return 'quota';
  if (/websocket|connection|transport|broken_pipe|eof|tls|network|timeout/.test(hint))
    return 'transport';
  if (/request_scoped|invalid_request|context_length|model_not_found|client/.test(code))
    return 'client';
  if (/upstream|cloudflare/.test(hint)) return 'upstream';
  if (/invalid_request|context_length|model_not_found|client/.test(hint)) return 'client';
  return 'other';
}
/** Replace secrets in place: JSON formatting and large integer literals remain intact. */
export function redactText(value: string, secrets: string[] = []): string {
  let text = value;
  for (const secret of secrets) if (secret) text = text.replaceAll(secret, '[redacted]');
  return text
    .replace(
      /(\bAuthorization(?:\\?["'])?[ \t]*:[ \t]*(?:\\?["'])?(?:Bearer|Basic)[ \t]+)[a-z0-9_+./~=-]{8,}/gi,
      '$1[redacted]'
    )
    .replace(/\bBearer[ \t]+[a-z0-9_+./~=-]{20,}/gi, 'Bearer [redacted]')
    .replace(
      /(\b(?:x-api-key|x-goog-api-key|x-management-key)(?:\\?["'])?[ \t]*:[ \t]*(?:\\?["'])?)[a-z0-9_+./~=-]{8,}/gi,
      '$1[redacted]'
    )
    .replace(/\bsk-(?:ant-[a-z0-9_-]{20,}|(?!ant-)[a-z0-9_-]{20,})/gi, '[redacted]')
    .replace(
      /(\b(?:\w+[_-])*(?:key|token|secret|password|api[-_]?key|client[_-]?secret)(?:\\?["'])?[ \t]*[:=][ \t]*)(\\"|\\'|"|')(?:(?!\2)(?:\\\\\\.|\\.|[^\\]))*?\2/gi,
      '$1$2[redacted]$2'
    )
    .replace(
      /(\b(?:\w+[_-])*(?:key|token|secret|password|api[-_]?key|client[_-]?secret)(?:\\?["'])?[ \t]*[:=][ \t]*)[a-z0-9_+./~%-]{8,}={0,2}/gi,
      '$1[redacted]'
    )
    .replace(/\bapi-keys:[ \t]*(?:\r?\n[ \t]+-[^\r\n]*)+/gi, (list) =>
      list.replace(/^([ \t]*-[ \t]+)(?:"[^"]*"|'[^']*'|[^\s#]+)/gm, '$1[redacted]')
    )
    .replace(
      /(\bapi-keys:[ \t]*\[)((?:"[^"]*"|'[^']*'|[^\]\r\n])*)(\])/gi,
      (_match, start: string, list: string, end: string) =>
        start + list.replace(/"[^"]*"|'[^']*'|[^\s,]+/g, '"[redacted]"') + end
    );
}

export function sanitize(value: unknown, secrets: string[] = [], preserveKeys = false): unknown {
  if (Array.isArray(value)) return value.map((v) => sanitize(v, secrets, preserveKeys));
  if (typeof value === 'string') return redactText(value, secrets);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(object(value)).flatMap(([key, v]) => {
      // Native locations and pointers must still resolve, even when they resemble keys.
      if (
        preserveKeys &&
        /^(pointer|file|path|cwd|repo|branch|git_branch|gitBranch|git|directory|worktree_path|repository_url)$/i.test(
          key
        )
      )
        return [[key, v]];
      if (
        /^(key|token|api[-_]?keys?|user_api_key|client[_-]?secret|authorization|x-api-key|x-goog-api-key|x-management-key|management_key|access_token|refresh_token|id_token|password|secret|cookie|set-cookie)$/i.test(
          key
        )
      )
        return preserveKeys ? [[key, '[redacted]']] : [];
      return [[key, sanitize(v, secrets, preserveKeys)]];
    })
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
  channel: 'usage' | 'errors',
  payload: string,
  received = Date.now(),
  secrets: string[] = []
) {
  const event = object(sanitize(json(payload), secrets));
  // CPA's usage source can be the raw upstream API key.
  if (channel === 'usage') {
    delete event.source;
    delete event.response_headers;
  }
  if (channel === 'usage' && (event.support_refresh === true || event.refresh === true)) return;
  const time = timestamp(event.timestamp);
  if (!time) throw new Error('Telemetry requires a valid timestamp');
  const common = [
    received,
    time,
    string(event.provider),
    string(event.model),
    string(event.auth_index),
    transport(event),
  ] as const;
  const safe = JSON.stringify(sanitize(event));
  if (channel === 'usage')
    db.query(
      'INSERT INTO usage_event(received,time,provider,model,authIndex,transport,payload) VALUES(?,?,?,?,?,?,?)'
    ).run(...common, safe);
  else
    db.query(
      'INSERT INTO error_event(received,time,provider,model,authIndex,transport,category,status,code,cooldownReason,payload) VALUES(?,?,?,?,?,?,?,?,?,?,?)'
    ).run(
      ...common,
      classify(event),
      number(event.status_code),
      string(event.code),
      cooldownReason(event),
      safe
    );
}
