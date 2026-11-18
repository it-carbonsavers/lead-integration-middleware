// Creates or completes .env for LOCAL development.
//  - New .env: copied from .env.example with fresh random encryption keys and the docker-compose DB.
//  - Existing .env: left as is, except settings added in later phases are appended if missing.
// Never overwrites a value you have set, and never prints secret values.
import { randomBytes } from "node:crypto";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  chmodSync,
  mkdirSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = resolve(root, ".env");
const local = (p) => resolve(root, ".local", p);
const key = () => randomBytes(32).toString("base64");

// Settings that hold absolute local paths (cannot live in .env.example).
const pathSettings = {
  RECORDING_STORAGE_DIR: local("storage"),
};

// Settings that pointed at the local SFTPGo / S3 containers (removed 18 Nov 2026). They are
// stripped from an existing .env so the app does not try to reach containers that no longer exist.
const OBSOLETE_HEADER =
  "# Local SFTPGo + S3-compatible storage (docker-compose) (added by setup:local)";
const OBSOLETE = [
  "SFTP_BACKEND",
  "SFTP_PUBLIC_HOST",
  "SFTP_PUBLIC_PORT",
  "SFTPGO_API_URL",
  "SFTPGO_ADMIN_USER",
  "SFTPGO_ADMIN_PASSWORD",
  "SFTPGO_S3_ENDPOINT",
  "S3_ENDPOINT",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "UPLOADS_BUCKET",
  "RECORDING_STORE",
  "RECORDINGS_BUCKET",
  "SFTP_DEV_HOST",
  "SFTP_DEV_PORT",
  "SFTP_PULL_KEYS_DIR",
];

for (const dir of Object.values(pathSettings)) mkdirSync(dir, { recursive: true, mode: 0o700 });

if (!existsSync(target)) {
  let text = readFileSync(resolve(root, ".env.example"), "utf8");
  const set = (name, value) => {
    text = new RegExp(`^${name}=.*$`, "m").test(text)
      ? text.replace(new RegExp(`^${name}=.*$`, "m"), `${name}=${value}`)
      : `${text.trimEnd()}\n${name}=${value}\n`;
  };
  set("DATABASE_URL", "postgres://lim:lim_local_only@127.0.0.1:5433/lead_integration");
  set("APP_ENCRYPTION_KEY", key());
  set("APP_BLIND_INDEX_KEY", key());
  set("HUBSPOT_ENABLED", "false");
  for (const [k, v] of Object.entries(pathSettings)) set(k, v);
  text = text.replace(/^(SFTP_DEV_HOST|SFTP_DEV_PORT)=.*\n?/gm, "");
  writeFileSync(target, text, { mode: 0o600 });
  chmodSync(target, 0o600);
  console.log("Created .env for local development (new random keys, HubSpot disabled).");
} else {
  let current = readFileSync(target, "utf8");
  const removed = [];
  if (current.includes(OBSOLETE_HEADER)) {
    current = current.replace(`\n${OBSOLETE_HEADER}\n`, "\n");
    for (const k of OBSOLETE) {
      const re = new RegExp(`^${k}=.*\\n?`, "m");
      if (re.test(current)) {
        current = current.replace(re, "");
        removed.push(k);
      }
    }
    writeFileSync(target, current, { mode: 0o600 });
  }
  const missing = Object.entries(pathSettings).filter(
    ([k]) => !new RegExp(`^${k}=`, "m").test(current),
  );
  if (missing.length)
    appendFileSync(
      target,
      `\n# Consent recordings (added by setup:local)\n${missing.map(([k, v]) => `${k}=${v}`).join("\n")}\n`,
    );
  console.log(
    [
      removed.length ? `removed local SFTPGo/S3 settings: ${removed.join(", ")}` : "",
      missing.length ? `added ${missing.map(([k]) => k).join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("; ") || ".env already complete: left unchanged.",
  );
}
