# Lead Provider Integration Guide

How a lead provider (source platform) sends leads to the Lead Integration Middleware.

> We will send you the API address for your environment. The machine-readable spec is [openapi.json](openapi.json), also served at `GET /openapi.json`.

---

## 1. Overview

1. You receive an API key for your platform (one key per environment).
2. When a customer is live-transferred to a sales agent, you send one `POST /v1/leads` request.
3. We answer straight away with `202 Accepted` and our reference (`lead_ref`). Delivery to the CRM happens afterwards.
4. You can check the status of your own leads at any time.
5. Consent call recordings are delivered separately over SFTP (section 5).

The API is one-way: we do not call you back.

---

## 2. Authentication

Send your key in every request:

```http
Authorization: Bearer lim_<env>_<prefix>_<secret>
```

- Keep the key secret. Do not put it in URLs, logs or client-side code.
- Keys can be rotated: we issue a new key, you switch over, we revoke the old one.
- Optionally your platform can be restricted to fixed source IP addresses.
- All authentication failures return the same `401` response, by design.

Check your setup:

```bash
curl -s $API_URL/v1/ping -H "Authorization: Bearer $KEY"
```

```json
{ "authenticated": true, "platform": "PRV01", "environment": "local", "server_time": "2026-11-17T08:00:00.000Z" }
```

---

## 3. Submitting a lead

`POST /v1/leads` with `Content-Type: application/json` (max 64 KB). Example: [samples/lead.json](samples/lead.json).

| Field | Required | Rules |
|---|---|---|
| `schema_version` | yes | `"1"` |
| `external_lead_id` | yes | Your unique id for this lead. 1–100 chars: letters, digits, `. _ : / -`. Must be unique per platform |
| `transferred_at` | yes | ISO 8601 with offset, e.g. `2026-11-17T09:41:12+11:00`. Not in the future |
| `customer.first_name`, `customer.last_name` | yes | 1–100 chars |
| `customer.phone` | yes | Any common format; national numbers are read as Australian unless `customer.address.country` says otherwise. Stored as E.164 |
| `customer.email` | recommended | Valid email |
| `customer.address` | optional | `line1` (required if address given), `line2`, `city`, `state`, `postcode`, `country` (ISO 3166 alpha-2) |
| `agent.external_id` | yes | Your id for the agent who handled the call |
| `agent.name`, `agent.email` | optional | |
| `campaign`, `product_interest`, `energy_plan` | optional | Free text |
| `consent.verbal_consent` | yes | `true` if verbal consent was captured on the call |
| `consent.captured_at` | optional | ISO 8601 |
| `consent.recording_ref` | optional | Reference that will identify the consent recording file (only with `verbal_consent: true`) |
| `notes` | optional | Up to 2,000 chars |
| `extra` | optional | Up to 30 extra key/value pairs (string ≤ 500 chars, number, boolean, null) |

Unknown fields are rejected, so typos are caught immediately.

The field list is the current working assumption and will be confirmed with the client before go-live.

### Responses

**202 Accepted** (new lead):

```json
{
  "lead_ref": "LD-01M7MA0J0WWY6BQKCKGDY67KH6",
  "external_lead_id": "SAMPLE-0001",
  "status": "queued",
  "duplicate": false,
  "possible_duplicate": false,
  "received_at": "2026-11-17T08:29:40.887Z"
}
```

**200 OK** (you sent this `external_lead_id` before): same body with `"duplicate": true` and the original `lead_ref`. Nothing new is created or delivered, so **retrying is always safe**.

`possible_duplicate: true` means we have seen the same phone or email recently (from any provider). The lead is still accepted and delivered; it is flagged for review.

**Errors** use `application/problem+json`:

```json
{
  "type": "https://lead-integration-middleware/problems/validation",
  "title": "Request failed validation",
  "status": 422,
  "errors": [{ "path": "customer.phone", "code": "invalid_phone" }],
  "request_id": "req_01M7MA0J4SN7CC0EH5KPQKCHY6"
}
```

| Status | Meaning | Retry? |
|---|---|---|
| 400 | Malformed JSON or bad `Idempotency-Key` | No: fix the request |
| 401 | API key missing or invalid | No: check the key |
| 403 | Platform suspended or IP not allowed | No: contact us |
| 409 | `Idempotency-Key` reused for a different lead | No |
| 413 / 415 | Too large / not JSON | No |
| 422 | Validation failed (see `errors`) | No: fix the data |
| 429 | Rate limit (default 60 per minute per platform) | Yes, after `Retry-After` seconds |
| 5xx / timeout | Temporary problem | Yes, with back-off. Duplicates are handled safely |

Quote the `request_id` when asking us about a request.

### Idempotency-Key (optional)

Send `Idempotency-Key: <8–128 chars>` to make a request safely repeatable even before you have stored your `external_lead_id`. Repeating the same key returns the original answer.

---

## 4. Checking status

One lead, by our reference:

```bash
curl -s $API_URL/v1/leads/LD-01M7MA0J0WWY6BQKCKGDY67KH6 -H "Authorization: Bearer $KEY"
```

```json
{
  "lead_ref": "LD-01M7MA0J0WWY6BQKCKGDY67KH6",
  "external_lead_id": "SAMPLE-0001",
  "status": "delivered",
  "consent_status": "awaiting_recording",
  "possible_duplicate": false,
  "received_at": "2026-11-17T08:29:40.887Z",
  "delivered_at": "2026-11-17T08:29:47.064Z"
}
```

Your leads as a list (newest first, paged). Filters: `external_lead_id`, `status`, `received_from`, `received_to` (ISO 8601), `page`, `page_size` (max 200):

```bash
curl -s "$API_URL/v1/leads?status=delivered&page_size=50" -H "Authorization: Bearer $KEY"
curl -s "$API_URL/v1/leads?external_lead_id=SAMPLE-0001" -H "Authorization: Bearer $KEY"
```

```json
{ "items": [ { "lead_ref": "LD-…", "external_lead_id": "SAMPLE-0001", "status": "delivered", "consent_status": "awaiting_recording", "possible_duplicate": false, "received_at": "…", "delivered_at": "…" } ], "total": 1, "page": 1, "page_size": 50 }
```

`status`: `queued` → `delivering` → `delivered`, or `retry_scheduled` (temporary CRM problem, retried automatically), `failed` / `dead_letter` (being handled by our operators). You only ever see your own leads.

`consent_status`: `not_captured` (no verbal consent), `awaiting_recording`, and later `received` / `matched` once recordings arrive.

---

## 5. Delivering consent recordings (SFTP)

You upload recordings to **our SFTP server**:

- We give you a host, port, username and our server's host key fingerprint (check it on first connect).
- You log in with your own SSH key (send us the **public** key only), or with a password we generate and send you securely. Your account accepts only the method agreed.
- You can upload and list files in your own folder. You cannot download, overwrite, delete or create folders. Uploading to a temporary name and renaming it when complete is supported.
- Files are picked up within about a minute and then removed from the folder.

**Files**

- Formats `.mp3`, `.wav`, `.m4a` or `.ogg`, maximum 50 MB. Content is checked against the extension.
- One recording per file, named either:
  - `<recording_ref>.<ext>`, using the `consent.recording_ref` you sent with the lead (recommended), or
  - `<YOUR_CODE>_<external_lead_id>_<YYYYMMDDTHHMMSSZ>.<ext>`, e.g. `PRV01_TRX-2026-000123_20261117T094002Z.wav`
- Letters, digits, `.`, `_` and `-` only.

A recording may arrive before or after its lead; it is matched automatically when both are present. The lead's `consent_status` then becomes `matched`, which you can see through the API or the portal. Rejected files (wrong type, too large, bad name) are listed in the portal with the reason. Leads still waiting for a recording after 48 hours show `overdue`.

## 6. Provider portal (web)

Your team can also be given logins to a web portal showing the same information: your leads, their delivery and consent status, rejected submissions with the reasons, your delivered recordings and transfer log, and per-agent results, with CSV export. Ask us to create logins; you only ever see your own platform's data.

## 7. Sample script

[samples/requests.sh](samples/requests.sh) runs ping, submit, duplicate replay, status lookups and a validation error.
