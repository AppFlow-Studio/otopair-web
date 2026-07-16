"use client";

// Zone 5 — governance + live ops: the director audit trail and the merged
// marketplace activity feed.

import Link from "next/link";
import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import { CARD, PILL, money, timeAgo, Skeleton } from "./shared";

type AuditRows = FunctionReturnType<typeof api.audit_log.listRecent> | undefined;
type Feed = FunctionReturnType<typeof api.opsOverview.activityFeed> | undefined;

function FeedShell({
  title,
  linkHref,
  linkLabel,
  loading,
  empty,
  children,
}: {
  title: string;
  linkHref: string;
  linkLabel: string;
  loading: boolean;
  empty: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className={CARD}>
      <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
      {loading ? (
        <div className="mt-3 space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-7 w-full" />
          ))}
        </div>
      ) : empty ? (
        <p className="mt-3 text-sm text-slate-500">Nothing here yet.</p>
      ) : (
        children
      )}
      <div className="mt-2 border-t border-slate-100 pt-2 text-right">
        <Link href={linkHref} className="text-[12px] font-semibold text-blue-600 hover:underline">
          {linkLabel} →
        </Link>
      </div>
    </section>
  );
}

export function ActionFeeds({ audit, feed }: { audit: AuditRows; feed: Feed }) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <FeedShell
        title="Director actions"
        linkHref="/ops/audit"
        linkLabel="Full audit log"
        loading={audit === undefined}
        empty={audit?.length === 0}
      >
        <ul className="mt-3 space-y-2">
          {audit?.slice(0, 12).map((a) => (
            <li key={String(a._id)} className="flex items-center gap-2 text-[13px]">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-200 text-[10px] font-bold text-slate-600">
                {a.actor.slice(0, 1).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1 truncate text-slate-700">
                <b className="font-semibold text-slate-900">{a.actor}</b>{" "}
                {a.action.replace(/_/g, " ")}{" "}
                <span className="font-mono text-[11px] text-slate-400">
                  {a.entity_type} …{a.entity_id.slice(-6)}
                </span>
                {a.detail && <span className="text-slate-400"> — {a.detail}</span>}
              </span>
              <span className="shrink-0 text-[11px] text-slate-400">{timeAgo(a.created_at)}</span>
            </li>
          ))}
        </ul>
      </FeedShell>

      <FeedShell
        title="Live marketplace activity"
        linkHref="/ops"
        linkLabel="Ops overview"
        loading={feed === undefined}
        empty={feed?.length === 0}
      >
        <ul className="mt-3 space-y-2">
          {feed?.map((e) => (
            <li key={`${e.kind}:${e.id}`} className="flex items-center gap-2 text-[13px]">
              <span
                className={`${PILL} shrink-0 ${
                  e.kind === "booking" ? "bg-blue-50 text-blue-700" : "bg-emerald-50 text-emerald-700"
                }`}
              >
                {e.kind}
              </span>
              <span className="min-w-0 flex-1 truncate text-slate-700">{e.label}</span>
              {e.amount != null && e.amount > 0 && (
                <span className="shrink-0 text-[12px] font-semibold text-slate-900">
                  {money(e.amount)}
                </span>
              )}
              <span className="shrink-0 text-[11px] text-slate-400">{timeAgo(e.at)}</span>
            </li>
          ))}
        </ul>
      </FeedShell>
    </div>
  );
}
