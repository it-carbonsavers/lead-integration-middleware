/**
 * Provider portal logins: an admin user can belong to one lead provider (platform).
 * Such users get the provider_viewer role and only ever see that provider's data.
 */

import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE admin_users ADD COLUMN platform_id uuid REFERENCES platforms(id);
    CREATE INDEX admin_users_platform_idx ON admin_users (platform_id) WHERE platform_id IS NOT NULL;

    INSERT INTO roles (code, description)
      VALUES ('provider_viewer', 'Lead provider portal: own leads, submissions and reports only')
      ON CONFLICT (code) DO NOTHING;
    INSERT INTO role_permissions (role_code, permission)
      VALUES ('provider_viewer', 'leads.read'), ('provider_viewer', 'leads.export'), ('provider_viewer', 'reports.read')
      ON CONFLICT DO NOTHING;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DELETE FROM admin_user_roles WHERE role_code = 'provider_viewer';
    DELETE FROM role_permissions WHERE role_code = 'provider_viewer';
    DELETE FROM roles WHERE code = 'provider_viewer';
    DROP INDEX IF EXISTS admin_users_platform_idx;
    ALTER TABLE admin_users DROP COLUMN IF EXISTS platform_id;
  `.execute(db);
}
