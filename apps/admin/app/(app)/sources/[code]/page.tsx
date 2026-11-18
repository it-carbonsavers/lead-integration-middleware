"use client";

import Link from "next/link";
import { Suspense, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { KeyRound, Plus, UserPlus, Users } from "lucide-react";
import { api } from "@/lib/api";
import { can, useMe } from "@/lib/me";
import { RecordingHealth, type Source } from "@/components/sources";
import { SourceRecordings } from "@/components/source-recordings";
import {
  Button,
  Card,
  CopyValue,
  EmptyState,
  ErrorBanner,
  Field,
  fmtDate,
  Input,
  KeyValue,
  Modal,
  Notice,
  PageHeader,
  pct,
  Select,
  Skeleton,
  StatCard,
  StatusPill,
  Table,
  Tabs,
  Td,
  Textarea,
  Th,
  timeAgo,
  useLoad,
} from "@/components/ui";

interface Key {
  id: string;
  key_prefix: string;
  label: string | null;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}
interface PortalUser {
  id: string;
  email: string;
  name: string | null;
  status: string;
  last_login_at: string | null;
  locked_until: string | null;
}
interface Agent {
  id: string;
  external_agent_id: string;
  name: string | null;
  lead_count: number;
  last_seen_at: string;
}

function OverviewTab({ s }: { s: Source }) {
  const agents = useLoad(() => api.get<{ items: Agent[] }>(`/agents?platform=${s.code}`), [s.code]);
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Leads (30 days)"
          value={s.leads_30d.toLocaleString()}
          href={`/leads?platform=${s.code}`}
        />
        <StatCard
          label="Delivered"
          value={pct(s.delivered_30d, s.leads_30d)}
          hint="of leads in 30 days"
        />
        <StatCard
          label="Last lead"
          value={<span className="text-xl">{timeAgo(s.last_lead_at)}</span>}
        />
        <StatCard label="All-time leads" value={s.lead_count.toLocaleString()} />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Integration status">
          <KeyValue
            items={[
              { label: "Status", value: <StatusPill status={s.status} /> },
              {
                label: "API access",
                value: s.active_keys
                  ? `${s.active_keys} active key(s), used ${timeAgo(s.last_api_use_at)}`
                  : "No active key",
              },
              { label: "Consent recordings", value: <RecordingHealth s={s} /> },
              {
                label: "Partner portal",
                value: s.portal_users ? `${s.portal_users} login(s)` : "No logins",
              },
            ]}
          />
        </Card>
        <Card
          title="Agents"
          description="Agents are added automatically when leads arrive."
          padded={false}
        >
          {agents.data?.items.length ? (
            <Table
              head={
                <tr>
                  <Th>Agent</Th>
                  <Th className="text-right">Leads</Th>
                  <Th className="text-right">Last seen</Th>
                </tr>
              }
            >
              {agents.data.items.slice(0, 8).map((a) => (
                <tr key={a.id}>
                  <Td>
                    <Link
                      className="font-medium text-slate-900 hover:underline"
                      href={`/leads?platform=${s.code}&agent=${a.id}`}
                    >
                      {a.name ?? a.external_agent_id}
                    </Link>
                    <div className="text-xs text-slate-500">{a.external_agent_id}</div>
                  </Td>
                  <Td className="text-right tabular-nums">{a.lead_count}</Td>
                  <Td className="text-right text-slate-500">{timeAgo(a.last_seen_at)}</Td>
                </tr>
              ))}
            </Table>
          ) : (
            <EmptyState icon={Users} title="No agents yet" />
          )}
        </Card>
      </div>
    </div>
  );
}

function ApiTab({ s, onChanged }: { s: Source; onChanged: () => void }) {
  const keys = useLoad(() => api.get<{ items: Key[] }>(`/platforms/${s.code}/keys`), [s.code]);
  const [issuing, setIssuing] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [rate, setRate] = useState(s.rate_limit_per_min?.toString() ?? "");
  const [cidrs, setCidrs] = useState(s.allowed_cidrs.join("\n"));
  const [saved, setSaved] = useState(false);

  return (
    <div className="space-y-6">
      <ErrorBanner error={error} />
      {newKey && (
        <Notice tone="warning" onClose={() => setNewKey(null)}>
          <div className="font-medium">New API key (shown once)</div>
          <div className="mt-2">
            <CopyValue value={newKey} />
          </div>
          <div className="mt-1 text-xs">
            Send it to the provider over a secure channel. We only keep a fingerprint of it.
          </div>
        </Notice>
      )}
      <Card
        title="API keys"
        description="The provider sends this key with every lead. Issue a new key and revoke the old one to rotate."
        padded={false}
        actions={
          <Button size="sm" icon={Plus} onClick={() => setIssuing(true)}>
            Issue key
          </Button>
        }
      >
        {keys.data?.items.length ? (
          <Table
            head={
              <tr>
                <Th>Key</Th>
                <Th>Created</Th>
                <Th>Last used</Th>
                <Th>Status</Th>
                <Th />
              </tr>
            }
          >
            {keys.data.items.map((k) => {
              const state = k.revoked_at
                ? "revoked"
                : k.expires_at && new Date(k.expires_at) < new Date()
                  ? "expired"
                  : "active";
              return (
                <tr key={k.id}>
                  <Td>
                    <div className="font-mono text-xs">{k.key_prefix}…</div>
                    <div className="text-xs text-slate-500">{k.label ?? "No label"}</div>
                  </Td>
                  <Td className="text-slate-500">{fmtDate(k.created_at, false)}</Td>
                  <Td className="text-slate-500">{timeAgo(k.last_used_at)}</Td>
                  <Td>
                    <StatusPill
                      label={
                        state === "active"
                          ? k.expires_at
                            ? `Active until ${fmtDate(k.expires_at, false)}`
                            : "Active"
                          : state === "expired"
                            ? "Expired"
                            : "Revoked"
                      }
                      tone={state === "active" ? "green" : "gray"}
                    />
                  </Td>
                  <Td className="text-right">
                    {state === "active" && (
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={async () => {
                          if (
                            !confirm(
                              `Revoke key ${k.key_prefix}…? Requests using it will be refused immediately.`,
                            )
                          )
                            return;
                          try {
                            await api.del(`/platforms/${s.code}/keys/${k.key_prefix}`);
                            keys.reload();
                            onChanged();
                          } catch (e) {
                            setError(e);
                          }
                        }}
                      >
                        Revoke
                      </Button>
                    )}
                  </Td>
                </tr>
              );
            })}
          </Table>
        ) : (
          <EmptyState
            icon={KeyRound}
            title="No API keys yet"
            text="Issue a key so this source can start sending leads."
          />
        )}
      </Card>

      <Card title="Access rules">
        {saved && (
          <Notice tone="success" onClose={() => setSaved(false)}>
            Access rules saved.
          </Notice>
        )}
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Request limit per minute" hint="Leave empty to use the standard limit.">
            <Input
              type="number"
              min={1}
              value={rate}
              onChange={(e) => setRate(e.target.value)}
              placeholder="Standard"
            />
          </Field>
          <Field
            label="Allowed IP addresses"
            hint="One per line (e.g. 203.0.113.10 or 203.0.113.0/24). Empty = any address."
          >
            <Textarea rows={3} value={cidrs} onChange={(e) => setCidrs(e.target.value)} />
          </Field>
        </div>
        <div className="mt-4 flex justify-end">
          <Button
            onClick={async () => {
              setError(null);
              try {
                await api.patch(`/platforms/${s.code}`, {
                  rate_limit_per_min: rate ? Number(rate) : null,
                  allowed_cidrs: cidrs.split(/[\s,]+/).filter(Boolean),
                });
                setSaved(true);
                onChanged();
              } catch (e) {
                setError(e);
              }
            }}
          >
            Save access rules
          </Button>
        </div>
      </Card>
      {issuing && (
        <IssueKey
          code={s.code}
          onClose={() => setIssuing(false)}
          onIssued={(token) => {
            setIssuing(false);
            setNewKey(token);
            keys.reload();
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function IssueKey({
  code,
  onClose,
  onIssued,
}: {
  code: string;
  onClose: () => void;
  onIssued: (token: string) => void;
}) {
  const [label, setLabel] = useState("");
  const [days, setDays] = useState("365");
  const [error, setError] = useState<unknown>(null);
  return (
    <Modal title="Issue an API key" onClose={onClose}>
      <ErrorBanner error={error} />
      <div className="space-y-4">
        <Field label="Label" hint="Helps you tell keys apart, e.g. 'production 2026'.">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field label="Valid for">
          <Select value={days} onChange={(e) => setDays(e.target.value)}>
            <option value="90">90 days</option>
            <option value="180">6 months</option>
            <option value="365">1 year</option>
          </Select>
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={async () => {
              try {
                const r = await api.post<{ token: string }>(`/platforms/${code}/keys`, {
                  label: label || undefined,
                  expires_in_days: Number(days),
                });
                onIssued(r.token);
              } catch (e) {
                setError(e);
              }
            }}
          >
            Issue key
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function LoginsTab({ code }: { code: string }) {
  const users = useLoad(() => api.get<{ items: PortalUser[] }>(`/platforms/${code}/users`), [code]);
  const [adding, setAdding] = useState(false);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [secret, setSecret] = useState<{ email: string; password: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      users.reload();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <div className="space-y-6">
      <ErrorBanner error={error} />
      {secret && (
        <Notice tone="warning" onClose={() => setSecret(null)}>
          <div className="font-medium">Temporary password for {secret.email} (shown once)</div>
          <div className="mt-2">
            <CopyValue value={secret.password} />
          </div>
          <div className="mt-1 text-xs">They can change it under My account after signing in.</div>
        </Notice>
      )}
      <Card
        title="Partner portal logins"
        description="People at this provider who can sign in to see only their own leads, delivery status and consent recordings."
        padded={false}
        actions={
          <Button size="sm" icon={UserPlus} onClick={() => setAdding(true)}>
            Add login
          </Button>
        }
      >
        {users.data?.items.length ? (
          <Table
            head={
              <tr>
                <Th>Person</Th>
                <Th>Status</Th>
                <Th>Last sign-in</Th>
                <Th />
              </tr>
            }
          >
            {users.data.items.map((u) => {
              const locked = u.locked_until && new Date(u.locked_until) > new Date();
              return (
                <tr key={u.id}>
                  <Td>
                    <div className="font-medium text-slate-900">{u.name}</div>
                    <div className="text-xs text-slate-500">{u.email}</div>
                  </Td>
                  <Td>
                    {locked ? (
                      <StatusPill label="Locked" tone="red" />
                    ) : (
                      <StatusPill status={u.status} />
                    )}
                  </Td>
                  <Td className="text-slate-500">{timeAgo(u.last_login_at)}</Td>
                  <Td className="text-right">
                    <div className="flex justify-end gap-1">
                      {locked && (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() =>
                            act(() =>
                              api.patch(`/platforms/${code}/users/${u.id}`, { unlock: true }),
                            )
                          }
                        >
                          Unlock
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() =>
                          act(async () => {
                            if (!confirm(`Reset the password for ${u.email}?`)) return;
                            const r = await api.post<{ temporary_password: string }>(
                              `/platforms/${code}/users/${u.id}/reset-password`,
                            );
                            setSecret({ email: u.email, password: r.temporary_password });
                          })
                        }
                      >
                        Reset password
                      </Button>
                      <Button
                        size="sm"
                        variant={u.status === "active" ? "danger" : "secondary"}
                        onClick={() =>
                          act(() =>
                            api.patch(`/platforms/${code}/users/${u.id}`, {
                              status: u.status === "active" ? "disabled" : "active",
                            }),
                          )
                        }
                      >
                        {u.status === "active" ? "Disable" : "Enable"}
                      </Button>
                    </div>
                  </Td>
                </tr>
              );
            })}
          </Table>
        ) : (
          <EmptyState
            icon={Users}
            title="No portal logins"
            text="Add a login so the provider can check their own leads."
          />
        )}
      </Card>
      {adding && (
        <Modal title="Add a partner login" onClose={() => setAdding(false)}>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                const r = await api.post<{ email: string; temporary_password: string }>(
                  `/platforms/${code}/users`,
                  { email, name },
                );
                setSecret({ email: r.email, password: r.temporary_password });
                setAdding(false);
                setEmail("");
                setName("");
              });
            }}
          >
            <Field label="Name">
              <Input required value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Email">
              <Input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setAdding(false)}>
                Cancel
              </Button>
              <Button type="submit">Add login</Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

function SettingsTab({ s, onChanged }: { s: Source; onChanged: () => void }) {
  const me = useMe();
  const dests = useLoad(
    () =>
      can(me, "destinations.manage")
        ? api.get<{ items: { id: string; name: string; type: string; is_default: boolean }[] }>(
            "/destinations",
          )
        : Promise.resolve({ items: [] }),
    [],
  );
  const [dest, setDest] = useState(s.destination_id ?? "");
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  return (
    <div className="space-y-6">
      <ErrorBanner error={error} />
      {saved && (
        <Notice tone="success" onClose={() => setSaved(false)}>
          Saved.
        </Notice>
      )}
      {can(me, "destinations.manage") && (
        <Card
          title="Where leads are delivered"
          description="Normally every source uses the standard destination."
        >
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[260px] flex-1">
              <Field label="Destination">
                <Select value={dest} onChange={(e) => setDest(e.target.value)}>
                  <option value="">Standard destination</option>
                  {dests.data?.items.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Button
              onClick={async () => {
                try {
                  await api.patch(`/platforms/${s.code}`, { destination_id: dest || null });
                  setSaved(true);
                  onChanged();
                } catch (e) {
                  setError(e);
                }
              }}
            >
              Save
            </Button>
          </div>
        </Card>
      )}
      <Card title={s.status === "active" ? "Suspend this source" : "Re-activate this source"}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-xl text-sm text-slate-600">
            {s.status === "active"
              ? "A suspended source cannot send leads (requests are refused) and its SFTP account stops working. Data already received is kept."
              : "The source can send leads again with its existing API keys."}
          </p>
          <Button
            variant={s.status === "active" ? "danger" : "primary"}
            onClick={async () => {
              if (s.status === "active" && !confirm(`Suspend ${s.display_name}?`)) return;
              try {
                await api.patch(`/platforms/${s.code}`, {
                  status: s.status === "active" ? "suspended" : "active",
                });
                onChanged();
              } catch (e) {
                setError(e);
              }
            }}
          >
            {s.status === "active" ? "Suspend source" : "Activate source"}
          </Button>
        </div>
      </Card>
    </div>
  );
}

function View() {
  const { code } = useParams<{ code: string }>();
  const params = useSearchParams();
  const tab = params.get("tab") ?? "overview";
  const { data, error, loading, reload } = useLoad(
    () => api.get<{ items: Source[] }>("/platforms"),
    [],
  );
  const s = data?.items.find((x) => x.code === code);
  if (error) return <ErrorBanner error={error} onRetry={reload} />;
  if (loading && !data) return <Skeleton className="h-96 rounded-2xl" />;
  if (!s)
    return (
      <EmptyState
        title="Source not found"
        action={<Link href="/sources">Back to lead sources</Link>}
      />
    );
  const href = (t: string) => `/sources/${code}${t === "overview" ? "" : `?tab=${t}`}`;
  return (
    <>
      <PageHeader
        back={{ href: "/sources", label: "Lead Sources" }}
        title={
          <span className="flex flex-wrap items-center gap-3">
            {s.display_name} <StatusPill status={s.status} />
          </span>
        }
        description={`Code ${s.code}`}
      />
      <Tabs
        active={tab}
        tabs={[
          { key: "overview", label: "Overview", href: href("overview") },
          { key: "api", label: "API access", href: href("api") },
          { key: "recordings", label: "Consent recordings", href: href("recordings") },
          { key: "logins", label: "Partner logins", href: href("logins"), count: s.portal_users },
          { key: "settings", label: "Settings", href: href("settings") },
        ]}
      />
      {tab === "overview" && <OverviewTab s={s} />}
      {tab === "api" && <ApiTab s={s} onChanged={reload} />}
      {tab === "recordings" && <SourceRecordings code={s.code} />}
      {tab === "logins" && <LoginsTab code={s.code} />}
      {tab === "settings" && <SettingsTab s={s} onChanged={reload} />}
    </>
  );
}

export default function SourcePage() {
  return (
    <Suspense>
      <View />
    </Suspense>
  );
}
