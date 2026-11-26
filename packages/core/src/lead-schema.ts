/**
 * Canonical lead submission schema, version 1 (what every provider sends to POST /v1/leads).
 *
 * Field list is the working assumption from the architecture proposal §6.2 (open question Q6):
 * adjust here once the client confirms mandatory fields. Unknown fields are rejected (strict),
 * so providers find mistakes immediately instead of data silently disappearing.
 */

import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";
import { z } from "zod";
import type { FieldError } from "./problems.js";

// Strip control characters (keeping \n and \t where multi-line text is allowed) and normalise Unicode.
// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const CONTROL_INCL_NEWLINES = /[\u0000-\u001F\u007F]/g;

const text = (max: number) =>
  z
    .string()
    .transform((v) => v.normalize("NFC").replace(CONTROL_INCL_NEWLINES, "").trim())
    .pipe(z.string().min(1).max(max));

const multiline = (max: number) =>
  z
    .string()
    .transform((v) => v.normalize("NFC").replace(CONTROL, "").trim())
    .pipe(z.string().max(max));

const reference = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^[A-Za-z0-9._:/-]+$/, { message: "only letters, digits and . _ : / -" });

const isoDateTime = z.iso.datetime({ offset: true });

export const leadSubmissionSchema = z.strictObject({
  schema_version: z.literal("1"),
  external_lead_id: reference(100),
  transferred_at: isoDateTime,
  customer: z.strictObject({
    first_name: text(100),
    last_name: text(100),
    phone: z.string().trim().min(6).max(32),
    email: z.string().trim().toLowerCase().pipe(z.email().max(254)).optional(),
    address: z
      .strictObject({
        line1: text(200),
        line2: text(200).optional(),
        city: text(100).optional(),
        state: text(50).optional(),
        postcode: z
          .string()
          .trim()
          .regex(/^[A-Za-z0-9 -]{3,10}$/)
          .optional(),
        country: z
          .string()
          .trim()
          .toUpperCase()
          .regex(/^[A-Z]{2}$/, { message: "ISO 3166 alpha-2" })
          .optional(),
      })
      .optional(),
  }),
  agent: z.strictObject({
    external_id: reference(100),
    name: text(200).optional(),
    email: z.string().trim().toLowerCase().pipe(z.email().max(254)).optional(),
  }),
  campaign: text(200).optional(),
  product_interest: text(100).optional(),
  energy_plan: text(200).optional(),
  consent: z.strictObject({
    verbal_consent: z.boolean(),
    captured_at: isoDateTime.optional(),
    recording_ref: reference(200).optional(),
  }),
  notes: multiline(2000).optional(),
  extra: z
    .record(
      z.string().regex(/^[A-Za-z0-9_]{1,64}$/),
      z.union([z.string().max(500), z.number(), z.boolean(), z.null()]),
    )
    .refine((o) => Object.keys(o).length <= 30, { message: "at most 30 keys" })
    .optional(),
});

export type LeadSubmission = z.infer<typeof leadSubmissionSchema>;

/** Validated + normalised lead, ready to store. */
export interface NormalisedLead extends LeadSubmission {
  customer: LeadSubmission["customer"] & {
    /** E.164, e.g. +61412345678 */
    phone: string;
  };
  transferredAt: Date;
  consentCapturedAt: Date | null;
}

export type NormaliseResult =
  { ok: true; lead: NormalisedLead } | { ok: false; errors: FieldError[] };

const MAX_CLOCK_SKEW_MS = 5 * 60_000;

/**
 * Validates and normalises a raw submission. Errors carry path + code only, never values.
 */
export function normaliseLeadSubmission(
  raw: unknown,
  opts: { defaultPhoneRegion: string; now?: Date },
): NormaliseResult {
  const parsed = leadSubmissionSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => ({
        path: i.path.length ? i.path.map(String).join(".") : "(body)",
        code: i.code === "unrecognized_keys" ? "unknown_field" : i.code,
      })),
    };
  }
  const input = parsed.data;
  const errors: FieldError[] = [];
  const now = (opts.now ?? new Date()).getTime();

  const region = (input.customer.address?.country ?? opts.defaultPhoneRegion) as CountryCode;
  const phone = parsePhoneNumberFromString(input.customer.phone, region);
  if (!phone || !phone.isValid()) errors.push({ path: "customer.phone", code: "invalid_phone" });

  const transferredAt = new Date(input.transferred_at);
  if (transferredAt.getTime() > now + MAX_CLOCK_SKEW_MS) {
    errors.push({ path: "transferred_at", code: "in_future" });
  }
  const consentCapturedAt = input.consent.captured_at ? new Date(input.consent.captured_at) : null;
  if (consentCapturedAt && consentCapturedAt.getTime() > now + MAX_CLOCK_SKEW_MS) {
    errors.push({ path: "consent.captured_at", code: "in_future" });
  }
  if (!input.consent.verbal_consent && input.consent.recording_ref) {
    errors.push({ path: "consent.recording_ref", code: "recording_without_consent" });
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    lead: {
      ...input,
      customer: { ...input.customer, phone: phone!.number },
      transferredAt,
      consentCapturedAt,
    },
  };
}

/** A phone number in E.164 form, or null when it is not a valid number. */
export function toE164(raw: string | null | undefined, defaultRegion: string): string | null {
  if (!raw) return null;
  const phone = parsePhoneNumberFromString(raw, defaultRegion as CountryCode);
  return phone?.isValid() ? phone.number : null;
}
