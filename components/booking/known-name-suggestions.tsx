"use client";

/**
 * KnownNameSuggestions — "other shops call it…", offered as you type.
 *
 * The second band under a custom-service name field. The first
 * (ServiceSuggestions) offers catalog services, and taking one is strictly
 * better: it's bookable and it earns the driver maintenance credit. This one
 * only matters once we've established there ISN'T a catalog answer, which is
 * why it renders underneath and in a quieter register.
 *
 * What it's for: a name typed forty different ways is forty clusters, and the
 * director view can only propose a service for work it can see repeating.
 * Converging on one spelling at the keyboard is worth more than any amount of
 * matching afterwards — nothing downstream can recover a distinction that was
 * never recorded.
 *
 * Taking a suggestion also carries its taxonomy across, because the shops that
 * already did this work have effectively voted on what it is. That saves two
 * taps and, more usefully, keeps the cluster's tagging internally consistent
 * instead of split between "engine · service" and "engine · repair".
 */

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { describeCustomJobTaxonomy } from "@/lib/custom-job-taxonomy";

export type KnownNameSuggestion = {
  name: string;
  shops: number;
  jobs: number;
  system_tags: string[];
  work_type: string | null;
  used_here: boolean;
};

export default function KnownNameSuggestions({
  typed,
  shopId,
  onPick,
  limit = 3,
}: {
  typed: string;
  shopId?: string;
  /** Replaces the typed name with the cluster's spelling, and carries its
   *  taxonomy so the chips below arrive pre-answered. */
  onPick: (suggestion: KnownNameSuggestion) => void;
  limit?: number;
}) {
  const suggestions = useQuery(
    api.customJobs.suggestKnownNames,
    typed.trim().length >= 3
      ? {
          name: typed.trim(),
          shopId: shopId ? (shopId as Id<"shops">) : undefined,
          limit,
        }
      : "skip",
  ) as KnownNameSuggestion[] | undefined;

  if (!suggestions || suggestions.length === 0) return null;

  return (
    <div className="space-y-1.5">
      <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
        Other shops call it
      </p>
      <ul className="space-y-1">
        {suggestions.map((s) => (
          <li key={s.name}>
            <button
              type="button"
              onClick={() => onPick(s)}
              className="flex w-full items-center justify-between gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-left transition-colors hover:border-primary/40 hover:bg-primary/5"
            >
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-medium text-foreground">
                  {s.name}
                </span>
                {s.system_tags.length > 0 || s.work_type ? (
                  <span className="block truncate text-[10px] uppercase tracking-[0.06em] text-muted-foreground">
                    {describeCustomJobTaxonomy(s.system_tags, s.work_type)}
                  </span>
                ) : null}
              </span>
              {/* Breadth, not volume — four shops doing it three times each is a
                  real category; one shop doing it forty times is that shop's
                  speciality. Deliberately anonymous: which shops is none of
                  this shop's business. */}
              <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                {s.shops} shop{s.shops === 1 ? "" : "s"}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
