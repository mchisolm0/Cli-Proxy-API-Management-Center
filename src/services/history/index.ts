// Client for the history server's /api routes (session search, health,
// problems). Same origin as the UI; no management key involved.
import type {
  FiltersResponse,
  HealthResponse,
  HealthWindow,
  ProblemsResponse,
  RawRecordResponse,
  SearchResponse,
  SessionDetail,
} from '../../../server/api';

export type * from '../../../server/api';

export type SearchParams = {
  q?: string;
  client?: string;
  host?: string;
  model?: string;
  cwd?: string;
  from?: string;
  to?: string;
  offset?: number;
};

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    throw new Error(
      typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string'
        ? body.error
        : `${path} returned ${response.status}`
    );
  }
  return response.json() as Promise<T>;
}

export const historyApi = {
  health: (window: HealthWindow, signal?: AbortSignal) =>
    get<HealthResponse>(`/api/health?window=${window}`, signal),
  problems: (window: HealthWindow, signal?: AbortSignal) =>
    get<ProblemsResponse>(`/api/problems?window=${window}`, signal),
  search: (params: SearchParams, signal?: AbortSignal) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params))
      if (value !== undefined && value !== '') query.set(key, String(value));
    return get<SearchResponse>(`/api/search?${query}`, signal);
  },
  filters: (signal?: AbortSignal) => get<FiltersResponse>('/api/filters', signal),
  session: (id: number, signal?: AbortSignal) => get<SessionDetail>(`/api/sessions/${id}`, signal),
  raw: (itemId: number, signal?: AbortSignal) =>
    get<RawRecordResponse>(`/api/items/${itemId}/raw`, signal),
};
