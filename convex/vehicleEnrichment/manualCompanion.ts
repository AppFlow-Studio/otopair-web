/**
 * vehicleEnrichment/manualCompanion.ts — FINDING THE DOCUMENT THE MANUAL POINTS AT
 *
 * WHY THIS EXISTS
 * ---------------
 * Some owner's manuals do not contain the maintenance schedule. The 2021 Subaru
 * Legacy says so on page 489: the scheduled items "are shown in the 'Warranty
 * and Maintenance Booklet.'" `detectScheduleDeferral` (manualPageIndex) reads
 * that sentence and gives us a title. This module turns the title into a
 * document.
 *
 * WHAT THE REAL SEARCH LOOKED LIKE (Aug 18 2026, Subaru)
 * -----------------------------------------------------
 * Six results, of which exactly one was the document: Subaru's own
 * techinfo.subaru.com/stis/doc/warrantyBooklet/2023_war_and_maint_060822.PDF.
 * The rest were owner forums, a Reddit thread and a Facebook group — all of
 * which mention the booklet by name and none of which are it. Ranking is
 * therefore the whole job, and it is why this is a scored decision rather than
 * "take the first PDF".
 *
 * The prize is large and it is not only about coverage. That booklet is 32
 * PAGES against a 592-page owner's manual, and it is denser: 63 mileage tokens,
 * a real `R=Replace / I=Inspect / P=Perform` grid headed "2023 MY All Vehicles".
 * It fits the Anthropic Files API comfortably, so it extracts for ZERO Reducto
 * spend. It is the same shape as Toyota's T-MMS booklet, which is already the
 * highest-yield source in the whole manual pipeline.
 *
 * THE YEAR TRAP
 * -------------
 * Subaru publishes ONE booklet per model year covering every model, and
 * techinfo exposes only the CURRENT one — a search for a 2021 Legacy returns
 * the 2023 booklet. Maintenance schedules do change between years, so quietly
 * accepting it would put a 2023 schedule on a 2021 car and stamp it
 * `oem_manual` at 0.95. A year mismatch is therefore a REFUSAL, surfaced as
 * such, not a near-miss that gets rounded up.
 */

export type CompanionCandidate = {
  url: string;
  title?: string | null;
};

export type ScoredCompanion = CompanionCandidate & {
  score: number;
  /** True when neither the URL nor the title carries the vehicle's year. */
  yearMismatch: boolean;
  /** Why it scored what it scored — shown in logs and the resolver result. */
  reasons: string[];
};

/**
 * Hosts that publish manufacturer documents. A booklet from one of these is the
 * document; the same words on a forum are a conversation about the document.
 */
const OEM_DOC_HOSTS = [
  "techinfo.subaru.com",
  "subaru.com",
  "assets.sia.toyota.com",
  "toyota.com",
  "owners.honda.com",
  "honda.com",
  "owners.acura.com",
  "nissanusa.com",
  "owners.hyundaiusa.com",
  "kia.com",
  "ford.com",
  "gm.com",
  "chevrolet.com",
  "gmc.com",
  "mopar.com",
  "mazdausa.com",
  "vw.com",
  "audiusa.com",
  "bmwusa.com",
  "mbusa.com",
  "volvocars.com",
];

/** Places that TALK about manuals. Never the manual itself. */
const DISCUSSION_HOSTS = [
  "reddit.com",
  "facebook.com",
  "quora.com",
  "youtube.com",
  "pinterest.com",
];

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
};

const isForumish = (host: string): boolean =>
  DISCUSSION_HOSTS.some((h) => host === h || host.endsWith("." + h)) ||
  /forum|forums|\bclub\b|owners?club|threads?/.test(host);

const isOemHost = (host: string): boolean =>
  OEM_DOC_HOSTS.some((h) => host === h || host.endsWith("." + h));

/**
 * Score one search result as the companion document.
 *
 * Negative scores are disqualifications, kept rather than filtered so a caller
 * can log WHY the obvious-looking forum thread was not chosen.
 */
export function scoreCompanionCandidate(
  candidate: CompanionCandidate,
  vehicle: { year: number; make: string },
  target: { title: string },
): ScoredCompanion {
  const url = candidate.url ?? "";
  const host = hostOf(url);
  const hay = `${url} ${candidate.title ?? ""}`.toLowerCase();
  const reasons: string[] = [];
  let score = 0;

  const isPdf = /\.pdf(?:[?#]|$)/i.test(url);
  if (isPdf) {
    score += 5;
    reasons.push("pdf");
  } else {
    score -= 3;
    reasons.push("not_pdf");
  }

  if (isOemHost(host)) {
    score += 6;
    reasons.push(`oem_host:${host}`);
  }
  if (isForumish(host)) {
    // A forum thread named exactly after the booklet is the single most
    // common false positive in this search — it outranks the real document on
    // title match alone.
    score -= 10;
    reasons.push(`discussion_host:${host}`);
  }

  // Title words from the deferral, e.g. "warranty" + "maintenance" + "booklet".
  const words = target.title.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  const matched = words.filter((w) => hay.includes(w));
  if (words.length > 0) {
    score += Math.round((4 * matched.length) / words.length);
    reasons.push(`title_words:${matched.length}/${words.length}`);
  }

  const yearMismatch = !hay.includes(String(vehicle.year));
  if (!yearMismatch) {
    score += 5;
    reasons.push(`year:${vehicle.year}`);
  } else {
    reasons.push("year_absent");
  }

  if (hay.includes(vehicle.make.toLowerCase())) {
    score += 2;
    reasons.push("make");
  }

  return { ...candidate, score, yearMismatch, reasons };
}

/**
 * Candidates best-first.
 *
 * Year-matching candidates always outrank non-matching ones regardless of
 * score: a 2023 booklet is not a better answer for a 2021 car than a worse-
 * ranked 2021 document, it is the wrong answer.
 */
export function rankCompanionCandidates(
  candidates: readonly CompanionCandidate[],
  vehicle: { year: number; make: string },
  target: { title: string },
): ScoredCompanion[] {
  return candidates
    .map((c) => scoreCompanionCandidate(c, vehicle, target))
    .sort((a, b) => {
      if (a.yearMismatch !== b.yearMismatch) return a.yearMismatch ? 1 : -1;
      return b.score - a.score;
    });
}

/** Minimum score for a candidate to be worth spending a probe on. */
export const COMPANION_MIN_SCORE = 8;

export type CompanionVerdict =
  | { status: "candidate"; pick: ScoredCompanion }
  | { status: "year_mismatch"; best: ScoredCompanion }
  | { status: "none"; reason: string };

/**
 * The decision, separated from the fetching so it is testable.
 *
 * `year_mismatch` is deliberately its own status rather than a `none`: it means
 * the document EXISTS and we found it, we simply cannot use this edition. That
 * distinction is what tells a human "publish year N of this booklet and the
 * vehicle resolves" instead of "nothing out there".
 */
export function decideCompanion(ranked: readonly ScoredCompanion[]): CompanionVerdict {
  if (ranked.length === 0) return { status: "none", reason: "no_results" };
  const usable = ranked.filter((r) => !r.yearMismatch && r.score >= COMPANION_MIN_SCORE);
  if (usable.length > 0) return { status: "candidate", pick: usable[0] };
  const anyGood = ranked.find((r) => r.score >= COMPANION_MIN_SCORE);
  if (anyGood) return { status: "year_mismatch", best: anyGood };
  return { status: "none", reason: `below_score:${ranked[0].score}` };
}

// ─── Resolver ────────────────────────────────────────────────────

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { searchAndFetch } from "./firecrawl";
import { companionSearchQueries, type DeferralTarget } from "./manualPageIndex";

const libApi = () => (internal as any).vehicleEnrichment.manualLibrary;

/**
 * Find the document a manual deferred to.
 *
 * Reports rather than ingests. The companion is keyed differently from the
 * owner's manual — Subaru publishes ONE booklet per model year covering every
 * model, so filing it under (make, model, year) would refetch identical bytes
 * per model — and that storage decision should be made deliberately, not as a
 * side effect of a search. What this settles is the part that was unknown:
 * whether the document is findable, and which URL it is.
 *
 *   npx convex run vehicleEnrichment/manualCompanion:resolveCompanionManual \
 *     '{"make":"Subaru","model":"Legacy","year":2021}'
 */
export const resolveCompanionManual = internalAction({
  args: { make: v.string(), model: v.string(), year: v.float64() },
  handler: async (ctx, args): Promise<any> => {
    const label = `${args.year} ${args.make} ${args.model}`;
    const row: any = await ctx.runQuery(libApi().getManualRow, {
      make: args.make,
      model: args.model,
      year: args.year,
    });
    const targets: DeferralTarget[] = row?.page_index?.defers_to ?? [];
    if (targets.length === 0) {
      return { status: "skipped", reason: "no_deferral_recorded", label };
    }
    const target = targets[0];
    const queries = companionSearchQueries(args, target);

    const seen = new Map<string, { url: string; title?: string | null }>();
    for (const q of queries) {
      let results;
      try {
        // STRICT: a transport failure must not be recorded as "no companion
        // document exists". Firecrawl answered HTTP 402 for hours on Aug 18
        // and every lenient caller read the empty list as an answer.
        results = await searchAndFetch(q, 6, false, { throwOnError: true });
      } catch (e) {
        console.error(`[companion] ${label}: search channel failed — NOT a verdict:`, e);
        return { status: "failed", reason: `search_unavailable:${String(e).slice(0, 120)}`, label };
      }
      for (const r of results) {
        const url = (r as any)?.url;
        if (url && !seen.has(url)) seen.set(url, { url, title: (r as any)?.title ?? null });
      }
    }

    const ranked = rankCompanionCandidates([...seen.values()], args, target);
    const verdict = decideCompanion(ranked);

    console.log(
      `[companion] ${label}: defers to "${target.title}" — ${seen.size} result(s), verdict=${verdict.status}` +
        (verdict.status === "candidate" ? ` → ${verdict.pick.url}` : "") +
        (verdict.status === "year_mismatch"
          ? ` → best is ${verdict.best.url} (wrong model year; the booklet exists, this edition is not it)`
          : ""),
    );

    return {
      status: verdict.status,
      label,
      defersTo: target.title,
      evidence: target.evidence,
      searched: queries,
      verdict,
      ranked: ranked.slice(0, 6).map((r) => ({
        url: r.url,
        score: r.score,
        yearMismatch: r.yearMismatch,
        reasons: r.reasons,
      })),
    };
  },
});
