"use client";

// Shops · Mechanics directory — /shops/mechanics (Shops spec §4.4).
// Stat tiles + rating distribution (client-side from loaded rows) →
// photo+name · shop chip (links to shop detail) · ★(n) · jobs · next slot ·
// Data contributions — the barber-shop moat column, sorted first by default.

import Link from "next/link";
import { useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { usePortalSession } from "../../portal-session";
import {
  CARD,
  MICRO_H,
  PILL,
  BarRows,
  PageHeader,
  StatTile,
  Skeleton,
  fmtNum,
} from "@/components/portal/ChartKit";

type MechanicRow = {
  id: string;
  name: string;
  title: string | null;
  photo: string | null;
  shop: string | null;
  shop_id: string;
  active: boolean;
  rating: number | null;
  review_count: number | null;
  jobs: number;
  jobs_capped: boolean;
  contributions: number;
  next_slot: string | null;
};

export default function ShopsMechanicsPage() {
  const { token } = usePortalSession();
  const rows = useQuery(api.shopsMechanics.directory, { token });

  const mechanics = rows as MechanicRow[] | undefined;

  // ── Client-side analytics from the loaded rows ──────────────────────────────
  const activeCount = mechanics?.filter((m) => m.active).length;
  const rated = mechanics?.filter((m) => m.rating != null) ?? [];
  const avgRating =
    mechanics === undefined
      ? undefined
      : rated.length > 0
        ? rated.reduce((s, m) => s + (m.rating ?? 0), 0) / rated.length
        : null;
  const totalContributions = mechanics?.reduce((s, m) => s + m.contributions, 0);

  const ratingDist = useMemo(() => {
    if (!mechanics) return undefined;
    const buckets = [5, 4, 3, 2, 1].map((star) => ({
      label: `${"★".repeat(star)}`,
      value: mechanics.filter((m) => m.rating != null && Math.round(m.rating) === star).length,
      sub: `${star}★`,
    }));
    const unrated = mechanics.filter((m) => m.rating == null).length;
    if (unrated > 0) buckets.push({ label: "unrated", value: unrated, sub: "—" });
    return buckets;
  }, [mechanics]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Mechanics"
        subtitle="First-class citizens of the barber-shop model — sorted by data contributions, the moat column."
      />

      {/* ── Stat tiles ── */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile
          label="Mechanics"
          value={mechanics === undefined ? <Skeleton /> : fmtNum(mechanics.length)}
        />
        <StatTile
          label="Active"
          value={activeCount === undefined ? <Skeleton /> : fmtNum(activeCount)}
        />
        <StatTile
          label="Avg rating"
          value={
            avgRating === undefined ? <Skeleton /> : avgRating === null ? "—" : `★ ${avgRating.toFixed(2)}`
          }
        />
        <StatTile
          label="Data contributions"
          value={totalContributions === undefined ? <Skeleton /> : fmtNum(totalContributions)}
          chip={<span className={`${PILL} bg-emerald-50 text-emerald-700`}>the moat</span>}
        />
      </div>

      {/* ── Rating distribution ── */}
      <div className={CARD}>
        <div className="mb-3 flex items-baseline gap-2">
          <h2 className="text-sm font-semibold text-slate-900">Rating distribution</h2>
          <span className="text-[11px] text-slate-400">mechanics by rounded star rating</span>
        </div>
        {ratingDist === undefined ? (
          <Skeleton className="h-24 w-full" />
        ) : ratingDist.every((b) => b.value === 0) ? (
          <p className="text-sm text-slate-500">No mechanics to distribute yet.</p>
        ) : (
          <BarRows rows={ratingDist} color="#fbbf24" />
        )}
      </div>

      {rows === undefined ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-14 animate-pulse rounded-lg bg-slate-100" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
          No mechanics on this deployment.
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className={`border-b border-slate-100 ${MICRO_H}`}>
                <th className="px-4 py-2">Mechanic</th>
                <th className="px-2 py-2">Shop</th>
                <th className="px-2 py-2">Rating</th>
                <th className="px-2 py-2">Jobs</th>
                <th className="px-2 py-2">Contributions</th>
                <th className="px-2 py-2">Next slot</th>
                <th className="px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {(rows as MechanicRow[]).map((m) => (
                <tr key={m.id} className={`border-b border-slate-50 hover:bg-slate-50 ${m.active ? "" : "opacity-50"}`}>
                  <td className="px-4 py-2">
                    <span className="flex items-center gap-2.5">
                      {m.photo ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={m.photo} alt="" className="h-8 w-8 rounded-full object-cover" />
                      ) : (
                        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-100 text-[12px] font-bold text-slate-500">
                          {m.name.slice(0, 1)}
                        </span>
                      )}
                      <span>
                        <Link
                          href={`/shops/mechanics/${m.id}`}
                          className="font-medium text-slate-900 hover:underline"
                        >
                          {m.name}
                        </Link>
                        {m.title && (
                          <span className="ml-1.5 text-[12px] text-slate-400">{m.title}</span>
                        )}
                        {!m.active && (
                          <span className={`${PILL} ml-1.5 bg-slate-100 text-slate-500`}>
                            inactive
                          </span>
                        )}
                      </span>
                    </span>
                  </td>
                  <td className="px-2 py-2">
                    {m.shop ? (
                      <Link
                        href={`/shops/all/${m.shop_id}`}
                        className={`${PILL} bg-blue-50 text-blue-700 hover:bg-blue-100`}
                      >
                        {m.shop}
                      </Link>
                    ) : (
                      <span className={`${PILL} bg-slate-100 text-slate-400`}>—</span>
                    )}
                  </td>
                  <td className="px-2 py-2 text-slate-600">
                    {m.rating != null ? `★ ${m.rating.toFixed(1)} (${m.review_count ?? 0})` : "—"}
                  </td>
                  <td className="px-2 py-2 text-slate-600">
                    {m.jobs}
                    {m.jobs_capped ? "+" : ""}
                  </td>
                  <td className="px-2 py-2">
                    <span
                      className={`${PILL} ${
                        m.contributions > 0
                          ? "bg-emerald-50 text-emerald-700"
                          : "bg-slate-100 text-slate-400"
                      }`}
                    >
                      {m.contributions} verifications
                    </span>
                  </td>
                  <td className="px-2 py-2 font-mono text-[12px] text-slate-500">
                    {m.next_slot ?? "—"}
                  </td>
                  <td className="px-2 py-2">
                    <Link
                      href={`/shops/mechanics/${m.id}`}
                      className="rounded-md px-2 py-1 text-[12px] font-medium text-blue-600 hover:bg-blue-50"
                    >
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
