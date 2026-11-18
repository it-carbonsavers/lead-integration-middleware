/**
 * Shared pino logger options.
 *
 * PII and credentials are redacted at the logger level so a careless log line cannot leak them.
 * Add new sensitive field names to REDACT_PATHS rather than relying on call sites.
 */

import type { LoggerOptions } from "pino";
import type { Env } from "./env.js";

const SENSITIVE_KEYS = [
  "email",
  "phone",
  "mobile",
  "first_name",
  "last_name",
  "firstName",
  "lastName",
  "address",
  "line1",
  "postcode",
  "password",
  "secret",
  "token",
  "apiKey",
  "api_key",
];

export const REDACT_PATHS: string[] = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers['x-lim-signature']",
  "res.headers['set-cookie']",
  "headers.authorization",
  "authorization",
  "body",
  "req.body",
  "payload",
  "customer",
  "*.customer",
  ...SENSITIVE_KEYS,
  ...SENSITIVE_KEYS.map((k) => `*.${k}`),
];

/**
 * Request log entries keep the path but drop the query string: admin searches put e-mail
 * addresses and phone numbers in the query (?q=...), which must never reach the logs.
 */
export function safeRequestSerializer(req: {
  method?: string;
  url?: string;
  ip?: string;
  socket?: { remoteAddress?: string };
}) {
  const url = req.url ?? "";
  const q = url.indexOf("?");
  return {
    method: req.method,
    url: q === -1 ? url : `${url.slice(0, q)}?[query omitted]`,
    remoteAddress: req.ip ?? req.socket?.remoteAddress,
  };
}

export function loggerOptions(
  env: Pick<Env, "LOG_LEVEL" | "NODE_ENV">,
  name: string,
): LoggerOptions {
  return {
    name,
    level: env.LOG_LEVEL,
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
    serializers: { req: safeRequestSerializer },
    ...(env.NODE_ENV === "development"
      ? { transport: { target: "pino-pretty", options: { colorize: true } } }
      : {}),
  };
}
