/**
 * Uniform error responses (RFC 9457 application/problem+json).
 *
 * Nothing from the original error (message, stack, SQL, upstream body) reaches the client
 * unless it is a ProblemError we created with a fixed, safe title.
 */

import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { hasZodFastifySchemaValidationErrors } from "fastify-type-provider-zod";
import { ProblemError, problems, type FieldError } from "@lim/core";

const PROBLEM_BASE = "https://lead-integration-middleware/problems/";

export function sendProblem(request: FastifyRequest, reply: FastifyReply, problem: ProblemError) {
  if (problem.extras.retryAfterSeconds !== undefined) {
    reply.header("retry-after", String(Math.max(1, Math.ceil(problem.extras.retryAfterSeconds))));
  }
  return reply
    .code(problem.status)
    .type("application/problem+json")
    .send({
      type: PROBLEM_BASE + problem.type,
      title: problem.title,
      status: problem.status,
      ...(problem.extras.detail ? { detail: problem.extras.detail } : {}),
      ...(problem.extras.errors ? { errors: problem.extras.errors } : {}),
      request_id: request.id,
    });
}

/** "/customer/phone" -> "customer.phone"; root -> "(body)" */
function pointerToPath(pointer: string | undefined): string {
  const p = (pointer ?? "").replace(/^\//, "").split("/").filter(Boolean).join(".");
  return p || "(body)";
}

function toProblem(error: FastifyError | Error): ProblemError {
  if (error instanceof ProblemError) return error;

  if (hasZodFastifySchemaValidationErrors(error)) {
    const errors: FieldError[] = error.validation.map((v) => {
      const issue = (v.params as { issue?: { code?: string; path?: PropertyKey[] } } | undefined)
        ?.issue;
      const path = issue?.path?.length
        ? issue.path.map(String).join(".")
        : pointerToPath(v.instancePath);
      return { path, code: issue?.code ?? v.keyword ?? "invalid" };
    });
    return problems.validation(errors);
  }

  const code = (error as FastifyError).code;
  switch (code) {
    case "FST_ERR_CTP_INVALID_MEDIA_TYPE":
      return problems.unsupportedMediaType();
    case "FST_ERR_CTP_BODY_TOO_LARGE":
      return problems.payloadTooLarge();
    case "FST_ERR_CTP_EMPTY_JSON_BODY":
    case "FST_ERR_CTP_INVALID_JSON_BODY":
    case "FST_ERR_CTP_INVALID_CONTENT_LENGTH":
      return problems.badRequest("Body is not valid JSON");
  }
  if (error instanceof SyntaxError) return problems.badRequest("Body is not valid JSON");

  const status = (error as FastifyError).statusCode;
  if (status === 400) return problems.badRequest();
  if (status === 404) return problems.notFound();
  return problems.internal();
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const problem = toProblem(error);
    if (problem.status >= 500) {
      request.log.error({ err: error }, "request failed");
    } else {
      request.log.info({ status: problem.status, type: problem.type }, "request rejected");
    }
    return sendProblem(request, reply, problem);
  });

  app.setNotFoundHandler((request, reply) => sendProblem(request, reply, problems.notFound()));
}
