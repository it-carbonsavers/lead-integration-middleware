"use client";

import { ArrowUpRight } from "lucide-react";
import { api } from "@/lib/api";
import { Card, CopyValue, KeyValue, Notice, Skeleton, useLoad } from "@/components/ui";

interface Integration {
  api_base_url: string | null;
  lead_endpoint: string | null;
  openapi_url: string | null;
}

/** What a lead provider needs, besides their key, to start sending leads. */
export function ProviderApiDetails({ title = "Details to give the provider" }: { title?: string }) {
  const { data, loading } = useLoad(() => api.get<Integration>("/integration"), []);
  if (loading && !data) return <Skeleton className="h-40 rounded-2xl" />;
  const endpoint = data?.lead_endpoint ?? null;
  return (
    <Card
      title={title}
      description="Send these together with the API key. The provider sends one request per lead."
    >
      {!endpoint ? (
        <Notice tone="warning">
          The public API address is not configured. Set PUBLIC_API_URL on the API service.
        </Notice>
      ) : (
        <div className="space-y-4">
          <div>
            <div className="mb-1 text-xs text-slate-500">API address (send leads here)</div>
            <CopyValue value={endpoint} />
          </div>
          <KeyValue
            items={[
              { label: "Method", value: "POST, JSON body, one lead per request" },
              {
                label: "Authentication",
                value: <code className="text-xs">Authorization: Bearer &lt;API key&gt;</code>,
              },
              {
                label: "Check a lead",
                value: <code className="text-xs">GET {endpoint}/&lt;lead_ref&gt;</code>,
              },
            ]}
          />
          <div>
            <div className="mb-1 text-xs text-slate-500">Test the key (example)</div>
            <CopyValue
              value={`curl ${data!.api_base_url}/v1/ping -H "Authorization: Bearer <API key>"`}
            />
          </div>
          {data?.openapi_url && (
            <a
              className="inline-flex items-center gap-1 text-sm font-medium text-emerald-700 hover:underline"
              href={data.openapi_url}
              target="_blank"
              rel="noreferrer"
            >
              Technical specification (OpenAPI) <ArrowUpRight className="h-4 w-4" />
            </a>
          )}
        </div>
      )}
    </Card>
  );
}
