"use client";

// The shared shell (Ops spec §3A): 240px sidebar with the portal switcher on
// top, grouped nav with badge pills, ⌘K search in the header, session menu.
// One build, three nav trees — every portal page mounts inside this.
// Visual system: dark console sidebar with a per-portal accent (ops = blue,
// shops = emerald, data = violet); light content pane, max-width so big
// monitors don't stretch tables into unreadability.

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { usePortalSession } from "@/app/(portals)/portal-session";
import { NAV, PORTALS, type PortalId } from "./nav";
import { CommandK } from "./CommandK";
import { AuditDrawer } from "./AuditDrawer";

const BADGE_KEYS = ["ops.pending_deletions", "data.vin_queue_pending", "slo.review_queue_depth"];

// Per-portal accent — switcher pill, active nav item, left rail.
const ACCENT: Record<PortalId, { pill: string; active: string; rail: string; badge: string }> = {
  ops: {
    pill: "bg-blue-500 text-white",
    active: "bg-blue-500/15 text-blue-200",
    rail: "bg-blue-400",
    badge: "bg-blue-400/20 text-blue-200",
  },
  shops: {
    pill: "bg-emerald-500 text-white",
    active: "bg-emerald-500/15 text-emerald-200",
    rail: "bg-emerald-400",
    badge: "bg-emerald-400/20 text-emerald-200",
  },
  data: {
    pill: "bg-violet-500 text-white",
    active: "bg-violet-500/15 text-violet-200",
    rail: "bg-violet-400",
    badge: "bg-violet-400/20 text-violet-200",
  },
};

export function PortalShell({ portal, children }: { portal: PortalId; children: React.ReactNode }) {
  const session = usePortalSession();
  const pathname = usePathname();
  const router = useRouter();
  const [cmdOpen, setCmdOpen] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const stats = useQuery(api.portalStats.getStats, { token: session.token, keys: BADGE_KEYS });
  const accent = ACCENT[portal];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const badge = (key?: string): number | null => {
    if (!key || !stats) return null;
    const row = stats[key];
    return row && row.value > 0 ? row.value : null;
  };

  const activeHref = useMemo(() => {
    // Longest matching nav href wins so /ops/users highlights Users, not Overview.
    const hrefs = NAV[portal].flatMap((g) => g.items.map((i) => i.href));
    return hrefs
      .filter((h) => pathname === h || pathname.startsWith(h + "/"))
      .sort((a, b) => b.length - a.length)[0];
  }, [pathname, portal]);

  return (
    <div className="flex min-h-screen">
      {/* Sidebar — 240px per spec, dark console */}
      <aside className="fixed inset-y-0 z-40 flex w-60 flex-col bg-slate-950">
        {/* Brand + portal switcher */}
        <div className="border-b border-white/5 px-3 pb-3 pt-4">
          <div className="mb-3 flex items-center gap-2 px-1">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-violet-600 text-[13px] font-black text-white">
              O
            </span>
            <span className="text-[14px] font-bold tracking-tight text-white">
              OtoPair <span className="font-medium text-slate-400">Console</span>
            </span>
          </div>
          <div className="flex items-center gap-1">
            {PORTALS.map((p) => (
              <Link
                key={p.id}
                href={p.base}
                className={`flex-1 rounded-md px-2 py-1 text-center text-[12px] font-semibold transition ${
                  p.id === portal
                    ? ACCENT[p.id].pill
                    : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
                }`}
              >
                {p.label}
              </Link>
            ))}
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto px-2 py-3">
          {NAV[portal].map((group, gi) => (
            <div key={gi} className="mb-4">
              {group.label && (
                <div className="mb-1 px-2 text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">
                  {group.label}
                </div>
              )}
              {group.items.map((item) => {
                const isActive = item.href === activeHref;
                const b = badge(item.badgeKey);
                if (item.phase) {
                  return (
                    <div
                      key={item.href}
                      className="flex cursor-default items-center justify-between rounded-md px-2 py-1.5 text-[13px] text-slate-600"
                      title={`Ships in ${item.phase}`}
                    >
                      {item.label}
                      <span className="rounded bg-white/5 px-1 text-[10px] font-semibold text-slate-500">
                        {item.phase}
                      </span>
                    </div>
                  );
                }
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`relative flex items-center justify-between rounded-md px-2 py-1.5 text-[13px] font-medium transition ${
                      isActive
                        ? accent.active
                        : "text-slate-400 hover:bg-white/5 hover:text-slate-100"
                    }`}
                  >
                    {isActive && (
                      <span
                        className={`absolute -left-2 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full ${accent.rail}`}
                      />
                    )}
                    {item.label}
                    {b !== null && (
                      <span className={`rounded-full px-1.5 text-[11px] font-semibold ${accent.badge}`}>
                        {b}
                      </span>
                    )}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>

        {/* Session footer */}
        <div className="relative border-t border-white/5 px-3 py-2.5">
          <button
            onClick={() => setMenuOpen((o) => !o)}
            className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-white/5"
          >
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-slate-600 to-slate-800 text-xs font-bold text-white">
              {session.name.slice(0, 1).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-semibold text-slate-200">
                {session.name}
              </span>
              <span className="block text-[11px] text-slate-500">{session.role}</span>
            </span>
          </button>
          {menuOpen && (
            <div className="absolute bottom-14 left-3 right-3 z-50 rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
              <button
                onClick={() => {
                  setMenuOpen(false);
                  setAuditOpen(true);
                }}
                className="block w-full px-3 py-1.5 text-left text-[13px] text-slate-600 hover:bg-slate-50"
              >
                Recent activity
              </button>
              <button
                onClick={() => session.logout()}
                className="block w-full px-3 py-1.5 text-left text-[13px] text-red-600 hover:bg-red-50"
              >
                Sign out
              </button>
            </div>
          )}
        </div>
      </aside>

      {/* Content */}
      <div className="ml-60 min-w-0 flex-1">
        <header className="sticky top-0 z-30 flex h-12 items-center justify-between border-b border-slate-200 bg-white/90 px-6 backdrop-blur">
          <div className="text-[13px] text-slate-400">
            <span className="font-semibold text-slate-700">
              {PORTALS.find((p) => p.id === portal)?.label}
            </span>
            <span className="mx-1.5">/</span>
            <span>
              {NAV[portal]
                .flatMap((g) => g.items)
                .find((i) => i.href === activeHref)?.label ?? "…"}
            </span>
          </div>
          <button
            onClick={() => setCmdOpen(true)}
            className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-[12px] text-slate-400 transition hover:border-slate-300 hover:text-slate-600"
          >
            Search…
            <kbd className="rounded border border-slate-200 bg-white px-1 text-[10px] font-semibold text-slate-400">
              ⌘K
            </kbd>
          </button>
        </header>
        <main className="mx-auto max-w-[1440px] p-6">{children}</main>
      </div>

      <CommandK open={cmdOpen} onOpenChange={setCmdOpen} onNavigate={(href) => router.push(href)} />
      <AuditDrawer open={auditOpen} onOpenChange={setAuditOpen} />
    </div>
  );
}
