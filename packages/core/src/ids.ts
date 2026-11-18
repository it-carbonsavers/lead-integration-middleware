import { ulid } from "ulidx";

/** Public lead reference returned to providers, e.g. LD-01JCZ8M4Q7X3... (sortable by time). */
export const newLeadRef = (): string => `LD-${ulid()}`;

/** Request id attached to every request, log line, audit entry and error response. */
export const newRequestId = (): string => `req_${ulid()}`;

const INBOUND_REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

/** Accepts a caller-supplied X-Request-Id only if it is short and safe to log. */
export function acceptRequestId(value: unknown): string | null {
  return typeof value === "string" && INBOUND_REQUEST_ID.test(value) ? value : null;
}
