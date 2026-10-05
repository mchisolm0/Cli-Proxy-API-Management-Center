import { basename } from "node:path";
import { immutable, lines } from "./archive";
import { redactText, sanitize } from './telemetry/events';
import {
  array,
  object,
  json,
  string,
  number,
  timestamp,
  text,
  role,
  session,
  item,
  type Parsed,
  type Pointer,
  type Session,
  type Item,
} from "./model";

function finish(s: Session) {
  s.title ||=
    s.items.find((i) => i.role === "user")?.body.slice(0, 120) || s.nativeId;
  // Native ordering wins ties, including blocks of the same message.
  s.items.sort(
    (a, b) =>
      a.time - b.time ||
      (a.pointer.kind === "jsonl" && b.pointer.kind === "jsonl"
        ? a.pointer.offset - b.pointer.offset
        : 0),
  );
  return s;
}
export function codex(path: string, file: string, secrets: string[] = []): Parsed {
  const s = session("codex", "");
  let startOrdinal = 0;
  const canonical = new Set<string>();
  const completed: { key: string; item: Item }[] = [];
  for (const line of lines(path)) {
    const o = object(line.value),
      p = object(o.payload),
      time = timestamp(o.timestamp);
    const pointer: Pointer = {
      kind: "jsonl",
      file,
      offset: line.offset,
      length: line.length,
    };
    if (o.type === "session_meta") {
      s.nativeId = string(p.id);
      s.cwd = string(p.cwd);
      s.provider = string(p.model_provider);
      s.started = timestamp(p.timestamp) || time;
      s.repo = string(object(p.git).repository_url);
      s.branch = string(object(p.git).branch);
      s.parentId = string(p.parent_thread_id) || string(p.forked_from_id);
      s.kind = p.parent_thread_id
        ? "subagent"
        : p.forked_from_id
          ? "fork"
          : "root";
      startOrdinal = number(p.subagent_history_start_ordinal);
      continue;
    }
    if (typeof o.ordinal === "number" && o.ordinal < startOrdinal) continue;
    s.updated = Math.max(s.updated, time);
    if (o.type === "turn_context") s.model = string(p.model) || s.model;
    if (o.type === "event_msg" && p.type === "token_count") {
      const u = object(object(p.info).total_token_usage);
      if (Object.keys(u).length)
        s.tokens =
          number(u.total_tokens) ||
          number(u.input_tokens) + number(u.output_tokens);
    }
    if (o.type === "event_msg" && p.type === "user_message") {
      const body = redactText(text(p.message), secrets);
      s.items.push(item(time, "user", body, pointer));
      canonical.add(`user:${body}`);
    }
    if (o.type === "response_item") {
      if (p.type === "message" && p.role === "assistant") {
        const body = redactText(text(p.content), secrets);
        s.items.push(item(time, "assistant", body, pointer));
        canonical.add(`assistant:${body}`);
      } else if (p.type === "function_call" || p.type === "custom_tool_call") {
        s.items.push(
          item(
            time,
            "tool_call",
            redactText(text(p.arguments ?? p.input), secrets),
            pointer,
            string(p.name),
            string(p.call_id),
          ),
        );
      } else if (
        p.type === "function_call_output" ||
        p.type === "custom_tool_call_output"
      ) {
        s.items.push(
          item(
            time,
            "tool_result",
            redactText(text(p.output), secrets),
            pointer,
            "",
            string(p.call_id),
          ),
        );
      }
    }
    if (o.type === "event_msg" && p.type === "item_completed") {
      const completedItem = object(p.item);
      const r =
        completedItem.type === "UserMessage"
          ? "user"
          : completedItem.type === "AgentMessage"
            ? "assistant"
            : null;
      const body = redactText(text(completedItem.content ?? completedItem.text), secrets);
      if (r && body)
        completed.push({
          key: `${r}:${body}`,
          item: item(time, r, body, pointer),
        });
    }
  }
  if (!s.nativeId) throw new Error(`Missing Codex session id: ${file}`);
  for (const c of completed)
    if (!canonical.has(c.key)) {
      s.items.push(c.item);
      canonical.add(c.key);
    }
  return { sessions: [finish(s)], links: [] };
}
export function claude(path: string, file: string, secrets: string[] = []): Parsed {
  const s = session("claude", "");
  const usage = new Map<string, number>();
  const blocks = new Set<string>();
  let agentId = "";
  for (const line of lines(path)) {
    const o = object(line.value),
      m = object(o.message),
      time = timestamp(o.timestamp);
    const pointer: Pointer = {
      kind: "jsonl",
      file,
      offset: line.offset,
      length: line.length,
    };
    s.nativeId ||= string(o.sessionId);
    s.cwd ||= string(o.cwd);
    agentId ||= string(o.agentId);
    s.branch = string(o.gitBranch) || s.branch;
    if (time) {
      s.started ||= time;
      s.updated = Math.max(s.updated, time);
    }
    if (o.type === "ai-title") s.title = redactText(string(o.aiTitle), secrets);
    if (o.type !== "user" && o.type !== "assistant") continue;
    s.model = string(m.model) || s.model;
    if (o.type === "assistant" && string(m.id) && m.usage !== undefined) {
      const u = object(m.usage);
      usage.set(
        string(m.id),
        number(u.input_tokens) +
          number(u.output_tokens) +
          number(u.cache_read_input_tokens) +
          number(u.cache_creation_input_tokens),
      );
    }
    const content =
      typeof m.content === "string"
        ? [{ type: "text", text: m.content }]
        : array(m.content);
    for (const value of content) {
      const b = object(value);
      const key = `${string(m.id)}:${JSON.stringify(b)}`;
      if (string(m.id) && blocks.has(key)) continue;
      blocks.add(key);
      if (b.type === "text")
        s.items.push(
          item(
            time,
            o.isMeta === true ? "system" : role(o.type),
            redactText(string(b.text), secrets),
            pointer,
          ),
        );
      else if (b.type === "thinking")
        s.items.push(item(time, "thinking", redactText(string(b.thinking), secrets), pointer));
      else if (b.type === "tool_use")
        s.items.push(
          item(
            time,
            "tool_call",
            redactText(text(b.input), secrets),
            pointer,
            string(b.name),
            string(b.id),
          ),
        );
      else if (b.type === "tool_result")
        s.items.push(
          item(
            time,
            "tool_result",
            redactText(text(b.content), secrets),
            pointer,
            "",
            string(b.tool_use_id),
          ),
        );
    }
  }
  if (!s.nativeId) throw new Error(`Missing Claude session id: ${file}`);
  if (file.includes("/subagents/")) {
    s.parentId = s.nativeId;
    s.nativeId += `/${agentId || basename(file, ".jsonl")}`;
    s.kind = "subagent";
  }
  s.tokens = [...usage.values()].reduce((a, b) => a + b, 0);
  s.provider = "anthropic";
  return { sessions: [finish(s)], links: [] };
}
export function opencode(path: string, file: string, secrets: string[] = []): Parsed {
  const db = immutable(path);
  try {
    const sessions: Session[] = [];
    for (const row of db.query("SELECT * FROM session").all()) {
      const r = object(row),
        id = string(r.id);
      if (!id) throw new Error("Invalid OpenCode session id");
      const s = session("opencode", id);
      s.title = redactText(string(r.title), secrets);
      s.cwd = string(r.directory);
      s.repo = s.cwd;
      s.started = timestamp(r.time_created);
      s.updated = timestamp(r.time_updated);
      s.parentId = string(r.parent_id);
      s.kind = s.parentId ? "subagent" : "root";
      for (const message of db
        .query(
          "SELECT * FROM message WHERE session_id=? ORDER BY time_created,id",
        )
        .all(id)) {
        const m = object(message),
          data = json(string(m.data)),
          u = object(data.tokens);
        s.model = string(data.modelID) || s.model;
        s.provider = string(data.providerID) || s.provider;
        s.tokens +=
          number(u.input) +
          number(u.output) +
          number(object(u.cache).read) +
          number(object(u.cache).write);
        for (const part of db
          .query(
            "SELECT * FROM part WHERE message_id=? ORDER BY time_created,id",
          )
          .all(string(m.id))) {
          const p = object(part),
            d = json(string(p.data)),
            state = object(d.state);
          const pointer: Pointer = {
            kind: "sqlite",
            file,
            table: "part",
            column: "id",
            key: string(p.id),
          };
          const time = timestamp(p.time_created) || timestamp(m.time_created);
          if (d.type === "text")
            s.items.push(item(time, role(data.role), redactText(string(d.text), secrets), pointer));
          else if (d.type === "tool") {
            const callId = string(d.callID) || string(p.id);
            s.items.push(
              item(
                time,
                "tool_call",
                redactText(text(state.input), secrets),
                pointer,
                string(d.tool),
                callId,
              ),
            );
            if (state.output !== undefined || state.error !== undefined)
              s.items.push(
                item(
                  time,
                  "tool_result",
                  redactText(text(state.output ?? state.error), secrets),
                  pointer,
                  string(d.tool),
                  callId,
                ),
              );
          }
        }
      }
      // Older schemas carry totals on session rows instead of messages.
      s.tokens ||=
        number(r.tokens_input) +
        number(r.tokens_output) +
        number(r.tokens_cache_read) +
        number(r.tokens_cache_write);
      sessions.push(finish(s));
    }
    return { sessions, links: [] };
  } finally {
    db.close();
  }
}
export function t3(path: string, file: string, secrets: string[] = []): Parsed {
  const db = immutable(path);
  const parsed: Parsed = { sessions: [], links: [] };
  try {
    const runtime = new Map(
      db
        .query("SELECT * FROM provider_session_runtime")
        .all()
        .map((row) => {
          const r = object(row);
          return [string(r.thread_id), r] as const;
        }),
    );
    for (const row of db.query("SELECT * FROM projection_threads").all()) {
      const t = object(row);
      if (t.deleted_at) continue;
      const id = string(t.thread_id);
      if (!id) throw new Error("Invalid T3 thread id");
      const r = runtime.get(id) ?? {},
        cursor = r.resume_cursor_json ? json(string(r.resume_cursor_json)) : {};
      const client =
        r.provider_name === "codex"
          ? "codex"
          : r.provider_name === "claudeAgent"
            ? "claude"
            : r.provider_name === "opencode"
              ? "opencode"
              : null;
      const nativeId = string(
        client === "codex"
          ? cursor.threadId
          : client === "claude"
            ? cursor.resume
            : cursor.sessionId,
      );
      if (client && nativeId)
        parsed.links.push({
          client,
          nativeId,
          title: redactText(string(t.title), secrets),
          branch: string(t.branch),
          threadId: id,
        });
      const s = session("t3", id),
        model = t.model_selection_json
          ? json(string(t.model_selection_json))
          : {};
      s.title = redactText(string(t.title), secrets);
      s.cwd = string(t.worktree_path);
      s.repo = s.cwd;
      s.branch = string(t.branch);
      s.model = string(model.model);
      s.provider = string(model.instanceId);
      s.t3ThreadId = id;
      s.started = timestamp(t.created_at);
      s.updated = timestamp(t.updated_at);
      for (const row of db
        .query(
          "SELECT * FROM projection_thread_messages WHERE thread_id=? ORDER BY created_at,message_id",
        )
        .all(id)) {
        const m = object(row);
        s.items.push(
          item(timestamp(m.created_at), role(m.role), redactText(string(m.text), secrets), {
            kind: "sqlite",
            file,
            table: "projection_thread_messages",
            column: "message_id",
            key: string(m.message_id),
          }),
        );
      }
      parsed.sessions.push(finish(s));
    }
    return parsed;
  } finally {
    db.close();
  }
}
export function codexMetadata(path: string, secrets: string[] = []): Record<string, unknown>[] {
  const db = immutable(path);
  try {
    if (
      !db
        .query(
          "SELECT name FROM sqlite_schema WHERE type='table' AND name='threads'",
        )
        .get()
    )
      return [];
    return db.query("SELECT * FROM threads").all().map((row) => object(sanitize(row, secrets, true)));
  } finally {
    db.close();
  }
}
