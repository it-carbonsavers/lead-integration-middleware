/**
 * Local SFTP test setup (called by the seed). Both test sources upload to OUR SFTP server:
 *   PRV01  logs in with an SSH key   (account "prv01")
 *   PRV02  logs in with a password   (account "prv02"; we generated the password, only its hash
 *                                     is in the database)
 * The provider-side test credentials are written to .local/sftp/keys (git-ignored, mode 600):
 * use them with any SFTP client to test uploads once SFTPGo is running (e.g. on Railway). When an
 * SFTPGo server is configured the accounts are pushed to it; otherwise that happens on the first
 * "Test connection" after it is connected.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Kysely } from "kysely";
import ssh2 from "ssh2";
import type { Env } from "@lim/config";
import { findPlatformByCode, type Database } from "@lim/db";
import { prepareObjectStorage, sftpRuntime, syncSftpAccount } from "@lim/recordings";
import { generatePassword, hashPassword } from "../admin/auth.js";
import { ROOT } from "./seed-paths.js";

export const SFTP_TEST_KEYS_DIR = resolve(ROOT, ".local/sftp/keys");

async function keyPair(path: string): Promise<{ private: string; public: string }> {
  if (!existsSync(path)) {
    const pair = ssh2.utils.generateKeyPairSync("ed25519", { comment: "lim-local-test" });
    await writeFile(path, pair.private, { mode: 0o600 });
    await writeFile(`${path}.pub`, pair.public + "\n", { mode: 0o644 });
  }
  return {
    private: await readFile(path, "utf8"),
    public: (await readFile(`${path}.pub`, "utf8")).trim(),
  };
}

async function testPassword(path: string): Promise<string> {
  if (!existsSync(path)) await writeFile(path, generatePassword() + "\n", { mode: 0o600 });
  return (await readFile(path, "utf8")).trim();
}

export async function seedSftp(db: Kysely<Database>, config: Env): Promise<void> {
  const keys = SFTP_TEST_KEYS_DIR;
  await mkdir(keys, { recursive: true, mode: 0o700 });
  const providerA = await keyPair(join(keys, "provider_prv01_ed25519")); // held by "Lead Provider A"
  const passwordB = await testPassword(join(keys, "provider_prv02_password")); // given to "Lead Provider B"

  const prv01 = await findPlatformByCode(db, "PRV01");
  const prv02 = await findPlatformByCode(db, "PRV02");
  if (!prv01 || !prv02) return;

  const accounts = [
    {
      platform: prv01,
      values: {
        mode: "sftp_hosted" as const,
        username: "prv01",
        auth_method: "key" as const,
        authorized_keys: [providerA.public],
        password_hash: null,
      },
    },
    {
      platform: prv02,
      values: {
        mode: "sftp_hosted" as const,
        username: "prv02",
        auth_method: "password" as const,
        authorized_keys: [],
        password_hash: await hashPassword(passwordB),
      },
    },
  ];
  for (const a of accounts) {
    await db
      .insertInto("platform_sftp_configs")
      .values({ platform_id: a.platform.id, ...a.values })
      .onConflict((oc) => oc.column("platform_id").doUpdateSet(a.values))
      .execute();
    await db
      .updateTable("platforms")
      .set({ recording_ingest_mode: "sftp_hosted" })
      .where("id", "=", a.platform.id)
      .execute();
  }

  const rt = sftpRuntime(config);
  if (rt.backend === "sftpgo") {
    try {
      await prepareObjectStorage(config);
      for (const a of accounts) {
        const r = await syncSftpAccount(db, rt.provisioner, a.platform.id);
        if (!r.ok) throw new Error(r.error);
      }
    } catch {
      console.log(
        "sftp              SFTPGo or the buckets are not reachable: accounts are saved and pushed on the next Test connection.",
      );
    }
  } else {
    console.log(
      "sftp              No SFTP server configured: PRV01/PRV02 accounts saved; they are created on SFTPGo once it is connected.",
    );
  }
  console.log(
    `sftp              Test credentials: PRV01 (prv01) key ${join(keys, "provider_prv01_ed25519")}, PRV02 (prv02) password in ${join(keys, "provider_prv02_password")}`,
  );
}
