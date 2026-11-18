"use client";

/**
 * Design system for the admin dashboard: one place for spacing, colours, typography and states.
 * Neutral slate surfaces, a single emerald accent, rounded cards, subtle borders.
 */

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Circle,
  Info,
  Inbox,
  Loader2,
  Search,
  X,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { ApiError } from "@/lib/api";

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

// --- Layout ---------------------------------------------------------------------------

export function PageHeader({
  title,
  description,
  actions,
  back,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  back?: { href: string; label: string };
}) {
  return (
    <div className="mb-6">
      {back && (
        <Link
          href={back.href}
          className="mb-2 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"
        >
          <ChevronLeft className="h-4 w-4" /> {back.label}
        </Link>
      )}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{title}</h1>
          {description && <p className="mt-1 text-sm text-slate-500">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

export function Card({
  title,
  description,
  actions,
  children,
  className,
  padded = true,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <section className={cx("rounded-2xl border border-slate-200 bg-white shadow-sm", className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <div>
            {title && <h2 className="text-sm font-semibold text-slate-900">{title}</h2>}
            {description && <p className="mt-0.5 text-xs text-slate-500">{description}</p>}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={padded ? "p-5" : ""}>{children}</div>
    </section>
  );
}

export function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = "slate",
  href,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: LucideIcon;
  tone?: "slate" | "emerald" | "amber" | "red" | "sky";
  href?: string;
}) {
  const tones = {
    slate: "bg-slate-100 text-slate-600",
    emerald: "bg-emerald-50 text-emerald-600",
    amber: "bg-amber-50 text-amber-600",
    red: "bg-red-50 text-red-600",
    sky: "bg-sky-50 text-sky-600",
  };
  const body = (
    <div
      className={cx(
        "h-full rounded-2xl border border-slate-200 bg-white p-5 shadow-sm",
        href && "transition hover:border-slate-300 hover:shadow",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="text-sm font-medium text-slate-500">{label}</div>
        {Icon && (
          <span className={cx("rounded-lg p-2", tones[tone])}>
            <Icon className="h-4 w-4" />
          </span>
        )}
      </div>
      <div className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">{value}</div>
      {hint && <div className="mt-1 text-xs text-slate-500">{hint}</div>}
    </div>
  );
  return href ? (
    <Link href={href} className="block h-full">
      {body}
    </Link>
  ) : (
    body
  );
}

// --- Controls -------------------------------------------------------------------------

export function Button({
  children,
  variant = "primary",
  size = "md",
  icon: Icon,
  loading,
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "ghost";
  size?: "sm" | "md";
  icon?: LucideIcon;
  loading?: boolean;
}) {
  return (
    <button
      {...props}
      disabled={props.disabled || loading}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40 disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "px-2.5 py-1.5 text-xs" : "px-3.5 py-2 text-sm",
        variant === "primary" && "bg-slate-900 text-white hover:bg-slate-800",
        variant === "secondary" &&
          "border border-slate-200 bg-white text-slate-700 shadow-sm hover:bg-slate-50",
        variant === "danger" && "border border-red-200 bg-white text-red-600 hover:bg-red-50",
        variant === "ghost" && "text-slate-600 hover:bg-slate-100",
        className,
      )}
    >
      {loading ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : Icon ? (
        <Icon className="h-4 w-4" />
      ) : null}
      {children}
    </button>
  );
}

const inputCls =
  "w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm placeholder:text-slate-400 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 disabled:bg-slate-50";

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx(inputCls, props.className)} />;
}
export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cx(inputCls, "font-mono text-xs", props.className)} />;
}
export function Select({ children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...props} className={cx(inputCls, "pr-8", props.className)}>
      {children}
    </select>
  );
}

export function SearchInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
      <input
        className={cx(inputCls, "pl-9")}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-slate-700">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cx(
            "rounded-md px-3 py-1.5 text-sm",
            value === o.value
              ? "bg-white font-medium text-slate-900 shadow-sm"
              : "text-slate-500 hover:text-slate-800",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Tabs({
  tabs,
  active,
}: {
  tabs: { key: string; label: string; href: string; count?: number }[];
  active: string;
}) {
  return (
    <nav className="mb-6 flex gap-6 overflow-x-auto border-b border-slate-200">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          className={cx(
            "-mb-px whitespace-nowrap border-b-2 pb-3 text-sm",
            active === t.key
              ? "border-emerald-600 font-medium text-slate-900"
              : "border-transparent text-slate-500 hover:text-slate-800",
          )}
        >
          {t.label}
          {t.count !== undefined && (
            <span
              className={cx(
                "ml-2 rounded-full px-2 py-0.5 text-xs",
                active === t.key ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600",
              )}
            >
              {t.count}
            </span>
          )}
        </Link>
      ))}
    </nav>
  );
}

// --- Status ---------------------------------------------------------------------------

type Tone = "green" | "amber" | "red" | "blue" | "gray";
const TONE: Record<Tone, string> = {
  green: "bg-emerald-50 text-emerald-700 ring-emerald-600/15",
  amber: "bg-amber-50 text-amber-800 ring-amber-600/20",
  red: "bg-red-50 text-red-700 ring-red-600/15",
  blue: "bg-sky-50 text-sky-700 ring-sky-600/15",
  gray: "bg-slate-100 text-slate-600 ring-slate-500/15",
};
const DOT: Record<Tone, string> = {
  green: "bg-emerald-500",
  amber: "bg-amber-500",
  red: "bg-red-500",
  blue: "bg-sky-500",
  gray: "bg-slate-400",
};

/** Everyday wording for every status in the system. */
export const STATUS: Record<string, { label: string; tone: Tone }> = {
  received: { label: "Received", tone: "blue" },
  queued: { label: "Processing", tone: "blue" },
  delivering: { label: "Processing", tone: "blue" },
  retry_scheduled: { label: "Retrying", tone: "amber" },
  delivered: { label: "Delivered", tone: "green" },
  failed: { label: "Failed", tone: "red" },
  dead_letter: { label: "Failed", tone: "red" },
  held: { label: "On hold", tone: "amber" },
  discarded: { label: "Discarded", tone: "gray" },
  awaiting_recording: { label: "Awaiting recording", tone: "amber" },
  overdue: { label: "Recording overdue", tone: "red" },
  matched: { label: "Recording matched", tone: "green" },
  not_captured: { label: "No recording needed", tone: "gray" },
  unmatched: { label: "Not matched yet", tone: "amber" },
  rejected: { label: "Rejected", tone: "red" },
  deleted: { label: "Deleted (retention)", tone: "gray" },
  stored: { label: "Completed", tone: "green" },
  transferring: { label: "In progress", tone: "blue" },
  skipped_duplicate: { label: "Duplicate", tone: "gray" },
  accepted: { label: "Accepted", tone: "green" },
  duplicate: { label: "Duplicate", tone: "gray" },
  active: { label: "Active", tone: "green" },
  suspended: { label: "Suspended", tone: "red" },
  disabled: { label: "Disabled", tone: "gray" },
  invited: { label: "Invited", tone: "blue" },
};

export function StatusPill({
  status,
  label,
  tone,
}: {
  status?: string;
  label?: string;
  tone?: Tone;
}) {
  const s = (status && STATUS[status]) || { label: label ?? status ?? "", tone: tone ?? "gray" };
  const t = tone ?? s.tone;
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset",
        TONE[t],
      )}
    >
      <span className={cx("h-1.5 w-1.5 rounded-full", DOT[t])} />
      {label ?? s.label}
    </span>
  );
}

// --- Data display ---------------------------------------------------------------------

export function Table({ head, children }: { head: ReactNode; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead className="border-b border-slate-100 bg-slate-50/60 text-left text-xs font-medium text-slate-500">
          {head}
        </thead>
        <tbody className="divide-y divide-slate-100">{children}</tbody>
      </table>
    </div>
  );
}
export const Th = ({ children, className }: { children?: ReactNode; className?: string }) => (
  <th className={cx("whitespace-nowrap px-5 py-3 font-medium", className)}>{children}</th>
);
export const Td = ({ children, className }: { children?: ReactNode; className?: string }) => (
  <td className={cx("px-5 py-3.5 align-middle text-slate-700", className)}>{children}</td>
);

export function Pagination({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (p: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total === 0) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 px-5 py-3 text-sm text-slate-500">
      <span>
        Showing {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of{" "}
        {total.toLocaleString()}
      </span>
      <div className="flex gap-1">
        <Button
          variant="secondary"
          size="sm"
          icon={ChevronLeft}
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
        >
          Previous
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={page >= pages}
          onClick={() => onPage(page + 1)}
        >
          Next <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

export function EmptyState({
  icon: Icon = Inbox,
  title,
  text,
  action,
}: {
  icon?: LucideIcon;
  title: string;
  text?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      <span className="mb-3 rounded-full bg-slate-100 p-3 text-slate-500">
        <Icon className="h-6 w-6" />
      </span>
      <div className="text-sm font-medium text-slate-900">{title}</div>
      {text && <p className="mt-1 max-w-sm text-sm text-slate-500">{text}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("animate-pulse rounded-md bg-slate-100", className)} />;
}

export function TableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-3 p-5" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-9 w-full" />
      ))}
    </div>
  );
}

export function ErrorBanner({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!error) return null;
  const e = error instanceof ApiError ? error : null;
  const msg =
    e?.status === 403
      ? "You don't have access to this."
      : e?.status === 404
        ? "Not found."
        : (e?.title ?? "Something went wrong. Please try again.");
  return (
    <div
      className="mb-4 flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
      role="alert"
    >
      <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="flex-1">
        <div className="font-medium">{msg}</div>
        {e?.errors?.length ? (
          <ul className="mt-1 list-disc pl-5 text-red-700">
            {e.errors.map((x) => (
              <li key={x.path + x.code}>
                {x.path.replace(/_/g, " ")}: {x.code.replace(/_/g, " ")}
              </li>
            ))}
          </ul>
        ) : null}
        {e?.requestId && <div className="mt-1 text-xs text-red-500">Reference: {e.requestId}</div>}
      </div>
      {onRetry && (
        <button onClick={onRetry} className="text-sm font-medium underline">
          Try again
        </button>
      )}
    </div>
  );
}

export function Notice({
  children,
  tone = "info",
  onClose,
}: {
  children: ReactNode;
  tone?: "info" | "warning" | "success";
  onClose?: () => void;
}) {
  const Icon = tone === "success" ? CheckCircle2 : tone === "warning" ? AlertTriangle : Info;
  return (
    <div
      className={cx(
        "mb-4 flex items-start gap-3 rounded-xl border px-4 py-3 text-sm",
        tone === "info" && "border-sky-200 bg-sky-50 text-sky-900",
        tone === "warning" && "border-amber-200 bg-amber-50 text-amber-900",
        tone === "success" && "border-emerald-200 bg-emerald-50 text-emerald-900",
      )}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1">{children}</div>
      {onClose && (
        <button onClick={onClose} aria-label="Dismiss">
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

export function Modal({
  title,
  description,
  children,
  onClose,
  wide,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      role="dialog"
      aria-modal="true"
    >
      <div
        className={cx(
          "max-h-[90vh] w-full overflow-y-auto rounded-2xl bg-white shadow-xl",
          wide ? "max-w-2xl" : "max-w-lg",
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-6 py-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">{title}</h2>
            {description && <p className="mt-0.5 text-sm text-slate-500">{description}</p>}
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="px-6 py-5">{children}</div>
      </div>
    </div>
  );
}

/** Horizontal bars for "by source" style breakdowns (no chart library needed). */
export function BarList({
  items,
}: {
  items: { label: ReactNode; value: number; href?: string; sub?: ReactNode }[];
}) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <ul className="space-y-4">
      {items.map((i, idx) => {
        const row = (
          <div>
            <div className="mb-1.5 flex items-center justify-between text-sm">
              <span className="truncate text-slate-700">{i.label}</span>
              <span className="ml-3 font-medium tabular-nums text-slate-900">
                {i.value.toLocaleString()}
              </span>
            </div>
            <div className="h-2 rounded-full bg-slate-100">
              <div
                className="h-2 rounded-full bg-emerald-500"
                style={{ width: `${Math.max(2, Math.round((i.value / max) * 100))}%` }}
              />
            </div>
            {i.sub && <div className="mt-1 text-xs text-slate-500">{i.sub}</div>}
          </div>
        );
        return (
          <li key={idx}>
            {i.href ? (
              <Link href={i.href} className="block rounded-lg hover:opacity-80">
                {row}
              </Link>
            ) : (
              row
            )}
          </li>
        );
      })}
    </ul>
  );
}

export interface WorkflowStep {
  key: string;
  label: string;
  state: "done" | "current" | "waiting" | "problem" | "not_applicable";
  at: string | null;
  note: string | null;
}

/** The consent recording workflow as a vertical stepper. */
export function Stepper({ steps }: { steps: WorkflowStep[] }) {
  return (
    <ol>
      {steps.map((s, i) => {
        const last = i === steps.length - 1;
        const icon =
          s.state === "done" ? (
            <CheckCircle2 className="h-5 w-5 text-emerald-600" />
          ) : s.state === "problem" ? (
            <AlertTriangle className="h-5 w-5 text-red-600" />
          ) : s.state === "current" ? (
            <span className="flex h-5 w-5 items-center justify-center">
              <span className="h-3 w-3 animate-pulse rounded-full bg-amber-500" />
            </span>
          ) : (
            <Circle className="h-5 w-5 text-slate-300" />
          );
        return (
          <li key={s.key} className="relative flex gap-3 pb-5 last:pb-0">
            {!last && (
              <span
                className={cx(
                  "absolute left-[9px] top-6 h-[calc(100%-1.25rem)] w-px",
                  s.state === "done" ? "bg-emerald-200" : "bg-slate-200",
                )}
              />
            )}
            <span className="relative z-10 bg-white">{icon}</span>
            <div className="min-w-0">
              <div
                className={cx(
                  "text-sm",
                  s.state === "not_applicable" || s.state === "waiting"
                    ? "text-slate-400"
                    : "font-medium text-slate-900",
                )}
              >
                {s.label}
              </div>
              {s.at && <div className="text-xs text-slate-500">{fmtDate(s.at)}</div>}
              {s.note && (
                <div
                  className={cx(
                    "mt-0.5 text-xs",
                    s.state === "problem" ? "text-red-600" : "text-slate-500",
                  )}
                >
                  {s.note}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** Six small bars summarising the workflow in a table row. */
export function StepDots({
  done,
  total = 6,
  problem,
}: {
  done: number;
  total?: number;
  problem?: boolean;
}) {
  return (
    <span className="inline-flex gap-1" aria-label={`${done} of ${total} steps done`}>
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          className={cx(
            "h-1.5 w-4 rounded-full",
            i < done
              ? "bg-emerald-500"
              : i === done && problem
                ? "bg-red-400"
                : i === done
                  ? "bg-amber-400"
                  : "bg-slate-200",
          )}
        />
      ))}
    </span>
  );
}

// --- Helpers --------------------------------------------------------------------------

export function fmtDate(v: string | Date | null | undefined, withTime = true) {
  if (!v) return "—";
  return new Date(v).toLocaleString(
    undefined,
    withTime ? { dateStyle: "medium", timeStyle: "short" } : { dateStyle: "medium" },
  );
}

export function timeAgo(v: string | Date | null | undefined) {
  if (!v) return "never";
  const s = Math.round((Date.now() - new Date(v).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

export const pct = (n: number, d: number) => {
  if (!d) return "—";
  const v = (n / d) * 100;
  // One decimal near the ends so 4,036 of 4,042 does not read as 100%.
  return `${v > 99 && v < 100 ? Math.floor(v * 10) / 10 : v < 1 && v > 0 ? Math.ceil(v * 10) / 10 : Math.round(v)}%`;
};

export function useLoad<T>(loader: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    loader()
      .then((d) => alive && (setData(d), setError(null)))
      .catch((e) => alive && setError(e))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [...deps, tick]);
  return { data, error, loading, reload: () => setTick((x) => x + 1) };
}

export function CopyValue({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
      <code className="min-w-0 flex-1 break-all text-xs text-slate-800">{value}</code>
      <button
        type="button"
        className="shrink-0 text-xs font-medium text-emerald-700 hover:underline"
        onClick={() => void navigator.clipboard.writeText(value).then(() => setCopied(true))}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export function KeyValue({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="divide-y divide-slate-100">
      {items.map((i) => (
        <div key={i.label} className="flex justify-between gap-4 py-2.5 text-sm">
          <dt className="shrink-0 text-slate-500">{i.label}</dt>
          <dd className="min-w-0 text-right text-slate-900">{i.value ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}
