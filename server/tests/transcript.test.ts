import { expect, test } from 'bun:test';
import type { SessionItem, SessionSummary } from '../api';
import {
  groupSessions,
  searchTerms,
  transcriptEntries,
} from '../../src/features/sessions/transcript';

const record = (id: number, role: string, callId: string): SessionItem => ({
  id,
  role,
  callId,
  sessionId: 1,
  seq: id,
  time: id,
  tool: '',
  body: '',
  bodyLength: 0,
});

test('transcript pairs output with its preceding call and preserves orphan outputs', () => {
  const items = [
    record(1, 'tool_result', 'missing'),
    record(2, 'tool_call', 'call'),
    record(3, 'assistant', ''),
    record(4, 'tool_result', 'call'),
    record(5, 'tool_call', 'call'),
    record(6, 'tool_result', 'call'),
  ];
  expect(
    transcriptEntries(items).map(({ item, outputs }) => [item.id, outputs.map((item) => item.id)])
  ).toEqual([
    [1, []],
    [2, [4]],
    [3, []],
    [5, [6]],
  ]);
});

test('sessions group by UTC day without changing search order', () => {
  const sessions = [
    { id: 1, updated: Date.parse('2026-10-05T23:00:00Z') },
    { id: 2, updated: Date.parse('2026-10-05T00:01:00Z') },
    { id: 3, updated: Date.parse('2026-10-04T23:59:00Z') },
    { id: 4, updated: 0 },
  ] as SessionSummary[];
  expect(
    groupSessions(sessions).map(([day, items]) => [day, items.map((item) => item.id)])
  ).toEqual([
    ['2026-10-05', [1, 2]],
    ['2026-10-04', [3]],
    ['', [4]],
  ]);
  expect(searchTerms('lunar "otters in space"')).toEqual(['lunar', 'otters in space']);
});
