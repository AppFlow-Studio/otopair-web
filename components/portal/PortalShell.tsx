"use client";

// The shared shell (Ops spec §3A): 240px sidebar with the portal switcher on
// top, grouped nav with badge pills, ⌘K search in the header, session menu.
// One build, three nav trees — every portal page mounts inside this.

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

export function PortalShell({ portal, children }: { portal: PortalId; children: React.ReactNode }) {
  const session = usePortalSession();
  const pathname = usePathname();
  const router = useRouter();
  const [cmdOpen, setCmdOpen] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const stats = useQuery(api.portalStats.getStats, { token: session.token, keys: BADGE_KEYS });

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
    <div className="flex min-h-[calc(100vh-1.5rem)]">
      {/* Sidebar — 240px per spec */}
      <aside className="fixed bottom-0 top-6 z-40 flex w-60 flex-col border-r border-slate-200 bg-white">
        {/* Portal switcher */}
        <div className="flex items-center gap-1 border-b border-slate-100 px-3 py-3">
          {PORTALS.map((p) => (
            <Link
              key={p.id}
              href={p.base}
              className={`rounded-md px-2.5 py-1 text-[13px] font-semibold ${
                p.id === portal
                  ? "bg-slate-900 text-white"
                  : "text-slate-500 hover:bg-slate-100 hover:text-slate-800"
              }`}
            >
              {p.label}
            </Link>
          ))}
        </div>

        <nav className="flex-1 overflow-y-auto px-2 py-3">
          {NAV[portal].map((group, gi) => (
            <div key={gi} className="mb-4">
              {group.label && (
                <div className="mb-1 px-2 text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">
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
                      className="flex cursor-default items-center justify-between rounded-md px-2 py-1.5 text-[13px] text-slate-300"
                      title={`Ships in ${item.phase}`}
                    >
                      {item.label}
                      <span className="rounded bg-slate-100 px-1 text-[10px] font-semibold text-slate-400">
                        {item.phase}
                      </span>
                    </div>
                  );
                }
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`flex items-center justify-between rounded-md px-2 py-1.5 text-[13px] font-medium ${
                      isActive
                        ? "bg-blue-50 text-blue-700"
                        : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"
                    }`}
                  >
                    {item.label}
                    {b !== null && (
                      <span className="rounded-full bg-blue-100 px-1.5 text-[11px] font-semibold text-blue-700">
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
        <div className="relative border-t border-slate-100 px-3 py-2.5">
          <button
            onClick={() => setMenuOpen((o) => !o)}
            className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-slate-50"
          >
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-slate-200 text-xs font-bold text-slate-600">
              {session.name.slice(0, 1).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-semibold text-slate-800">
                {session.name}
              </span>
              <span className="block text-[11px] text-slate-400">{session.role}</span>
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
      <div className="ml-60 flex-1">
        <header className="sticky top-6 z-30 flex h-12 items-center justify-between border-b border-slate-200 bg-white/90 px-6 backdrop-blur">
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
            className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-[12px] text-slate-400 hover:border-slate-300"
          >
            Search…
            <kbd className="rounded border border-slate-200 bg-white px-1 text-[10px] font-semibold text-slate-400">
              ⌘K
            </kbd>
          </button>
        </header>
        <main className="p-6">{children}</main>
      </div>

      <CommandK open={cmdOpen} onOpenChange={setCmdOpen} onNavigate={(href) => router.push(href)} />
      <AuditDrawer open={auditOpen} onOpenChange={setAuditOpen} />
    </div>
  );
}
