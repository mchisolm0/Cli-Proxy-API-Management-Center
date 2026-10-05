// JSON contract between the history server (server/) and the UI (src/).
// Dependency-free so the UI type-checks without Bun types. Server handlers
// must return these shapes; change both sides together.

export type FailureClass =
  | "auth"
  | "quota"
  | "upstream"
  | "transport"
  | "client"
  | "other";
export type ClassCounts = Record<FailureClass, number>;
export type Percentiles = { p50: number | null; p95: number | null };
export type HealthWindow = "1h" | "24h" | "7d";

type Traffic = {
  requests: number;
  failures: number;
  failureRate: number;
  latency: Percentiles;
  ttft: Percentiles;
  tokens: number;
  websocket: number;
  http: number;
  unknown: number;
  errorCounts: ClassCounts;
  usageErrorCounts: ClassCounts;
};

/** Raw rate-limit header readings CLIProxyAPI attaches to a credential. */
export type QuotaObservation = {
  observed_at?: string;
  signals?: Record<string, string>;
};

export type CredentialState = {
  provider: string;
  authIndex: string;
  name: string;
  status: string;
  message: string;
  unavailable: boolean;
  disabled: boolean;
  /** Epoch ms, 0 when unknown. */
  nextRetry: number;
  lastRefresh: number;
  cooldowns: unknown[];
  quota: QuotaObservation | null;
  modelQuotas: Record<string, QuotaObservation>;
};

export type CredentialHealth = Traffic & {
  authIndex: string;
  /** Epoch ms of the latest auth-files observation. */
  observed: number;
  state: CredentialState | null;
};

export type ProviderHealth = Traffic & {
  provider: string;
  /** Credential count per auth status, e.g. { active: 1, error: 1 }. */
  authSummary: Record<string, number>;
  credentials: CredentialHealth[];
};

export type HealthResponse = {
  since: number;
  now: number;
  providers: ProviderHealth[];
};

export type ProblemExample = {
  time: number;
  payload: Record<string, unknown>;
  outcome: string;
};

export type Problem = {
  key: string;
  source: string;
  provider: string;
  model: string;
  category: FailureClass;
  code: string;
  count: number;
  firstSeen: number;
  lastSeen: number;
  affectedSessions: number;
  retriedAttempts: number;
  inferredFinalFailures: number;
  unresolvedAttempts: number;
  attemptErrors: number;
  fix: string;
  examples: ProblemExample[];
  /** Up to 20 indexed sessions; sessionCount is the deduplicated total. */
  sessions: SessionSummary[];
  sessionCount: number;
  unindexedSessionCount: number;
};

export type ProblemsResponse = {
  since: number;
  now: number;
  problems: Problem[];
};

export type SessionSummary = {
  id: number;
  host: string;
  client: string;
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
  kind: string;
  t3ThreadId: string;
  snapshot: string;
  snapshotTime: number;
  itemCount: number;
};

export type SearchResponse = { sessions: SessionSummary[]; total: number };

export type SessionItem = {
  id: number;
  sessionId: number;
  seq: number;
  time: number;
  role: string;
  tool: string;
  callId: string;
  body: string;
  bodyLength: number;
};

export type SessionDetail = { session: SessionSummary; items: SessionItem[] };
export type FiltersResponse = { hosts: string[]; models: string[] };
export type RawRecordResponse = { record: unknown };
