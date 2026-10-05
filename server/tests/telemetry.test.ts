import { expect, test, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Socket } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RespDecoder, command, type Resp } from '../telemetry/resp';
import { classify, transport } from '../telemetry/events';
import { managementRetryAt, managementAccepted, managementKey } from '../auth';
import { startTelemetry } from '../telemetry';
import { openIndex } from '../db';

test('RESP decoder handles byte fragmentation, multiple frames, errors and invalid lengths', () => {
  const decoder = new RespDecoder(),
    frame = command('message', 'usage', JSON.stringify({ text: '🦦' }));
  const result: Resp[] = [];
  for (const byte of frame) result.push(...decoder.push(Buffer.from([byte])));
  expect(result).toEqual([['message', 'usage', '{"text":"🦦"}']]);
  expect(decoder.push(Buffer.from('+OK\r\n:2\r\n$-1\r\n-ERR rejected\r\n'))).toEqual([
    'OK',
    2,
    null,
    { error: 'ERR rejected' },
  ]);
  expect(() => new RespDecoder().push(Buffer.from('$-2\r\n'))).toThrow('Invalid RESP length');
  expect(() => new RespDecoder().push(Buffer.from('$3\r\nabcXX'))).toThrow(
    'Invalid RESP terminator'
  );
});
test('transport and error classes follow proxy codes, status and cooldown reasons', () => {
  expect(transport({ endpoint: 'GET /v1/responses' })).toBe('websocket');
  expect(
    transport({
      endpoint: 'POST /v1/responses',
      executor_type: 'CodexWebsocketsExecutor',
    })
  ).toBe('websocket');
  expect(transport({ endpoint: 'POST /v1/chat/completions' })).toBe('http');
  expect(transport({})).toBe('unknown');
  expect(classify({ status_code: 401, auth_status: { quota: { exceeded: true } } })).toBe('auth');
  expect(
    classify({
      status_code: 403,
      body: 'payment_required',
    })
  ).toBe('quota');
  expect(
    classify({
      status_code: 500,
      auth_status: { quota: { reason: 'credential_quota', exceeded: true } },
    })
  ).toBe('upstream');
  expect(classify({ body: 'context deadline exceeded' })).toBe('upstream');
  expect(classify({ status_code: 401, body: 'context deadline exceeded' })).toBe('auth');
  expect(classify({ status_code: 502 })).toBe('upstream');
  expect(
    classify({
      status_code: 403,
      body: 'cloudflare challenge',
    })
  ).toBe('upstream');
  expect(classify({ status_code: 500, code: 'connection_lifecycle' })).toBe('transport');
  expect(classify({ status_code: 500, code: 'transient_transport' })).toBe('transport');
  expect(classify({ status_code: 500, code: 'request_scoped' })).toBe('client');
  expect(classify({ status_code: 400 })).toBe('client');
  expect(classify({ code: 'unrecognized' })).toBe('other');
});
test('event signals override unrelated credential and model quota state', () => {
  const auth_status = {
    quota: { exceeded: true, reason: 'credential_quota' },
    model: { name: 'other', quota: { exceeded: true, reason: 'quota' } },
  };
  for (const [code, status_code, category] of [
    ['transient_transport', 500, 'transport'],
    ['connection_lifecycle', 500, 'transport'],
    ['request_scoped', 400, 'client'],
    ['model_not_found', 500, 'client'],
    ['model_not_supported', 429, 'client'],
    ['not_found', 404, 'client'],
    ['transient_error', 500, 'upstream'],
    ['', 502, 'upstream'],
    ['', 403, 'auth'],
    ['', 429, 'quota'],
  ] as const)
    expect(classify({ code, status_code, model: 'test', auth_status })).toBe(category);
  expect(
    classify({
      status_code: 403,
      model: 'test',
      auth_status: { model: { name: 'test', quota: { exceeded: true } } },
    })
  ).toBe('quota');
  expect(classify({ status_code: 502, body: 'quota exhausted' })).toBe('upstream');
  expect(classify({ body: '{"error":{"code":"invalid_api_key"}}' })).toBe('auth');
  expect(
    classify({
      code: 'connection_lifecycle',
      status_code: 500,
      body: 'context canceled',
      auth_status,
    })
  ).toBe('client');
  expect(
    classify({
      code: 'connection_lifecycle',
      body: 'context deadline exceeded',
    })
  ).toBe('upstream');
  expect(
    classify({
      code: 'connection_lifecycle',
      body: 'websocket: close 1006 (abnormal closure)',
    })
  ).toBe('transport');
});
test('AUTH rejection pauses both telemetry channels and records only state changes', async () => {
  const db = new Database(':memory:');
  const sockets: Socket[] = [];
  let attempts = 0;
  const connect = () => {
    attempts++;
    const socket = new Socket();
    sockets.push(socket);
    socket.write = () => {
      queueMicrotask(() => socket.emit('data', Buffer.from('-ERR invalid management key\r\n')));
      return true;
    };
    queueMicrotask(() => socket.emit('connect'));
    return socket;
  };
  const stop = startTelemetry(db, 'synthetic:8317', () => 'wrong-key', {
    connect,
    retryMinMs: 1,
    retryMaxMs: 2,
    warn: () => {},
  });
  try {
    const before = Date.now();
    await Bun.sleep(30);
    expect(attempts).toBe(2);
    expect(managementRetryAt(db)).toBeGreaterThanOrEqual(before + 600000);
    expect(
      db
        .query<{ n: number }, []>(
          "SELECT count(*) n FROM dashboard_event WHERE code='telemetry_auth_rejected'"
        )
        .get()?.n
    ).toBe(1);
    // Repeated rejections stay in the same state; recovery allows a new transition.
    sockets[0]!.emit('data', Buffer.from('-ERR invalid management key\r\n'));
    expect(db.query<{ n: number }, []>('SELECT count(*) n FROM dashboard_event').get()?.n).toBe(1);
    managementAccepted(db, 'telemetry');
    sockets[0]!.emit('data', Buffer.from('-ERR invalid management key\r\n'));
    expect(db.query<{ n: number }, []>('SELECT count(*) n FROM dashboard_event').get()?.n).toBe(2);
  } finally {
    stop();
    db.close();
  }
});
test('fake RESP proxy stores sanitized records and reloads the rotated key on reconnect', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dashboard-telemetry-key-')),
    keyPath = join(root, 'management-key');
  writeFileSync(keyPath, 'synthetic-management-key\n');
  const loadKey = () => managementKey({ CPA_MANAGEMENT_KEY_FILE: keyPath });
  const db = new Database(':memory:');
  const sockets = new Set<Socket>(),
    commands: string[][] = [],
    warnings: string[] = [];
  let usageConnections = 0;
  const connect = () => {
    const socket = new Socket();
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    const decoder = new RespDecoder();
    socket.write = (chunk: string | Uint8Array) => {
      for (const frame of decoder.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk))) {
        if (!Array.isArray(frame) || !frame.every((p) => typeof p === 'string')) {
          socket.destroy();
          continue;
        }
        commands.push(frame);
        if (frame[0] === 'AUTH') {
          queueMicrotask(() => socket.emit('data', Buffer.from('+OK\r\n')));
          continue;
        }
        if (frame[0] === 'PING') {
          queueMicrotask(() => socket.emit('data', command('pong', '')));
          continue;
        }
        if (frame[0] !== 'SUBSCRIBE' || frame.length !== 2) {
          queueMicrotask(() => socket.emit('data', Buffer.from('-ERR wrong command\r\n')));
          continue;
        }
        const channel = frame[1]!;
        queueMicrotask(() => socket.emit('data', command('subscribe', channel, '1')));
        const event = {
          timestamp: '2026-10-01T12:00:00Z',
          provider: 'fixture',
          model: 'synthetic',
          auth_index: 'synthetic-account',
          api_key: 'never-store-this',
          nested: { api_key: 'nested-key' },
          body: loadKey(),
          source: 'synthetic-upstream-key',
          response_headers: { 'x-sensitive': 'discard-this-header' },
          endpoint: 'GET /v1/responses',
          text: '🦦',
        };
        if (channel === 'usage') {
          usageConnections++;
          const payload = command(
            'message',
            channel,
            JSON.stringify({
              ...event,
              request_id: `synthetic-${usageConnections}`,
            })
          );
          // Split within the JSON payload and close one connection to force reauthentication.
          queueMicrotask(() => socket.emit('data', payload.subarray(0, 61)));
          setTimeout(() => {
            socket.emit('data', payload.subarray(61));
            if (usageConnections === 1) {
              writeFileSync(keyPath, 'synthetic-rotated-key\n');
              socket.destroy();
            }
          }, 5);
        } else
          queueMicrotask(() =>
            socket.emit(
              'data',
              Buffer.concat([
                command('message', channel, 'malformed JSON'),
                command(
                  'message',
                  channel,
                  JSON.stringify({
                    ...event,
                    status_code: 429,
                    code: 'rate_limit',
                    auth_status: {
                      quota: { reason: 'credential_quota', exceeded: true },
                    },
                  })
                ),
              ])
            )
          );
      }
      return true;
    };
    queueMicrotask(() => socket.emit('connect'));
    return socket;
  };
  const stop = startTelemetry(db, 'synthetic-proxy:8317', loadKey, {
    connect,
    retryMinMs: 10,
    retryMaxMs: 20,
    warn: (m) => warnings.push(m),
  });
  try {
    const deadline = Date.now() + 2000;
    while (
      Date.now() < deadline &&
      (db.query<{ n: number }, []>('SELECT count(*) n FROM usage_event').get()!.n < 2 ||
        db.query<{ n: number }, []>('SELECT count(*) n FROM error_event').get()!.n < 1)
    )
      await Bun.sleep(10);
    const usage = db
      .query<{ payload: string; transport: string }, []>(
        'SELECT payload,transport FROM usage_event'
      )
      .all();
    expect(usage).toHaveLength(2);
    expect(usage[0]!.transport).toBe('websocket');
    expect(JSON.stringify(usage)).not.toContain('api_key');
    expect(JSON.stringify(usage)).not.toContain('never-store-this');
    expect(JSON.stringify(usage)).not.toContain('nested-key');
    expect(JSON.stringify(usage)).not.toContain('synthetic-management-key');
    expect(JSON.stringify(usage)).not.toContain('synthetic-rotated-key');
    expect(JSON.stringify(usage)).not.toContain('synthetic-upstream-key');
    const error = db
      .query<{ category: string; cooldownReason: string; payload: string }, []>(
        'SELECT category,cooldownReason,payload FROM error_event'
      )
      .get()!;
    expect(error.category).toBe('quota');
    expect(error.cooldownReason).toBe('credential_quota');
    expect(error.payload).not.toContain('api_key');
    expect(commands.filter((c) => c[0] === 'AUTH')).toHaveLength(3);
    expect(commands.filter((c) => c[0] === 'AUTH').map((c) => c[1])).toEqual([
      'synthetic-management-key',
      'synthetic-management-key',
      'synthetic-rotated-key',
    ]);
    expect(
      commands
        .filter((c) => c[0] === 'SUBSCRIBE')
        .map((c) => c[1])
        .sort()
    ).toEqual(['errors', 'usage', 'usage']);
    expect(commands.every((c) => ['AUTH', 'SUBSCRIBE', 'PING'].includes(c[0]!))).toBe(true);
    expect(warnings.some((w) => w.includes('record could not be stored'))).toBe(true);
  } finally {
    stop();
    for (const socket of sockets) socket.destroy();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('telemetry shutdown drains both buffered channels and preserves receipt times', () => {
  const root = mkdtempSync(join(tmpdir(), 'dashboard-telemetry-lock-')),
    path = join(root, 'index.sqlite'),
    db = openIndex(path, 250),
    locker = openIndex(path);
  const sockets: Socket[] = [],
    warnings: string[] = [];
  const clock = spyOn(Date, 'now').mockReturnValue(Date.now());
  const stop = startTelemetry(db, 'synthetic:8317', () => 'synthetic-key', {
    connect: () => {
      const socket = new Socket();
      socket.write = () => true;
      sockets.push(socket);
      return socket;
    },
    warn: (message) => warnings.push(message),
  });
  try {
    for (const [i, channel] of ['usage', 'errors'].entries()) {
      sockets[i]!.emit('connect');
      sockets[i]!.emit('data', Buffer.from('+OK\r\n'));
      sockets[i]!.emit('data', command('subscribe', channel, '1'));
    }
    locker.run('BEGIN IMMEDIATE');
    const before = Date.now();
    for (const [i, channel] of ['usage', 'errors'].entries())
      sockets[i]!.emit(
        'data',
        command(
          'message',
          channel,
          JSON.stringify({
            timestamp: before,
            body: 'synthetic-key',
            source: 'never-store-this',
            status_code: 504,
          })
        )
      );
    expect(Date.now() - before).toBeLessThan(1000);
    expect(db.query('SELECT * FROM usage_event').all()).toHaveLength(0);
    expect(db.query('SELECT * FROM error_event').all()).toHaveLength(0);
    clock.mockReturnValue(before + 1000);
    const unlocked = Date.now();
    locker.run('COMMIT');
    stop();
    for (const table of ['usage_event', 'error_event']) {
      const records = db
        .query<{ received: number; payload: string }, []>(`SELECT received,payload FROM ${table}`)
        .all();
      expect(records).toHaveLength(1);
      expect(records[0]!.received).toBeGreaterThanOrEqual(before);
      expect(records[0]!.received).toBeLessThan(unlocked);
      expect(records[0]!.payload).not.toContain('synthetic-key');
    }
    expect(
      db.query<{ payload: string }, []>('SELECT payload FROM usage_event').get()!.payload
    ).not.toContain('never-store-this');
    expect(warnings).toEqual([]);
  } finally {
    stop();
    clock.mockRestore();
    if (locker.inTransaction) locker.run('ROLLBACK');
    locker.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('telemetry caps pending records, warns once per overflow, and backs off until writes recover', () => {
  const root = mkdtempSync(join(tmpdir(), 'dashboard-telemetry-overflow-')),
    path = join(root, 'index.sqlite'),
    db = openIndex(path, 0),
    locker = openIndex(path);
  const sockets: Socket[] = [],
    warnings: string[] = [];
  const scheduled: {
    callback: () => void;
    delay: number;
    timer: ReturnType<typeof setTimeout>;
  }[] = [];
  const timeout = setTimeout;
  const cancellations = spyOn(globalThis, 'clearTimeout');
  const timers = spyOn(globalThis, 'setTimeout').mockImplementation(((
    callback: () => void,
    delay: number
  ) => {
    if (delay === 45000) return timeout(callback, delay);
    const timer = timeout(() => {}, 60000);
    scheduled.push({ callback, delay, timer });
    return timer;
  }) as typeof setTimeout);
  let stop: (() => void) | undefined;
  const tick = (delay: number) => {
    expect(scheduled).toHaveLength(1);
    const next = scheduled.shift()!;
    clearTimeout(next.timer);
    expect(next.delay).toBe(delay);
    next.callback();
  };
  const send = (sequence: number) => {
    const channel = sequence % 2 ? 'errors' : 'usage';
    sockets[sequence % 2]!.emit(
      'data',
      command(
        'message',
        channel,
        JSON.stringify({
          timestamp: Date.now(),
          sequence,
        })
      )
    );
  };
  try {
    stop = startTelemetry(db, 'synthetic:8317', () => 'synthetic-key', {
      connect: () => {
        const socket = new Socket();
        socket.write = () => true;
        sockets.push(socket);
        return socket;
      },
      warn: (message) => warnings.push(message),
    });
    for (const [i, channel] of ['usage', 'errors'].entries()) {
      sockets[i]!.emit('data', Buffer.from('+OK\r\n'));
      sockets[i]!.emit('data', command('subscribe', channel, '1'));
    }
    locker.run('BEGIN IMMEDIATE');
    for (let i = 0; i < 10002; i++) send(i);
    expect(warnings).toEqual(['Telemetry: pending buffer full; dropping oldest records']);
    for (const delay of [1000, 2000, 4000, 8000, 10000, 10000]) tick(delay);
    expect(db.query('SELECT * FROM usage_event').all()).toHaveLength(0);
    expect(db.query('SELECT * FROM error_event').all()).toHaveLength(0);
    locker.run('COMMIT');
    tick(10000);
    const records = db
      .query<{ sequence: number }, []>(
        "SELECT json_extract(payload,'$.sequence') sequence FROM usage_event UNION ALL SELECT json_extract(payload,'$.sequence') sequence FROM error_event"
      )
      .all();
    expect(records).toHaveLength(10000);
    const sequences = records.map((r) => r.sequence).sort((a, b) => a - b);
    expect(sequences[0]).toBe(2);
    expect(sequences.at(-1)).toBe(10001);
    expect(new Set(sequences).size).toBe(10000);
    expect(scheduled).toHaveLength(0);
    locker.run('BEGIN IMMEDIATE');
    for (let i = 10002; i < 20004; i++) send(i);
    expect(warnings).toHaveLength(2);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.delay).toBe(1000);
    // A held lock during shutdown gets one drain attempt and no further retries.
    stop();
    expect(cancellations).toHaveBeenCalledWith(scheduled[0]!.timer);
    expect(warnings).toHaveLength(2);
    expect(scheduled).toHaveLength(1);
  } finally {
    stop?.();
    for (const { timer } of scheduled) clearTimeout(timer);
    timers.mockRestore();
    cancellations.mockRestore();
    if (locker.inTransaction) locker.run('ROLLBACK');
    locker.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('AUTH rejection storage failures keep their own warning and pause reconnects', () => {
  const root = mkdtempSync(join(tmpdir(), 'dashboard-telemetry-auth-lock-')),
    path = join(root, 'index.sqlite'),
    db = openIndex(path, 0),
    locker = openIndex(path);
  const sockets: Socket[] = [],
    warnings: string[] = [];
  const stop = startTelemetry(db, 'synthetic:8317', () => 'synthetic-key', {
    connect: () => {
      const socket = new Socket();
      socket.write = () => true;
      sockets.push(socket);
      return socket;
    },
    warn: (message) => warnings.push(message),
  });
  try {
    locker.run('BEGIN IMMEDIATE');
    sockets[0]!.emit('data', Buffer.from('-ERR rejected\r\n'));
    expect(warnings).toEqual([
      'Telemetry usage: auth rejection could not be stored',
      'Telemetry usage: RESP rejected the command',
    ]);
    expect(managementRetryAt(db)).toBeGreaterThan(Date.now());
    expect(db.query('SELECT * FROM dashboard_event').all()).toHaveLength(0);
  } finally {
    stop();
    if (locker.inTransaction) locker.run('ROLLBACK');
    locker.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
