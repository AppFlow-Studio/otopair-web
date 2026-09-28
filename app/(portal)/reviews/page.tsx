"use client";

/**
 * Shop Reviews — the portal's view of what customers say about this shop.
 *
 * WHY THIS EXISTS
 * ---------------
 * The app's shop page has had a Reviews tab for a long time, fed by
 * `reviews.getByShopId`. The portal called no review function at all, so a
 * shop owner could not read their own reviews anywhere: a one-star landed,
 * showed on their public shop page in the app, and the only people who could
 * see it were the director panel and ops. This closes that.
 *
 * READ-ONLY, deliberately. There is no reply/respond mutation in
 * `convex/reviews.ts` — replying needs a schema field, a mutation and an
 * app-side surface to render it, which is a feature rather than wiring. The
 * rating breakdown mirrors what the app renders so the two sides agree.
 *
 * Hidden reviews are excluded: `getByShopId` now filters `hidden_at`, which
 * is the contract `convex/opsReviews.ts` always stated. A shop sees exactly
 * what a customer sees.
 *
 * FILTERS
 * -------
 * All / Shop only / All mechanics / one chip per mechanic. The rating summary
 * recomputes for whatever is selected, which is the point — "how is James Bond
 * doing" is the question this page could not answer before.
 *
 * The mechanic chips are derived from the reviews themselves rather than from
 * `mechanics.getManagedByShop`, which computes booking blockers per mechanic
 * and is far heavier than a filter row needs. The trade-off: a mechanic with
 * zero reviews gets no chip. They would contribute nothing to any view, so the
 * only thing lost is confirming a silence you can already see in the counts.
 */

import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { MessageSquareQuote, Star, User } from "lucide-react";
import { cn } from "@/lib/utils";
import { SettingsCard } from "@/components/settings/primitives";

type ReviewRow = {
  _id: string;
  rating: number;
  comment?: string | null;
  created_at?: number | null;
  _creationTime: number;
  mechanic?: { first_name?: string; last_name?: string } | null;
  user?: { first_name?: string; last_name?: string } | null;
};

function reviewerName(user: ReviewRow["user"]): string {
  const name = [user?.first_name, user?.last_name].filter(Boolean).join(" ").trim();
  return name || "Otopair customer";
}

function mechanicName(mechanic: ReviewRow["mechanic"]): string | null {
  const name = [mechanic?.first_name, mechanic?.last_name].filter(Boolean).join(" ").trim();
  return name || null;
}

/** Same wording the app uses, so a shop reading here and a customer reading
 *  there describe the same review the same way. */
function formatTimeAgo(ms: number): string {
  const diff = Date.now() - ms;
  const day = 86_400_000;
  if (diff < day) return "Today";
  if (diff < 2 * day) return "Yesterday";
  if (diff < 30 * day) return `${Math.floor(diff / day)} days ago`;
  if (diff < 365 * day) {
    const months = Math.floor(diff / (30 * day));
    return months === 1 ? "1 month ago" : `${months} months ago`;
  }
  const years = Math.floor(diff / (365 * day));
  return years === 1 ? "1 year ago" : `${years} years ago`;
}

function Stars({ rating, size = 14 }: { rating: number; size?: number }) {
  const rounded = Math.round(rating);
  return (
    <span className="inline-flex items-center gap-0.5" aria-label={`${rating} out of 5`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Star
          key={n}
          size={size}
          className={cn(
            n <= rounded ? "fill-amber-400 text-amber-400" : "fill-transparent text-slate-300",
          )}
          strokeWidth={2}
        />
      ))}
    </span>
  );
}

export default function ShopReviewsPage() {
  const shops = useQuery(api.shops.getMyShops);
  const shop = shops?.[0] as { _id: Id<"shops">; name?: string } | undefined;

  const reviews = useQuery(
    api.reviews.getByShopId,
    shop ? { shopId: shop._id } : "skip",
  ) as ReviewRow[] | undefined;

  /** "all" | "shop" (no mechanic attached) | "mechanics" (any mechanic) |
   *  a mechanic's display name. */
  const [filter, setFilter] = useState<string>("all");

  /** Chips, with counts, built from the reviews in one pass. Mechanics are
   *  keyed by display name because that is all the review row carries. */
  const chips = useMemo(() => {
    if (!reviews) return [];
    let shopOnly = 0;
    let withMechanic = 0;
    const byMechanic = new Map<string, number>();
    for (const r of reviews) {
      const mech = mechanicName(r.mechanic);
      if (mech) {
        withMechanic += 1;
        byMechanic.set(mech, (byMechanic.get(mech) ?? 0) + 1);
      } else {
        shopOnly += 1;
      }
    }
    const base = [
      { key: "all", label: "All reviews", count: reviews.length },
      { key: "shop", label: "Shop only", count: shopOnly },
      { key: "mechanics", label: "All mechanics", count: withMechanic },
    ];
    const perMechanic = [...byMechanic.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name, count]) => ({ key: name, label: name, count }));
    // Drop the two aggregate chips when they would say the same thing as
    // "All" — a shop with no mechanic-attributed reviews does not need a
    // "Shop only (25)" chip sitting next to "All reviews (25)".
    const useful = base.filter(
      (c) => c.key === "all" || (c.count > 0 && c.count < reviews.length),
    );
    return [...useful, ...perMechanic];
  }, [reviews]);

  const filtered = useMemo(() => {
    if (!reviews) return undefined;
    if (filter === "all") return reviews;
    if (filter === "shop") return reviews.filter((r) => !mechanicName(r.mechanic));
    if (filter === "mechanics") return reviews.filter((r) => !!mechanicName(r.mechanic));
    return reviews.filter((r) => mechanicName(r.mechanic) === filter);
  }, [reviews, filter]);

  const summary = useMemo(() => {
    const reviews = filtered;
    if (!reviews) return null;
    const counts: Record<1 | 2 | 3 | 4 | 5, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    let total = 0;
    for (const r of reviews) {
      const star = Math.min(5, Math.max(1, Math.round(r.rating))) as 1 | 2 | 3 | 4 | 5;
      counts[star] += 1;
      total += r.rating;
    }
    return {
      counts,
      count: reviews.length,
      average: reviews.length > 0 ? total / reviews.length : 0,
    };
  }, [filtered]);

  const ordered = useMemo(() => {
    if (!filtered) return [];
    return [...filtered].sort(
      (a, b) => (b.created_at ?? b._creationTime) - (a.created_at ?? a._creationTime),
    );
  }, [filtered]);

  const loading = shops === undefined || (shop != null && reviews === undefined);

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-50">
          Reviews
        </h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          What customers see on your shop page in the Otopair app.
        </p>
      </header>

      {loading ? (
        <div className="space-y-3" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-24 animate-pulse rounded-xl bg-slate-100 dark:bg-slate-800"
            />
          ))}
        </div>
      ) : !shop ? (
        <SettingsCard title="No shop yet" icon={<MessageSquareQuote size={18} />}>
          <p className="text-sm text-slate-500">
            Reviews appear here once your shop is set up.
          </p>
        </SettingsCard>
      ) : (
        <div className="space-y-6">
          {/* Filters. Rendered only when there is something to choose between —
              a shop with one mechanic and no unattributed reviews would get a
              row of chips that all say the same thing. */}
          {chips.length > 1 ? (
            <div
              className="flex flex-wrap gap-2"
              role="group"
              aria-label="Filter reviews"
            >
              {chips.map((c) => {
                const active = filter === c.key;
                return (
                  <button
                    key={c.key}
                    type="button"
                    onClick={() => setFilter(c.key)}
                    aria-pressed={active}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors",
                      active
                        ? "border-blue-600 bg-blue-600 text-white"
                        : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300",
                    )}
                  >
                    <span>{c.label}</span>
                    <span
                      className={cn(
                        "tabular-nums text-xs",
                        active ? "text-blue-100" : "text-slate-400",
                      )}
                    >
                      {c.count}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}

          {/* Rating breakdown — mirrors the app's shop page so both agree.
              Recomputes for the active filter, so selecting a mechanic gives
              that mechanic's average rather than the shop's. */}
          <SettingsCard
            title={
              filter === "all"
                ? "Rating"
                : filter === "shop"
                  ? "Rating — shop only"
                  : filter === "mechanics"
                    ? "Rating — all mechanics"
                    : `Rating — ${filter}`
            }
            description={
              summary && summary.count > 0
                ? `${summary.count} review${summary.count === 1 ? "" : "s"}`
                : "No reviews yet"
            }
            icon={<Star size={18} />}
          >
            {summary && summary.count > 0 ? (
              <div className="flex flex-col gap-6 sm:flex-row sm:items-center">
                <div className="flex-1 space-y-1.5">
                  {([5, 4, 3, 2, 1] as const).map((star) => {
                    const n = summary.counts[star];
                    const pct = summary.count > 0 ? (n / summary.count) * 100 : 0;
                    return (
                      <div key={star} className="flex items-center gap-2">
                        <span className="w-3 text-xs tabular-nums text-slate-500">{star}</span>
                        <Star size={11} className="fill-amber-400 text-amber-400" />
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                          <div
                            className="h-full rounded-full bg-blue-500"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span className="w-6 text-right text-xs tabular-nums text-slate-400">
                          {n}
                        </span>
                      </div>
                    );
                  })}
                </div>
                <div className="flex flex-col items-center gap-1 sm:w-40">
                  <span className="text-4xl font-semibold tabular-nums text-slate-900 dark:text-slate-50">
                    {summary.average.toFixed(1)}
                  </span>
                  <Stars rating={summary.average} size={16} />
                  <span className="text-xs text-slate-400">
                    {summary.count} review{summary.count === 1 ? "" : "s"}
                  </span>
                </div>
              </div>
            ) : (
              <p className="text-sm text-slate-500">
                {filter === "all"
                  ? "Once a customer reviews a completed booking, it shows here and on your shop page in the app."
                  : "No reviews match this filter yet."}
              </p>
            )}
          </SettingsCard>

          {ordered.length > 0 ? (
            <section aria-label="Customer reviews" className="space-y-3">
              <h2 className="text-sm font-medium text-slate-500 dark:text-slate-400">
                {filter === "all"
                  ? `Customer reviews (${ordered.length})`
                  : `${chips.find((c) => c.key === filter)?.label ?? filter} (${ordered.length})`}
              </h2>
              {ordered.map((r) => {
                const mech = mechanicName(r.mechanic);
                return (
                  <article
                    key={r._id}
                    className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900"
                  >
                    <div className="flex items-start gap-3">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-400 dark:bg-slate-800">
                        <User size={17} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="font-medium text-slate-900 dark:text-slate-50">
                            {reviewerName(r.user)}
                          </span>
                          <Stars rating={r.rating} />
                          <span className="text-xs text-slate-400">
                            {formatTimeAgo(r.created_at ?? r._creationTime)}
                          </span>
                        </div>
                        {mech ? (
                          <p className="mt-0.5 text-xs text-slate-400">Served by {mech}</p>
                        ) : null}
                        {r.comment ? (
                          <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-slate-600 dark:text-slate-300">
                            {r.comment}
                          </p>
                        ) : (
                          <p className="mt-2 text-sm italic text-slate-400">
                            Rating only — no comment left.
                          </p>
                        )}
                      </div>
                    </div>
                  </article>
                );
              })}
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}
