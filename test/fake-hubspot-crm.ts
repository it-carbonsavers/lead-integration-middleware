/**
 * In-memory stand-in for the HubSpot read endpoints used by the outcome reader: pipelines,
 * batch reads of leads and deals, and v4 association batch reads. No network is involved.
 */

type Props = Record<string, string>;

export class FakeHubSpotCrm {
  leads = new Map<string, Props>();
  deals = new Map<string, Props>();
  leadDeals = new Map<string, string[]>();
  contactDeals = new Map<string, string[]>();
  calls: { method: string; path: string }[] = [];
  /** HTTP status to return for deal and association reads (e.g. 403 when the scope is missing). */
  dealsStatus = 200;

  leadPipelines = [
    {
      id: "lead-pipeline-id",
      label: "Lead pipeline",
      stages: [
        { id: "new-stage-id", label: "New" },
        { id: "connected-stage-id", label: "Connected/Voicemail" },
        { id: "qualified-stage-id", label: "Qualified [Create Deal]" },
        { id: "unqualified-stage-id", label: "Disqualified" },
      ],
    },
  ];
  dealPipelines = [
    {
      id: "p-sales",
      label: "VIC Heat Pump - Sales",
      stages: [
        { id: "s-new", label: "New Deal" },
        { id: "s-proposal", label: "Proposal Sent" },
        { id: "s-lost", label: "Lost Customer" },
      ],
    },
    {
      id: "p-assess",
      label: "VIC Heat Pump - Assessments",
      stages: [
        { id: "a-1", label: "To Be Assessed" },
        { id: "a-2", label: "Awaiting Photos" },
      ],
    },
  ];

  readonly fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const p = u.pathname;
    this.calls.push({ method, path: p });

    if (method === "GET" && p === "/crm/v3/pipelines/leads")
      return json(200, { results: this.leadPipelines });
    if (method === "GET" && p === "/crm/v3/pipelines/deals")
      return json(200, { results: this.dealPipelines });

    const ids = ((body?.inputs ?? []) as { id: string }[]).map((i) => i.id);
    if (method === "POST" && p === "/crm/v3/objects/leads/batch/read")
      return json(200, { results: read(this.leads, ids, body.properties) });

    if (this.dealsStatus !== 200 && (p.includes("/deals") || p.includes("/associations/")))
      return json(this.dealsStatus, { category: "MISSING_SCOPES" });

    if (method === "POST" && p === "/crm/v3/objects/deals/batch/read")
      return json(200, { results: read(this.deals, ids, body.properties) });
    if (method === "POST" && p === "/crm/v4/associations/leads/deals/batch/read")
      return json(200, { results: assoc(this.leadDeals, ids) });
    if (method === "POST" && p === "/crm/v4/associations/contacts/deals/batch/read")
      return json(200, { results: assoc(this.contactDeals, ids) });

    return json(404, { category: "OBJECT_NOT_FOUND" });
  };
}

function read(store: Map<string, Props>, ids: string[], properties: string[]) {
  return ids
    .filter((id) => store.has(id))
    .map((id) => {
      const all = store.get(id)!;
      return {
        id,
        properties: Object.fromEntries(properties.filter((k) => k in all).map((k) => [k, all[k]])),
      };
    });
}

function assoc(store: Map<string, string[]>, ids: string[]) {
  return ids
    .filter((id) => store.has(id))
    .map((id) => ({
      from: { id },
      to: store.get(id)!.map((d) => ({ toObjectId: Number(d), associationTypes: [] })),
    }));
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
