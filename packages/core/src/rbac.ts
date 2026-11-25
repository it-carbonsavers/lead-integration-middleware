/**
 * Admin roles and permissions (architecture proposal §6.8).
 * The database seeds these; the API checks permissions, never role names.
 */

export const PERMISSIONS = [
  "leads.read",
  "leads.pii_reveal",
  "leads.operate",
  "leads.export",
  "recordings.read",
  "recordings.play",
  "recordings.link",
  "recordings.upload",
  "platforms.manage",
  "agents.manage",
  "destinations.manage",
  "reports.read",
  "users.manage",
  "audit.read",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLES: Record<string, { description: string; permissions: readonly Permission[] }> = {
  super_admin: { description: "Full access including user management", permissions: PERMISSIONS },
  admin: {
    description: "Operate the platform; no user management",
    permissions: PERMISSIONS.filter((p) => p !== "users.manage"),
  },
  compliance: {
    description: "Review leads, consent recordings and audit trail",
    permissions: [
      "leads.read",
      "leads.pii_reveal",
      "recordings.read",
      "recordings.play",
      "audit.read",
    ],
  },
  operator: {
    description: "Day-to-day lead operations (retry, release, link recordings)",
    permissions: [
      "leads.read",
      "leads.pii_reveal",
      "leads.operate",
      "recordings.read",
      "recordings.link",
      "recordings.upload",
    ],
  },
  analyst: {
    description: "Reports and masked lead lists",
    permissions: ["leads.read", "reports.read", "leads.export"],
  },
  provider_viewer: {
    description: "Lead provider portal: own leads, submissions and reports only",
    permissions: [
      "leads.read",
      "leads.export",
      "reports.read",
      "recordings.read",
      "recordings.upload",
      "recordings.link",
    ],
  },
  org_viewer: {
    description: "Future external portal: own organisation's leads only",
    permissions: ["leads.read"],
  },
};

/** Actions written to the audit log. Extend as features land. */
export type AuditAction =
  | "organisation.created"
  | "platform.created"
  | "platform.updated"
  | "platform.suspended"
  | "platform.activated"
  | "platform.credential_issued"
  | "platform.credential_revoked"
  | "destination.created"
  | "destination.updated"
  | "lead.retry_requested"
  | "lead.view"
  | "lead.search"
  | "lead.pii_reveal"
  | "lead.export"
  | "performance.export"
  | "submission.search"
  | "agent.updated"
  | "destination.tested"
  | "report.viewed"
  | "audit.viewed"
  | "admin.login"
  | "admin.login_failed"
  | "admin.logout"
  | "user.created"
  | "user.updated"
  | "user.password_reset"
  | "user.password_changed"
  | "provider_user.created"
  | "provider_user.updated"
  | "provider_user.password_reset"
  | "recording.played"
  | "recording.linked"
  | "recording.uploaded"
  | "recording.purged"
  | "platform.sftp_updated"
  | "transfer.scan_requested"
  | "transfer.retry_requested"
  | "platform.sftp_tested"
  | "lead.anonymised"
  | "submission.payloads_purged";
