/**
 * Uploads inbox: where files uploaded by providers to our SFTP server can be read from.
 *
 *  - S3Inbox  SFTPGo stores each provider account's uploads in one bucket under the prefix
 *             "<username>/". The worker lists, reads and deletes objects there. An object only
 *             becomes visible once its upload has completed.
 *
 * Names that look like unfinished uploads (".part", ".filepart", ".tmp", or hidden files) are
 * never returned, so a client that uploads to a temporary name and renames is handled.
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  type S3Client,
} from "@aws-sdk/client-s3";

export interface InboxFile {
  name: string;
  size: number;
  mtime: Date;
}

export interface UploadInbox {
  readonly kind: string;
  list(account: string): Promise<InboxFile[]>;
  read(account: string, name: string): Promise<Buffer>;
  remove(account: string, name: string): Promise<void>;
}

const ACCOUNT = /^[a-z0-9][a-z0-9_-]{2,31}$/;
const NAME = /^[^/\\\0]{1,255}$/;

export const isUnfinishedUpload = (name: string) =>
  name.startsWith(".") || /\.(part|filepart|tmp)$/i.test(name);

export function checkAccount(account: string) {
  if (!ACCOUNT.test(account)) throw new Error("invalid SFTP account name");
}
export function checkName(name: string) {
  if (!NAME.test(name) || name === "." || name === "..") throw new Error("invalid file name");
}

export class S3Inbox implements UploadInbox {
  readonly kind = "s3" as const;
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
    /** Folder inside the bucket ("" or e.g. "uploads/"). */
    private readonly prefix = "",
  ) {}

  private key(account: string, name: string) {
    checkAccount(account);
    checkName(name);
    return `${this.prefix}${account}/${name}`;
  }

  async list(account: string): Promise<InboxFile[]> {
    checkAccount(account);
    const prefix = `${this.prefix}${account}/`;
    const out: InboxFile[] = [];
    let token: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          Delimiter: "/", // only the provider's upload folder, no sub-folders
          ContinuationToken: token,
        }),
      );
      for (const o of page.Contents ?? []) {
        const name = (o.Key ?? "").slice(prefix.length);
        if (!name || isUnfinishedUpload(name) || !NAME.test(name)) continue;
        out.push({ name, size: o.Size ?? 0, mtime: o.LastModified ?? new Date(0) });
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return out;
  }

  async read(account: string, name: string): Promise<Buffer> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: this.key(account, name) }),
    );
    if (!res.Body) throw new Error("empty object body");
    return Buffer.from(await res.Body.transformToByteArray());
  }

  async remove(account: string, name: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(account, name) }),
    );
  }
}
