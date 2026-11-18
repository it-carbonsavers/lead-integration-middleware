/**
 * Browser client for the admin API. All calls go to /admin-api/* on this origin (proxied to the
 * Fastify admin API), carry the session cookie automatically, and send the X-Lim-Admin header
 * on state-changing requests (CSRF guard).
 */

export interface FieldError {
  path: string;
  code: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public title: string,
    public errors: FieldError[] = [],
    public requestId?: string,
  ) {
    super(title);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/admin-api${path}`, {
    method,
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      ...(method !== "GET" ? { "x-lim-admin": "1" } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    cache: "no-store",
  });
  if (res.status === 401 && !path.startsWith("/auth/login") && typeof window !== "undefined") {
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.href = `/login?next=${next}`;
  }
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new ApiError(
      res.status,
      json?.title ?? `Request failed (${res.status})`,
      json?.errors ?? [],
      json?.request_id,
    );
  }
  return json as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
  patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, body),
  put: <T>(path: string, body: unknown) => request<T>("PUT", path, body),
  del: <T>(path: string) => request<T>("DELETE", path),
};

export interface Me {
  id: string;
  email: string;
  name: string | null;
  organisation_id: string | null;
  /** Set for lead-provider portal users (their provider code). */
  platform: string | null;
  roles: string[];
  permissions: string[];
  environment: string;
  hubspot_enabled: boolean;
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
