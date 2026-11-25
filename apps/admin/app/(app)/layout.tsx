"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLayoutEffect, useState } from "react";
import {
  BarChart3,
  FileAudio,
  LayoutDashboard,
  LogOut,
  Menu,
  Plug,
  Settings,
  TrendingUp,
  UserCircle,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import { api, type Me } from "@/lib/api";
import { canSeeSettings, isProvider, isStaff, MeContext, ROLE_LABEL } from "@/lib/me";
import { cx, Skeleton } from "@/components/ui";
import { cacheMe, clearCachedMe, readCachedMe } from "@/lib/session-cache";
import { BrandLabel, Logo } from "@/components/brand";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  show: (me: Me) => boolean;
}

const NAV: NavItem[] = [
  {
    href: "/",
    label: "Overview",
    icon: LayoutDashboard,
    show: (m) => m.permissions.includes("leads.read"),
  },
  {
    href: "/leads",
    label: "Leads",
    icon: Users,
    show: (m) => m.permissions.includes("leads.read"),
  },
  {
    href: "/sources",
    label: "Lead Sources",
    icon: Plug,
    show: (m) => isStaff(m) && m.permissions.includes("platforms.manage"),
  },
  {
    href: "/consent",
    label: "Consent Recordings",
    icon: FileAudio,
    show: (m) => m.permissions.includes("recordings.read"),
  },
  {
    href: "/reports",
    label: "Reports",
    icon: BarChart3,
    show: (m) => m.permissions.includes("reports.read"),
  },
  {
    href: "/performance",
    label: "Performance",
    icon: TrendingUp,
    show: (m) => isStaff(m) && m.permissions.includes("reports.read"),
  },
  { href: "/settings", label: "Settings", icon: Settings, show: canSeeSettings },
];

/** Where leads go in a non-production environment, shown to staff above every page. */
function environmentNotice(me: Me): string {
  if (!me.hubspot_enabled)
    return "Test environment · leads go to a test destination, nothing is sent to HubSpot.";
  const sources = me.hubspot_sources ?? [];
  if (me.hubspot_all_sources)
    return "Test environment · all leads are sent to the live HubSpot, so only send leads marked TEST.";
  if (sources.length === 0)
    return "Test environment · HubSpot is connected but no source sends to it; leads go to a test destination.";
  return `Test environment · leads from ${sources.join(", ")} are sent to the live HubSpot and must be marked TEST; other leads go to a test destination.`;
}

function NavLinks({
  items,
  pathname,
  onNavigate,
}: {
  items: NavItem[];
  pathname: string;
  onNavigate?: () => void;
}) {
  return (
    <nav className="space-y-1 px-3">
      {items.map((n) => {
        const active = n.href === "/" ? pathname === "/" : pathname.startsWith(n.href);
        return (
          <Link
            key={n.href}
            href={n.href}
            onClick={onNavigate}
            className={cx(
              "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition",
              active
                ? "bg-emerald-50 font-medium text-emerald-800"
                : "text-slate-600 hover:bg-slate-100 hover:text-slate-900",
            )}
          >
            <n.icon className={cx("h-4 w-4", active ? "text-emerald-700" : "text-slate-400")} />
            {n.label}
          </Link>
        );
      })}
    </nav>
  );
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const pathname = usePathname();

  // Draw from the user remembered for this tab before the first paint (one loading state on
  // refresh, the page's own), then confirm with the server and refresh the remembered copy.
  useLayoutEffect(() => {
    const cached = readCachedMe();
    if (cached) setMe(cached);
    api
      .get<Me>("/auth/me")
      .then((m) => {
        cacheMe(m);
        setMe(m);
      })
      .catch(() => {});
  }, []);

  if (!me) {
    return (
      // Same frame as the signed-in layout (sidebar, logo, page header, cards) so nothing jumps.
      <div className="flex min-h-screen bg-slate-50" role="status" aria-label="Loading">
        <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-slate-200 bg-white lg:flex">
          <div className="px-3 pb-4 pt-3">
            <Logo width={136} priority />
            <Skeleton className="mx-3 mt-1 h-3 w-28" />
          </div>
          <div className="space-y-1 px-3">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="flex items-center gap-3 px-3 py-2">
                <Skeleton className="h-4 w-4" />
                <Skeleton className="h-3.5 w-28" />
              </div>
            ))}
          </div>
        </aside>
        <div className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6 lg:px-10">
          {/* Only the page title, which every page has; the page's own skeleton follows it. */}
          <Skeleton className="mb-2 h-8 w-48" />
          <Skeleton className="mb-6 h-4 w-80 max-w-full" />
        </div>
      </div>
    );
  }

  const items = NAV.filter((n) => n.show(me));
  const section = NAV.find((n) => n.href !== "/" && pathname.startsWith(n.href));
  const denied = section !== undefined && !section.show(me) && !pathname.startsWith("/account");

  async function signOut() {
    clearCachedMe();
    await api.post("/auth/logout").catch(() => {});
    window.location.href = "/login";
  }

  const brand = (
    <div className="px-3 pb-4 pt-3">
      <Link href="/" aria-label="Carbon Savers home">
        <Logo width={136} priority />
      </Link>
      <BrandLabel className="mt-1 px-3">
        {isProvider(me) ? `Partner portal · ${me.platform}` : "Lead Integration"}
      </BrandLabel>
    </div>
  );

  const userBlock = (
    <div className="border-t border-slate-100 p-3">
      <Link
        href="/account"
        className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-slate-100"
        onClick={() => setMenuOpen(false)}
      >
        <UserCircle className="h-8 w-8 text-slate-400" />
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-slate-900">{me.name ?? me.email}</div>
          <div className="truncate text-xs text-slate-500">
            {me.roles.map((r) => ROLE_LABEL[r] ?? r).join(", ")}
          </div>
        </div>
      </Link>
      <button
        onClick={signOut}
        className="mt-1 flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-slate-600 hover:bg-slate-100"
      >
        <LogOut className="h-4 w-4 text-slate-400" /> Sign out
      </button>
    </div>
  );

  return (
    <MeContext.Provider value={me}>
      <div className="flex min-h-screen bg-slate-50">
        {/* Desktop sidebar */}
        <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-slate-200 bg-white lg:flex">
          {brand}
          <div className="flex-1 overflow-y-auto">
            <NavLinks items={items} pathname={pathname} />
          </div>
          {userBlock}
        </aside>

        {/* Tablet / small screens: slide-over menu */}
        {menuOpen && (
          <div className="fixed inset-0 z-40 lg:hidden">
            <div className="absolute inset-0 bg-slate-900/30" onClick={() => setMenuOpen(false)} />
            <aside className="absolute left-0 top-0 flex h-full w-72 flex-col bg-white shadow-xl">
              <div className="flex items-center justify-between pr-3">
                {brand}
                <button
                  onClick={() => setMenuOpen(false)}
                  className="rounded-md p-1 text-slate-400 hover:bg-slate-100"
                  aria-label="Close menu"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto">
                <NavLinks items={items} pathname={pathname} onNavigate={() => setMenuOpen(false)} />
              </div>
              {userBlock}
            </aside>
          </div>
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-slate-200 bg-white/90 px-4 py-3 backdrop-blur lg:hidden">
            <button
              onClick={() => setMenuOpen(true)}
              className="rounded-md p-1.5 text-slate-600 hover:bg-slate-100"
              aria-label="Open menu"
            >
              <Menu className="h-5 w-5" />
            </button>
            <Logo width={96} />
            <span className="text-sm font-semibold text-slate-900">Lead Integration</span>
          </header>
          {!isProvider(me) && me.environment !== "production" && (
            <div className="border-b border-slate-200 bg-white px-6 py-2 text-xs text-slate-500 lg:px-10">
              {environmentNotice(me)}
            </div>
          )}
          <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-8 sm:px-6 lg:px-10">
            {denied ? (
              <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center shadow-sm">
                <h1 className="text-lg font-semibold">No access</h1>
                <p className="mt-1 text-sm text-slate-500">
                  Your role does not include {section!.label}.
                </p>
              </div>
            ) : (
              children
            )}
          </main>
        </div>
      </div>
    </MeContext.Provider>
  );
}
