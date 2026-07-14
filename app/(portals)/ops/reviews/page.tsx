"use client";

// Ops · Reviews moderation — /ops/reviews (Ops spec p.10).
// Default "needs eyes" = rating ≤3, newest first. Hide = ceremony; hidden
// rows collapse to grey strips with Restore.

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { usePortalSession, useCan } from "../../portal-session";
import { Ceremony } from "@/components/portal/Ceremony";

const pill = "inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold";
const fmtDate = (ms: number) => new Date(ms).toLocaleDateString();

type ReviewRow = {
  id: string;
  rating: number;
  comment: string | null;
  user: string | null;
  shop: string | null;
  mechanic: string | null;
  booking_id: string;
  hidden: boolean;
  hidden_reason: string | null;
  hidden_by: string | null;
  at: number;
};

function Stars({ n }: { n: number }) {
  return (
    <span className="text-[15px] tracking-tight" style={{ color: "#F59E0B" }}>
      {"★".repeat(Math.round(n))}
      <span className="text-slate-200">{"★".repeat(Math.max(0, 5 - Math.round(n)))}</span>
    </span>
  );
}

export default function OpsReviewsPage() {
  const { token } = usePortalSession();
  const canWrite = useCan("users.write");
  const [view, setView] = useState<"needs-eyes" | "all">("needs-eyes");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState<{ row: ReviewRow; action: "hide" | "restore" } | null>(null);

  const reviews = useQuery(api.opsReviews.list, { token });
  const hide = useMutation(api.opsReviews.hide);
  const restore = useMutation(api.opsReviews.restore);

  const rows = useMemo(() => {
    const all: ReviewRow[] = reviews ?? [];
    return view === "needs-eyes" ? all.filter((r) => r.rating <= 3 || r.hidden) : all;
  }, [reviews, view]);

  const toggleExpand = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold text-slate-900">Reviews</h1>
        <div className="ml-auto flex gap-1 rounded-lg border border-slate-200 bg-white p-1">
          {(["needs-eyes", "all"] as const).map((vw) => (
            <button
              key={vw}
              onClick={() => setView(vw)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium ${
                view === vw ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              {vw === "needs-eyes" ? "Needs eyes (≤3★)" : "All"}
            </button>
          ))}
        </div>
      </div>

      {reviews === undefined ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-16 animate-pulse rounded-lg bg-slate-100" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
          {view === "needs-eyes"
            ? "Nothing needs eyes — no ≤3★ or hidden reviews."
            : "No reviews on this deployment."}
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((r) =>
            r.hidden ? (
              /* Hidden strip */
              <div
                key={r.id}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-slate-100 px-4 py-2 text-[13px] text-slate-500"
              >
                <span className={`${pill} bg-slate-200 text-slate-600`}>hidden</span>
                <Stars n={r.rating} />
                <span className="italic">— {r.hidden_reason ?? "no reason recorded"}</span>
                <span className="text-slate-400">by {r.hidden_by ?? "?"}</span>
                {canWrite && (
                  <button
                    onClick={() => setTarget({ row: r, action: "restore" })}
                    className="ml-auto rounded-md px-2 py-1 text-[12px] font-medium text-blue-600 hover:bg-blue-50"
                  >
                    Restore
                  </button>
                )}
              </div>
            ) : (
              <div key={r.id} className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Stars n={r.rating} />
                  {r.user && <span className={`${pill} bg-slate-100 text-slate-600`}>{r.user}</span>}
                  {r.shop && <span className={`${pill} bg-blue-50 text-blue-700`}>{r.shop}</span>}
                  {r.mechanic && (
                    <span className={`${pill} bg-slate-100 text-slate-600`}>{r.mechanic}</span>
                  )}
                  <span className="ml-auto text-[12px] text-slate-400">{fmtDate(r.at)}</span>
                  {canWrite && (
                    <button
                      onClick={() => setTarget({ row: r, action: "hide" })}
                      className="rounded-md px-2 py-1 text-[12px] font-medium text-red-500 hover:bg-red-50"
                    >
                      Hide
                    </button>
                  )}
                </div>
                {r.comment && (
                  <p
                    onClick={() => toggleExpand(r.id)}
                    className={`mt-2 cursor-pointer text-[13px] text-slate-600 ${
                      expanded.has(r.id) ? "" : "line-clamp-2"
                    }`}
                    title="click to expand"
                  >
                    {r.comment}
                  </p>
                )}
              </div>
            ),
          )}
        </div>
      )}

      <Ceremony
        open={target !== null}
        onOpenChange={(o) => !o && setTarget(null)}
        title={target?.action === "hide" ? "Hide review" : "Restore review"}
        destructive={target?.action === "hide"}
        summary={
          target && (
            <>
              {target.row.rating}★ review{target.row.user ? ` by ${target.row.user}` : ""}
              {target.row.shop ? ` for ${target.row.shop}` : ""} —{" "}
              {target.action === "hide"
                ? "hidden from every consumer surface (the row is kept for the audit trail)."
                : "returns to consumer surfaces immediately."}
            </>
          )
        }
        onConfirm={async (reason) => {
          if (!target) return;
          const fn = target.action === "hide" ? hide : restore;
          await fn({ token, reason, id: target.row.id as Id<"reviews"> });
        }}
      />
    </div>
  );
}
