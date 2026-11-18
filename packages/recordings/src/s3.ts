/**
 * S3-compatible object storage client (local: SeaweedFS container; hosted: Railway Buckets).
 */

import {
  CreateBucketCommand,
  HeadBucketCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";

export interface S3Settings {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

export function s3Client(s: S3Settings): S3Client {
  return new S3Client({
    endpoint: s.endpoint,
    region: s.region,
    forcePathStyle: s.forcePathStyle,
    credentials: { accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey },
    // Only send checksums when the operation requires them: not every S3-compatible
    // service accepts the newer default (streaming CRC32 trailers).
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

/**
 * Checks a bucket exists. With `create` (local development only) a missing bucket is created;
 * hosted buckets are created by the platform, never by the application.
 */
export async function ensureBucket(
  client: S3Client,
  bucket: string,
  opts: { create: boolean },
): Promise<void> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch (err) {
    const status = err instanceof S3ServiceException ? err.$metadata.httpStatusCode : undefined;
    if (status !== 404 || !opts.create) throw err;
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  }
}
