"use client";

import Link from "next/link";
import { useState } from "react";
import {
  ArrowUpRight,
  CheckCircle2,
  KeyRound,
  RefreshCw,
  Server,
  Upload,
  Wifi,
} from "lucide-react";
import { api } from "@/lib/api";
import {
  Button,
  Card,
  CopyValue,
  cx,
  ErrorBanner,
  Field,
  fmtDate,
  Input,
  KeyValue,
  Notice,
  Segmented,
  Skeleton,
  StatusPill,
  Textarea,
  timeAgo,
  useLoad,
} from "@/components/ui";

type Mode = "none" | "sftp_hosted";

interface SftpInfo {
  mode: Mode;
  config: null | {
    username: string | null;
    auth_method: "key" | "password";
    authorized_keys: { fingerprint: string | null; comment: string }[];
    password_set: boolean;
    account_synced_at: string | null;
    last_checked_at: string | null;
    last_success_at: string | null;
    last_error: string | null;
    last_file_at: string | null;
  };
  transfers: { stored: number; failed: number; rejected: number; last_transfer_at: string | null };
  our_server: {
    server: string | null;
    host: string | null;
    port: number | null;
    host_key_fingerprint: string | null;
    upload_directory: string;
    max_file_mb: number;
  };
}

interface TestResult {
  ok: boolean;
  message: string;
  error?: string;
}

const ERROR_TEXT: Record<string, string> = {
  server_unreachable: "Our SFTP server is not reachable.",
  no_credentials: "No key or password has been set for the provider's account.",
  account_sync_failed: "The provider's account could not be updated on the SFTP server.",
  account_missing: "The provider's account is missing on the SFTP server.",
  storage_unavailable: "The upload storage could not be read.",
  processing_failed: "Some files could not be processed; they will be retried.",
};

function MethodCard({
  active,
  onClick,
  icon: Icon,
  title,
  text,
  badge,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof Upload;
  title: string;
  text: string;
  badge?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        "flex w-full items-start gap-3 rounded-xl border p-4 text-left transition",
        active
          ? "border-emerald-500 bg-emerald-50/50 ring-2 ring-emerald-500/20"
          : "border-slate-200 bg-white hover:border-slate-300",
      )}
    >
      <span
        className={cx(
          "rounded-lg p-2",
          active ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500",
        )}
      >
        <Icon className="h-5 w-5" />
      </span>
      <span>
        <span className="flex items-center gap-2 text-sm font-medium text-slate-900">
          {title}
          {badge && (
            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700">
              {badge}
            </span>
          )}
        </span>
        <span className="mt-0.5 block text-xs text-slate-500">{text}</span>
      </span>
    </button>
  );
}

export function SourceRecordings({ code }: { code: string }) {
  const info = useLoad(() => api.get<SftpInfo>(`/platforms/${code}/sftp`), [code]);
  const [mode, setMode] = useState<Mode | null>(null);
  const [f, setF] = useState<Record<string, string>>({});
  const [test, setTest] = useState<TestResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [syncWarning, setSyncWarning] = useState<string | null>(null);

  if (info.loading && !info.data) return <Skeleton className="h-96 rounded-2xl" />;
  if (!info.data) return <ErrorBanner error={info.error} onRetry={info.reload} />;
  const d = info.data;
  const cfg = d.config;
  const current: Mode = mode ?? d.mode;
  const savedMode = d.mode;
  const v = (k: string, fallback: unknown) =>
    f[k] ?? (fallback === null || fallback === undefined ? "" : String(fallback));
  const set = (k: string) => (e: { target: { value: string } }) =>
    setF({ ...f, [k]: e.target.value });
  const auth = v("auth_method", cfg?.auth_method ?? "key") as "key" | "password";

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  }

  const save = () =>
    run("save", async () => {
      const body: Record<string, unknown> =
        current === "none"
          ? { mode: "none" }
          : {
              mode: "sftp_hosted",
              username: v("username", cfg?.username ?? code.toLowerCase()),
              auth_method: auth,
            };
      if (current === "sftp_hosted" && auth === "key" && f.authorized_keys?.trim())
        body.authorized_keys = f.authorized_keys
          .split("\n")
          .map((x) => x.trim())
          .filter(Boolean);
      const r = await api.put<{ generated_password?: string; account_sync_error?: string }>(
        `/platforms/${code}/sftp`,
        body,
      );
      setSecret(r.generated_password ?? null);
      setSyncWarning(r.account_sync_error ?? null);
      setF({});
      setMode(null);
      setNotice("Settings saved.");
      info.reload();
    });

  const showStatus = savedMode !== "none" && cfg;
  const health = !cfg?.last_checked_at ? "unknown" : cfg.last_error ? "problem" : "ok";

  return (
    <div className="space-y-6">
      <ErrorBanner error={error} />
      {notice && (
        <Notice tone="success" onClose={() => setNotice(null)}>
          {notice}
        </Notice>
      )}
      {syncWarning && (
        <Notice tone="warning" onClose={() => setSyncWarning(null)}>
          {syncWarning}
        </Notice>
      )}
      {secret && (
        <Notice tone="warning" onClose={() => setSecret(null)}>
          <div className="font-medium">New SFTP password for the provider (shown once)</div>
          <div className="mt-2">
            <CopyValue value={secret} />
          </div>
          <div className="mt-1 text-xs">
            Send it over a secure channel. It is stored only as a one-way hash and cannot be shown
            again.
          </div>
        </Notice>
      )}

      {showStatus && (
        <Card
          title="Connection status"
          actions={
            health === "ok" ? (
              <StatusPill label="Working" tone="green" />
            ) : health === "problem" ? (
              <StatusPill label="Needs attention" tone="red" />
            ) : (
              <StatusPill label="Not checked yet" tone="amber" />
            )
          }
        >
          <div className="grid gap-6 md:grid-cols-2">
            <KeyValue
              items={[
                {
                  label: "Account on our SFTP server",
                  value:
                    d.our_server.server === "SFTPGo"
                      ? cfg!.account_synced_at
                        ? `Up to date (${timeAgo(cfg!.account_synced_at)})`
                        : "Not created yet"
                      : "Waiting: no SFTP server connected in this environment",
                },
                {
                  label: "Last successful connection",
                  value: cfg!.last_success_at
                    ? `${fmtDate(cfg!.last_success_at)} (${timeAgo(cfg!.last_success_at)})`
                    : "Never",
                },
                {
                  label: "Last file received",
                  value: cfg!.last_file_at ? timeAgo(cfg!.last_file_at) : "None yet",
                },
                {
                  label: "Problem",
                  value: cfg!.last_error ? (
                    <span className="text-red-600">
                      {ERROR_TEXT[cfg!.last_error] ?? cfg!.last_error}
                    </span>
                  ) : (
                    "None"
                  ),
                },
              ]}
            />
            <div>
              <div className="grid grid-cols-3 gap-3 text-center">
                <div className="rounded-xl bg-slate-50 p-3">
                  <div className="text-xl font-semibold text-slate-900">{d.transfers.stored}</div>
                  <div className="text-xs text-slate-500">Files completed</div>
                </div>
                <div className="rounded-xl bg-slate-50 p-3">
                  <div
                    className={cx(
                      "text-xl font-semibold",
                      d.transfers.failed ? "text-red-600" : "text-slate-900",
                    )}
                  >
                    {d.transfers.failed}
                  </div>
                  <div className="text-xs text-slate-500">Failed</div>
                </div>
                <div className="rounded-xl bg-slate-50 p-3">
                  <div
                    className={cx(
                      "text-xl font-semibold",
                      d.transfers.rejected ? "text-amber-600" : "text-slate-900",
                    )}
                  >
                    {d.transfers.rejected}
                  </div>
                  <div className="text-xs text-slate-500">Rejected</div>
                </div>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  icon={Wifi}
                  loading={busy === "test"}
                  onClick={() =>
                    run("test", async () => {
                      setTest(await api.post<TestResult>(`/platforms/${code}/sftp/test`));
                      info.reload();
                    })
                  }
                >
                  Test connection
                </Button>
                <Button
                  variant="secondary"
                  icon={RefreshCw}
                  loading={busy === "scan"}
                  onClick={() =>
                    run("scan", async () => {
                      await api.post("/transfers/scan", { platform: code });
                      setNotice("Checking for new files now. Results appear in a few seconds.");
                      setTimeout(info.reload, 4000);
                    })
                  }
                >
                  Check for new files
                </Button>
                <Link href={`/consent?tab=transfers&platform=${code}`}>
                  <Button variant="ghost" icon={ArrowUpRight}>
                    View files
                  </Button>
                </Link>
              </div>
            </div>
          </div>
          {test && (
            <div
              className={cx(
                "mt-5 rounded-xl border px-4 py-3 text-sm",
                test.ok
                  ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                  : "border-red-200 bg-red-50 text-red-900",
              )}
            >
              <div className="flex items-start gap-2">
                {test.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4" /> : null}
                <span>{test.message}</span>
              </div>
            </div>
          )}
        </Card>
      )}

      <Card
        title="How this source sends consent recordings"
        description="The provider uploads recordings to their own private folder on our SFTP server."
      >
        <div className="grid gap-3 md:grid-cols-2">
          <MethodCard
            active={current === "sftp_hosted"}
            onClick={() => setMode("sftp_hosted")}
            icon={Upload}
            title="Upload to our SFTP server"
            text="We give the provider a private SFTP account on our server."
          />
          <MethodCard
            active={current === "none"}
            onClick={() => setMode("none")}
            icon={Server}
            title="Not set up"
            text="No consent recordings from this source yet."
          />
        </div>
        {current === "sftp_hosted" && (
          <div className="mt-6 grid gap-6 md:grid-cols-2">
            <div className="space-y-4">
              <Field label="SFTP username" hint="Lower-case letters, digits, - or _.">
                <Input
                  value={v("username", cfg?.username ?? code.toLowerCase())}
                  onChange={set("username")}
                />
              </Field>
              <Field label="How the provider logs in">
                <Segmented
                  value={auth}
                  onChange={(x) => setF({ ...f, auth_method: x })}
                  options={[
                    { value: "key", label: "SSH key (recommended)" },
                    { value: "password", label: "Password" },
                  ]}
                />
              </Field>
              {auth === "key" ? (
                <Field
                  label="Provider's public SSH key"
                  hint={
                    cfg?.authorized_keys.length
                      ? `${cfg.authorized_keys.length} key(s) saved (${cfg.authorized_keys.map((k) => k.fingerprint).join(", ")}). Paste new keys to replace them.`
                      : "Ask the provider for their public key (starts with ssh-ed25519 or ssh-rsa). Never accept a private key."
                  }
                >
                  <Textarea
                    rows={3}
                    value={f.authorized_keys ?? ""}
                    onChange={set("authorized_keys")}
                    placeholder="ssh-ed25519 AAAA… provider@example"
                  />
                </Field>
              ) : (
                <div className="rounded-xl bg-slate-50 p-4 text-sm text-slate-600">
                  {cfg?.password_set ? (
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="flex items-center gap-2">
                        <KeyRound className="h-4 w-4" /> A password is set. It is stored only as a
                        one-way hash.
                      </span>
                      <Button
                        size="sm"
                        variant="secondary"
                        loading={busy === "pw"}
                        onClick={() =>
                          run("pw", async () => {
                            if (
                              !confirm(
                                "Issue a new password? The current one stops working immediately.",
                              )
                            )
                              return;
                            const r = await api.post<{
                              generated_password: string;
                              account_sync_error?: string;
                            }>(`/platforms/${code}/sftp/password`);
                            setSecret(r.generated_password);
                            setSyncWarning(r.account_sync_error ?? null);
                          })
                        }
                      >
                        Issue new password
                      </Button>
                    </div>
                  ) : (
                    "A strong password is generated when you save, and shown once."
                  )}
                </div>
              )}
            </div>
            <div>
              <h3 className="mb-2 text-sm font-medium text-slate-700">
                Details to give the provider
              </h3>
              <div className="space-y-2">
                <KeyValue
                  items={[
                    {
                      label: "Server",
                      value: (
                        <code className="text-xs">{d.our_server.host ?? "not connected yet"}</code>
                      ),
                    },
                    {
                      label: "Port",
                      value: <code className="text-xs">{d.our_server.port ?? "–"}</code>,
                    },
                    {
                      label: "Username",
                      value: (
                        <code className="text-xs">
                          {v("username", cfg?.username ?? code.toLowerCase())}
                        </code>
                      ),
                    },
                    {
                      label: "Upload folder",
                      value: <code className="text-xs">{d.our_server.upload_directory}</code>,
                    },
                  ]}
                />
                {d.our_server.host_key_fingerprint && (
                  <div>
                    <div className="mb-1 text-xs text-slate-500">
                      Our server fingerprint (they should check it on first connect)
                    </div>
                    <CopyValue value={d.our_server.host_key_fingerprint} />
                  </div>
                )}
                <p className="text-xs text-slate-500">
                  File names: the recording reference sent with the lead, e.g.{" "}
                  <code>TRX-123.wav</code>, or{" "}
                  <code>{code}_&lt;lead id&gt;_&lt;UTC time&gt;.wav</code>. Formats: mp3, wav, m4a,
                  ogg; up to {d.our_server.max_file_mb} MB.
                </p>
              </div>
            </div>
          </div>
        )}

        <div className="mt-6 flex justify-end gap-2 border-t border-slate-100 pt-4">
          {(mode !== null || Object.keys(f).length > 0) && (
            <Button
              variant="ghost"
              onClick={() => {
                setMode(null);
                setF({});
              }}
            >
              Discard changes
            </Button>
          )}
          <Button loading={busy === "save"} onClick={save}>
            Save
          </Button>
        </div>
      </Card>
    </div>
  );
}
