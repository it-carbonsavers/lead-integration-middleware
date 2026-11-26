/**
 * Kysely table types. Keep in step with src/migrations/*.
 */

import type { ColumnType, Generated, Insertable, Selectable, Updateable } from "kysely";

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type CreatedAt = ColumnType<Date, Date | string | undefined, never>;
type Json = ColumnType<
  Record<string, unknown>,
  string | Record<string, unknown> | undefined,
  string | Record<string, unknown>
>;

export interface OrganisationsTable {
  id: Generated<string>;
  name: string;
  slug: string;
  status: Generated<"active" | "suspended">;
  created_at: CreatedAt;
  updated_at: Timestamp;
}

export interface AdminUsersTable {
  id: Generated<string>;
  organisation_id: string | null;
  email: string;
  name: string | null;
  auth_provider: "oidc" | "local";
  oidc_subject: string | null;
  password_hash: string | null;
  mfa_secret_enc: Buffer | null;
  status: Generated<"invited" | "active" | "disabled">;
  last_login_at: Date | null;
  failed_login_count: Generated<number>;
  locked_until: Date | null;
  password_changed_at: Date | null;
  /** Set for lead-provider portal users: they only see this platform's data. */
  platform_id: string | null;
  created_at: CreatedAt;
  updated_at: Timestamp;
}

export interface RolesTable {
  code: string;
  description: string;
}

export interface RolePermissionsTable {
  role_code: string;
  permission: string;
}

export interface AdminUserRolesTable {
  user_id: string;
  role_code: string;
  granted_at: CreatedAt;
}

export interface AdminSessionsTable {
  id_hash: Buffer;
  user_id: string;
  created_at: CreatedAt;
  last_seen_at: Timestamp;
  expires_at: Date;
  ip: string | null;
  user_agent: string | null;
}

export interface DestinationsTable {
  id: Generated<string>;
  type: string;
  name: string;
  is_default: Generated<boolean>;
  config: Json;
  credential_ref: string;
  status: Generated<"active" | "disabled">;
  created_at: CreatedAt;
  updated_at: Timestamp;
}

export interface PlatformsTable {
  id: Generated<string>;
  organisation_id: string;
  code: string;
  display_name: string;
  status: Generated<"active" | "suspended">;
  require_hmac: Generated<boolean>;
  /** Postgres cidr[]; parsed to string[] by the type parser in client.ts */
  allowed_cidrs: ColumnType<string[], string[] | undefined, string[]>;
  rate_limit_per_min: number | null;
  recording_ingest_mode: Generated<"none" | "sftp_hosted">;
  destination_id: string | null;
  /** Import existing HubSpot leads whose "Lead Company" equals this value (null = off). */
  hubspot_lead_company: string | null;
  created_at: CreatedAt;
  updated_at: Timestamp;
}

export interface PlatformApiCredentialsTable {
  id: Generated<string>;
  platform_id: string;
  env_tag: "live" | "stg" | "dev" | "test";
  key_prefix: string;
  key_hash: Buffer;
  hmac_secret_enc: Buffer | null;
  label: string | null;
  last_used_at: Date | null;
  expires_at: Date | null;
  revoked_at: Date | null;
  created_by: string | null;
  created_at: CreatedAt;
}

export interface AuditLogTable {
  /** bigserial: returned as string by node-postgres */
  id: Generated<string>;
  occurred_at: CreatedAt;
  actor_type: "admin" | "platform" | "system";
  actor_id: string | null;
  actor_label: string | null;
  organisation_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  request_id: string | null;
  ip: string | null;
  detail: Json;
}

export interface RetentionPoliciesTable {
  entity: string;
  keep_days: number;
  action: "delete" | "anonymise";
  updated_at: Timestamp;
}

export type LeadStatus =
  | "received"
  | "queued"
  | "held"
  | "discarded"
  | "delivering"
  | "retry_scheduled"
  | "delivered"
  | "failed"
  | "dead_letter";

export type ConsentStatus =
  "not_captured" | "awaiting_recording" | "received" | "matched" | "unmatched" | "overdue";

export interface AgentsTable {
  id: Generated<string>;
  platform_id: string;
  external_agent_id: string;
  name: string | null;
  email: string | null;
  destination_owner_id: string | null;
  active: Generated<boolean>;
  first_seen_at: CreatedAt;
  last_seen_at: Timestamp;
}

export interface LeadsTable {
  id: Generated<string>;
  lead_ref: string;
  organisation_id: string;
  platform_id: string;
  agent_id: string | null;
  external_lead_id: string;
  status: LeadStatus;
  status_changed_at: Timestamp;
  consent_status: ConsentStatus;
  possible_duplicate_of: string | null;
  first_name: string;
  last_name: string;
  email_enc: Buffer | null;
  email_bidx: Buffer | null;
  phone_enc: Buffer;
  phone_bidx: Buffer;
  address_enc: Buffer | null;
  postcode: string | null;
  state: string | null;
  country: string | null;
  campaign: string | null;
  product_interest: string | null;
  energy_plan: string | null;
  notes_enc: Buffer | null;
  extra_enc: Buffer | null;
  verbal_consent: boolean;
  consent_captured_at: Date | null;
  recording_ref: string | null;
  transferred_at: Date;
  received_at: CreatedAt;
  delivered_at: Date | null;
  destination_id: string | null;
  destination_ids: Json;
  /** api: sent by the provider; hubspot_import: an existing HubSpot lead read for reporting. */
  origin: Generated<"api" | "hubspot_import">;
  attempt_count: Generated<number>;
  last_error_code: string | null;
  retention_until: Date;
  anonymised_at: Date | null;
}

export interface SubmissionsTable {
  id: Generated<string>;
  platform_id: string;
  credential_id: string | null;
  lead_id: string | null;
  external_lead_id: string | null;
  idempotency_key: string | null;
  request_id: string;
  source_ip: string | null;
  outcome: "accepted" | "duplicate" | "rejected";
  http_status: number;
  error_summary: ColumnType<unknown, string | null | undefined, string | null>;
  payload_enc: Buffer | null;
  received_at: CreatedAt;
}

export interface DeliveryAttemptsTable {
  id: Generated<string>;
  lead_id: string;
  destination_id: string;
  attempt_no: number;
  job_id: string | null;
  status: "in_progress" | "success" | "retryable_error" | "permanent_error";
  step_results: Json;
  http_status: number | null;
  error_code: string | null;
  error_message: string | null;
  started_at: CreatedAt;
  finished_at: Date | null;
}

export interface LeadEventsTable {
  id: Generated<string>;
  lead_id: string;
  type: string;
  from_status: string | null;
  to_status: string | null;
  actor_type: "system" | "platform" | "admin";
  actor_id: string | null;
  detail: Json;
  created_at: CreatedAt;
}

export interface MockDestinationRecordsTable {
  id: Generated<string>;
  destination_id: string;
  lead_ref: string;
  contact_key: string;
  payload_enc: Buffer;
  created_at: CreatedAt;
  updated_at: Timestamp;
}

export interface PlatformSftpConfigsTable {
  platform_id: string;
  /** Recordings are uploaded by the provider to our SFTP server (the only supported method). */
  mode: "sftp_hosted";
  username: string;
  authorized_keys: ColumnType<string[], string[] | undefined, string[]>;
  auth_method: Generated<"key" | "password">;
  /** Password login: argon2id hash only (we generate the password and show it once). */
  password_hash: string | null;
  last_checked_at: Date | null;
  last_success_at: Date | null;
  last_error: string | null;
  last_file_at: Date | null;
  /** When the account was last pushed to the SFTP server (SFTPGo). */
  account_synced_at: Date | null;
  updated_at: Timestamp;
}

export type RecordingStatus = "matched" | "unmatched" | "rejected" | "deleted";

export interface ConsentRecordingsTable {
  id: Generated<string>;
  organisation_id: string;
  platform_id: string;
  lead_id: string | null;
  original_filename: string;
  recording_ref: string;
  storage_key: string | null;
  content_type: string | null;
  /** bigint: returned as string by node-postgres */
  size_bytes: ColumnType<string, number | string, number | string>;
  sha256: Buffer;
  status: RecordingStatus;
  rejection_reason: string | null;
  matched_by:
    "recording_ref" | "naming_convention" | "external_lead_id" | "admin" | "uploader" | null;
  matched_at: Date | null;
  retention_until: Date;
  created_at: CreatedAt;
}

export interface TransferJobsTable {
  id: Generated<string>;
  platform_id: string;
  mode: "sftp_hosted" | "sftp_pull" | "portal_upload";
  remote_path: string;
  remote_size: ColumnType<string, number | string, number | string>;
  remote_mtime: Date;
  recording_id: string | null;
  status: "transferring" | "stored" | "rejected" | "failed" | "skipped_duplicate";
  attempts: Generated<number>;
  error_code: string | null;
  started_at: CreatedAt;
  finished_at: Date | null;
}

export interface LeadOutcomesTable {
  lead_id: string;
  hubspot_lead_id: string;
  missing: Generated<boolean>;
  lead_stage_id: string | null;
  lead_stage: string | null;
  lead_stage_changed_at: Date | null;
  disqualification_reason: string | null;
  calls_attempted: Generated<number>;
  calls_connected: Generated<number>;
  deal_count: Generated<number>;
  deal_id: string | null;
  deal_pipeline: string | null;
  deal_stage: string | null;
  deal_created_at: Date | null;
  proposal_sent_at: Date | null;
  proposal_status: string | null;
  lost: Generated<boolean>;
  lost_reason: string | null;
  sold: Generated<boolean>;
  sold_at: Date | null;
  /** numeric: returned as a string by node-postgres. */
  sale_value: ColumnType<string | null, number | string | null, number | string | null>;
  sale_value_field: "total_amount" | "amount" | null;
  synced_at: Timestamp;
  created_at: CreatedAt;
}

export interface ServiceStatusTable {
  name: string;
  last_seen_at: Timestamp;
  detail: Json;
}

export interface Database {
  organisations: OrganisationsTable;
  admin_users: AdminUsersTable;
  roles: RolesTable;
  role_permissions: RolePermissionsTable;
  admin_user_roles: AdminUserRolesTable;
  admin_sessions: AdminSessionsTable;
  destinations: DestinationsTable;
  platforms: PlatformsTable;
  platform_api_credentials: PlatformApiCredentialsTable;
  audit_log: AuditLogTable;
  retention_policies: RetentionPoliciesTable;
  agents: AgentsTable;
  leads: LeadsTable;
  submissions: SubmissionsTable;
  delivery_attempts: DeliveryAttemptsTable;
  lead_events: LeadEventsTable;
  mock_destination_records: MockDestinationRecordsTable;
  platform_sftp_configs: PlatformSftpConfigsTable;
  consent_recordings: ConsentRecordingsTable;
  transfer_jobs: TransferJobsTable;
  service_status: ServiceStatusTable;
  lead_outcomes: LeadOutcomesTable;
}

export type Organisation = Selectable<OrganisationsTable>;
export type LeadOutcome = Selectable<LeadOutcomesTable>;
export type Platform = Selectable<PlatformsTable>;
export type NewPlatform = Insertable<PlatformsTable>;
export type PlatformUpdate = Updateable<PlatformsTable>;
export type PlatformApiCredential = Selectable<PlatformApiCredentialsTable>;
export type AuditLogEntry = Selectable<AuditLogTable>;
export type NewAuditLogEntry = Insertable<AuditLogTable>;
export type Lead = Selectable<LeadsTable>;
export type Destination = Selectable<DestinationsTable>;
export type DeliveryAttempt = Selectable<DeliveryAttemptsTable>;
export type AdminUser = Selectable<AdminUsersTable>;
export type PlatformSftpConfig = Selectable<PlatformSftpConfigsTable>;
export type ConsentRecording = Selectable<ConsentRecordingsTable>;
