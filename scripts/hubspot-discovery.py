#!/usr/bin/env python3
"""
Read-only HubSpot discovery for lead performance reporting.

What it reads (GET requests only, nothing is changed in HubSpot):
  - Lead and deal pipelines with their stages
  - Lead and deal properties relevant to outcomes, proposals and sale amounts
  - Call outcomes (dispositions)
  - A sample of recent leads: stage, how many calls and which outcomes, linked deals
    (stage, proposal status, amount), via the lead and via its contact

Privacy: only IDs, stage names, outcomes, statuses, amounts and dates are recorded.
No names, emails, phone numbers or notes. The key is read from $HS and never printed.

Usage (in a terminal where the key is loaded):
  read -rs "HS?Paste the HubSpot key (hidden): "; export HS; echo
  python3 scripts/hubspot-discovery.py            # sample 25 leads
  python3 scripts/hubspot-discovery.py 50         # sample 50 leads
  python3 scripts/hubspot-discovery.py 50 30      # 50 leads created in the last 30 days (default 90)
  python3 scripts/hubspot-discovery.py won        # how often won deals carry a sale amount (counts only)
  python3 scripts/hubspot-discovery.py sold       # which fields carry a sale value on sold deals (counts only)
  python3 scripts/hubspot-discovery.py company "Name"  # which Lead property holds the Lead Company, and how many leads have that value
Output: summary on screen, full results in .local/hubspot-discovery.json (git-ignored).
"""
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

TOKEN = os.environ.get("HS")
if not TOKEN:
    sys.exit('No key loaded. Run first:  read -rs "HS?Paste the HubSpot key (hidden): "; export HS; echo')
if len(sys.argv) > 1 and sys.argv[1] == "company":
    # Which Lead property holds "Lead Company", which values it has, and how many leads match a name.
    # Prints property names, company names and counts only: no people, emails or phone numbers.
    wanted = sys.argv[2] if len(sys.argv) > 2 else ""
    def call(method, path, body=None):
        req = urllib.request.Request("https://api.hubapi.com" + path, data=json.dumps(body).encode() if body else None,
                                     headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}, method=method)
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            return {"error": e.code}
    props = [p for p in call("GET", "/crm/v3/properties/leads").get("results", [])
             if "compan" in p["name"].lower() or "compan" in p.get("label", "").lower()
             or "source" in p["name"].lower() or "source" in p.get("label", "").lower()]
    print("Lead properties about company or source:")
    for p in props:
        print(f"  {p['name']:45} {p.get('label', '')!r:40} {p.get('type')}")
    names = [p["name"] for p in props]
    leads, after = [], None
    while len(leads) < 1000:
        body = {"properties": names + ["hs_createdate"], "limit": 100,
                "sorts": [{"propertyName": "hs_createdate", "direction": "DESCENDING"}]}
        if after:
            body["after"] = after
        page = call("POST", "/crm/v3/objects/leads/search", body)
        leads += [x["properties"] for x in page.get("results", [])]
        after = page.get("paging", {}).get("next", {}).get("after")
        if not after:
            break
        time.sleep(0.2)
    print(f"\nNewest {len(leads)} leads, most common values per property:")
    for n in names:
        counts = {}
        for l in leads:
            v = l.get(n)
            if v not in (None, ""):
                counts[v] = counts.get(v, 0) + 1
        if counts:
            top = sorted(counts.items(), key=lambda kv: -kv[1])[:8]
            print(f"  {n}: " + "; ".join(f"{v[:40]} ({c})" for v, c in top))
    if wanted:
        print(f"\nLeads (all time) whose property equals {wanted!r}:")
        for n in names:
            r = call("POST", "/crm/v3/objects/leads/search",
                     {"filterGroups": [{"filters": [{"propertyName": n, "operator": "EQ", "value": wanted}]}], "limit": 1})
            if r.get("total"):
                print(f"  {n:45} {r['total']}")
    sys.exit(0)
if len(sys.argv) > 1 and sys.argv[1] == "sold":
    # Sold deals = deals now in an Assessments or Installations pipeline (where sales move after the
    # sale), created in the last 180 days. Which fields carry a sale value? Counts only, no records.
    def call(method, path, body=None):
        req = urllib.request.Request("https://api.hubapi.com" + path, data=json.dumps(body).encode() if body else None,
                                     headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}, method=method)
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read())
    pipes = {p["id"]: p["label"] for p in call("GET", "/crm/v3/pipelines/deals")["results"]
             if any(k in p["label"].lower() for k in ("assessment", "installation"))}
    fields = ["amount", "total_amount", "system_amount", "system_price", "cash_amount", "financed_amount",
              "deposit_amount", "total_payment_received", "balance_amount", "hs_closed_amount", "pipeline"]
    since = str(int((time.time() - 180 * 86400) * 1000))
    rows = []
    for pid in pipes:
        after = None
        while True:
            body = {"filterGroups": [{"filters": [{"propertyName": "pipeline", "operator": "EQ", "value": pid},
                                                  {"propertyName": "createdate", "operator": "GTE", "value": since}]}],
                    "properties": fields, "limit": 100}
            if after:
                body["after"] = after
            page = call("POST", "/crm/v3/objects/deals/search", body)
            rows += [x["properties"] for x in page.get("results", [])]
            after = page.get("paging", {}).get("next", {}).get("after")
            if not after or len(rows) >= 2000:
                break
            time.sleep(0.2)
    print(f"Deals in Assessments/Installations pipelines, created in the last 180 days: {len(rows)}")
    for f in fields[:-1]:
        n = sum(1 for r in rows if r.get(f) not in (None, "", "0", "0.0"))
        print(f"  {f:24} filled on {n:4} of {len(rows)}")
    any_value = sum(1 for r in rows if any(r.get(f) not in (None, "", "0", "0.0") for f in fields[:-1]))
    print(f"  any of these filled      on {any_value:4} of {len(rows)}")
    sys.exit(0)

if len(sys.argv) > 1 and sys.argv[1] == "won":
    # Sale amounts: how often won deals (last 180 days) carry an amount. Counts only, no records.
    since = str(int((time.time() - 180 * 86400) * 1000))
    fields = ["amount", "total_amount", "system_amount", "hs_closed_amount", "pipeline", "dealstage"]
    rows, after = [], None
    while True:
        body = {"filterGroups": [{"filters": [
                    {"propertyName": "hs_is_closed_won", "operator": "EQ", "value": "true"},
                    {"propertyName": "closedate", "operator": "GTE", "value": since}]}],
                "properties": fields, "limit": 100}
        if after:
            body["after"] = after
        req = urllib.request.Request("https://api.hubapi.com/crm/v3/objects/deals/search", data=json.dumps(body).encode(),
                                     headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=30) as r:
            page = json.loads(r.read())
        rows += [x["properties"] for x in page.get("results", [])]
        after = page.get("paging", {}).get("next", {}).get("after")
        if not after or len(rows) >= 1000:
            break
    def filled(f):
        return sum(1 for r in rows if r.get(f) not in (None, "", "0", "0.0"))
    print(f"Won deals closed in the last 180 days: {len(rows)}")
    for f in ("amount", "total_amount", "system_amount", "hs_closed_amount"):
        print(f"  {f:18} filled on {filled(f)} of {len(rows)}")
    by_pipe = {}
    for r in rows:
        by_pipe.setdefault(r.get("pipeline"), [0, 0])
        by_pipe[r.get("pipeline")][0] += 1
        by_pipe[r.get("pipeline")][1] += 1 if r.get("amount") not in (None, "", "0", "0.0") else 0
    print("  by pipeline id (won, with amount):", by_pipe)
    sys.exit(0)

SAMPLE = int(sys.argv[1]) if len(sys.argv) > 1 else 25
DAYS = int(sys.argv[2]) if len(sys.argv) > 2 else 90  # only leads created in the last N days
BASE = "https://api.hubapi.com"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".local", "hubspot-discovery.json")

result = {"permissions": {}, "notes": []}


def get(path, params=None):
    url = BASE + path + ("?" + urllib.parse.urlencode(params, doseq=True) if params else "")
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {TOKEN}"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.status, json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < 3:
                time.sleep(2 + attempt * 2)
                continue
            try:
                body = json.loads(e.read() or b"{}")
            except Exception:
                body = {}
            return e.code, body
    return 429, {}


def post(path, body):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
        method="POST",  # HubSpot's search endpoint is a POST, but it only reads
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except Exception:
            return e.code, {}


def access(name, status, body):
    ok = status == 200
    result["permissions"][name] = "ok" if ok else f"refused ({status}) {body.get('category', '')} {body.get('message', '')[:160]}".strip()
    return ok


def pipelines(obj):
    s, b = get(f"/crm/v3/pipelines/{obj}")
    if not access(f"{obj} pipelines", s, b):
        return []
    return [
        {"id": p["id"], "label": p["label"], "stages": [{"id": st["id"], "label": st["label"], "meta": st.get("metadata", {})} for st in p["stages"]]}
        for p in b.get("results", [])
    ]


INTERESTING = ("stage", "pipeline", "amount", "price", "total", "reason", "lost", "won", "proposal", "outcome",
               "disposition", "call", "source", "opensolar", "lim_", "status", "closed", "attempt", "disqualif", "qualif")


def properties(obj):
    s, b = get(f"/crm/v3/properties/{obj}")
    if not access(f"{obj} properties", s, b):
        return []
    out = []
    for p in b.get("results", []):
        n, label = p["name"], p.get("label", "")
        if any(k in n.lower() or k in label.lower() for k in INTERESTING):
            out.append({
                "name": n, "label": label, "type": p.get("type"), "group": p.get("groupName"),
                "custom": not p.get("hubspotDefined", False),
                "options": [o.get("label") for o in p.get("options", [])][:40],
            })
    return sorted(out, key=lambda x: (not x["custom"], x["name"]))


def assoc(from_obj, oid, to_obj):
    s, b = get(f"/crm/v4/objects/{from_obj}/{oid}/associations/{to_obj}", {"limit": 100})
    return [r["toObjectId"] for r in b.get("results", [])] if s == 200 else None


print("Reading pipelines and properties ...")
result["lead_pipelines"] = pipelines("leads")
result["deal_pipelines"] = pipelines("deals")
result["lead_properties"] = properties("leads")
result["deal_properties"] = properties("deals")
result["call_properties"] = properties("calls")

s, b = get("/calling/v1/dispositions")
if access("call outcomes (dispositions)", s, b):
    result["call_outcomes"] = [{"id": d.get("id"), "label": d.get("label")} for d in (b if isinstance(b, list) else b.get("results", []))]

# ---------------------------------------------------------------- sample journeys
print(f"Sampling the {SAMPLE} most recent leads ...")
# Leads name their creation date hs_createdate (sorting by "createdate" is silently ignored).
lead_props = ["hs_pipeline", "hs_pipeline_stage", "hs_lead_disqualification_reason", "hs_lead_type",
              "hs_lead_source", "hs_createdate", "lim_lead_ref", "lim_source_platform",
              "hs_calls_attempted_count", "hs_calls_connected_count", "hs_lead_call_count",
              "hs_lead_closed_won_deals_amount", "hs_lead_associated_deal_pipeline_stage",
              "hs_pipeline_stage_category_v2", "hs_lead_is_qualified", "hs_lead_is_disqualified"]
known = {p["name"] for p in result["lead_properties"]} | {"hs_createdate", "hs_pipeline", "hs_pipeline_stage"}
lead_props = [p for p in lead_props if p in known]
since_ms = int((time.time() - DAYS * 86400) * 1000)
s, b = post("/crm/v3/objects/leads/search", {
    "filterGroups": [{"filters": [{"propertyName": "hs_createdate", "operator": "GTE", "value": str(since_ms)}]}],
    "sorts": [{"propertyName": "hs_createdate", "direction": "DESCENDING"}],
    "properties": lead_props, "limit": min(SAMPLE, 100),
})
result["sample_window_days"] = DAYS
leads = b.get("results", []) if access("lead search", s, b) else []

deal_props = [p for p in ("pipeline", "dealstage", "amount", "total_amount", "system_amount", "hs_closed_amount",
                          "closedate", "hs_is_closed_won", "hs_is_closed", "closed_lost_reason",
                          "proposal_sent_date", "sale_made_on_call", "opensolar_proposal_status",
                          "opensolar_proposal_signed_at", "createdate")
              if p in {d["name"] for d in result["deal_properties"]} | {"pipeline", "dealstage", "createdate"}]
call_props = ["hs_call_disposition", "hs_call_status", "hs_call_direction", "hs_call_duration", "hs_timestamp"]

stage_label = {st["id"]: f'{p["label"]} / {st["label"]}' for p in result["lead_pipelines"] for st in p["stages"]}
deal_stage_label = {st["id"]: f'{p["label"]} / {st["label"]}' for p in result["deal_pipelines"] for st in p["stages"]}
outcome_label = {o["id"]: o["label"] for o in result.get("call_outcomes", [])}

calls_refused = deals_refused = False
journeys = []
for i, lead in enumerate(leads, 1):
    p = lead.get("properties", {})
    j = {
        "lead_id": lead["id"], "created": p.get("hs_createdate"),
        "calls_attempted": p.get("hs_calls_attempted_count"), "calls_connected": p.get("hs_calls_connected_count"),
        "closed_won_amount": p.get("hs_lead_closed_won_deals_amount"),
        "deal_stage_rollup": p.get("hs_lead_associated_deal_pipeline_stage"),
        "stage_category": p.get("hs_pipeline_stage_category_v2"),
        "stage": stage_label.get(p.get("hs_pipeline_stage"), p.get("hs_pipeline_stage")),
        "disqualification_reason": p.get("hs_lead_disqualification_reason"),
        "lead_type": p.get("hs_lead_type"), "lead_source": p.get("hs_lead_source"),
        "lim_lead_ref": p.get("lim_lead_ref"), "lim_source_platform": p.get("lim_source_platform"),
        "calls": [], "deals_on_lead": [], "deals_via_contact": [],
    }
    contacts = assoc("leads", lead["id"], "contacts") or []
    j["contacts"] = len(contacts)

    call_ids = assoc("leads", lead["id"], "calls")
    if call_ids is None:
        calls_refused = True
        call_ids = []
    for cid in call_ids[:30]:
        s, c = get(f"/crm/v3/objects/calls/{cid}", {"properties": call_props})
        if s != 200:
            calls_refused = True
            break
        cp = c.get("properties", {})
        j["calls"].append({
            "outcome": outcome_label.get(cp.get("hs_call_disposition"), cp.get("hs_call_disposition")),
            "status": cp.get("hs_call_status"), "direction": cp.get("hs_call_direction"),
            "duration_ms": cp.get("hs_call_duration"), "at": cp.get("hs_timestamp"),
        })

    def deal_rows(ids):
        rows = []
        for did in (ids or [])[:10]:
            s, d = get(f"/crm/v3/objects/deals/{did}", {"properties": deal_props})
            if s != 200:
                return None
            dp = d.get("properties", {})
            rows.append({
                "deal_id": did, "stage": deal_stage_label.get(dp.get("dealstage"), dp.get("dealstage")),
                **{k: dp.get(k) for k in deal_props if k not in ("dealstage", "pipeline")},
            })
        return rows

    on_lead = deal_rows(assoc("leads", lead["id"], "deals"))
    via_contact = deal_rows(assoc("contacts", contacts[0], "deals")) if contacts else []
    if on_lead is None or via_contact is None:
        deals_refused = True
    j["deals_on_lead"] = on_lead or []
    j["deals_via_contact"] = via_contact or []
    journeys.append(j)
    print(f"  {i}/{len(leads)} lead {lead['id']}: {j['stage']} | calls {len(j['calls'])} | deals {len(j['deals_on_lead'])} on lead, {len(j['deals_via_contact'])} via contact")

result["sample_journeys"] = journeys
result["permissions"]["calls (read)"] = "refused" if calls_refused else "ok"
result["permissions"]["deals (read)"] = "refused" if deals_refused else "ok"

# ---------------------------------------------------------------- summary
def pct(n, d):
    return f"{round(100 * n / d)}%" if d else "-"

n = len(journeys)
with_calls = sum(1 for j in journeys if j["calls"])
with_outcome = sum(1 for j in journeys if any(c["outcome"] for c in j["calls"]))
with_deal = sum(1 for j in journeys if j["deals_on_lead"] or j["deals_via_contact"])
deal_on_lead = sum(1 for j in journeys if j["deals_on_lead"])
with_amount = sum(1 for j in journeys for d in j["deals_on_lead"] + j["deals_via_contact"] if d.get("amount") or d.get("total_amount"))
result["summary"] = {
    "leads_sampled": n, "leads_with_logged_calls": with_calls, "leads_with_call_outcome": with_outcome,
    "leads_with_a_deal": with_deal, "leads_with_deal_linked_directly": deal_on_lead, "deals_with_amount": with_amount,
}

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w") as f:
    json.dump(result, f, indent=2)

print("\nPermissions:")
for k, v in result["permissions"].items():
    print(f"  {k:32} {v}")
print(f"\nLead pipelines: {len(result['lead_pipelines'])}, deal pipelines: {len(result['deal_pipelines'])}, "
      f"call outcomes: {len(result.get('call_outcomes', []))}")
print(f"Sample of {n} leads: calls logged on {pct(with_calls, n)}, call outcome set on {pct(with_outcome, n)}, "
      f"a deal on {pct(with_deal, n)} ({deal_on_lead} linked to the lead directly), deals with an amount: {with_amount}")
print(f"\nFull results (no names, emails or phone numbers): {os.path.abspath(OUT)}")
