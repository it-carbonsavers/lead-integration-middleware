import { isUnfinishedUpload, type InboxFile, type UploadInbox } from "@lim/recordings";

/** In-memory stand-in for the uploads bucket (tests only). */
export class MemoryInbox implements UploadInbox {
  readonly kind = "memory";
  readonly files = new Map<string, { data: Buffer; mtime: Date }>();

  add(account: string, name: string, data: Buffer, mtime = new Date()) {
    this.files.set(`${account}/${name}`, { data, mtime });
  }
  names(account: string) {
    return [...this.files.keys()]
      .filter((k) => k.startsWith(`${account}/`))
      .map((k) => k.slice(account.length + 1));
  }
  async list(account: string): Promise<InboxFile[]> {
    return this.names(account)
      .filter((n) => !isUnfinishedUpload(n))
      .map((name) => {
        const f = this.files.get(`${account}/${name}`)!;
        return { name, size: f.data.length, mtime: f.mtime };
      });
  }
  async read(account: string, name: string): Promise<Buffer> {
    const f = this.files.get(`${account}/${name}`);
    if (!f) throw new Error("not found");
    return f.data;
  }
  async remove(account: string, name: string): Promise<void> {
    this.files.delete(`${account}/${name}`);
  }
}
