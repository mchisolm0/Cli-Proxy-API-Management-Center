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
const REDACTED = '[redacted]';
const REDACTION_BUDGET_MS = 25;
const MAX_REDACTION_LENGTH = 1024 * 1024;

// Normalize camelCase once per identifier, then check whole name segments.
function credentialName(name: string): boolean {
  return (
    /(?:^|[_-])(?:key|token|secret|password)(?:[_-]|$)|^api[-_]?keys$|^pgpassword$/i.test(
      name.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    ) ||
    // Acronym or run-together forms the camelCase split cannot separate.
    /(?:^|[_-])(?:api|jwt|auth|access|refresh|session|client)(?:key|token|secret)s?(?:[_-]|$)/i.test(
      name
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1$2')
        .toLowerCase()
        .replace(/(api|jwt)[-_]?/g, '$1')
    )
  );
}

function proseLabel(text: string, start: number): boolean {
  return /(?:^|\s)the $/i.test(text.slice(Math.max(0, start - 5), start));
}

// Generic key/token fields also describe keyboard input and code identifiers.
function looksLikeSecret(value: string): boolean {
  return (
    value.length >= 12 &&
    !/^(?:\/|\.{1,2}\/|[a-z]:\\)/i.test(value) &&
    /^[a-z0-9_+./~%=-]+$/i.test(value) &&
    (/[0-9_+./~%=]/.test(value) ||
      (value.length >= 20 && /[a-z]/.test(value) && /[A-Z]/.test(value)))
  );
}

/** Read one value forwards, including escaped JSON quotes, but never across a newline. */
function assignmentValue(text: string, start: number) {
  const delimiter =
    text[start] === '\\' && /["']/.test(text[start + 1] || '')
      ? text.slice(start, start + 2)
      : /["']/.test(text[start] || '')
        ? text[start]
        : '';
  const from = start + delimiter.length;
  if (!delimiter) {
    const token = /[^\s"'`,;&<>()[\]{}]+/y;
    token.lastIndex = start;
    const match = token.exec(text);
    return {
      from,
      to: token.lastIndex || start,
      end: token.lastIndex || start,
      value: match?.[0] || '',
    };
  }
  let i = from;
  while (i < text.length && text[i] !== '\r' && text[i] !== '\n') {
    if (text[i] === '\\') {
      let end = i;
      while (text[end] === '\\') end++;
      if (text[end] === delimiter.at(-1)) {
        // A JSON-encoded closing quote has 1 mod 4 backslashes; an escaped
        // content quote has 3 mod 4. Plain quotes close after an even count.
        if ((end - i) % (delimiter.length === 2 ? 4 : 2) === (delimiter.length === 2 ? 1 : 0)) {
          const to = end - (delimiter.length - 1);
          return { from, to, end: end + 1, value: text.slice(from, to) };
        }
        i = end + 1;
      } else i = end;
    } else if (delimiter.length === 1 && text[i] === delimiter) {
      return { from, to: i, end: i + 1, value: text.slice(from, i) };
    } else i++;
  }
  return { from, to: i, end: i, value: text.slice(from, i) };
}

/** Full raw strings fail closed when their size or time budget is exceeded. */
export function redactText(value: string, secrets: string[] = []): string {
  return scanText(value, secrets, performance.now() + REDACTION_BUDGET_MS);
}

/** Indexed text has bounded work, so host load cannot wipe an ordinary large body. */
export function redactIndexedText(value: string, secrets: string[] = []): string {
  return scanText(value.slice(0, 64 * 1024), secrets, Infinity);
}

/** Forward scans preserve formatting and never restart inside an already consumed value. */
function scanText(value: string, secrets: string[], deadline: number): string {
  if (value.length > MAX_REDACTION_LENGTH) return REDACTED;
  const expired = () => deadline !== Infinity && performance.now() >= deadline;
  let text = value;
  for (const secret of secrets) {
    if (expired()) return REDACTED;
    if (secret.length >= 12)
      text = text
        .split(REDACTED)
        .map((part) => part.replaceAll(secret, REDACTED))
        .join(REDACTED);
  }
  text = text.replace(
    /(\bAuthorization(?:\\?["'])?[ \t]*:[ \t]*(?:\\?["'])?(?:Bearer|Basic)[ \t]+)[a-z0-9_+./~=-]+/gi,
    '$1[redacted]'
  );
  if (expired()) return REDACTED;
  text = text.replace(/\bBearer[ \t]+[a-z0-9_+./~=-]{20,}/gi, 'Bearer [redacted]');
  text = text.replace(
    /(\b(?:x-api-key|x-goog-api-key|x-management-key)(?:\\?["'])?[ \t]*:[ \t]*(?:\\?["'])?)[a-z0-9_+./~=-]+/gi,
    '$1[redacted]'
  );
  if (expired()) return REDACTED;
  const cookies = /\b(?:cookie|set-cookie)(?:\\?["'])?[ \t]*:[ \t]*/gi;
  const cookieParts: string[] = [];
  let cookieCopied = 0;
  for (let header = cookies.exec(text); header; header = cookies.exec(text)) {
    if (expired()) return REDACTED;
    if (/^cookie/i.test(header[0]) && proseLabel(text, header.index)) continue;
    const start = cookies.lastIndex;
    const value = assignmentValue(text, start);
    if (value.from === start) {
      const line = /[^\r\n]*/y;
      line.lastIndex = start;
      line.exec(text);
      value.to = value.end = line.lastIndex;
    }
    cookieParts.push(text.slice(cookieCopied, value.from), REDACTED);
    cookieCopied = value.to;
    cookies.lastIndex = value.end;
  }
  text = cookieParts.join('') + text.slice(cookieCopied);
  // URL delimiters are fixed; username/password runs cannot cross another URL's slashes.
  text = text.replace(/(:\/\/[^\s/:@]*:)[^\s/@]+@/g, '$1[redacted]@');
  text = text.replace(/(:\/\/)([^\s/:@]+)@/g, (match, scheme: string, user: string) =>
    /^(?:gh[pousr]_|github_pat_|glpat-|x-access-token$)/i.test(user) || looksLikeSecret(user)
      ? `${scheme}[redacted]@`
      : match
  );
  // Run standalone tokens before assignment scanning so an ordinary quoted
  // key/token value containing a pasted credential cannot hide it.
  text = text.replace(
    /(?<![\w/])(?:sk-ant-[a-z0-9_-]{20,}|sk-(?!ant-)[a-z0-9_-]{20,}|gh[pousr]_[a-z0-9]{36,}|github_pat_[a-z0-9_]{22,}|AIza[a-z0-9_-]{35}|glpat-[a-z0-9_-]{20,}|xox[abposr]-[a-z0-9_-]{10,})/gi,
    REDACTED
  );
  // Consume each candidate once, so repeated eyJ prefixes cannot restart a failed JWT scan.
  text = text.replace(/[a-z0-9_.-]+/gi, (token, start: number) => {
    if (!/^eyJ/i.test(token) || /[\w/]/.test(text[start - 1] || '')) return token;
    let end = token.length;
    while (token[end - 1] === '.') end--;
    return /^eyJ[a-z0-9_-]*\.[a-z0-9_-]+\.[a-z0-9_-]+$/i.test(token.slice(0, end))
      ? REDACTED + token.slice(end)
      : token;
  });
  if (expired()) return REDACTED;
  const pem = /-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY)-----/g;
  const pemParts: string[] = [];
  let pemCopied = 0;
  for (let begin = pem.exec(text); begin; begin = pem.exec(text)) {
    if (expired()) return REDACTED;
    const closing = `-----END ${begin[1]}-----`;
    const end = text.indexOf(closing, pem.lastIndex);
    // A prefix can end inside a key. Consume the rest if the end marker is missing.
    pem.lastIndex = end < 0 ? text.length : end + closing.length;
    pemParts.push(text.slice(pemCopied, begin.index), REDACTED);
    pemCopied = pem.lastIndex;
  }
  text = pemParts.join('') + text.slice(pemCopied);

  const flags = /(?:^|[ \t\n])--(?:api-key|token|password|client-secret)[ \t]+/gi;
  const flagParts: string[] = [];
  let flagCopied = 0;
  for (let flag = flags.exec(text); flag; flag = flags.exec(text)) {
    if (expired()) return REDACTED;
    const value = assignmentValue(text, flags.lastIndex);
    flags.lastIndex = value.end;
    // "the --token flag" names the flag; a plain lowercase word is not a value.
    const quoted = /["']/.test(text[value.from - 1] || '');
    if (!value.value || value.value === REDACTED || (!quoted && /^[a-z]+$/.test(value.value)))
      continue;
    flagParts.push(text.slice(flagCopied, value.from), REDACTED);
    flagCopied = value.to;
  }
  text = flagParts.join('') + text.slice(flagCopied);
  if (expired()) return REDACTED;
  text = text.replace(/\bapi-keys:[ \t]*(?:\r?\n[ \t]+-[^\r\n]*)+/gi, (list) =>
    list.replace(/^([ \t]*-[ \t]+)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s#]+)/gm, '$1[redacted]')
  );
  text = text.replace(
    /(\bapi-keys:[ \t]*\[)([^\r\n]*)/gi,
    (_match, start: string, list: string) => {
      const tokens = /"[^"\r\n]*"|'[^'\r\n]*'|\[redacted\]|[^\s,\]]+/g;
      const parts: string[] = [start];
      let copied = 0;
      for (let token = tokens.exec(list); token; token = tokens.exec(list)) {
        if (list.slice(copied, token.index).includes(']')) break;
        parts.push(list.slice(copied, token.index));
        parts.push(token[0] === REDACTED ? REDACTED : '"[redacted]"');
        copied = tokens.lastIndex;
      }
      return parts.join('') + list.slice(copied);
    }
  );
  if (expired()) return REDACTED;

  // Consume each whole identifier once. Trying the suffix rule at every
  // underscore can be quadratic even with a non-ambiguous prefix regex.
  const identifiers = /\[redacted\]|[a-z0-9_-]+/gi;
  const separator = /(?:\\?["'])?[ \t]*[:=][ \t]*/y;
  const parts: string[] = [];
  let copied = 0;
  for (let match = identifiers.exec(text); match; match = identifiers.exec(text)) {
    if (expired()) return REDACTED;
    const name = match[0];
    if (name === REDACTED) continue;
    if (!credentialName(name) || (/^secret$/i.test(name) && proseLabel(text, match.index)))
      continue;
    separator.lastIndex = identifiers.lastIndex;
    const delimiter = separator.exec(text);
    if (!delimiter) continue;
    const value = assignmentValue(text, separator.lastIndex);
    if (
      delimiter[0].includes(':') &&
      (!value.value || /^[|>](?:[+-][1-9]?|[1-9][+-]?)?$/.test(value.value))
    ) {
      // YAML scalars occupy more-indented lines. Advance through the block once,
      // leaving its line breaks and the following sibling fields intact.
      const lineStart = text.lastIndexOf('\n', match.index - 1) + 1;
      const indentation = text.slice(lineStart, match.index);
      if (/^[ \t]*$/.test(indentation)) {
        let end = text.indexOf('\n', value.end);
        const from = end < 0 ? text.length : end + 1;
        end = from;
        while (end < text.length) {
          if (expired()) return REDACTED;
          const newline = text.indexOf('\n', end);
          const next = newline < 0 ? text.length : newline + 1;
          let content = end;
          while (text[content] === ' ' || text[content] === '\t') content++;
          const blank = content >= next || text[content] === '\r' || text[content] === '\n';
          if (!blank && content - end <= indentation.length) break;
          end = next;
        }
        if (end > from) {
          parts.push(
            text.slice(copied, from),
            text.slice(from, end).replace(/^([ \t]*)\S[^\r\n]*/gm, '$1[redacted]')
          );
          copied = identifiers.lastIndex = end;
          continue;
        }
      }
    }
    identifiers.lastIndex = value.end;
    if (!value.value || value.value === REDACTED || text[value.end] === '(') continue;
    const quoted = value.from > separator.lastIndex;
    if (
      !quoted &&
      (/^(?:true|false|null|undefined)$/i.test(value.value) ||
        (delimiter[0].includes(':') &&
          /^(?:string|number|boolean|unknown|never|any)$/i.test(value.value) &&
          /[,;|?}]/.test(text[value.end] || '')) ||
        /^(?:process\.env|(?:os\.)?environ)(?:\.|$)/.test(value.value))
    )
      continue;
    if (/^(key|token)$/i.test(name) && !looksLikeSecret(value.value)) continue;
    parts.push(text.slice(copied, value.from), REDACTED);
    copied = value.to;
  }
  parts.push(text.slice(copied));
  return expired() ? REDACTED : parts.join('');
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
        typeof v === 'string' &&
        /^(pointer|file|path|cwd|branch|git_branch|gitBranch|directory|worktree_path)$/i.test(key)
      )
        return [[key, v]];
      if (
        preserveKeys &&
        /^(key|token)$/i.test(key) &&
        (typeof v !== 'string' || !looksLikeSecret(v))
      )
        return [[key, sanitize(v, secrets, preserveKeys)]];
      if (credentialName(key) || /^(authorization|cookie|set-cookie)$/i.test(key))
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
