"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { ROLE_LABEL, useMe } from "@/lib/me";
import {
  Button,
  Card,
  ErrorBanner,
  Field,
  Input,
  KeyValue,
  Notice,
  PageHeader,
} from "@/components/ui";

export default function AccountPage() {
  const me = useMe();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [mismatch, setMismatch] = useState(false);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  return (
    <>
      <PageHeader title="My account" />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Profile">
          <KeyValue
            items={[
              { label: "Name", value: me.name ?? "—" },
              { label: "Email", value: me.email },
              { label: "Role", value: me.roles.map((r) => ROLE_LABEL[r] ?? r).join(", ") },
              ...(me.platform ? [{ label: "Lead source", value: me.platform }] : []),
            ]}
          />
        </Card>
        <Card title="Change password">
          {done && (
            <Notice tone="success">Password changed. Other sessions were signed out.</Notice>
          )}
          {mismatch && <Notice tone="warning">The new passwords do not match.</Notice>}
          <ErrorBanner error={error} />
          <form
            className="space-y-4"
            onSubmit={async (e) => {
              e.preventDefault();
              setError(null);
              setDone(false);
              setMismatch(next !== confirm);
              if (next !== confirm) return;
              setBusy(true);
              try {
                await api.post("/auth/change-password", {
                  current_password: current,
                  new_password: next,
                });
                setDone(true);
                setCurrent("");
                setNext("");
                setConfirm("");
              } catch (err) {
                setError(err);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Field label="Current password">
              <Input
                type="password"
                autoComplete="current-password"
                required
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
              />
            </Field>
            <Field label="New password" hint="At least 12 characters. A short sentence works well.">
              <Input
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
                value={next}
                onChange={(e) => setNext(e.target.value)}
              />
            </Field>
            <Field label="Repeat new password">
              <Input
                type="password"
                autoComplete="new-password"
                required
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </Field>
            <div className="flex justify-end">
              <Button type="submit" loading={busy}>
                Change password
              </Button>
            </div>
          </form>
        </Card>
      </div>
    </>
  );
}
