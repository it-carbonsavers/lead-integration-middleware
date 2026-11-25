/**
 * Reads what happened to delivered leads in HubSpot. READ-ONLY: only GET and batch/read calls.
 *
 * Only HubSpot records we created are looked up (by the Lead id saved at delivery), plus the deals
 * linked to them or to their contact. Nothing else in the portal is read.
 *
 * Attribution rules (design doc "Lead performance and sales conversion reporting"):
 *  1. Credit deals linked to the HubSpot Lead, or deals of the same contact created after the
 *     lead was received. Older deals of returning customers are never credited.
 *  2. (applied by the reports) report by the date the lead was received.
 *  3. A sale is a deal in an Assessments or Installations pipeline, not the "won" flag.
 *     Sale value: total_amount, falling back to amount when it is empty.
 */

import { DestinationError } from "@lim/core";
import { HubSpotClient, type HubSpotClientOptions } from "./client.js";

export interface OutcomeLookup {
  hubspotLeadId: string;
  contactId: string | null;
  receivedAt: Date;
}

export interface DealOutcome {
  dealId: string;
  pipeline: string;
  stage: string;
  createdAt: Date | null;
  proposalSentAt: Date | null;
  proposalStatus: string | null;
  lost: boolean;
  lostReason: string | null;
  sold: boolean;
  /** Earliest date the deal entered a stage of its (sold) pipeline, when HubSpot records it. */
  soldAt: Date | null;
  saleValue: number | null;
  saleValueField: "total_amount" | "amount" | null;
}

export interface LeadOutcomeRead {
  hubspotLeadId: string;
  /** The HubSpot Lead no longer exists (deleted or merged). */
  missing: boolean;
  leadStageId: string | null;
  leadStage: string | null;
  leadStageEnteredAt: Date | null;
  disqualificationReason: string | null;
  callsAttempted: number;
  callsConnected: number;
  dealCount: number;
  deal: DealOutcome | null;
}

export interface OutcomeReadResult {
  outcomes: LeadOutcomeRead[];
  /** Deals could not be read (for example the key lacks the deals read scope). */
  dealsUnreadable: string | null;
}

interface HsObject {
  id: string;
  properties: Record<string, string | null | undefined>;
}
interface Pipeline {
  id: string;
  label: string;
  stages: { id: string; label: string }[];
}

const LEAD_PROPERTIES = [
  "hs_pipeline_stage",
  "hs_lead_disqualification_reason",
  "hs_calls_attempted_count",
  "hs_calls_connected_count",
  "hs_v2_date_entered_current_stage",
];
const DEAL_PROPERTIES = [
  "pipeline",
  "dealstage",
  "createdate",
  "proposal_sent_date",
  "opensolar_proposal_status",
  "closed_lost_reason",
  "hs_is_closed_lost",
  "total_amount",
  "amount",
];
const BATCH = 100;

export interface OutcomeReaderOptions extends HubSpotClientOptions {
  /** Deal pipelines whose label matches count as sold. */
  soldPipelinePattern: RegExp;
}

export class HubSpotOutcomeReader {
  private readonly client: HubSpotClient;

  constructor(private readonly opts: OutcomeReaderOptions) {
    this.client = new HubSpotClient(opts);
  }

  async read(lookups: OutcomeLookup[]): Promise<OutcomeReadResult> {
    this.client.guard();
    if (lookups.length === 0) return { outcomes: [], dealsUnreadable: null };

    const leadPipelines = await this.pipelines("leads");
    const leadStageLabel = new Map(
      leadPipelines.flatMap((p) => p.stages.map((s) => [s.id, s.label])),
    );

    const leads = await this.batchRead(
      "leads",
      lookups.map((l) => l.hubspotLeadId),
      LEAD_PROPERTIES,
    );

    let dealsUnreadable: string | null = null;
    let credited = new Map<string, DealOutcome[]>();
    try {
      credited = await this.creditedDeals(lookups, new Set(leads.keys()));
    } catch (err) {
      // Deals are optional: without the deals scope the lead-side outcome is still worth keeping.
      if (err instanceof DestinationError && err.errorClass === "permanent") {
        dealsUnreadable = err.code;
      } else {
        throw err;
      }
    }

    const outcomes = lookups.map((l): LeadOutcomeRead => {
      const lead = leads.get(l.hubspotLeadId);
      if (!lead) {
        return {
          hubspotLeadId: l.hubspotLeadId,
          missing: true,
          leadStageId: null,
          leadStage: null,
          leadStageEnteredAt: null,
          disqualificationReason: null,
          callsAttempted: 0,
          callsConnected: 0,
          dealCount: 0,
          deal: null,
        };
      }
      const p = lead.properties;
      const stageId = text(p["hs_pipeline_stage"]);
      const deals = credited.get(l.hubspotLeadId) ?? [];
      return {
        hubspotLeadId: l.hubspotLeadId,
        missing: false,
        leadStageId: stageId,
        leadStage: stageId ? (leadStageLabel.get(stageId) ?? stageId) : null,
        leadStageEnteredAt: date(p["hs_v2_date_entered_current_stage"]),
        disqualificationReason: text(p["hs_lead_disqualification_reason"]),
        callsAttempted: int(p["hs_calls_attempted_count"]),
        callsConnected: int(p["hs_calls_connected_count"]),
        dealCount: deals.length,
        deal: pickCreditedDeal(deals),
      };
    });
    return { outcomes, dealsUnreadable };
  }

  private async creditedDeals(
    lookups: OutcomeLookup[],
    existingLeads: Set<string>,
  ): Promise<Map<string, DealOutcome[]>> {
    const live = lookups.filter((l) => existingLeads.has(l.hubspotLeadId));
    const byLead = await this.associations(
      "leads",
      live.map((l) => l.hubspotLeadId),
    );
    const contactIds = [...new Set(live.map((l) => l.contactId).filter((c): c is string => !!c))];
    const byContact = await this.associations("contacts", contactIds);

    const allDealIds = new Set<string>();
    for (const ids of [...byLead.values(), ...byContact.values()])
      ids.forEach((i) => allDealIds.add(i));
    if (allDealIds.size === 0) return new Map();

    const dealPipelines = await this.pipelines("deals");
    const soldPipelines = dealPipelines.filter((p) => this.opts.soldPipelinePattern.test(p.label));
    const enteredProps = soldPipelines.flatMap((p) =>
      p.stages.map((s) => `hs_v2_date_entered_${s.id}`),
    );
    const deals = await this.batchRead(
      "deals",
      [...allDealIds],
      [...DEAL_PROPERTIES, ...enteredProps],
    );
    const parsed = new Map<string, DealOutcome & { contactDeal: boolean }>();
    for (const d of deals.values()) {
      parsed.set(d.id, { ...toDealOutcome(d, dealPipelines, soldPipelines), contactDeal: false });
    }

    const result = new Map<string, DealOutcome[]>();
    for (const l of live) {
      const ids = new Set(byLead.get(l.hubspotLeadId) ?? []);
      for (const id of byContact.get(l.contactId ?? "") ?? []) {
        const deal = parsed.get(id);
        // Rule 1: a contact's deal is credited only if it was created after the lead arrived.
        if (deal?.createdAt && deal.createdAt.getTime() >= l.receivedAt.getTime()) ids.add(id);
      }
      const list = [...ids]
        .map((id) => parsed.get(id))
        .filter((d): d is DealOutcome & { contactDeal: boolean } => !!d);
      result.set(
        l.hubspotLeadId,
        list.map(({ contactDeal: _ignored, ...d }) => d),
      );
    }
    return result;
  }

  private async pipelines(objectType: "leads" | "deals"): Promise<Pipeline[]> {
    const res = await this.client.request<{ results: Pipeline[] }>(
      "GET",
      `/crm/v3/pipelines/${objectType}`,
    );
    return res.results ?? [];
  }

  private async batchRead(
    objectType: "leads" | "deals",
    ids: string[],
    properties: string[],
  ): Promise<Map<string, HsObject>> {
    const out = new Map<string, HsObject>();
    for (let i = 0; i < ids.length; i += BATCH) {
      const res = await this.client.request<{ results?: HsObject[] }>(
        "POST",
        `/crm/v3/objects/${objectType}/batch/read`,
        { properties, inputs: ids.slice(i, i + BATCH).map((id) => ({ id })) },
      );
      for (const o of res.results ?? []) out.set(o.id, o);
    }
    return out;
  }

  /** Deal ids associated with each lead or contact id. */
  private async associations(
    from: "leads" | "contacts",
    ids: string[],
  ): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    for (let i = 0; i < ids.length; i += BATCH) {
      const res = await this.client.request<{
        results?: { from: { id: string }; to: { toObjectId: string | number }[] }[];
      }>("POST", `/crm/v4/associations/${from}/deals/batch/read`, {
        inputs: ids.slice(i, i + BATCH).map((id) => ({ id })),
      });
      for (const r of res.results ?? []) {
        out.set(
          String(r.from.id),
          r.to.map((t) => String(t.toObjectId)),
        );
      }
    }
    return out;
  }
}

export function toDealOutcome(
  d: HsObject,
  pipelines: Pipeline[],
  soldPipelines: Pipeline[],
): DealOutcome {
  const p = d.properties;
  const pipelineId = text(p["pipeline"]) ?? "";
  const stageId = text(p["dealstage"]) ?? "";
  const pipeline = pipelines.find((x) => x.id === pipelineId);
  const stageLabel = pipeline?.stages.find((s) => s.id === stageId)?.label ?? stageId;
  const soldPipeline = soldPipelines.find((x) => x.id === pipelineId);
  const sold = !!soldPipeline;
  const entered = soldPipeline
    ? soldPipeline.stages
        .map((s) => date(p[`hs_v2_date_entered_${s.id}`]))
        .filter((x): x is Date => !!x)
    : [];
  const lost = !sold && (p["hs_is_closed_lost"] === "true" || /\blost\b/i.test(stageLabel));
  const sale = saleValue(p);
  return {
    dealId: d.id,
    pipeline: pipeline?.label ?? pipelineId,
    stage: stageLabel,
    createdAt: date(p["createdate"]),
    proposalSentAt: date(p["proposal_sent_date"]),
    proposalStatus: text(p["opensolar_proposal_status"]),
    lost,
    lostReason: lost ? text(p["closed_lost_reason"]) : null,
    sold,
    soldAt: entered.length ? new Date(Math.min(...entered.map((x) => x.getTime()))) : null,
    saleValue: sold ? sale.value : null,
    saleValueField: sold ? sale.field : null,
  };
}

/** Sale value: total_amount (the quote total), falling back to amount. Zero counts as empty. */
export function saleValue(p: Record<string, string | null | undefined>): {
  value: number | null;
  field: "total_amount" | "amount" | null;
} {
  for (const field of ["total_amount", "amount"] as const) {
    const n = Number(p[field]);
    if (p[field] != null && p[field] !== "" && Number.isFinite(n) && n > 0)
      return { value: n, field };
  }
  return { value: null, field: null };
}

/**
 * The deal that represents the lead's outcome: a sale first (earliest), then an open deal with a
 * proposal, then any open deal, then a lost one. Ties go to the most recently created deal.
 */
export function pickCreditedDeal(deals: DealOutcome[]): DealOutcome | null {
  const rank = (d: DealOutcome) => (d.sold ? 0 : d.lost ? 3 : d.proposalSentAt ? 1 : 2);
  const sorted = [...deals].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    if (a.sold && b.sold)
      return (a.soldAt?.getTime() ?? Infinity) - (b.soldAt?.getTime() ?? Infinity);
    return (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0);
  });
  return sorted[0] ?? null;
}

function text(v: string | null | undefined): string | null {
  return v == null || v === "" ? null : v;
}
function int(v: string | null | undefined): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}
/** HubSpot returns ISO datetimes, YYYY-MM-DD dates, or epoch milliseconds. */
export function date(v: string | null | undefined): Date | null {
  if (v == null || v === "") return null;
  const d = /^\d{11,}$/.test(v) ? new Date(Number(v)) : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
