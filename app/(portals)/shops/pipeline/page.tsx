"use client";

// Shops · Onboarding Pipeline — /shops/pipeline (Shops spec §4.3).
// 7-column kanban; every stage DERIVED from live table checks. Card drawer
// shows the auto-checklist with the proving query per item. Stages advance
// themselves the moment the facts change — no buttons, honestly.

import { useState } from "react";
import Link from "next/link";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { usePortalSession } from "../../portal-session";
import {
  CARD,
  BarRows,
  PageHeader,
  StatTile,
  Skeleton,
  fmtNum,
} from "@/components/portal/ChartKit";

const pill = "inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold";

type ChecklistItem = { label: string; proof: string; passed: boolean };
type PipelineCard = {
  shop_id: string;
  name: string;
  city: string | null;
  phone: string | null;
  owner: string | null;
  owner_id: string | null;
  bookings_30d: number;
  revenue_30d: number;
  stage: string;
  stage_index: number;
  age_days: number | null;
  checklist: ChecklistItem[];
  next_item: string | null;
};

export default function ShopsPipelinePage() {
  const { token } = usePortalSession();
  const data = useQuery(api.shopsPipeline.board, { token });
  const [drawer, setDrawer] = useState<PipelineCard | null>(null);

  // ── Stage analytics (client-side from the board payload) ───────────────────
  const columns = data?.columns as { stage: string; cards: PipelineCard[] }[] | undefined;
  const allCards = columns?.flatMap((c) => c.cards);
  const liveCount = columns
    ?.filter((c) => c.stage === "Live")
    .reduce((s, c) => s + c.cards.length, 0);
  const inPipeline =
    allCards === undefined || liveCount === undefined ? undefined : allCards.length - liveCount;
  const stuckCount = allCards?.filter(
    (c) => c.stage !== "Live" && c.age_days != null && c.age_days > 5,
  ).length;
  const stageRows = columns?.map((c) => ({
    label: c.stage,
    value: c.cards.length,
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Onboarding Pipeline"
        subtitle="Every stage is auto-verified against the tables — cards advance the moment the facts change. No checkbox of vibes; the drawer names the query behind each ✓."
      />

      {/* ── Stat tiles ── */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile
          label="Shops on the board"
          value={allCards === undefined ? <Skeleton /> : fmtNum(allCards.length)}
        />
        <StatTile
          label="Still onboarding"
          value={inPipeline === undefined ? <Skeleton /> : fmtNum(inPipeline)}
        />
        <StatTile
          label="Fully onboarded (Live)"
          value={liveCount === undefined ? <Skeleton /> : fmtNum(liveCount)}
        />
        <StatTile
          label="Onboarding >5 days"
          value={stuckCount === undefined ? <Skeleton /> : fmtNum(stuckCount)}
          chip={
            stuckCount !== undefined ? (
              <span
                className={`${pill} ${
                  stuckCount > 0 ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700"
                }`}
              >
                {stuckCount > 0 ? "nudge these" : "none stuck"}
              </span>
            ) : undefined
          }
        />
      </div>

      {/* ── Stage summary strip ── */}
      <div className={CARD}>
        <div className="mb-3 flex items-baseline gap-2">
          <h2 className="text-sm font-semibold text-slate-900">Shops per stage</h2>
          <span className="text-[11px] text-slate-400">derived live from table checks</span>
        </div>
        {stageRows === undefined ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <BarRows rows={stageRows} color="#93c5fd" />
        )}
      </div>

      {data === undefined ? (
        <div className="flex gap-3 overflow-x-auto">
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="h-64 w-44 shrink-0 animate-pulse rounded-xl bg-slate-100" />
          ))}
        </div>
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-2">
          {data.columns.map((col: { stage: string; cards: PipelineCard[] }) => (
            <div key={col.stage} className="w-48 shrink-0">
              <div className="flex items-center gap-1.5 px-1 pb-2">
                <span className="text-[12px] font-bold uppercase tracking-wide text-slate-500">
                  {col.stage}
                </span>
                <span className={`${pill} bg-slate-100 text-slate-500`}>{col.cards.length}</span>
              </div>
              <div className="space-y-2">
                {col.cards.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-slate-200 py-6 text-center text-[11px] text-slate-300">
                    empty
                  </div>
                ) : (
                  col.cards.map((c) => (
                    <button
                      key={c.shop_id}
                      onClick={() => setDrawer(c)}
                      className="block w-full rounded-xl border border-slate-200 bg-white p-3 text-left shadow-sm hover:border-blue-300"
                    >
                      <div className="text-[13px] font-semibold text-slate-900">{c.name}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        {c.city && (
                          <span className="text-[11px] text-slate-400">{c.city}</span>
                        )}
                        {c.age_days != null && (
                          <span
                            className={`${pill} ${
                              c.age_days > 5 && c.stage !== "Live"
                                ? "bg-amber-50 text-amber-700"
                                : "bg-slate-100 text-slate-500"
                            }`}
                          >
                            {c.age_days}d
                          </span>
                        )}
                      </div>
                      {(c.owner || c.phone) && (
                        <div className="mt-1 truncate text-[11px] text-slate-500">
                          {[c.owner, c.phone].filter(Boolean).join(" · ")}
                        </div>
                      )}
                      {c.bookings_30d > 0 && (
                        <div className="mt-0.5 text-[11px] text-slate-400">
                          {c.bookings_30d} bookings
                          {c.revenue_30d > 0 && ` · $${Math.round(c.revenue_30d).toLocaleString()}`} · 30d
                        </div>
                      )}
                      {c.next_item && (
                        <div className="mt-1.5 text-[11px] text-slate-500">→ {c.next_item}</div>
                      )}
                    </button>
                  ))
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Checklist drawer */}
      {drawer && (
        <div className="fixed inset-0 z-40 bg-slate-950/40" onClick={() => setDrawer(null)}>
          <div
            className="absolute right-0 top-0 h-full w-full max-w-md overflow-auto bg-white p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center">
              <h2 className="text-base font-semibold text-slate-900">{drawer.name}</h2>
              <span className={`${pill} ml-2 bg-blue-50 text-blue-700`}>{drawer.stage}</span>
              <button
                onClick={() => setDrawer(null)}
                className="ml-auto rounded-md px-2 py-1 text-sm text-slate-400 hover:bg-slate-100"
              >
                ✕
              </button>
            </div>
            <Link
              href={`/shops/all/${drawer.shop_id}`}
              className="mt-1 inline-block text-[12px] font-medium text-blue-600 hover:underline"
            >
              Open shop detail →
            </Link>
            <div className="mt-4 space-y-2">
              {drawer.checklist.map((item) => (
                <div
                  key={item.label}
                  className={`rounded-lg border px-3.5 py-2.5 ${
                    item.passed ? "border-emerald-100 bg-emerald-50/50" : "border-slate-200 bg-white"
                  }`}
                >
                  <div className="flex items-center gap-2 text-[13px] font-medium text-slate-800">
                    <span>{item.passed ? "✓" : "○"}</span>
                    {item.label}
                  </div>
                  <div className="mt-0.5 pl-6 font-mono text-[11px] text-slate-400">
                    {item.proof}
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-4 text-[11px] text-slate-400">
              Stage age uses shop creation date (no per-stage timestamps exist yet) — an
              amber badge means the shop has been onboarding &gt;5 days total.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
