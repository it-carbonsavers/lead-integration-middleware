/**
 * RFC 9457 problem details.
 *
 * Every error leaving the API is a ProblemError rendered as application/problem+json.
 * Titles and details are fixed, safe strings: never upstream bodies, SQL, stack traces,
 * credentials or personal data.
 */

export interface FieldError {
  /** Dotted path into the request body, e.g. "customer.phone" */
  path: string;
  /** Machine-readable code, e.g. "required", "invalid_type" */
  code: string;
}

export type ProblemType =
  | "bad-request"
  | "unauthorized"
  | "forbidden"
  | "not-found"
  | "method-not-allowed"
  | "payload-too-large"
  | "unsupported-media-type"
  | "conflict"
  | "validation"
  | "rate-limited"
  | "unavailable"
  | "internal";

export class ProblemError extends Error {
  constructor(
    public readonly status: number,
    public readonly type: ProblemType,
    public readonly title: string,
    public readonly extras: {
      detail?: string;
      errors?: FieldError[];
      retryAfterSeconds?: number;
    } = {},
  ) {
    super(title);
    this.name = "ProblemError";
  }
}

export const problems = {
  badRequest: (detail?: string) =>
    new ProblemError(400, "bad-request", "Malformed request", detail ? { detail } : {}),
  unauthorized: () => new ProblemError(401, "unauthorized", "Invalid or missing API credentials"),
  forbidden: (detail?: string) =>
    new ProblemError(403, "forbidden", "Access denied", detail ? { detail } : {}),
  notFound: () => new ProblemError(404, "not-found", "Resource not found"),
  payloadTooLarge: () => new ProblemError(413, "payload-too-large", "Request body too large"),
  unsupportedMediaType: () =>
    new ProblemError(415, "unsupported-media-type", "Content-Type must be application/json"),
  conflict: (detail: string) =>
    new ProblemError(409, "conflict", "Request conflicts with an earlier one", { detail }),
  validation: (errors: FieldError[]) =>
    new ProblemError(422, "validation", "Request failed validation", { errors }),
  rateLimited: (retryAfterSeconds: number) =>
    new ProblemError(429, "rate-limited", "Too many requests", { retryAfterSeconds }),
  unavailable: () =>
    new ProblemError(503, "unavailable", "Service temporarily unavailable, retry later"),
  internal: () => new ProblemError(500, "internal", "Unexpected error"),
};
