/** Writes docs/openapi.json from the live zod schemas. Usage: npm run openapi */
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildOpenApiDocument } from "../openapi.js";
import { ROOT } from "./seed-paths.js";

const out = resolve(ROOT, "docs/openapi.json");
await writeFile(out, JSON.stringify(buildOpenApiDocument(), null, 2) + "\n");
console.log(`Wrote ${out}`);
