"use client";

// Ops · Reviews moderation — /ops/reviews (Ops spec p.10).
// Zones: PageHeader → analytics (volume trend + rating tiles) → view toggle →
// list. Default "needs eyes" = rating ≤3, newest first. Hide = ceremony;
// hidden rows collapse to grey strips with Restore.

import { useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { usePortalSession, useCan } from "../../portal-session";
import { Ceremony } from "@/components/portal/Ceremony";
import {
  CARD_STATIC,
  MICRO_H,
  PILL as pill,
  PageHeader,
  StatTile,
  TrendBars,
  fmtNum,
} from "@/components/portal/ChartKit";

const fmtDate = (ms: number) => new Date(ms).toLocaleDateString();

type ReviewRow = {
  id: string;
  rating: number;
  comment: string | null;
  user: string | null;
  user_id: string;
  shop: string | null;
  shop_id: string;
  mechanic: string | null;
  mechanic_id: string | null;
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
  const daily = useQuery(api.portalSeries.reviewsDaily, { token, days: 30 });
  const hide = useMutation(api.opsReviews.hide);
  const restore = useMutation(api.opsReviews.restore);

  const rows = useMemo(() => {
    const all: ReviewRow[] = reviews ?? [];
    return view === "needs-eyes" ? all.filter((r) => r.rating <= 3 || r.hidden) : all;
  }, [reviews, view]);

  // 30d rollups from the daily series (weighted avg over days with reviews).
  const count30d = daily?.reduce((s, d) => s + d.count, 0);
  const avg30d = useMemo(() => {
    if (!daily) return undefined;
    let sum = 0;
    let n = 0;
    for (const d of daily) {
      if (d.avg_rating != null && d.count > 0) {
        sum += d.avg_rating * d.count;
        n += d.count;
      }
    }
    return n > 0 ? sum / n : null;
  }, [daily]);
  const avgSpark = daily?.filter((d) => d.avg_rating != null).map((d) => d.avg_rating as number);
  const needsEyes = reviews?.filter((r) => !r.hidden && r.rating <= 3).length;
  const hiddenCount = reviews?.filter((r) => r.hidden).length;

  const toggleExpand = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reviews"
        subtitle="Consumer reviews across the shop network — moderate with a reason, never delete."
      >
        <div className="flex gap-1 rounded-lg border border-slate-200 bg-white p-1">
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
      </PageHeader>

      {/* Analytics zone */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Reviews · 30d" value={count30d == null ? "—" : fmtNum(count30d)} />
        <StatTile
          label="Avg rating · 30d"
          value={avg30d === undefined ? "—" : avg30d === null ? "—" : `${avg30d.toFixed(1)}★`}
          spark={avgSpark && avgSpark.length > 1 ? avgSpark : undefined}
          sparkColor="#f59e0b"
        />
        <StatTile
          label="Needs eyes (≤3★, visible)"
          value={needsEyes == null ? "—" : fmtNum(needsEyes)}
          chip={
            needsEyes != null && needsEyes > 0 ? (
              <span className={`${pill} bg-amber-50 text-amber-700`}>review</span>
            ) : undefined
          }
        />
        <StatTile label="Hidden" value={hiddenCount == null ? "—" : fmtNum(hiddenCount)} />
      </div>
      <div className={CARD_STATIC}>
        <div className={MICRO_H}>Reviews per day · last 30 days</div>
        <div className="mt-3">
          <TrendBars data={daily} dataKey="count" name="Reviews" color="#93c5fd" height={150} />
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
                {r.user && (
                  <Link
                    href={`/ops/users/${r.user_id}`}
                    title="Reviewer"
                    className="hover:text-blue-700 hover:underline"
                  >
                    {r.user}
                  </Link>
                )}
                {r.shop && (
                  <Link
                    href={`/shops/all/${r.shop_id}`}
                    title="Shop"
                    className="hover:text-blue-700 hover:underline"
                  >
                    {r.shop}
                  </Link>
                )}
                {r.mechanic &&
                  (r.mechanic_id ? (
                    <Link
                      href={`/shops/mechanics/${r.mechanic_id}`}
                      title="Mechanic"
                      className="hover:text-blue-700 hover:underline"
                    >
                      {r.mechanic}
                    </Link>
                  ) : (
                    <span title="Mechanic">{r.mechanic}</span>
                  ))}
                <span className="italic">— {r.hidden_reason ?? "no reason recorded"}</span>
                <span className="text-slate-400">by {r.hidden_by ?? "?"}</span>
                <Link
                  href={`/ops/bookings/${r.booking_id}`}
                  className="text-[12px] font-medium text-blue-600 hover:underline"
                >
                  booking →
                </Link>
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
              <div
                key={r.id}
                className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition-shadow hover:shadow-md"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Stars n={r.rating} />
                  {r.user && (
                    <Link
                      href={`/ops/users/${r.user_id}`}
                      className={`${pill} bg-slate-100 text-slate-600 hover:text-blue-700 hover:underline`}
                      title="Reviewer"
                    >
                      {r.user}
                    </Link>
                  )}
                  {r.shop && (
                    <Link
                      href={`/shops/all/${r.shop_id}`}
                      className={`${pill} bg-blue-50 text-blue-700 hover:underline`}
                      title="Shop"
                    >
                      {r.shop}
                    </Link>
                  )}
                  {r.mechanic &&
                    (r.mechanic_id ? (
                      <Link
                        href={`/shops/mechanics/${r.mechanic_id}`}
                        className={`${pill} bg-slate-100 text-slate-600 hover:text-blue-700 hover:underline`}
                        title="Mechanic"
                      >
                        {r.mechanic}
                      </Link>
                    ) : (
                      <span className={`${pill} bg-slate-100 text-slate-600`} title="Mechanic">
                        {r.mechanic}
                      </span>
                    ))}
                  <Link
                    href={`/ops/bookings/${r.booking_id}`}
                    className="text-[12px] font-medium text-blue-600 hover:underline"
                  >
                    booking →
                  </Link>
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
