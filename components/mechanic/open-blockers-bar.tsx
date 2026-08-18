"use client";

/**
 * OpenBlockersBar — stalled jobs, visible somewhere that isn't the stalled job.
 *
 * The whole point of the blocker lane (Flag Issue spec, §5) is that a job which
 * can't proceed stops being invisible. Rendering that only inside the job's own
 * overlay defeats it: nobody opens the overlay of a car they've stopped thinking
 * about, so the blocker ages silently — which is the exact failure the lane
 * exists to prevent.
 *
 * So it lives on the schedule board, where the front desk already looks, sorted
 * oldest-first and leading with age. Age is the number that should make someone
 * act: "waiting on a part" is fine at 20 minutes and a problem at two days.
 *
 * Renders nothing when nothing is blocked, so it costs no space on a normal day.
 */

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { PauseCircle } from "lucide-react";

function formatAge(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/** Past this, a blocker isn't waiting any more — it's forgotten. */
const STALE_MINUTES = 24 * 60;

export default function OpenBlockersBar({
  onOpenBooking,
}: {
  onOpenBooking?: (bookingId: Id<"bookings">) => void;
}) {
  const shopData = useQuery(api.schedule.getShopServicesWithCategories);
  const shopId = (shopData as any)?.shopId as Id<"shops"> | undefined;

  const blockers = useQuery(
    api.jobBlockers.openForShop,
    shopId ? { shopId } : "skip",
  );

  if (!blockers || blockers.length === 0) return null;

  return (
    <div className="mb-3 rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <PauseCircle className="h-3.5 w-3.5 shrink-0 text-amber-600" />
        <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-amber-700">
          {blockers.length} job{blockers.length === 1 ? "" : "s"} stopped
        </p>
      </div>
      <ul className="mt-2 space-y-1.5">
        {blockers.map((b: any) => {
          const stale = b.age_minutes >= STALE_MINUTES;
          return (
            <li key={String(b._id)}>
              <button
                type="button"
                onClick={() => onOpenBooking?.(b.booking_id)}
                className="flex w-full items-start justify-between gap-3 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-amber-500/10"
              >
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-medium text-foreground">
                    {b.label}
                    {b.vin ? (
                      <span className="ml-1.5 font-mono text-[11px] text-muted-foreground">
                        {b.vin.slice(-6)}
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                    {b.note}
                  </span>
                </span>
                {/* Age leads, and goes red once it's been sitting long enough
                    that nobody is actually waiting on it any more. */}
                <span
                  className={`shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-semibold tabular-nums ${
                    stale
                      ? "bg-red-500/15 text-red-700"
                      : "bg-amber-500/15 text-amber-700"
                  }`}
                >
                  {formatAge(b.age_minutes)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
