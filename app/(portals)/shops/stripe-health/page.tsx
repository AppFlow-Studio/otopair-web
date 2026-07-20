"use client";

// Shops · Stripe Connect Health — /shops/stripe-health (Shops Atlas T2, §4.7).
// Read-only mirror of webhook-synced Connect status. One row per shop:
// derived status pill (connected / incomplete / no-account), masked account
// id, charges/payouts flags, requirements-due chips. Expandable row shows the
// recent webhook event types + timestamps for that account. Never renders a
// secret or full account id. Refund/dispute UI stays Stripe-hosted (LOCKED).

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { anyApi } from "convex/server";
import { usePortalSession } from "@/app/(portals)/portal-session";
import { PageHeader, StatTile, Skeleton, PILL, fmtNum } from "@/components/portal/ChartKit";

const stripeHealthApi = anyApi.shopsStripeHealth;

type EventRow = {
  eventType: string;
  livemode: boolean | null;
  receivedAt: number;
  processedAt: number | null;
};

type HealthRow = {
  id: string;
  name: string;
  city: string | null;
  accountIdMasked: string | null;
  status: "connected" | "incomplete" | "no-account";
  chargesEnabled: boolean | null;
  payoutsEnabled: boolean | null;
  requirementsDue: string[];
  onboardingCompletedAt: number | null;
  recentEvents: EventRow[];
};

type HealthPayload = {
  rows: HealthRow[];
  platformEvents: EventRow[];
  eventsWindow: number;
};

const PILL_BASE = "inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold";

function StatusPill({ status }: { status: HealthRow["status"] }) {
  if (status === "connected") {
    return <span className={`${PILL_BASE} bg-emerald-50 text-emerald-700`}>connected</span>;
  }
  if (status === "incomplete") {
    return <span className={`${PILL_BASE} bg-amber-50 text-amber-700`}>incomplete</span>;
  }
  return <span className={`${PILL_BASE} bg-slate-100 text-slate-600`}>no account</span>;
}

function BoolMark({ on }: { on: boolean | null }) {
  if (on === null) return <span className="text-slate-300">—</span>;
  return on ? (
    <span className="font-semibold text-emerald-600">✓</span>
  ) : (
    <span className="font-semibold text-red-500">✕</span>
  );
}

function fmtTs(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function EventsList({ events }: { events: EventRow[] }) {
  if (events.length === 0) {
    return (
      <p className="text-[12px] text-slate-500">
        No recent webhook events for this account in the latest window.
      </p>
    );
  }
  return (
    <ul className="space-y-1">
      {events.map((e, i) => (
        <li key={`${e.eventType}-${e.receivedAt}-${i}`} className="flex items-center gap-2 text-[12px]">
          <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-700">
            {e.eventType}
          </span>
          <span className="text-slate-500">{fmtTs(e.receivedAt)}</span>
          {e.livemode === false && (
            <span className={`${PILL_BASE} bg-amber-50 text-amber-700`}>test</span>
          )}
          {e.processedAt === null && (
            <span className={`${PILL_BASE} bg-red-50 text-red-700`}>unprocessed</span>
          )}
        </li>
      ))}
    </ul>
  );
}

export default function StripeHealthPage() {
  const { token } = usePortalSession();
  const data = useQuery(stripeHealthApi.connectHealth, { token }) as HealthPayload | undefined;
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const allRows = data?.rows;
  const problemCount = allRows?.filter((r) => r.status !== "connected").length ?? 0;
  // Spec default filter: "anything not fully green" — page opens on problems.
  const rows =
    allRows === undefined ? undefined : showAll ? allRows : allRows.filter((r) => r.status !== "connected");

  const connectedCount = allRows?.filter((r) => r.status === "connected").length;
  const chargesCount = allRows?.filter((r) => r.chargesEnabled === true).length;
  const payoutsCount = allRows?.filter((r) => r.payoutsEnabled === true).length;
  const notReady = allRows?.filter((r) => r.status !== "connected");

  return (
    <div className="space-y-4">
      <PageHeader
        title="Stripe Connect Health"
        subtitle="Webhook-synced Connect status per shop — read-only, never calls Stripe live."
      >
        <div className="flex items-center gap-3">
          {allRows !== undefined && (
            <span
              className={`${PILL_BASE} ${
                problemCount > 0 ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700"
              }`}
            >
              {problemCount > 0 ? `${problemCount} need attention` : "all green"}
            </span>
          )}
          <div className="flex gap-1 rounded-lg border border-slate-200 bg-white p-0.5 text-[12px]">
          <button
            onClick={() => setShowAll(false)}
            className={`rounded-md px-2.5 py-1 font-medium ${
              !showAll ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50"
            }`}
          >
            Not fully green
          </button>
          <button
            onClick={() => setShowAll(true)}
            className={`rounded-md px-2.5 py-1 font-medium ${
              showAll ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50"
            }`}
          >
            All shops
          </button>
          </div>
        </div>
      </PageHeader>

      {/* ── Stat tiles ── */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile
          label="Shops"
          value={allRows === undefined ? <Skeleton /> : fmtNum(allRows.length)}
        />
        <StatTile
          label="Connected"
          value={connectedCount === undefined ? <Skeleton /> : fmtNum(connectedCount)}
          chip={
            allRows !== undefined && allRows.length > 0 && connectedCount !== undefined ? (
              <span
                className={`${PILL} ${
                  connectedCount === allRows.length
                    ? "bg-emerald-50 text-emerald-700"
                    : "bg-amber-50 text-amber-700"
                }`}
              >
                {Math.round((connectedCount / allRows.length) * 100)}%
              </span>
            ) : undefined
          }
        />
        <StatTile
          label="Charges enabled"
          value={chargesCount === undefined ? <Skeleton /> : fmtNum(chargesCount)}
        />
        <StatTile
          label="Payouts enabled"
          value={payoutsCount === undefined ? <Skeleton /> : fmtNum(payoutsCount)}
        />
      </div>

      {/* ── Not-ready list — every shop links to its detail ── */}
      {notReady !== undefined && notReady.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50/60 px-4 py-3 text-[12px] text-amber-800">
          <span className="font-semibold">Not payment-ready:</span>{" "}
          {notReady.map((r, i) => (
            <span key={r.id}>
              {i > 0 && ", "}
              <Link href={`/shops/all/${r.id}`} className="font-medium underline hover:text-amber-900">
                {r.name}
              </Link>
              <span className="text-amber-600"> ({r.status})</span>
            </span>
          ))}
        </div>
      )}

      <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-[12px] text-slate-600">
        <span className="mr-1.5 font-semibold uppercase tracking-wider text-slate-400">Locked</span>
        Read-only mirror of webhook-synced Connect status — this page never calls Stripe live.
        Refunds and disputes live in Stripe-hosted flows; this page links, never rebuilds. Account
        ids are shown masked; no secrets are ever rendered.
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        {rows === undefined && (
          <div className="space-y-2 py-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        )}

        {rows !== undefined && allRows !== undefined && allRows.length === 0 && (
          <div className="py-10 text-center text-sm text-slate-500">
            No shops exist yet — Connect status appears here once shops are onboarded.
          </div>
        )}

        {rows !== undefined && allRows !== undefined && allRows.length > 0 && rows.length === 0 && (
          <div className="py-10 text-center text-sm text-slate-500">
            Every shop is fully green — charges and payouts enabled on all connected accounts.
            Switch to “All shops” to see them.
          </div>
        )}

        {rows !== undefined && rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-slate-200 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  <th className="pb-2 pr-4">Shop</th>
                  <th className="pb-2 pr-4">Account</th>
                  <th className="pb-2 pr-4">Status</th>
                  <th className="pb-2 pr-4">Charges</th>
                  <th className="pb-2 pr-4">Payouts</th>
                  <th className="pb-2 pr-4">Requirements due</th>
                  <th className="pb-2 pr-4">Events</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const expanded = expandedId === r.id;
                  return [
                    <tr
                      key={r.id}
                      onClick={() => setExpandedId(expanded ? null : r.id)}
                      className="cursor-pointer border-b border-slate-50 hover:bg-slate-50"
                    >
                      <td className="py-2.5 pr-4">
                        <Link
                          href={`/shops/all/${r.id}`}
                          onClick={(e) => e.stopPropagation()}
                          className="font-medium text-slate-900 hover:underline"
                        >
                          {r.name}
                        </Link>
                        {r.city && <span className="ml-1.5 text-[11px] text-slate-400">{r.city}</span>}
                      </td>
                      <td className="py-2.5 pr-4">
                        {r.accountIdMasked ? (
                          <span className="font-mono text-[12px] text-slate-600">{r.accountIdMasked}</span>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>
                      <td className="py-2.5 pr-4">
                        <StatusPill status={r.status} />
                      </td>
                      <td className="py-2.5 pr-4">
                        <BoolMark on={r.chargesEnabled} />
                      </td>
                      <td className="py-2.5 pr-4">
                        <BoolMark on={r.payoutsEnabled} />
                      </td>
                      <td className="py-2.5 pr-4">
                        {r.requirementsDue.length === 0 ? (
                          <span className="text-slate-300">—</span>
                        ) : (
                          <span className="flex flex-wrap gap-1">
                            {r.requirementsDue.map((req) => (
                              <span key={req} className={`${PILL_BASE} bg-red-50 text-red-700`}>
                                {req}
                              </span>
                            ))}
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 pr-4 text-slate-500">
                        {r.recentEvents.length > 0 ? `${r.recentEvents.length} recent` : "—"}
                        <span className="ml-1.5 text-[11px] text-slate-400">{expanded ? "▾" : "▸"}</span>
                      </td>
                    </tr>,
                    expanded ? (
                      <tr key={`${r.id}-detail`} className="border-b border-slate-50 bg-slate-50/60">
                        <td colSpan={7} className="px-4 py-3">
                          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                            Recent webhook events
                          </div>
                          <EventsList events={r.recentEvents} />
                          {r.onboardingCompletedAt !== null && (
                            <p className="mt-2 text-[12px] text-slate-500">
                              Onboarding completed {fmtTs(r.onboardingCompletedAt)}
                            </p>
                          )}
                        </td>
                      </tr>
                    ) : null,
                  ];
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {data !== undefined && (
        <div className="mt-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="mb-2 flex items-baseline gap-2">
            <h2 className="text-sm font-semibold text-slate-900">Platform-level webhook events</h2>
            <span className="text-[11px] text-slate-400">
              latest {data.eventsWindow} events scanned
            </span>
          </div>
          {data.platformEvents.length === 0 ? (
            <p className="text-[12px] text-slate-500">
              No recent platform-level webhook events in the latest window.
            </p>
          ) : (
            <EventsList events={data.platformEvents} />
          )}
        </div>
      )}
    </div>
  );
}
