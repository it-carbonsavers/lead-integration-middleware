/**
 * Builds the recording components from configuration, so the API, worker and seed share them.
 *
 *   SFTPGO_* set   uploads inbox = S3 bucket (UPLOADS_BUCKET), provider accounts pushed to SFTPGo,
 *                  providers connect to SFTP_PUBLIC_HOST:SFTP_PUBLIC_PORT (Railway TCP proxy)
 *   SFTPGO_* unset no SFTP server: nothing is picked up, accounts wait until SFTPGo is connected
 *
 *   RECORDING_STORE=s3     encrypted recordings in RECORDINGS_BUCKET
 *   RECORDING_STORE=local  encrypted recordings in RECORDING_STORAGE_DIR
 */

import type { Env } from "@lim/config";
import { S3Inbox, type UploadInbox } from "./inbox.js";
import { NoSftpServer, SftpgoProvisioner, type AccountProvisioner } from "./provisioner.js";
import { ensureBucket, s3Client, type S3Settings } from "./s3.js";
import { LocalEncryptedStore, S3EncryptedStore, type ObjectStore } from "./storage.js";

export interface SftpRuntime {
  backend: "none" | "sftpgo";
  inbox: UploadInbox | null;
  provisioner: AccountProvisioner;
  /** Address providers connect to; null when no SFTP server is configured. */
  host: string | null;
  port: number | null;
}

function s3Settings(config: Env): S3Settings {
  if (!config.S3_ENDPOINT || !config.S3_ACCESS_KEY_ID || !config.S3_SECRET_ACCESS_KEY)
    throw new Error("S3_ENDPOINT, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required");
  return {
    endpoint: config.S3_ENDPOINT,
    region: config.S3_REGION,
    accessKeyId: config.S3_ACCESS_KEY_ID,
    secretAccessKey: config.S3_SECRET_ACCESS_KEY,
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
  };
}

export const sftpConfigured = (config: Env) => Boolean(config.SFTPGO_API_URL);

export function sftpRuntime(config: Env): SftpRuntime {
  if (!sftpConfigured(config))
    return {
      backend: "none",
      inbox: null,
      provisioner: new NoSftpServer(),
      host: null,
      port: null,
    };
  const s3 = s3Settings(config);
  return {
    backend: "sftpgo",
    inbox: new S3Inbox(s3Client(s3), config.UPLOADS_BUCKET!, config.UPLOADS_PREFIX),
    provisioner: new SftpgoProvisioner({
      apiUrl: config.SFTPGO_API_URL!,
      adminUser: config.SFTPGO_ADMIN_USER!,
      adminPassword: config.SFTPGO_ADMIN_PASSWORD!,
      storage: {
        ...s3,
        endpoint: config.SFTPGO_S3_ENDPOINT ?? s3.endpoint,
        bucket: config.UPLOADS_BUCKET!,
        prefix: config.UPLOADS_PREFIX,
      },
      maxUploadBytes: config.RECORDING_MAX_MB * 1024 * 1024,
    }),
    host: config.SFTP_PUBLIC_HOST!,
    port: config.SFTP_PUBLIC_PORT!,
  };
}

export function recordingStore(config: Env): ObjectStore | null {
  if (config.RECORDING_STORE === "s3")
    return new S3EncryptedStore(
      s3Client(s3Settings(config)),
      config.RECORDINGS_BUCKET!,
      config.APP_ENCRYPTION_KEY,
    );
  return config.RECORDING_STORAGE_DIR
    ? new LocalEncryptedStore(config.RECORDING_STORAGE_DIR, config.APP_ENCRYPTION_KEY)
    : null;
}

/**
 * Checks the configured buckets exist. Hosted buckets are created on the platform (Railway),
 * never by the application; in tests (APP_ENV=test) missing buckets are created.
 */
export async function prepareObjectStorage(config: Env): Promise<void> {
  const buckets = [
    sftpConfigured(config) ? config.UPLOADS_BUCKET : undefined,
    config.RECORDING_STORE === "s3" ? config.RECORDINGS_BUCKET : undefined,
  ].filter((b): b is string => Boolean(b));
  if (!buckets.length) return;
  const client = s3Client(s3Settings(config));
  for (const b of buckets) await ensureBucket(client, b, { create: config.APP_ENV === "test" });
}
