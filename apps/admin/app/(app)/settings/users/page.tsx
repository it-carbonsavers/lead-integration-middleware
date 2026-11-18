"use client";

import Link from "next/link";
import { useState } from "react";
import { UserPlus } from "lucide-react";
import { api } from "@/lib/api";
import { ROLE_LABEL, useMe } from "@/lib/me";
import {
  Button,
  Card,
  CopyValue,
  ErrorBanner,
  Field,
  Input,
  Modal,
  Notice,
  Select,
  StatusPill,
  Table,
  TableSkeleton,
  Td,
  Th,
  timeAgo,
  useLoad,
} from "@/components/ui";

interface User {
  id: string;
  email: string;
  name: string | null;
  status: string;
  last_login_at: string | null;
  locked_until: string | null;
  platform: string | null;
  roles: string[];
}

const ROLE_HELP: Record<string, string> = {
  super_admin: "Everything, including users and settings",
  admin: "Everything except managing users",
  operator: "Work with leads: see details, retry deliveries, link recordings",
  analyst: "Reports and exports; customer details stay hidden",
  compliance: "Leads, recordings and the audit log",
};

export default function UsersPage() {
  const me = useMe();
  const { data, error, loading, reload } = useLoad(() => api.get<{ items: User[] }>("/users"), []);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ email: "", name: "", role: "operator" });
  const [secret, setSecret] = useState<{ email: string; password: string } | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const act = async (fn: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await fn();
      reload();
    } catch (e) {
      setActionError(e);
    }
  };
  const staff = data?.items.filter((u) => !u.platform) ?? [];
  const partners = data?.items.filter((u) => u.platform) ?? [];

  return (
    <div className="space-y-6">
      <ErrorBanner error={error ?? actionError} onRetry={reload} />
      {secret && (
        <Notice tone="warning" onClose={() => setSecret(null)}>
          <div className="font-medium">Temporary password for {secret.email} (shown once)</div>
          <div className="mt-2">
            <CopyValue value={secret.password} />
          </div>
        </Notice>
      )}
      <Card
        title="Team members"
        description="People in your organisation who use this dashboard."
        padded={false}
        actions={
          <Button size="sm" icon={UserPlus} onClick={() => setAdding(true)}>
            Add person
          </Button>
        }
      >
        {loading && !data ? (
          <TableSkeleton rows={4} />
        ) : (
          <Table
            head={
              <tr>
                <Th>Person</Th>
                <Th>Role</Th>
                <Th>Status</Th>
                <Th>Last sign-in</Th>
                <Th />
              </tr>
            }
          >
            {staff.map((u) => {
              const locked = u.locked_until && new Date(u.locked_until) > new Date();
              const self = u.id === me.id;
              return (
                <tr key={u.id}>
                  <Td>
                    <div className="font-medium text-slate-900">
                      {u.name}{" "}
                      {self && <span className="text-xs font-normal text-slate-500">(you)</span>}
                    </div>
                    <div className="text-xs text-slate-500">{u.email}</div>
                  </Td>
                  <Td>
                    <Select
                      className="w-44 py-1.5"
                      value={u.roles[0] ?? ""}
                      disabled={self}
                      onChange={(e) =>
                        act(() => api.patch(`/users/${u.id}`, { roles: [e.target.value] }))
                      }
                    >
                      {Object.keys(ROLE_HELP).map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABEL[r]}
                        </option>
                      ))}
                    </Select>
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
                    {!self && (
                      <div className="flex justify-end gap-1">
                        {locked && (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => act(() => api.patch(`/users/${u.id}`, { unlock: true }))}
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
                                `/users/${u.id}/reset-password`,
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
                              api.patch(`/users/${u.id}`, {
                                status: u.status === "active" ? "disabled" : "active",
                              }),
                            )
                          }
                        >
                          {u.status === "active" ? "Disable" : "Enable"}
                        </Button>
                      </div>
                    )}
                  </Td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>

      {partners.length > 0 && (
        <Card
          title="Partner logins"
          description="People at lead sources who can see their own leads. Manage them on each source's page."
          padded={false}
        >
          <Table
            head={
              <tr>
                <Th>Person</Th>
                <Th>Source</Th>
                <Th>Status</Th>
                <Th>Last sign-in</Th>
              </tr>
            }
          >
            {partners.map((u) => (
              <tr key={u.id}>
                <Td>
                  <div className="font-medium text-slate-900">{u.name}</div>
                  <div className="text-xs text-slate-500">{u.email}</div>
                </Td>
                <Td>
                  <Link className="hover:underline" href={`/sources/${u.platform}?tab=logins`}>
                    {u.platform}
                  </Link>
                </Td>
                <Td>
                  <StatusPill status={u.status} />
                </Td>
                <Td className="text-slate-500">{timeAgo(u.last_login_at)}</Td>
              </tr>
            ))}
          </Table>
        </Card>
      )}

      {adding && (
        <Modal title="Add a team member" onClose={() => setAdding(false)}>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                const r = await api.post<{ email: string; temporary_password: string }>("/users", {
                  email: form.email,
                  name: form.name,
                  roles: [form.role],
                });
                setSecret({ email: r.email, password: r.temporary_password });
                setAdding(false);
                setForm({ email: "", name: "", role: form.role });
              });
            }}
          >
            <Field label="Name">
              <Input
                required
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </Field>
            <Field label="Email">
              <Input
                type="email"
                required
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
            </Field>
            <Field label="Role" hint={ROLE_HELP[form.role]}>
              <Select
                value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value })}
              >
                {Object.keys(ROLE_HELP).map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setAdding(false)}>
                Cancel
              </Button>
              <Button type="submit">Add person</Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
