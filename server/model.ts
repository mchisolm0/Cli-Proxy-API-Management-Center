export const clients = ["codex", "claude", "opencode", "t3"] as const;
export type Client = (typeof clients)[number];
export type Role =
  "user" | "assistant" | "system" | "thinking" | "tool_call" | "tool_result";
export type Pointer = { file: string } & (
  | { kind: "jsonl"; offset: number; length: number }
  | {
      kind: "sqlite";
      table: "part" | "projection_thread_messages";
      column: "id" | "message_id";
      key: string;
    }
);
export type Item = {
  time: number;
  role: Role;
  tool: string;
  callId: string;
  body: string;
  bodyLength: number;
  pointer: Pointer;
};
export type Session = {
  client: Client;
  nativeId: string;
  title: string;
  cwd: string;
  repo: string;
  branch: string;
  model: string;
  provider: string;
  started: number;
  updated: number;
  tokens: number;
  parentId: string;
  kind: "root" | "fork" | "subagent";
  t3ThreadId: string;
  items: Item[];
};
export type Link = {
  client: Client;
  nativeId: string;
  title: string;
  branch: string;
  threadId: string;
};
export type Parsed = { sessions: Session[]; links: Link[] };

export function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}
export function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
export function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
export function json(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Expected JSON object");
  return object(value);
}
export function timestamp(value: unknown): number {
  return typeof value === "number"
    ? number(value)
    : Date.parse(string(value)) || 0;
}
export function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value
      .map((v) => string(object(v).text))
      .filter(Boolean)
      .join("\n");
  return value === undefined || value === null ? "" : JSON.stringify(value);
}
export function role(value: unknown): Role {
  return value === "assistant" || value === "system" || value === "thinking"
    ? value
    : "user";
}
export function session(client: Client, nativeId: string): Session {
  return {
    client,
    nativeId,
    title: "",
    cwd: "",
    repo: "",
    branch: "",
    model: "",
    provider: "",
    started: 0,
    updated: 0,
    tokens: 0,
    parentId: "",
    kind: "root",
    t3ThreadId: "",
    items: [],
  };
}
export function item(
  time: number,
  role: Role,
  body: string,
  pointer: Pointer,
  tool = "",
  callId = "",
): Item {
  return {
    time,
    role,
    body: body.slice(0, role.startsWith("tool") ? 2048 : 8192),
    bodyLength: body.length,
    pointer,
    tool,
    callId,
  };
}
