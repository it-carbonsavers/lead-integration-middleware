/**
 * Mock external lead providers. Pushes fictional leads to the LOCAL API, the same way a real
 * provider would, and prints what came back. Only talks to localhost.
 *
 *   npm run simulate                        all scenarios
 *   npm run simulate -- --scenario normal --count 25
 *   scenarios: normal | duplicates | invalid | failures | all
 *
 * All personal data is fictional: names are invented, phone numbers come from the Australian
 * range reserved for fiction (0491 570 xxx...), emails use example.com.
 */

import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { KEYS_FILE } from "./seed-paths.js";

const FIRST = [
  "Alex",
  "Sam",
  "Jordan",
  "Taylor",
  "Morgan",
  "Casey",
  "Riley",
  "Jamie",
  "Avery",
  "Quinn",
  "Harper",
  "Rowan",
];
const LAST = [
  "Example",
  "Sample",
  "Testing",
  "Placeholder",
  "Demo",
  "Fictional",
  "Mockridge",
  "Dummyfield",
];
const PHONES = [
  "0491570006",
  "0491570156",
  "0491570313",
  "0491570737",
  "0491571266",
  "0491571804",
  "0491572549",
  "0491572983",
  "0491573770",
  "0491574118",
  "0491575254",
  "0491576398",
  "0491577426",
  "0491578957",
  "0491579212",
];
const CITIES = [
  { city: "Sampletown", state: "NSW", postcode: "2000" },
  { city: "Exampleville", state: "VIC", postcode: "3000" },
  { city: "Demoford", state: "QLD", postcode: "4000" },
  { city: "Mockton", state: "SA", postcode: "5000" },
];
const CAMPAIGNS = [
  "Winter energy plans",
  "Solar savings",
  "Battery upgrade",
  "Business energy review",
];
const PRODUCTS = ["solar", "solar_battery", "battery", "energy_plan"];
const AGENTS = ["AG-101", "AG-102", "AG-103", "AG-104", "AG-105", "AG-106"];

const pick = <T>(a: readonly T[]) => a[Math.floor(Math.random() * a.length)]!;

interface Keys {
  base_url: string;
  keys: Record<string, { token: string }>;
}

interface Outcome {
  scenario: string;
  provider: string;
  expect: string;
  status: number;
  lead_ref: string;
  note: string;
}

let seq = 0;
function makeLead(overrides: Record<string, unknown> = {}, phone = pick(PHONES)) {
  const first = pick(FIRST);
  const last = pick(LAST);
  const place = pick(CITIES);
  const ext = `SIM-${Date.now().toString(36)}-${(seq++).toString().padStart(3, "0")}`;
  const now = new Date(Date.now() - Math.floor(Math.random() * 3_600_000));
  return {
    schema_version: "1",
    external_lead_id: ext,
    transferred_at: now.toISOString(),
    customer: {
      first_name: first,
      last_name: last,
      phone,
      email: `${first}.${last}.${seq}@example.com`.toLowerCase(),
      address: { line1: `${1 + (seq % 90)} Example Street`, ...place, country: "AU" },
    },
    agent: { external_id: pick(AGENTS), name: `Agent ${pick(["One", "Two", "Three", "Four"])}` },
    campaign: pick(CAMPAIGNS),
    product_interest: pick(PRODUCTS),
    consent: { verbal_consent: true, captured_at: now.toISOString(), recording_ref: ext },
    ...overrides,
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      scenario: { type: "string", default: "all" },
      count: { type: "string", default: "12" },
      "base-url": { type: "string" },
    },
  });
  const keys = JSON.parse(await readFile(KEYS_FILE, "utf8")) as Keys;
  const base = new URL(values["base-url"] ?? keys.base_url);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)) {
    throw new Error("the simulator only sends to a local API (localhost / 127.0.0.1)");
  }
  const tokenFor = (code: string) => {
    const t = keys.keys[code]?.token;
    if (!t) throw new Error(`no key for ${code} in ${KEYS_FILE}; run npm run seed`);
    return t;
  };

  const results: Outcome[] = [];
  const post = async (
    scenario: string,
    provider: string,
    expect: string,
    body: unknown,
    opts: { token?: string; idempotencyKey?: string; contentType?: string } = {},
  ) => {
    const res = await fetch(new URL("/v1/leads", base), {
      method: "POST",
      headers: {
        authorization: `Bearer ${opts.token ?? tokenFor(provider)}`,
        "content-type": opts.contentType ?? "application/json",
        ...(opts.idempotencyKey ? { "idempotency-key": opts.idempotencyKey } : {}),
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const errors = Array.isArray(json["errors"])
      ? (json["errors"] as { path: string; code: string }[])
          .map((e) => `${e.path}:${e.code}`)
          .join(", ")
      : "";
    results.push({
      scenario,
      provider,
      expect,
      status: res.status,
      lead_ref: String(json["lead_ref"] ?? ""),
      note: [
        json["duplicate"] ? "duplicate" : "",
        json["possible_duplicate"] ? "possible_duplicate" : "",
        errors,
        res.status >= 400 && !errors ? String(json["title"] ?? "") : "",
      ]
        .filter(Boolean)
        .join(" "),
    });
    return json;
  };

  const scenario = values.scenario;
  const count = Math.max(1, Number(values.count) || 12);
  const all = scenario === "all";

  if (all || scenario === "normal") {
    for (let i = 0; i < count; i++) {
      const provider = ["PRV01", "PRV02", "PRV03"][i % 3]!;
      const lead = makeLead(i % 5 === 4 ? { consent: { verbal_consent: false } } : {});
      await post("normal", provider, "202", lead);
    }
  }

  if (all || scenario === "duplicates") {
    const lead = makeLead({}, PHONES[0]);
    await post("duplicates", "PRV01", "202", lead);
    await post("duplicates", "PRV01", "200 duplicate (same external_lead_id)", lead);
    const key = randomUUID();
    const lead2 = makeLead();
    await post("duplicates", "PRV02", "202", lead2, { idempotencyKey: key });
    await post("duplicates", "PRV02", "200 duplicate (same Idempotency-Key)", lead2, {
      idempotencyKey: key,
    });
    await post("duplicates", "PRV02", "409 (key reused for another lead)", makeLead(), {
      idempotencyKey: key,
    });
    await post(
      "duplicates",
      "PRV03",
      "202 + possible_duplicate (same phone, other provider)",
      makeLead({}, PHONES[0]),
    );
  }

  if (all || scenario === "invalid") {
    await post(
      "invalid",
      "PRV01",
      "422 invalid phone",
      makeLead({ customer: { first_name: "Alex", last_name: "Example", phone: "12345678" } }),
    );
    const missing = makeLead() as Record<string, unknown>;
    delete missing["agent"];
    await post("invalid", "PRV01", "422 missing agent", missing);
    await post("invalid", "PRV01", "422 unknown field", {
      ...makeLead(),
      favourite_colour: "blue",
    });
    await post(
      "invalid",
      "PRV01",
      "422 future date",
      makeLead({ transferred_at: new Date(Date.now() + 86_400_000).toISOString() }),
    );
    await post("invalid", "PRV01", "400 malformed JSON", "{not json");
    await post("invalid", "PRV01", "415 wrong content type", "hello", {
      contentType: "text/plain",
    });
    await post("invalid", "PRV01", "401 bad key", makeLead(), {
      token: "lim_dev_AAAAAAAA_" + "a".repeat(43),
    });
    await post("invalid", "PRV04", "403 suspended provider", makeLead());
  }

  if (all || scenario === "failures") {
    await post(
      "failures",
      "PRV01",
      "202 then delivered after 1 retry",
      makeLead({ extra: { simulate: "fail_once" } }),
    );
    await post(
      "failures",
      "PRV01",
      "202 then dead_letter after retries",
      makeLead({ extra: { simulate: "retryable_error" } }),
    );
    await post(
      "failures",
      "PRV02",
      "202 then rate-limited retries -> dead_letter",
      makeLead({ extra: { simulate: "rate_limited" } }),
    );
    await post(
      "failures",
      "PRV02",
      "202 then failed (permanent)",
      makeLead({ extra: { simulate: "permanent_error" } }),
    );
  }

  console.table(results);
  const leadRefs = results.filter((r) => r.lead_ref).map((r) => r.lead_ref);
  if (leadRefs.length) {
    console.log("\nCheck a lead's timeline, e.g.:");
    console.log(`  npm run admin -- lead:show --ref ${leadRefs[leadRefs.length - 1]}`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : "simulation failed");
  process.exit(1);
});
