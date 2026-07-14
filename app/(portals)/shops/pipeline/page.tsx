"use client";

// Shops · Onboarding Pipeline — /shops/pipeline (Shops spec §4.3).
// 7-column kanban; every stage DERIVED from live table checks. Card drawer
// shows the auto-checklist with the proving query per item. Stages advance
// themselves the moment the facts change — no buttons, honestly.

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { usePortalSession } from "../../portal-session";

const pill = "inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold";

type ChecklistItem = { label: string; proof: string; passed: boolean };
type PipelineCard = {
  shop_id: string;
  name: string;
  city: string | null;
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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Onboarding Pipeline</h1>
        <p className="mt-1 text-[13px] text-slate-500">
          Every stage is auto-verified against the tables — cards advance the moment the
          facts change. No checkbox of vibes; the drawer names the query behind each ✓.
        </p>
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
