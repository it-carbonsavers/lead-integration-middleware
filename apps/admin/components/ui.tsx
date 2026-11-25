"use client";

/**
 * Design system for the admin dashboard: one place for spacing, colours, typography and states.
 * Carbon Savers brand: Slate Gray text and pill buttons, Mantis green accent, Outfit type.
 * "slate" and "emerald" are remapped to the brand colours in app/globals.css.
 */

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
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
  loading,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  padded?: boolean;
  /** Data in the card is being refreshed: shows a thin progress bar along the top edge. */
  loading?: boolean;
}) {
  return (
    <section
      aria-busy={loading || undefined}
      className={cx(
        "relative overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm",
        className,
      )}
    >
      {loading && <LoadingBar />}
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
  loading,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: LucideIcon;
  tone?: "slate" | "emerald" | "amber" | "red" | "sky";
  href?: string;
  /** Value is being refreshed: dims the number so stale figures are not read as current. */
  loading?: boolean;
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
      <div
        className={cx(
          "mt-2 text-3xl font-semibold tracking-tight text-slate-900 transition-opacity",
          loading && "opacity-40",
        )}
      >
        {value}
      </div>
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
  const { onClick, ...rest } = props;
  const [pending, handleClick] = usePendingClick(onClick);
  const busy = Boolean(loading) || pending;
  return (
    <button
      {...rest}
      onClick={handleClick}
      aria-busy={busy || undefined}
      disabled={props.disabled || busy}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-full font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40 disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "px-3 py-1.5 text-xs" : "px-4 py-2 text-sm",
        variant === "primary" && "bg-slate-900 text-white hover:bg-slate-800",
        variant === "secondary" &&
          "border border-slate-200 bg-white text-slate-700 shadow-sm hover:bg-slate-50",
        variant === "danger" && "border border-red-200 bg-white text-red-600 hover:bg-red-50",
        variant === "ghost" && "text-slate-600 hover:bg-slate-100",
        className,
      )}
    >
      {busy ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : Icon ? (
        <Icon className="h-4 w-4" />
      ) : null}
      {children}
    </button>
  );
}

/**
 * An async onClick (saving, issuing a key, revoking...) marks the control as busy until it
 * finishes, and further clicks are ignored meanwhile, so a slow request cannot be sent twice.
 */
function usePendingClick(
  onClick: React.MouseEventHandler<HTMLButtonElement> | undefined,
): [boolean, React.MouseEventHandler<HTMLButtonElement> | undefined] {
  const [pending, setPending] = useState(false);
  const busyRef = useRef(false);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  if (!onClick) return [pending, undefined];
  return [
    pending,
    (e) => {
      if (busyRef.current) return;
      const result = onClick(e) as unknown;
      if (result instanceof Promise) {
        busyRef.current = true;
        setPending(true);
        void result.finally(() => {
          busyRef.current = false;
          if (alive.current) setPending(false);
        });
      }
    },
  ];
}

/** Link-style action inside tables and lists (Play, Retry, Link...), with the same busy state. */
export function TextButton({
  children,
  className,
  onClick,
  disabled,
  tone = "brand",
}: {
  children: ReactNode;
  className?: string;
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
  disabled?: boolean;
  tone?: "brand" | "danger" | "muted";
}) {
  const [pending, handleClick] = usePendingClick(onClick);
  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled || pending}
      aria-busy={pending || undefined}
      className={cx(
        "inline-flex items-center gap-1 text-xs font-medium hover:underline disabled:cursor-not-allowed disabled:opacity-60 disabled:no-underline",
        tone === "brand" && "text-emerald-700",
        tone === "danger" && "text-red-600",
        tone === "muted" && "text-slate-500 hover:text-slate-800",
        className,
      )}
    >
      {pending && <Loader2 className="h-3 w-3 animate-spin" />}
      {children}
    </button>
  );
}

const inputCls =
  "rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm placeholder:text-slate-400 focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 disabled:bg-slate-50";

/**
 * Fields are full width unless the caller sets a width class (w-44, w-56...). Both used to be
 * applied and the full width won, so a dropdown in a table column could shrink to nothing.
 */
const fieldWidth = (className?: string) =>
  className && /(^|\s)w-/.test(className) ? undefined : "w-full";

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input {...props} className={cx(inputCls, fieldWidth(props.className), props.className)} />
  );
}
export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea {...props} className={cx(inputCls, "w-full font-mono text-xs", props.className)} />
  );
}
export function Select({ children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={cx(inputCls, fieldWidth(props.className), "pr-8", props.className)}
    >
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
        className={cx(inputCls, "w-full pl-9")}
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

export function Table({
  head,
  children,
  loading,
}: {
  head: ReactNode;
  children: ReactNode;
  /**
   * New rows are being fetched (filter, page or refresh). The current rows stay in place
   * (no layout jump) but are dimmed under a progress bar and a "Loading" spinner.
   */
  loading?: boolean;
}) {
  return (
    <div className="relative" aria-busy={loading || undefined}>
      {loading && <LoadingBar />}
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="border-b border-slate-100 bg-slate-50/60 text-left text-xs font-medium text-slate-500">
            {head}
          </thead>
          <tbody
            className={cx(
              "divide-y divide-slate-100 transition-opacity",
              loading && "pointer-events-none opacity-50",
            )}
          >
            {children}
          </tbody>
        </table>
      </div>
      {loading && (
        <div className="pointer-events-none absolute inset-x-0 top-14 flex justify-center">
          <span className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 shadow-sm">
            <Spinner /> Loading…
          </span>
        </div>
      )}
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
  loading,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (p: number) => void;
  /** A page is loading: the buttons wait so clicks do not pile up. */
  loading?: boolean;
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
          disabled={page <= 1 || loading}
          onClick={() => onPage(page - 1)}
        >
          Previous
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={page >= pages || loading}
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

// --- Loading states -------------------------------------------------------------------
// One family of loading indicators, in brand colours, used everywhere:
// - first load: a skeleton shaped like the content (no blank screen, no layout jump)
// - refresh / filter / paging: the content stays, dimmed, under a thin progress bar
// - actions: the button shows a spinner and is disabled until the request finishes

export function Spinner({ className }: { className?: string }) {
  return <Loader2 aria-hidden className={cx("h-4 w-4 animate-spin text-emerald-600", className)} />;
}

/** Thin indeterminate progress bar along the top edge of its (relative) container. */
export function LoadingBar() {
  return (
    <div
      role="progressbar"
      aria-label="Loading"
      className="absolute inset-x-0 top-0 z-10 h-0.5 overflow-hidden bg-emerald-100"
    >
      <div className="cs-loading-bar h-full w-1/3 rounded-full bg-emerald-500" />
    </div>
  );
}

/** Small inline "Loading…" text with a spinner, for lists and pickers. */
export function LoadingText({ children = "Loading…" }: { children?: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm text-slate-500" role="status">
      <Spinner /> {children}
    </span>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cx("animate-pulse rounded-md bg-slate-100", className)} />;
}

/** Table placeholder: header and rows at the real table's height, so nothing jumps on load. */
export function TableSkeleton({ rows = 6, cols = 4 }: { rows?: number; cols?: number }) {
  const widths = ["w-3/4", "w-1/2", "w-2/3", "w-1/3", "w-5/12", "w-7/12"];
  return (
    <div role="status" aria-label="Loading" className="overflow-hidden">
      <div className="flex gap-6 border-b border-slate-100 bg-slate-50/60 px-5 py-3">
        {Array.from({ length: cols }, (_, c) => (
          <Skeleton key={c} className="h-3 flex-1 bg-slate-200/70" />
        ))}
      </div>
      <div className="divide-y divide-slate-100">
        {Array.from({ length: rows }, (_, r) => (
          <div key={r} className="flex items-center gap-6 px-5 py-4">
            {Array.from({ length: cols }, (_, c) => (
              <div key={c} className="flex-1">
                <Skeleton className={cx("h-3.5", widths[(r + c) % widths.length])} />
                {c === 0 && <Skeleton className="mt-1.5 h-2.5 w-1/3" />}
              </div>
            ))}
          </div>
        ))}
      </div>
      <span className="sr-only">Loading…</span>
    </div>
  );
}

/** Placeholder for a StatCard (same size and padding). */
export function StatCardSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading"
      className="h-full rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
    >
      <div className="flex items-start justify-between gap-3">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-8 w-8 rounded-lg" />
      </div>
      <Skeleton className="mt-3 h-8 w-16" />
      <Skeleton className="mt-2 h-3 w-28" />
    </div>
  );
}

export function StatCardsSkeleton({ count = 4 }: { count?: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <StatCardSkeleton key={i} />
      ))}
    </>
  );
}

/** Placeholder for a BarList chart. */
export function ChartSkeleton({ rows = 4 }: { rows?: number }) {
  const widths = ["w-11/12", "w-2/3", "w-1/2", "w-1/3", "w-1/4"];
  return (
    <div role="status" aria-label="Loading" className="space-y-4">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i}>
          <div className="mb-1.5 flex justify-between">
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="h-3.5 w-8" />
          </div>
          <div className="h-2 rounded-full bg-slate-100">
            <Skeleton className={cx("h-2 rounded-full bg-slate-200", widths[i % widths.length])} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Placeholder for a KeyValue list. */
export function KeyValueSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading" className="divide-y divide-slate-100">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex justify-between gap-4 py-3">
          <Skeleton className="h-3.5 w-28" />
          <Skeleton className={cx("h-3.5", i % 2 ? "w-24" : "w-40")} />
        </div>
      ))}
    </div>
  );
}

/** Placeholder for a form: label + field rows and a button. */
export function FormSkeleton({ fields = 3 }: { fields?: number }) {
  return (
    <div role="status" aria-label="Loading" className="space-y-4">
      {Array.from({ length: fields }, (_, i) => (
        <div key={i}>
          <Skeleton className="mb-1.5 h-3.5 w-28" />
          <Skeleton className="h-9 w-full rounded-lg" />
        </div>
      ))}
      <Skeleton className="h-9 w-28 rounded-full" />
    </div>
  );
}

/** Placeholder for a whole Card (title, description and body). */
export function CardSkeleton({
  className,
  children,
}: {
  className?: string;
  children?: ReactNode;
}) {
  return (
    <section
      role="status"
      aria-label="Loading"
      className={cx("rounded-2xl border border-slate-200 bg-white shadow-sm", className)}
    >
      <header className="border-b border-slate-100 px-5 py-4">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="mt-2 h-3 w-64 max-w-full" />
      </header>
      <div className="p-5">{children ?? <KeyValueSkeleton />}</div>
    </section>
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
  busy,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  /** An operation is running: the dialog cannot be closed until it finishes. */
  busy?: boolean;
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
            disabled={busy}
            className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 disabled:cursor-not-allowed disabled:opacity-40"
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
  // Callers waiting for a reload to finish (see reload below).
  const waiting = useRef<(() => void)[]>([]);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    loader()
      .then((d) => alive && (setData(d), setError(null)))
      .catch((e) => alive && setError(e))
      .finally(() => {
        if (!alive) return;
        setLoading(false);
        const done = waiting.current;
        waiting.current = [];
        done.forEach((resolve) => resolve());
      });
    return () => {
      alive = false;
    };
  }, [...deps, tick]);
  /** Fetches again; the returned promise settles once the new data (or error) is in. */
  const reload = () =>
    new Promise<void>((resolve) => {
      waiting.current.push(resolve);
      setTick((x) => x + 1);
    });
  /** True while new data is fetched for content already on screen (filters, paging, refresh). */
  const refreshing = loading && data !== null;
  return { data, error, loading, refreshing, reload };
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
