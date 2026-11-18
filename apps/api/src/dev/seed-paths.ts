import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root (works from src/dev and dist/dev). */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

/** Local test provider keys written by `npm run seed` (git-ignored). */
export const KEYS_FILE = resolve(ROOT, ".local/provider-keys.json");

/** Local admin dashboard test accounts written by `npm run seed` (git-ignored). */
export const ADMIN_ACCOUNTS_FILE = resolve(ROOT, ".local/admin-accounts.json");
