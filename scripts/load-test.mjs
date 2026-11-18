// Local load test for the provider API and the delivery worker. LOCAL ONLY.
//
//   node scripts/load-test.mjs [--requests 2000] [--concurrency 20]
//
// Creates (or re-uses) a dedicated test provider "LOADTEST" through the admin API, issues it a
// key, submits fictional leads as fast as the concurrency allows, then waits for the worker to
// deliver them to the mock destination. Prints latency percentiles and throughput.
// Start the API with a high per-IP limit for this run, e.g.
//   RATE_LIMIT_IP_PER_MIN=100000 npm run dev:all
// The LOADTEST provider is suspended at the end.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import pg from "pg";

const { values } = parseArgs({
  options: {
    requests: { type: "string", default: "2000" },
    concurrency: { type: "string", default: "20" },
  },
});
const N = Number(values.requests);
const C = Number(values.concurrency);
const API = "http://127.0.0.1:3000";
const env = Object.fromEntries(
  readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace(/\s+#.*$/, "")]),
);
const accounts = JSON.parse(
  readFileSync(new URL("../.local/admin-accounts.json", import.meta.url), "utf8"),
).accounts;

// --- admin session -----------------------------------------------------------------------
const login = await fetch(`${API}/admin/v1/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-lim-admin": "1" },
  body: JSON.stringify({ email: "admin@local.test", password: accounts["admin@local.test"] }),
});
const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
if (!cookie) throw new Error("admin login failed");
const admin = (method, path, body) =>
  fetch(`${API}/admin/v1${path}`, {
    method,
    headers: { cookie, "x-lim-admin": "1", "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
await admin("POST", "/platforms", {
  organisation: "carbon-savers",
  code: "LOADTEST",
  display_name: "Load test (local)",
  rate_limit_per_min: 100000,
});
await admin("PATCH", "/platforms/LOADTEST", { status: "active", rate_limit_per_min: 100000 });
const { token } = await (
  await admin("POST", "/platforms/LOADTEST/keys", { label: "load test", expires_in_days: 1 })
).json();

// --- submit -----------------------------------------------------------------------------
const run = Date.now().toString(36);
const phones = ["0491570006", "0491570156", "0491570313", "0491570737", "0491571266", "0491571804"];
const latencies = [];
const codes = {};
let next = 0;
const started = performance.now();
async function workerLoop() {
  while (next < N) {
    const i = next++;
    const body = {
      schema_version: "1",
      external_lead_id: `LOAD-${run}-${i}`,
      transferred_at: new Date().toISOString(),
      customer: {
        first_name: "Load",
        last_name: `Test${i}`,
        phone: phones[i % phones.length],
        email: `load${i}.${run}@example.com`,
      },
      agent: { external_id: `AG-L${i % 10}` },
      consent: { verbal_consent: true, recording_ref: `LOAD-${run}-${i}` },
    };
    const t0 = performance.now();
    const res = await fetch(`${API}/v1/leads`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    await res.arrayBuffer();
    latencies.push(performance.now() - t0);
    codes[res.status] = (codes[res.status] ?? 0) + 1;
  }
}
await Promise.all(Array.from({ length: C }, workerLoop));
const elapsed = (performance.now() - started) / 1000;
latencies.sort((a, b) => a - b);
const pct = (p) =>
  latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))].toFixed(1);

// --- wait for delivery -------------------------------------------------------------------
const db = new pg.Client({ connectionString: env.DATABASE_URL });
await db.connect();
const deliverStart = Date.now();
let delivered;
for (;;) {
  const r = await db.query(
    "SELECT count(*) FILTER (WHERE status = 'delivered')::int AS d, count(*)::int AS n FROM leads WHERE external_lead_id LIKE $1",
    [`LOAD-${run}-%`],
  );
  delivered = r.rows[0].d;
  if (delivered >= r.rows[0].n || Date.now() - deliverStart > 300_000) break;
  await new Promise((res) => setTimeout(res, 1000));
}
const firstReceived = await db.query(
  "SELECT extract(epoch FROM (max(delivered_at) - min(received_at)))::float AS span FROM leads WHERE external_lead_id LIKE $1",
  [`LOAD-${run}-%`],
);
await db.end();
await admin("PATCH", "/platforms/LOADTEST", { status: "suspended" });

const span = firstReceived.rows[0].span;
const summary = {
  requests: N,
  concurrency: C,
  status_codes: codes,
  submit_seconds: Number(elapsed.toFixed(2)),
  submit_per_second: Number((N / elapsed).toFixed(1)),
  latency_ms: { p50: pct(50), p95: pct(95), p99: pct(99), max: latencies.at(-1).toFixed(1) },
  delivered,
  end_to_end_seconds: Number(span.toFixed(1)),
  delivered_per_second: Number((delivered / span).toFixed(1)),
};
console.log(JSON.stringify(summary, null, 2));
