/**
 * Recordings can be attached to a lead chosen at upload time, and providers can link their own
 * unmatched recordings:
 *  - consent_recordings.matched_by allows 'uploader' (lead chosen by whoever uploaded the file)
 *  - provider_viewer gets recordings.link (the API limits it to the provider's own files and leads)
 */

import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$
    DECLARE c text;
    BEGIN
      FOR c IN SELECT conname FROM pg_constraint
               WHERE conrelid = 'consent_recordings'::regclass AND contype = 'c'
                 AND pg_get_constraintdef(oid) LIKE '%matched_by%'
      LOOP
        EXECUTE format('ALTER TABLE consent_recordings DROP CONSTRAINT %I', c);
      END LOOP;
    END $$;
    ALTER TABLE consent_recordings ADD CONSTRAINT consent_recordings_matched_by_check
      CHECK (matched_by IN ('recording_ref','naming_convention','external_lead_id','admin','uploader'));
    INSERT INTO role_permissions (role_code, permission)
      SELECT 'provider_viewer', 'recordings.link'
      WHERE EXISTS (SELECT 1 FROM roles WHERE code = 'provider_viewer')
      ON CONFLICT DO NOTHING;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DELETE FROM role_permissions WHERE role_code = 'provider_viewer' AND permission = 'recordings.link';
    UPDATE consent_recordings SET matched_by = 'admin' WHERE matched_by = 'uploader';
    ALTER TABLE consent_recordings DROP CONSTRAINT IF EXISTS consent_recordings_matched_by_check;
    ALTER TABLE consent_recordings ADD CONSTRAINT consent_recordings_matched_by_check
      CHECK (matched_by IN ('recording_ref','naming_convention','external_lead_id','admin'));
  `.execute(db);
}
