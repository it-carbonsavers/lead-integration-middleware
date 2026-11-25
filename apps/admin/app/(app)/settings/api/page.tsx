"use client";

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { ProviderApiDetails } from "@/components/api-details";
import { Card, KeyValue } from "@/components/ui";

export default function ApiSettingsPage() {
  return (
    <div className="space-y-6">
      <ProviderApiDetails title="API address" />
      <Card
        title="Lead submission API"
        description="What lead sources use to send leads. Each source has its own key (Lead Sources → API access)."
      >
        <div className="space-y-4">
          <KeyValue
            items={[
              { label: "Authentication", value: "Per-source API key (Bearer token)" },
              { label: "Format", value: "JSON, one lead per request" },
              {
                label: "Duplicate protection",
                value: "Same lead reference from the same source is never processed twice",
              },
              {
                label: "Standard request limit",
                value: "60 per minute per source (adjustable per source)",
              },
              { label: "Status lookups", value: "Sources can check their own leads only" },
            ]}
          />
          <div className="flex flex-wrap gap-4 text-sm">
            <a
              className="inline-flex items-center gap-1 font-medium text-emerald-700 hover:underline"
              href="/openapi.json"
              target="_blank"
              rel="noreferrer"
            >
              Technical specification (OpenAPI) <ArrowUpRight className="h-4 w-4" />
            </a>
            <span className="text-slate-500">
              Provider guide: docs/PROVIDER_INTEGRATION_GUIDE.md
            </span>
          </div>
        </div>
      </Card>
      <Card title="Where to manage things">
        <KeyValue
          items={[
            {
              label: "Issue or revoke a source's API key",
              value: (
                <Link className="text-emerald-700 hover:underline" href="/sources">
                  Lead Sources → source → API access
                </Link>
              ),
            },
            {
              label: "Allowed IP addresses / request limit",
              value: (
                <Link className="text-emerald-700 hover:underline" href="/sources">
                  Lead Sources → source → API access
                </Link>
              ),
            },
            {
              label: "CRM delivery",
              value: (
                <Link className="text-emerald-700 hover:underline" href="/settings/destinations">
                  Settings → Destination
                </Link>
              ),
            },
          ]}
        />
      </Card>
    </div>
  );
}
