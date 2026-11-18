"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Activity, Plug2, ScrollText, Send, Server, Users, type LucideIcon } from "lucide-react";
import { can, useMe } from "@/lib/me";
import { cx, PageHeader } from "@/components/ui";

const SECTIONS: { href: string; label: string; icon: LucideIcon; perm: string }[] = [
  { href: "/settings", label: "System health", icon: Activity, perm: "platforms.manage" },
  { href: "/settings/destinations", label: "Destination", icon: Send, perm: "destinations.manage" },
  { href: "/settings/api", label: "API & integration", icon: Plug2, perm: "platforms.manage" },
  { href: "/settings/sftp", label: "SFTP", icon: Server, perm: "platforms.manage" },
  { href: "/settings/users", label: "Users & access", icon: Users, perm: "users.manage" },
  { href: "/settings/audit", label: "Audit log", icon: ScrollText, perm: "audit.read" },
];

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const me = useMe();
  const pathname = usePathname();
  const items = SECTIONS.filter((s) => can(me, s.perm));
  const current = SECTIONS.find((s) =>
    s.href === "/settings" ? pathname === "/settings" : pathname.startsWith(s.href),
  );
  return (
    <>
      <PageHeader
        title="Settings"
        description="Configuration and administration. Most people never need these pages."
      />
      <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
        <nav className="flex gap-1 overflow-x-auto lg:flex-col">
          {items.map((s) => {
            const active = current?.href === s.href;
            return (
              <Link
                key={s.href}
                href={s.href}
                className={cx(
                  "flex items-center gap-2.5 whitespace-nowrap rounded-lg px-3 py-2 text-sm",
                  active
                    ? "bg-white font-medium text-slate-900 shadow-sm ring-1 ring-slate-200"
                    : "text-slate-600 hover:bg-white/70",
                )}
              >
                <s.icon className={cx("h-4 w-4", active ? "text-emerald-600" : "text-slate-400")} />
                {s.label}
              </Link>
            );
          })}
        </nav>
        <div className="min-w-0">
          {current && !can(me, current.perm) ? (
            <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">
              You don&apos;t have access to this section.
            </div>
          ) : (
            children
          )}
        </div>
      </div>
    </>
  );
}
