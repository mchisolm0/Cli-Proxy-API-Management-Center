import type { Database, SQLQueryBindings } from "bun:sqlite";
import type { SessionRow } from "./db";
import { clients } from "./model";

// User input is literal text. Only double-quoted groups have phrase semantics.
export function ftsQuery(input: string): string {
  const terms: string[] = [];
  for (const match of input.matchAll(/"([^"\n]*)"|([^\s"]+)/g)) {
    const term = (match[1] ?? match[2] ?? "").trim();
    if (/[\p{L}\p{N}]/u.test(term))
      terms.push(`"${term.replaceAll('"', '""')}"`);
  }
  return terms.join(" AND ");
}
export function search(db: Database, params: URLSearchParams) {
  const where: string[] = [],
    bindings: SQLQueryBindings[] = [];
  const raw = params.get("q") || "";
  if (raw.length > 2000)
    throw new Error("Search must be at most 2000 characters");
  const query = ftsQuery(raw);
  if (raw.trim() && !query) return { sessions: [], total: 0 };
  if (query) {
    where.push(
      "s.id IN (SELECT rowid FROM session_fts WHERE session_fts MATCH ? UNION SELECT sessionId FROM item WHERE id IN (SELECT rowid FROM item_fts WHERE item_fts MATCH ?))",
    );
    bindings.push(query, query);
  }
  for (const column of ["client", "host", "model"] as const) {
    const value = params.get(column);
    if (!value) continue;
    if (column === "client" && !clients.some((c) => c === value))
      throw new Error("Unknown client");
    where.push(`s.${column}=?`);
    bindings.push(value);
  }
  const cwd = params.get("cwd");
  if (cwd) {
    where.push(
      "(instr(lower(s.cwd),lower(?))>0 OR instr(lower(s.repo),lower(?))>0)",
    );
    bindings.push(cwd, cwd);
  }
  for (const [key, operator] of [
    ["from", ">="],
    ["to", "<"],
  ] as const) {
    const value = params.get(key);
    if (!value) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
      throw new Error("Dates must use YYYY-MM-DD");
    const time = Date.parse(value);
    if (
      !Number.isFinite(time) ||
      new Date(time).toISOString().slice(0, 10) !== value
    )
      throw new Error("Invalid date");
    where.push(`s.updated${operator}?`);
    bindings.push(time + (key === "to" ? 86400000 : 0));
  }
  const sql = `FROM session s ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`;
  const offset = Number(params.get("offset") || 0);
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new Error("Invalid offset");
  const total =
    db
      .query<{ count: number }, SQLQueryBindings[]>(
        `SELECT count(*) count ${sql}`,
      )
      .get(...bindings)?.count || 0;
  const sessions = db
    .query<SessionRow, SQLQueryBindings[]>(
      `SELECT s.* ${sql} ORDER BY s.updated DESC,s.id DESC LIMIT 100 OFFSET ?`,
    )
    .all(...bindings, offset);
  return { sessions, total };
}
