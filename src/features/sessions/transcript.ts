import type { SessionItem, SessionSummary } from '@/services/history';

export function groupSessions(sessions: SessionSummary[]) {
  const days = new Map<string, SessionSummary[]>();
  for (const session of sessions) {
    const day = session.updated ? new Date(session.updated).toISOString().slice(0, 10) : '';
    const group = days.get(day) ?? [];
    group.push(session);
    days.set(day, group);
  }
  return [...days];
}

// Keep orphan outputs visible and attach results to the preceding call with that ID.
export function transcriptEntries(items: SessionItem[]) {
  const entries: { item: SessionItem; outputs: SessionItem[] }[] = [];
  const calls = new Map<string, (typeof entries)[number]>();
  for (const item of items) {
    if (item.role === 'tool_result' && item.callId) {
      const call = calls.get(item.callId);
      if (call) {
        call.outputs.push(item);
        continue;
      }
    }
    const entry = { item, outputs: [] as SessionItem[] };
    entries.push(entry);
    if (item.role === 'tool_call' && item.callId) calls.set(item.callId, entry);
  }
  return entries;
}

export function searchTerms(query: string) {
  return [...query.matchAll(/"([^"\n]*)"|([^\s"]+)/g)]
    .map((match) => (match[1] ?? match[2] ?? '').trim())
    .filter(Boolean);
}
