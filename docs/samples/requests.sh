#!/usr/bin/env bash
# Sample requests against the LOCAL API. Requires: API running, `npm run seed` done, jq installed.
# Usage: bash docs/samples/requests.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
BASE=http://localhost:3000
KEY=$(jq -r '.keys.PRV01.token' .local/provider-keys.json)
EXT="SAMPLE-$(date +%s)"

echo "== ping"; curl -s "$BASE/v1/ping" -H "Authorization: Bearer $KEY"; echo

echo "== submit (expect 202)"
BODY=$(jq --arg ext "$EXT" '.external_lead_id=$ext | .consent.recording_ref=$ext' docs/samples/lead.json)
REF=$(curl -s "$BASE/v1/leads" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: idem-$EXT" -d "$BODY" | tee /dev/stderr | jq -r .lead_ref); echo

echo "== same lead again (expect 200, duplicate: true)"
curl -s "$BASE/v1/leads" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d "$BODY"; echo

echo "== status by our reference"; sleep 2
curl -s "$BASE/v1/leads/$REF" -H "Authorization: Bearer $KEY"; echo

echo "== find by your id"
curl -s "$BASE/v1/leads?external_lead_id=$EXT" -H "Authorization: Bearer $KEY"; echo

echo "== list your latest leads (page of 5)"
curl -s "$BASE/v1/leads?page_size=5" -H "Authorization: Bearer $KEY" | jq '{total, statuses: [.items[].status]}'; echo

echo "== validation error (expect 422)"
curl -s "$BASE/v1/leads" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"schema_version":"1","external_lead_id":"BAD-1"}'; echo
