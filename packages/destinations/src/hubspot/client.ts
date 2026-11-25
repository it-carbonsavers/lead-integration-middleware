/**
 * Minimal HubSpot HTTP client shared by the destination adapter (writes) and the outcome reader
 * (reads). Refuses every call unless HUBSPOT_ENABLED is true and a token is configured.
 * Retries 429/502/503/504 a few times in-call; error bodies are never stored or logged.
 */

import { DestinationError } from "@lim/core";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface HubSpotClientOptions {
  enabled: boolean;
  baseUrl: string;
  token: string | undefined;
  fetch?: FetchLike;
  /** In-call retries for 429/502/503/504 before handing back to the job queue. */
  inCallRetries?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const TRANSIENT = new Set([429, 502, 503, 504]);

export class HubSpotClient {
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: HubSpotClientOptions) {
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  guard(): string {
    if (!this.opts.enabled) {
      throw new DestinationError(
        "permanent",
        "hubspot_disabled",
        "HubSpot delivery is disabled (HUBSPOT_ENABLED=false)",
      );
    }
    if (!this.opts.token) {
      throw new DestinationError(
        "permanent",
        "credential_missing",
        "HubSpot token is not configured",
      );
    }
    return this.opts.token;
  }

  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const token = this.guard();
    const retries = this.opts.inCallRetries ?? 2;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(this.opts.baseUrl + path, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
        });
      } catch {
        if (attempt < retries) {
          await this.sleep(500 * 2 ** attempt);
          continue;
        }
        throw new DestinationError("retryable", "network_error", "HubSpot could not be reached");
      }

      if (res.ok) return (await res.json()) as T;

      const retryAfter = Number(res.headers.get("retry-after"));
      if (TRANSIENT.has(res.status) && attempt < retries) {
        const waitMs =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter, 10) * 1000
            : 1000 * 2 ** attempt;
        await this.sleep(waitMs);
        continue;
      }
      throw await toDestinationError(
        res,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
      );
    }
  }
}

export class HubSpotHttpError extends DestinationError {
  constructor(
    cls: ConstructorParameters<typeof DestinationError>[0],
    code: string,
    message: string,
    status: number,
    retryAfter: number | null,
    public readonly existingId: string | null,
  ) {
    super(cls, code, message, status, retryAfter);
  }
}

/**
 * Builds a safe error: status, HubSpot's error category and a fixed message. HubSpot error bodies
 * can echo submitted values (personal data), so the body itself is never stored or logged.
 */
async function toDestinationError(
  res: Response,
  retryAfter: number | null,
): Promise<DestinationError> {
  let category = "";
  let existingId: string | null = null;
  try {
    const body = (await res.json()) as { category?: unknown; message?: unknown };
    if (typeof body.category === "string" && /^[A-Z_]{1,64}$/.test(body.category))
      category = body.category;
    if (res.status === 409 && typeof body.message === "string") {
      existingId = /Existing ID:\s*(\d+)/.exec(body.message)?.[1] ?? null;
    }
  } catch {
    // non-JSON body: ignore
  }
  const code = `hubspot_${res.status}${category ? `_${category.toLowerCase()}` : ""}`;
  if (res.status === 429) {
    return new HubSpotHttpError(
      "rate_limited",
      code,
      "HubSpot rate limit reached",
      429,
      retryAfter,
      null,
    );
  }
  if (res.status >= 500) {
    return new HubSpotHttpError(
      "retryable",
      code,
      "HubSpot server error",
      res.status,
      retryAfter,
      null,
    );
  }
  if (res.status === 401 || res.status === 403) {
    return new HubSpotHttpError(
      "permanent",
      code,
      "HubSpot rejected the credentials or scopes",
      res.status,
      null,
      null,
    );
  }
  return new HubSpotHttpError(
    "permanent",
    code,
    "HubSpot rejected the request",
    res.status,
    null,
    existingId,
  );
}
