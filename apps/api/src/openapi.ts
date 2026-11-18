/**
 * OpenAPI 3.1 description of the provider API, generated from the same zod schemas the API
 * validates with, so the document cannot drift from the implementation.
 * Served at GET /openapi.json and written to docs/openapi.json by `npm run openapi`.
 */

import { z } from "zod";
import { leadSubmissionSchema } from "@lim/core";
import { leadListSchema, leadStatusSchema } from "./routes/v1/leads.js";

const jsonSchema = (s: z.ZodType) => z.toJSONSchema(s, { io: "input", unrepresentable: "any" });

const submitResponse = z.object({
  lead_ref: z.string().describe("Our reference for the lead, e.g. LD-01JCZ8M4Q7X3..."),
  external_lead_id: z.string(),
  status: z.string(),
  duplicate: z
    .boolean()
    .describe("true when this request repeated an earlier one; nothing new was created"),
  possible_duplicate: z
    .boolean()
    .describe("same phone or email seen recently (any provider); lead still accepted"),
  received_at: z.string(),
});

const problem = {
  type: "object",
  properties: {
    type: { type: "string" },
    title: { type: "string" },
    status: { type: "integer" },
    detail: { type: "string" },
    errors: {
      type: "array",
      items: { type: "object", properties: { path: { type: "string" }, code: { type: "string" } } },
    },
    request_id: { type: "string" },
  },
  required: ["type", "title", "status", "request_id"],
};

const problemResponse = (description: string) => ({
  description,
  content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } },
});

const commonErrors = {
  "401": problemResponse(
    "Missing, malformed, unknown, revoked or expired API key (same response for all)",
  ),
  "403": problemResponse("Platform suspended, or source IP not in the platform's allow-list"),
  "429": problemResponse("Rate limit exceeded; see Retry-After header"),
  "503": problemResponse("Temporarily unavailable; safe to retry"),
};

export function buildOpenApiDocument() {
  return {
    openapi: "3.1.0",
    info: {
      title: "Lead Integration Middleware: Provider API",
      version: "1.0.0",
      description:
        "One-way API for lead providers to submit live-transfer leads. LOCAL DEVELOPMENT BUILD: " +
        "no data leaves the machine; deliveries go to a local mock destination.",
    },
    servers: [{ url: "http://localhost:3000", description: "Local development" }],
    security: [{ apiKey: [] }],
    components: {
      securitySchemes: {
        apiKey: {
          type: "http",
          scheme: "bearer",
          description: "Per-platform API key: lim_<env>_<prefix>_<secret>",
        },
      },
      schemas: {
        LeadSubmission: jsonSchema(leadSubmissionSchema),
        SubmitResponse: jsonSchema(submitResponse),
        LeadStatus: jsonSchema(leadStatusSchema),
        LeadList: jsonSchema(leadListSchema),
        Problem: problem,
      },
    },
    paths: {
      "/v1/ping": {
        get: {
          summary: "Check connectivity and credentials",
          responses: { "200": { description: "Authenticated" }, ...commonErrors },
        },
      },
      "/v1/leads": {
        post: {
          summary: "Submit one lead",
          parameters: [
            {
              name: "Idempotency-Key",
              in: "header",
              required: false,
              schema: { type: "string", pattern: "^[A-Za-z0-9._:-]{8,128}$" },
              description:
                "Optional. Repeating a request with the same key returns the original answer.",
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/LeadSubmission" } },
            },
          },
          responses: {
            "202": {
              description: "Accepted and queued for delivery",
              headers: { Location: { schema: { type: "string" } } },
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/SubmitResponse" } },
              },
            },
            "200": {
              description:
                "Duplicate: the same external_lead_id (or Idempotency-Key) was already received. The original lead is returned; nothing is delivered again.",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/SubmitResponse" } },
              },
            },
            "400": problemResponse("Malformed JSON or invalid Idempotency-Key"),
            "409": problemResponse("Idempotency-Key already used for a different lead"),
            "413": problemResponse("Body larger than 64 KB"),
            "415": problemResponse("Content-Type is not application/json"),
            "422": problemResponse(
              "Validation failed; `errors` lists field path and code (never values)",
            ),
            ...commonErrors,
          },
        },
        get: {
          summary: "List your own leads (newest first)",
          parameters: [
            {
              name: "external_lead_id",
              in: "query",
              required: false,
              schema: { type: "string" },
              description: "Your own lead id (exact)",
            },
            { name: "status", in: "query", required: false, schema: { type: "string" } },
            {
              name: "received_from",
              in: "query",
              required: false,
              schema: { type: "string", format: "date-time" },
            },
            {
              name: "received_to",
              in: "query",
              required: false,
              schema: { type: "string", format: "date-time" },
            },
            {
              name: "page",
              in: "query",
              required: false,
              schema: { type: "integer", minimum: 1, default: 1 },
            },
            {
              name: "page_size",
              in: "query",
              required: false,
              schema: { type: "integer", minimum: 1, maximum: 200, default: 50 },
            },
          ],
          responses: {
            "200": {
              description: "Page of your leads",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/LeadList" } },
              },
            },
            ...commonErrors,
          },
        },
      },
      "/v1/leads/{lead_ref}": {
        get: {
          summary: "Status of one of your leads",
          parameters: [
            { name: "lead_ref", in: "path", required: true, schema: { type: "string" } },
          ],
          responses: {
            "200": {
              description: "Lead status",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/LeadStatus" } },
              },
            },
            "404": problemResponse("No lead with that reference from your platform"),
            ...commonErrors,
          },
        },
      },
    },
  };
}
