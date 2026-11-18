/**
 * In-memory stand-in for the HubSpot CRM API, used as the adapter's `fetch` in tests.
 * No network is involved. Supports failure injection and search-index lag.
 */

interface Obj {
  id: string;
  properties: Record<string, string>;
  associations?: unknown;
}

interface Failure {
  method: string;
  pathPrefix: string;
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  times: number;
}

export class FakeHubSpot {
  contacts: Obj[] = [];
  leads: Obj[] = [];
  calls: { method: string; path: string; body: unknown; auth: string | null }[] = [];
  /** When true, newly created contacts are not returned by search (HubSpot index lag). */
  searchLag = false;
  private nextId = 1000;
  private failures: Failure[] = [];
  private unsearchable = new Set<string>();

  failNext(
    method: string,
    pathPrefix: string,
    status: number,
    times = 1,
    body?: unknown,
    headers?: Record<string, string>,
  ) {
    this.failures.push({ method, pathPrefix, status, times, body, headers });
  }

  readonly fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const headers = new Headers(init.headers);
    this.calls.push({ method, path: u.pathname, body, auth: headers.get("authorization") });

    const f = this.failures.find(
      (x) => x.method === method && u.pathname.startsWith(x.pathPrefix) && x.times > 0,
    );
    if (f) {
      f.times--;
      return json(
        f.status,
        f.body ?? { category: "SIMULATED", message: "simulated failure for Alex Example" },
        f.headers,
      );
    }

    const p = u.pathname;
    if (method === "GET" && p === "/crm/v3/objects/contacts")
      return json(200, { results: this.contacts.slice(0, 1) });

    if (method === "POST" && p === "/crm/v3/objects/contacts/search") {
      const groups =
        (body.filterGroups as { filters: { propertyName: string; value: string }[] }[]) ?? [];
      const hit = this.contacts.find(
        (c) =>
          !this.unsearchable.has(c.id) &&
          groups.some((g) => g.filters.every((f) => c.properties[f.propertyName] === f.value)),
      );
      return json(200, { results: hit ? [hit] : [] });
    }
    if (method === "POST" && p === "/crm/v3/objects/contacts") {
      const email = body.properties.email as string | undefined;
      const dup = email ? this.contacts.find((c) => c.properties["email"] === email) : undefined;
      if (dup)
        return json(409, {
          category: "CONFLICT",
          message: `Contact already exists. Existing ID: ${dup.id}`,
        });
      const c = { id: String(this.nextId++), properties: { ...body.properties } };
      this.contacts.push(c);
      if (this.searchLag) this.unsearchable.add(c.id);
      return json(201, c);
    }
    if (method === "PATCH" && p.startsWith("/crm/v3/objects/contacts/")) {
      const c = this.contacts.find((x) => x.id === p.split("/").pop());
      if (!c) return json(404, { category: "OBJECT_NOT_FOUND" });
      Object.assign(c.properties, body.properties);
      return json(200, c);
    }
    if (method === "POST" && p === "/crm/v3/objects/leads/search") {
      const ref = body.filterGroups[0].filters[0].value as string;
      const hit = this.leads.find((l) => l.properties["lim_lead_ref"] === ref);
      return json(200, { results: hit ? [hit] : [] });
    }
    if (method === "POST" && p === "/crm/v3/objects/leads") {
      const assoc = body.associations?.[0]?.to?.id;
      if (!assoc || !this.contacts.some((c) => c.id === assoc)) {
        return json(400, {
          category: "VALIDATION_ERROR",
          message: "Lead requires an associated contact",
        });
      }
      const l = {
        id: String(this.nextId++),
        properties: { ...body.properties },
        associations: body.associations,
      };
      this.leads.push(l);
      return json(201, l);
    }
    if (p.includes("/deals")) throw new Error("adapter must never touch deals");
    return json(404, { category: "OBJECT_NOT_FOUND" });
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
