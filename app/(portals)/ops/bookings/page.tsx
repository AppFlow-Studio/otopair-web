"use client";

// Ops · Bookings — the heartbeat page. Board (kanban by measured status) is
// the default view; toggle to a filterable recent list. The board is a
// window, not a lever: read-only for P0, no drag-to-change-status.

import { useState } from "react";
import Link from "next/link";
import { useQuery, usePaginatedQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { usePortalSession } from "../../portal-session";
import {
  CARD_STATIC,
  MICRO_H,
  PageHeader,
  SegmentedControl,
  Skeleton,
  StatTile,
  TrendBars,
  fmtNum,
} from "@/components/portal/ChartKit";

const STATUSES = [
  "pending",
  "pending_quote",
  "quotes_ready",
  "vehicle_at_shop",
  "completed",
  "cancelled",
  "no_show",
] as const;

const STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  pending_quote: "Pending quote",
  quotes_ready: "Quotes ready",
  vehicle_at_shop: "Vehicle at shop",
  completed: "Completed",
  cancelled: "Cancelled",
  no_show: "No show",
};

function StatusPill({ status }: { status: string }) {
  const cls =
    status === "completed"
      ? "bg-emerald-50 text-emerald-700"
      : status === "cancelled" || status === "no_show"
        ? "bg-red-50 text-red-700"
        : status === "pending" || status === "pending_quote"
          ? "bg-amber-50 text-amber-700"
          : status === "quotes_ready"
            ? "bg-sky-50 text-sky-700"
            : status === "vehicle_at_shop"
              ? "bg-indigo-50 text-indigo-700"
              : "bg-slate-100 text-slate-600";
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ${cls}`}>
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

// Row shape returned by opsBookings.board / opsBookings.list (annotated
// locally because the generated api types collapse in this tree).
type BookingRow = {
  id: string;
  userId: string;
  user: string;
  shopId: string | null;
  shop: string;
  vin: string;
  vehicleYmm: string | null;
  services: string[];
  scheduledDate: string | null;
  scheduledTime: string | null;
  createdAt: number;
  status: string;
  liveStage: string | null;
  total: number | null;
  quote: {
    low: number | null;
    high: number | null;
    setPrice: number | null;
    isFixed: boolean;
  };
};

// The money to show on a card: the captured total when present, else the
// quote (fixed/set price, or the disclosed low–high band) for quote-stage
// bookings. Returns a display string + whether it's an estimate.
function cardPrice(r: BookingRow): { text: string; estimate: boolean } | null {
  if (r.total != null) return { text: money(r.total), estimate: false };
  if (r.quote.setPrice != null)
    return { text: money(r.quote.setPrice), estimate: !r.quote.isFixed };
  if (r.quote.low != null && r.quote.high != null)
    return { text: `${money(r.quote.low)}–${money(r.quote.high)}`, estimate: true };
  if (r.quote.high != null) return { text: money(r.quote.high), estimate: true };
  return null;
}

type BoardColumn = {
  status: string;
  count: number;
  more: boolean;
  cards: BookingRow[];
};

function money(n: number | null | undefined): string {
  if (n == null) return "—";
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function shortDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ---------------------------------------------------------------------------
// Analytics zone — created per day + completed-vs-cancelled summary tiles,
// all from portalSeries.bookingsDaily (single query, zero-filled days).
// ---------------------------------------------------------------------------
const TREND_PERIODS = ["7d", "30d", "90d"] as const;
type TrendPeriod = (typeof TREND_PERIODS)[number];
const TREND_DAYS: Record<TrendPeriod, number> = { "7d": 7, "30d": 30, "90d": 90 };

function AnalyticsZone({
  token,
  period,
}: {
  token: string;
  period: TrendPeriod;
}) {
  const days = TREND_DAYS[period];
  const series = useQuery(api.portalSeries.bookingsDaily, { token, days });

  const sum = (key: "created" | "completed" | "cancelled" | "revenue") =>
    series?.reduce((s, d) => s + d[key], 0);
  const spark = (key: "created" | "completed" | "cancelled") => series?.map((d) => d[key]);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile
          label={`Created (${period})`}
          value={series === undefined ? <Skeleton /> : fmtNum(sum("created"))}
          spark={spark("created")}
          sparkColor="#3b82f6"
        />
        <StatTile
          label={`Completed (${period})`}
          value={series === undefined ? <Skeleton /> : fmtNum(sum("completed"))}
          spark={spark("completed")}
          sparkColor="#059669"
        />
        <StatTile
          label={`Cancelled (${period})`}
          value={series === undefined ? <Skeleton /> : fmtNum(sum("cancelled"))}
          spark={spark("cancelled")}
          sparkColor="#dc2626"
        />
        <StatTile
          label={`Completed revenue (${period})`}
          value={series === undefined ? <Skeleton /> : money(sum("revenue") ?? 0)}
        />
      </div>
      <div className={CARD_STATIC}>
        <div className="flex items-baseline justify-between">
          <h2 className={MICRO_H}>Bookings created per day</h2>
          <span className="text-[11px] text-slate-400">last {days} days</span>
        </div>
        <div className="mt-2">
          <TrendBars
            data={series}
            dataKey="created"
            name="Bookings created"
            color="#93c5fd"
            height={140}
          />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Board view
// ---------------------------------------------------------------------------
function BoardView({ token }: { token: string }) {
  const columns = useQuery(api.opsBookings.board, { token });

  if (columns === undefined) {
    return (
      <div className="flex gap-3 overflow-x-auto pb-2">
        {STATUSES.map((s) => (
          <div key={s} className="w-64 shrink-0 rounded-xl border border-slate-200 bg-white p-3">
            <div className="h-4 w-24 animate-pulse rounded bg-slate-100" />
            <div className="mt-3 space-y-2">
              <div className="h-16 animate-pulse rounded-lg bg-slate-50" />
              <div className="h-16 animate-pulse rounded-lg bg-slate-50" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {(columns as BoardColumn[]).map((col) => (
        <div key={col.status} className="flex w-64 shrink-0 flex-col rounded-xl border border-slate-200 bg-white">
          <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2.5">
            <StatusPill status={col.status} />
            <span className="text-[11px] font-semibold text-slate-400">
              {col.count}
              {col.more ? "+" : ""}
            </span>
          </div>
          <div className="flex-1 space-y-2 overflow-y-auto p-2" style={{ maxHeight: "70vh" }}>
            {col.cards.length === 0 && (
              <div className="px-2 py-6 text-center text-[12px] text-slate-400">
                No {STATUS_LABEL[col.status]?.toLowerCase() ?? col.status} bookings.
              </div>
            )}
            {col.cards.map((c: BookingRow) => {
              const price = cardPrice(c);
              return (
                <div
                  key={c.id}
                  className="block rounded-lg border border-slate-100 p-2.5 hover:border-slate-300 hover:bg-slate-50"
                >
                  <div className="flex items-baseline justify-between gap-2">
                    {/* Customer links to their profile, not the booking. */}
                    <Link
                      href={`/ops/users/${c.userId}`}
                      className="truncate text-[13px] font-semibold text-slate-800 hover:text-blue-600 hover:underline"
                    >
                      {c.user}
                    </Link>
                    <span className="shrink-0 text-[11px] text-slate-400">
                      {c.scheduledDate ?? shortDate(c.createdAt)}
                      {c.scheduledTime ? ` ${c.scheduledTime}` : ""}
                    </span>
                  </div>
                  {/* Everything below opens the booking. */}
                  <Link href={`/ops/bookings/${c.id}`} className="mt-0.5 block">
                    <div className="truncate text-[12px] text-slate-500">{c.shop}</div>
                    {c.vehicleYmm && (
                      <div className="mt-0.5 truncate text-[12px] font-medium text-slate-700">
                        {c.vehicleYmm}
                      </div>
                    )}
                    <div className="mt-1 truncate text-[12px] text-slate-600">
                      {c.services.filter((s) => s && s !== "—").join(", ") || "Service TBD"}
                    </div>
                    <div className="mt-1 flex items-center justify-between gap-2">
                      <span className="truncate font-mono text-[10px] text-slate-400">
                        {c.vin || "no VIN"}
                      </span>
                      {price ? (
                        <span className="shrink-0 text-[12px] font-semibold text-slate-700">
                          {price.text}
                          {price.estimate && (
                            <span className="ml-1 text-[10px] font-normal text-slate-400">est</span>
                          )}
                        </span>
                      ) : (
                        <span className="shrink-0 text-[11px] text-slate-400">awaiting quote</span>
                      )}
                    </div>
                  </Link>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// List view
// ---------------------------------------------------------------------------
function ListView({ token }: { token: string }) {
  const [status, setStatus] = useState<string>("");
  const { results, status: pageStatus, loadMore } = usePaginatedQuery(
    api.opsBookings.list,
    { token, status: status || undefined },
    { initialNumItems: 50 },
  );

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5">
      <div className="mb-4 flex items-center gap-3">
        <label className="text-xs font-medium text-slate-500" htmlFor="status-filter">
          Status
        </label>
        <select
          id="status-filter"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[13px] text-slate-700"
        >
          <option value="">All (recent)</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </div>

      {pageStatus === "LoadingFirstPage" && (
        <div className="py-10 text-center text-sm text-slate-400">Loading bookings…</div>
      )}

      {pageStatus !== "LoadingFirstPage" && results.length === 0 && (
        <div className="py-10 text-center text-sm text-slate-400">
          No bookings match this filter yet.
        </div>
      )}

      {results.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-slate-200 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                <th className="pb-2 pr-4">Created</th>
                <th className="pb-2 pr-4">Scheduled</th>
                <th className="pb-2 pr-4">User</th>
                <th className="pb-2 pr-4">VIN</th>
                <th className="pb-2 pr-4">Shop</th>
                <th className="pb-2 pr-4">Services</th>
                <th className="pb-2 pr-4">Total</th>
                <th className="pb-2 pr-4">Status</th>
              </tr>
            </thead>
            <tbody>
              {(results as BookingRow[]).map((r) => (
                <tr key={r.id} className="border-b border-slate-50 hover:bg-slate-50">
                  <td className="py-2.5 pr-4 text-slate-500">{shortDate(r.createdAt)}</td>
                  <td className="py-2.5 pr-4">
                    {r.scheduledDate ?? "—"}
                    {r.scheduledTime ? ` ${r.scheduledTime}` : ""}
                  </td>
                  <td className="py-2.5 pr-4">
                    <Link href={`/ops/bookings/${r.id}`} className="font-medium text-slate-800 hover:underline">
                      {r.user}
                    </Link>
                  </td>
                  <td className="py-2.5 pr-4 font-mono text-[11px] text-slate-500">{r.vin || "—"}</td>
                  <td className="py-2.5 pr-4">
                    {r.shopId ? (
                      <Link href={`/shops/all/${r.shopId}`} className="text-slate-700 hover:underline">
                        {r.shop}
                      </Link>
                    ) : (
                      r.shop || "—"
                    )}
                  </td>
                  <td className="py-2.5 pr-4 text-slate-600" title={r.services.join(", ")}>
                    {r.services.length}
                  </td>
                  <td className="py-2.5 pr-4">{money(r.total)}</td>
                  <td className="py-2.5 pr-4">
                    <StatusPill status={r.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pageStatus === "CanLoadMore" && (
        <div className="mt-4 text-center">
          <button
            onClick={() => loadMore(50)}
            className="rounded-md border border-slate-200 px-3 py-1.5 text-[13px] font-medium text-slate-600 hover:bg-slate-50"
          >
            Load more
          </button>
        </div>
      )}
      {pageStatus === "LoadingMore" && (
        <div className="mt-4 text-center text-sm text-slate-400">Loading…</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export default function OpsBookingsPage() {
  const { token } = usePortalSession();
  const [view, setView] = useState<"board" | "list">("board");
  const [period, setPeriod] = useState<TrendPeriod>("30d");

  return (
    <div className="space-y-4">
      <PageHeader
        title="Bookings"
        subtitle="The heartbeat page — every booking across the network, by status."
      >
        <div className="flex items-center gap-2">
          <SegmentedControl value={period} options={TREND_PERIODS} onChange={setPeriod} />
          <div className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5">
            {(["board", "list"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`rounded-md px-3 py-1 text-[13px] font-medium ${
                  view === v ? "bg-slate-900 text-white" : "text-slate-500 hover:bg-slate-50"
                }`}
              >
                {v === "board" ? "Board" : "List"}
              </button>
            ))}
          </div>
        </div>
      </PageHeader>

      <AnalyticsZone token={token} period={period} />

      {view === "board" ? <BoardView token={token} /> : <ListView token={token} />}
    </div>
  );
}
