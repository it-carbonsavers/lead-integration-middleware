/**
 * Recording storage.
 *
 * `ObjectStore` is the port; `LocalEncryptedStore` is the local-development implementation:
 * every file is AES-256-GCM encrypted with the application key before it touches disk, stored
 * under a random key (never the original file name), with owner-only file permissions.
 * `S3EncryptedStore` keeps the same application-encrypted bytes in a private S3-compatible bucket
 * (local: SeaweedFS container; hosted: a private Railway Bucket).
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { decryptBytes, encryptBytes } from "@lim/core";

export interface ObjectStore {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

const KEY_PATTERN = /^[a-z0-9][a-z0-9/_-]{0,200}\.bin$/;

export class LocalEncryptedStore implements ObjectStore {
  private readonly root: string;
  constructor(
    root: string,
    private readonly encryptionKey: string,
  ) {
    this.root = resolve(root);
  }

  private pathFor(key: string): string {
    if (!KEY_PATTERN.test(key) || key.includes("..")) throw new Error("Invalid storage key");
    const p = resolve(join(this.root, key));
    if (!p.startsWith(this.root + sep)) throw new Error("Invalid storage key");
    return p;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const p = this.pathFor(key);
    await mkdir(dirname(p), { recursive: true, mode: 0o700 });
    await writeFile(p, encryptBytes(data, this.encryptionKey), { mode: 0o600, flag: "wx" });
  }

  async get(key: string): Promise<Buffer> {
    return decryptBytes(await readFile(this.pathFor(key)), this.encryptionKey);
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }
}

export class S3EncryptedStore implements ObjectStore {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
    private readonly encryptionKey: string,
  ) {}

  private check(key: string) {
    if (!KEY_PATTERN.test(key) || key.includes("..")) throw new Error("Invalid storage key");
    return key;
  }

  async put(key: string, data: Buffer): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.check(key),
        Body: encryptBytes(data, this.encryptionKey),
        ContentType: "application/octet-stream",
        IfNoneMatch: "*", // never overwrite an existing recording
      }),
    );
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: this.check(key) }),
    );
    if (!res.Body) throw new Error("empty object body");
    return decryptBytes(Buffer.from(await res.Body.transformToByteArray()), this.encryptionKey);
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.check(key) }));
  }
}

/** recordings/<org>/<platform>/<yyyy>/<mm>/<uuid>.bin */
export function newRecordingKey(
  organisationId: string,
  platformId: string,
  now = new Date(),
): string {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `recordings/${organisationId}/${platformId}/${yyyy}/${mm}/${randomUUID()}.bin`;
}
