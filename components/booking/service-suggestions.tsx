"use client";

/**
 * ServiceSuggestions — matching catalog services surface as you type.
 *
 * Replaces the older "Did you mean?" / "We already offer this" framing, which
 * asked the mechanic a question and made them answer it before they could carry
 * on. Someone with dirty hands shouldn't have to resolve an assertion the system
 * made about their typing.
 *
 * The model here is search, not interrogation: what you typed is always the
 * answer, and matches are just there to be taken if one of them is what you
 * meant. Nothing blocks, nothing asks, nothing has to be dismissed.
 *
 * WHAT THIS STILL PROTECTS. The reason the gate exists is that a mechanic who
 * types a name we already carry silently costs the driver their maintenance
 * credit — custom work can never write a health-score anchor. That protection
 * came from the canonical option being *visible and one tap away*, never from
 * the question. So a confident match still gets visual weight (it leads the
 * list, styled as the obvious choice) — it just doesn't demand a reply.
 *
 * Renders nothing at all when there's no plausible match, which is the common
 * case for genuinely off-catalog work.
 */

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";

export type SuggestedService = {
  serviceId: string;
  name: string;
  slug: string | null;
  has_options: boolean;
  via: "alias" | "name" | "slug";
};

export default function ServiceSuggestions({
  typed,
  onPick,
  offeredServiceIds,
  dark = false,
  limit = 3,
}: {
  typed: string;
  onPick: (service: SuggestedService) => void;
  /** When set, only services in this set are offered — a shop can't book a
   *  service it doesn't carry, and selecting one would leave an id the
   *  duration/price maths can't resolve. */
  offeredServiceIds?: Set<string>;
  dark?: boolean;
  limit?: number;
}) {
  const verdict = useQuery(
    api.serviceMatch.matchCustomName,
    typed.trim().length >= 2 ? { name: typed.trim(), limit } : "skip",
  );

  if (!verdict || verdict.confidence === "none") return null;

  const candidates = (verdict.candidates as SuggestedService[]).filter((c) =>
    offeredServiceIds ? offeredServiceIds.has(String(c.serviceId)) : true,
  );
  if (candidates.length === 0) return null;

  // A confident match leads and carries more weight — the obvious answer should
  // look obvious without anyone being asked about it.
  const confident =
    verdict.confidence === "exact" || verdict.confidence === "high";

  const labelClass = dark
    ? "text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500"
    : "text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground";

  const rowClass = (lead: boolean) => {
    if (dark) {
      return lead
        ? "flex w-full items-center justify-between gap-2 rounded-lg border border-emerald-400/50 bg-emerald-400/10 px-3 py-2 text-left transition-colors hover:bg-emerald-400/20"
        : "flex w-full items-center justify-between gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-left transition-colors hover:bg-white/[0.08]";
    }
    return lead
      ? "flex w-full items-center justify-between gap-2 rounded-lg border border-primary/40 bg-primary/10 px-3 py-2 text-left transition-colors hover:bg-primary/20"
      : "flex w-full items-center justify-between gap-2 rounded-lg border border-primary/15 bg-background px-3 py-2 text-left transition-colors hover:bg-primary/5";
  };

  const nameClass = dark
    ? "truncate text-[13px] font-semibold text-slate-100"
    : "truncate text-[13px] font-semibold text-foreground";

  const hintClass = dark
    ? "shrink-0 text-[10px] text-slate-500"
    : "shrink-0 text-[10px] text-muted-foreground";

  return (
    <div className="space-y-1.5">
      <p className={labelClass}>In the catalog</p>
      <ul className="space-y-1">
        {candidates.map((c, i) => (
          <li key={c.serviceId}>
            <button
              type="button"
              onClick={() => onPick(c)}
              className={rowClass(confident && i === 0)}
            >
              <span className={nameClass}>{c.name}</span>
              {/* An alias hit means someone already made this call by hand.
                  Worth saying; a bare confidence score isn't. */}
              {c.via === "alias" ? (
                <span className={hintClass}>linked before</span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
