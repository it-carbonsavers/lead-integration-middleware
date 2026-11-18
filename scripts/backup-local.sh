#!/usr/bin/env bash
# Local backup and restore drill. LOCAL ONLY (uses the docker-compose database).
#
#   bash scripts/backup-local.sh            back up database + encrypted recordings
#   bash scripts/backup-local.sh --verify   ...then restore into a scratch database and compare
#
# Backups go to .local/backups/ (git-ignored). They contain personal data (encrypted fields and
# encrypted recordings): keep them as protected as the live data.
# IMPORTANT: the encryption keys in .env (APP_ENCRYPTION_KEY, APP_BLIND_INDEX_KEY) are NOT in
# the backup. Without them, encrypted fields and recordings cannot be read. Back them up
# separately, in a password manager or secret store, never next to the database dump.
set -euo pipefail
cd "$(dirname "$0")/.."
TS=$(date -u +%Y%m%dT%H%M%SZ)
OUT=.local/backups
mkdir -p "$OUT" && chmod 700 "$OUT"
DB=lead_integration
PSQL=(docker compose exec -T postgres psql -U lim -v ON_ERROR_STOP=1)

echo "== Backing up database ($DB)"
docker compose exec -T postgres pg_dump -U lim -Fc "$DB" > "$OUT/db-$TS.dump"
echo "== Backing up encrypted recordings"
tar -czf "$OUT/recordings-$TS.tgz" -C .local storage 2>/dev/null || tar -czf "$OUT/recordings-$TS.tgz" -T /dev/null
chmod 600 "$OUT"/*-"$TS".*
ls -l "$OUT"/*-"$TS".*

if [[ "${1:-}" == "--verify" ]]; then
  CHECK=lead_integration_restore_check
  echo "== Restoring into scratch database $CHECK"
  "${PSQL[@]}" -d postgres -qc "DROP DATABASE IF EXISTS $CHECK" -c "CREATE DATABASE $CHECK"
  docker compose exec -T postgres pg_restore -U lim -d "$CHECK" --no-owner < "$OUT/db-$TS.dump"
  Q="SELECT (SELECT count(*) FROM leads) leads, (SELECT count(*) FROM submissions) submissions,
            (SELECT count(*) FROM delivery_attempts) attempts, (SELECT count(*) FROM consent_recordings) recordings,
            (SELECT count(*) FROM audit_log) audit, (SELECT count(*) FROM admin_users) users,
            (SELECT max(name) FROM schema_migrations) last_migration"
  LIVE=$("${PSQL[@]}" -d "$DB" -tAc "$Q")
  RESTORED=$("${PSQL[@]}" -d "$CHECK" -tAc "$Q")
  echo "live:     $LIVE"
  echo "restored: $RESTORED"
  echo "== Checking the recordings archive"
  tar -tzf "$OUT/recordings-$TS.tgz" | grep -c '\.bin$' | xargs -I{} echo "recording files in archive: {}"
  "${PSQL[@]}" -d postgres -qc "DROP DATABASE $CHECK"
  if [[ "$LIVE" == "$RESTORED" ]]; then echo "RESULT: restore verified (counts identical)"; else echo "RESULT: MISMATCH (live data may have changed during the drill)"; exit 1; fi
fi
