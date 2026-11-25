/**
 * Consent recordings can also be uploaded in the web portal (as well as over SFTP):
 *  - transfer_jobs.mode allows 'portal_upload'
 *  - new permission recordings.upload for providers, operators and admins
 */

import { sql, type Kysely } from "kysely";

const ROLES_WITH_UPLOAD = ["super_admin", "admin", "operator", "provider_viewer"];

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    DO $$
    DECLARE c text;
    BEGIN
      FOR c IN SELECT conname FROM pg_constraint
               WHERE conrelid = 'transfer_jobs'::regclass AND contype = 'c'
                 AND pg_get_constraintdef(oid) LIKE '%mode%'
      LOOP
        EXECUTE format('ALTER TABLE transfer_jobs DROP CONSTRAINT %I', c);
      END LOOP;
    END $$;
    ALTER TABLE transfer_jobs ADD CONSTRAINT transfer_jobs_mode_check
      CHECK (mode IN ('sftp_hosted', 'sftp_pull', 'portal_upload'));
  `.execute(db);
  for (const role of ROLES_WITH_UPLOAD) {
    await sql`
      INSERT INTO role_permissions (role_code, permission)
      SELECT ${role}, 'recordings.upload' WHERE EXISTS (SELECT 1 FROM roles WHERE code = ${role})
      ON CONFLICT DO NOTHING
    `.execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DELETE FROM role_permissions WHERE permission = 'recordings.upload';
    UPDATE transfer_jobs SET mode = 'sftp_hosted' WHERE mode = 'portal_upload';
    ALTER TABLE transfer_jobs DROP CONSTRAINT IF EXISTS transfer_jobs_mode_check;
    ALTER TABLE transfer_jobs ADD CONSTRAINT transfer_jobs_mode_check
      CHECK (mode IN ('sftp_hosted', 'sftp_pull'));
  `.execute(db);
}
