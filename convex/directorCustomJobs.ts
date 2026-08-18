/**
 * directorCustomJobs.ts — what shops are doing that we don't model
 * (Off-Catalog Work spec, §8).
 *
 * There is no promotion pipeline, no thresholds and no approval workflow.
 * `pending_service_submissions` keeps its unused lifecycle enum; deciding to
 * build something is a human product call made outside this system. What the
 * director gets here is a READ — the clearest available picture of off-catalog
 * work, ranked so the top of the list answers "what should we build next".
 *
 * The view has three bands, and the order matters:
 *
 *   1. likelyCanonical  — clusters that are probably a service we already offer.
 *      NOTE the confidence bar here is LOWER than the match gate's, deliberately.
 *      The gate auto-selects, so a false positive there puts the wrong service on
 *      a real booking — it must stay strict (exact/high only). This band is a
 *      human review surface, so a false positive costs one dismissal while a MISS
 *      leaves drivers silently mis-scored for months. Medium therefore belongs
 *      here and not there: this band's job is precisely to catch what the gate
 *      was right to only ask about.
 *      This is a CORRECTNESS band, not a roadmap one. While a cluster sits here,
 *      every driver whose custom job it covers is quietly losing maintenance
 *      credit (§2 Leak 2). It should normally be empty; when it isn't, that's a
 *      bug report about the match gate. Aliasing a cluster is what clears it,
 *      and that alias is the only feedback path into the gate.
 *
 *   2. highVariance     — shop shortcuts whose actuals scatter. Either the button
 *      is being pressed for several different jobs (§3 drift) or the work is
 *      genuinely config-dependent. We flag rather than guess; the complaint texts
 *      are what settle it.
 *
 *   3. clusters         — the roadmap read. No buttons at all.
 *
 * RANKING: distinct shops first, not raw occurrences. One shop doing something
 * forty times is that shop's specialty; four shops doing it three times each is
 * a category we're missing. Ties break on trend, then on total charged, so
 * breadth and money float rather than one enthusiastic garage.
 */

import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireDirector } from "./directorGate";
import {
  matchServiceName,
  serviceMatchKey,
  type MatchCandidateInput,
} from "./lib/serviceMatch";
import { shortcutMinutesStats } from "./shopCustomServices";
import {
  customJobTaxonomyKey,
  describeCustomJobTaxonomy,
} from "../lib/custom-job-taxonomy";

const DAY_MS = 24 * 60 * 60 * 1000;
const TREND_WINDOW_DAYS = 90;

/** A shortcut needs this many samples before its scatter means anything. */
const VARIANCE_MIN_SAMPLES = 3;
/** Coefficient of variation above which a shortcut is worth a human look. */
const VARIANCE_CV_THRESHOLD = 0.5;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function loadCatalog(ctx: any): Promise<MatchCandidateInput[]> {
  const services = await ctx.db.query("services").collect();
  const aliases = await ctx.db.query("service_aliases").collect();
  const byService = new Map<string, string[]>();
  for (const row of aliases) {
    const key = String(row.service_id);
    const list = byService.get(key);
    if (list) list.push(row.alias);
    else byService.set(key, [row.alias]);
  }
  return services
    .filter((s: any) => s.is_bookable !== false)
    .map((s: any) => ({
      serviceId: String(s._id),
      name: s.name,
      slug: s.slug ?? null,
      aliases: byService.get(String(s._id)) ?? [],
    }));
}

/**
 * Match keys that have already been linked to a canonical service by hand.
 *
 * These are the RESOLVED ones. Without this set the likelyCanonical band could
 * never empty: aliasing a cluster makes it match the catalog *more* strongly, so
 * it would rank itself straight back to the top of its own to-do list.
 */
async function resolvedAliasKeys(ctx: any): Promise<Set<string>> {
  const aliases = await ctx.db.query("service_aliases").collect();
  return new Set<string>(aliases.map((a: any) => a.normalized_alias));
}

type ClusterAccumulator = {
  match_key: string;
  /** The most common spelling, which is what the alias action should use. */
  names: Map<string, number>;
  shops: Set<string>;
  vins: Set<string>;
  configs: Set<string>;
  /** "primary_system:work_type" counts. The coarse axis beside match_key. */
  taxonomies: Map<string, number>;
  /** Every system touched by any job in the cluster, for the drawer. */
  systems: Map<string, number>;
  categories: Map<string, number>;
  occurrences: number;
  recent: number;
  prior: number;
  chargedCents: number[];
  minutes: number[];
  complaints: string[];
  resolvedYes: number;
  resolvedKnown: number;
  lastSeenAt: number;
  fromShortcut: number;
  /** How many jobs in this cluster consumed parts, and which ones. */
  withParts: number;
  partNames: Map<string, number>;
  partsCents: number[];
};

function dominant(counts: Map<string, number>): string | null {
  let best: string | null = null;
  let bestN = -1;
  for (const [key, n] of counts) {
    if (n > bestN) {
      best = key;
      bestN = n;
    }
  }
  return best;
}

/**
 * Build every cluster from the custom_jobs table.
 *
 * Full collect: custom_jobs is young, and the aggregation needs every row to
 * compute distinct-shop counts and medians. If this table reaches the tens of
 * thousands, move it to a precomputed portal_stats-style rollup rather than
 * quietly capping the scan — a silently truncated roadmap read is worse than a
 * slow one.
 */
async function buildClusters(ctx: any, now: number) {
  const jobs = await ctx.db.query("custom_jobs").collect();
  const acc = new Map<string, ClusterAccumulator>();

  for (const job of jobs) {
    const key = job.match_key;
    if (!key) continue;
    let c = acc.get(key);
    if (!c) {
      c = {
        match_key: key,
        names: new Map(),
        shops: new Set(),
        vins: new Set(),
        configs: new Set(),
        taxonomies: new Map(),
        systems: new Map(),
        categories: new Map(),
        occurrences: 0,
        recent: 0,
        prior: 0,
        chargedCents: [],
        minutes: [],
        complaints: [],
        resolvedYes: 0,
        resolvedKnown: 0,
        lastSeenAt: 0,
        fromShortcut: 0,
        withParts: 0,
        partNames: new Map(),
        partsCents: [],
      };
      acc.set(key, c);
    }

    c.occurrences += 1;
    c.names.set(job.name, (c.names.get(job.name) ?? 0) + 1);
    c.shops.add(String(job.shop_id));
    if (job.vehicle_vin) c.vins.add(job.vehicle_vin);
    if (job.vehicle_config_id) c.configs.add(String(job.vehicle_config_id));
    // The descriptive taxonomy. Grouping on the PRIMARY system only (see
    // customJobTaxonomyKey) is what lets "walnut blast" and "intake decarbon"
    // read as one engine-service gap even though their match_keys never meet.
    const taxKey = customJobTaxonomyKey(job.system_tags, job.work_type);
    if (taxKey) c.taxonomies.set(taxKey, (c.taxonomies.get(taxKey) ?? 0) + 1);
    for (const sys of (job.system_tags ?? []) as string[]) {
      c.systems.set(sys, (c.systems.get(sys) ?? 0) + 1);
    }
    if (job.category_id) {
      const cat = String(job.category_id);
      c.categories.set(cat, (c.categories.get(cat) ?? 0) + 1);
    }
    if (job.shop_custom_service_id) c.fromShortcut += 1;
    if (Array.isArray(job.parts) && job.parts.length > 0) {
      c.withParts += 1;
      for (const part of job.parts) {
        const label = String(part?.part_name ?? "").trim();
        if (label) c.partNames.set(label, (c.partNames.get(label) ?? 0) + 1);
      }
    }
    if (typeof job.quoted_parts_cents === "number") {
      c.partsCents.push(job.quoted_parts_cents);
    }

    const age = now - job.created_at;
    if (age <= TREND_WINDOW_DAYS * DAY_MS) c.recent += 1;
    else if (age <= 2 * TREND_WINDOW_DAYS * DAY_MS) c.prior += 1;

    if (typeof job.charged_price_cents === "number") {
      c.chargedCents.push(job.charged_price_cents);
    }
    if (typeof job.actual_minutes === "number") c.minutes.push(job.actual_minutes);
    else if (typeof job.estimated_minutes === "number") {
      c.minutes.push(job.estimated_minutes);
    }

    // A handful of verbatim complaints is what turns a name into something a
    // reviewer can actually understand. Cap it — this is a sample, not a dump.
    if (job.complaint && c.complaints.length < 4) c.complaints.push(job.complaint);

    if (typeof job.resolved_complaint === "boolean") {
      c.resolvedKnown += 1;
      if (job.resolved_complaint) c.resolvedYes += 1;
    }
    if (job.created_at > c.lastSeenAt) c.lastSeenAt = job.created_at;
  }

  return acc;
}

export type DirectorCluster = {
  match_key: string;
  name: string;
  occurrences: number;
  distinct_shops: number;
  distinct_vehicles: number;
  distinct_configs: number;
  /** Dominant "primary_system:work_type" across the cluster, or null on
   *  clusters made entirely of rows written before the taxonomy shipped. */
  taxonomy_key: string | null;
  /** Human form of the above — "Engine · Service". */
  taxonomy_label: string | null;
  /** Every system any job in the cluster touched, most common first. */
  systems: string[];
  /** Legacy catalog category, kept for historical rows. */
  category_id: string | null;
  /** recent-window count minus prior-window count. Positive = growing. */
  trend: number;
  recent_count: number;
  median_charged_cents: number | null;
  min_charged_cents: number | null;
  max_charged_cents: number | null;
  median_minutes: number | null;
  min_minutes: number | null;
  max_minutes: number | null;
  total_charged_cents: number;
  sample_complaints: string[];
  /** Of the jobs that reported an outcome, what fraction fixed the complaint. */
  resolution_rate: number | null;
  outcomes_recorded: number;
  from_shortcut: number;
  /** Jobs in this cluster that consumed parts, and the parts most often used.
   *  A cluster that always needs the same part is a service we can price. */
  jobs_with_parts: number;
  common_parts: string[];
  median_parts_cents: number | null;
  last_seen_at: number;
  /** Set when this cluster looks like an existing service. */
  canonical_suggestion: {
    service_id: string;
    service_name: string;
    confidence: string;
    score: number;
  } | null;
};

/**
 * The whole view in one query. Deliberately one round-trip: the three bands are
 * derived from the same aggregation, and splitting them would let the bands
 * disagree about the same cluster mid-render.
 */
export const patternView = query({
  args: { token: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requireDirector(ctx, args.token);

    const now = Date.now();
    const [catalog, resolved, acc] = await Promise.all([
      loadCatalog(ctx),
      resolvedAliasKeys(ctx),
      buildClusters(ctx, now),
    ]);

    const clusters: DirectorCluster[] = [];
    for (const c of acc.values()) {
      const name = dominant(c.names) ?? c.match_key;
      const totalCharged = c.chargedCents.reduce((sum, n) => sum + n, 0);

      // Only score against the catalog when nobody has already ruled on this
      // name — see resolvedAliasKeys.
      let suggestion: DirectorCluster["canonical_suggestion"] = null;
      if (!resolved.has(c.match_key)) {
        const verdict = matchServiceName(name, catalog);
        // Medium included on purpose — see the note in the file header. A human
        // reads this band, so the cost of over-flagging is one dismissal.
        if (verdict.best && verdict.confidence !== "none") {
          suggestion = {
            service_id: verdict.best.serviceId,
            service_name: verdict.best.name,
            confidence: verdict.confidence,
            score: Math.round(verdict.best.score * 100) / 100,
          };
        }
      }

      clusters.push({
        match_key: c.match_key,
        name,
        occurrences: c.occurrences,
        distinct_shops: c.shops.size,
        distinct_vehicles: c.vins.size,
        distinct_configs: c.configs.size,
        taxonomy_key: dominant(c.taxonomies),
        taxonomy_label: (() => {
          const key = dominant(c.taxonomies);
          if (!key) return null;
          const [system, workType] = key.split(":");
          return describeCustomJobTaxonomy([system], workType);
        })(),
        systems: [...c.systems.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([slug]) => slug),
        category_id: dominant(c.categories),
        trend: c.recent - c.prior,
        recent_count: c.recent,
        median_charged_cents: median(c.chargedCents),
        min_charged_cents: c.chargedCents.length
          ? Math.min(...c.chargedCents)
          : null,
        max_charged_cents: c.chargedCents.length
          ? Math.max(...c.chargedCents)
          : null,
        median_minutes: median(c.minutes),
        min_minutes: c.minutes.length ? Math.min(...c.minutes) : null,
        max_minutes: c.minutes.length ? Math.max(...c.minutes) : null,
        total_charged_cents: totalCharged,
        sample_complaints: c.complaints,
        resolution_rate:
          c.resolvedKnown > 0 ? c.resolvedYes / c.resolvedKnown : null,
        outcomes_recorded: c.resolvedKnown,
        from_shortcut: c.fromShortcut,
        jobs_with_parts: c.withParts,
        common_parts: [...c.partNames.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([name]) => name),
        median_parts_cents: median(c.partsCents),
        last_seen_at: c.lastSeenAt,
        canonical_suggestion: suggestion,
      });
    }

    // Distinct shops first — breadth beats one enthusiastic garage. Then trend,
    // then money.
    clusters.sort((a, b) => {
      if (b.distinct_shops !== a.distinct_shops) {
        return b.distinct_shops - a.distinct_shops;
      }
      if (b.trend !== a.trend) return b.trend - a.trend;
      return b.total_charged_cents - a.total_charged_cents;
    });

    const likelyCanonical = clusters.filter((c) => c.canonical_suggestion);
    // Ranked by how much harm is accruing, not by how interesting they are: a
    // cluster covering more vehicles is penalising more drivers right now.
    likelyCanonical.sort((a, b) => b.distinct_vehicles - a.distinct_vehicles);

    const roadmap = clusters.filter((c) => !c.canonical_suggestion);

    // ── High-variance shortcuts (§3 drift) ────────────────────────────────
    const shortcuts = await ctx.db.query("shop_custom_services").collect();
    const highVariance = shortcuts
      .map((s: any) => {
        const stats = shortcutMinutesStats(s);
        return {
          _id: s._id,
          shop_id: s.shop_id,
          name: s.name,
          use_count: s.use_count,
          samples: stats.samples,
          mean_minutes: stats.mean,
          cv: stats.cv,
          deviation_count: s.deviation_count ?? 0,
          default_minutes: s.default_minutes ?? null,
        };
      })
      .filter(
        (s) =>
          s.samples >= VARIANCE_MIN_SAMPLES &&
          s.cv != null &&
          s.cv > VARIANCE_CV_THRESHOLD,
      )
      .sort((a, b) => (b.cv ?? 0) - (a.cv ?? 0));

    const limit = args.limit ?? 40;
    return {
      // The correctness band leads. It should normally be empty.
      likelyCanonical: likelyCanonical.slice(0, limit),
      highVariance: highVariance.slice(0, limit),
      clusters: roadmap.slice(0, limit),
      totals: {
        clusters: clusters.length,
        likely_canonical: likelyCanonical.length,
        high_variance: highVariance.length,
        // Vehicles currently carrying probably-mislabelled work. This is the
        // exposure number the alert watches — see portalStats.
        exposed_vehicles: exposureFromClusters(likelyCanonical),
      },
    };
  },
});

/**
 * How many distinct vehicles are affected by probably-mislabelled work.
 *
 * This is the alert's metric rather than queue length, because queue length says
 * how much work is waiting while this says how much harm is accruing: each of
 * these is a driver whose health score is decaying for a service they paid for.
 *
 * Exported so portalStats and the review-queue sweep compute it identically.
 */
export function exposureFromClusters(
  clusters: Array<{ distinct_vehicles: number }>,
): number {
  return clusters.reduce((sum, c) => sum + c.distinct_vehicles, 0);
}

/**
 * Just the correctness band, for the cron and the SLO. Cheaper than
 * `patternView` because it skips medians, complaints and the shortcut scan.
 */
export async function likelyCanonicalClusters(
  ctx: any,
  now: number,
): Promise<
  Array<{
    match_key: string;
    name: string;
    occurrences: number;
    distinct_shops: number;
    distinct_vehicles: number;
    service_id: string;
    service_name: string;
    confidence: string;
  }>
> {
  const [catalog, resolved, acc] = await Promise.all([
    loadCatalog(ctx),
    resolvedAliasKeys(ctx),
    buildClusters(ctx, now),
  ]);

  const out: Array<{
    match_key: string;
    name: string;
    occurrences: number;
    distinct_shops: number;
    distinct_vehicles: number;
    service_id: string;
    service_name: string;
    confidence: string;
  }> = [];

  for (const c of acc.values()) {
    if (resolved.has(c.match_key)) continue;
    const name = dominant(c.names) ?? c.match_key;
    const verdict = matchServiceName(name, catalog);
    // Same lower bar as patternView — a human triages these.
    if (!verdict.best || verdict.confidence === "none") continue;
    out.push({
      match_key: c.match_key,
      name,
      occurrences: c.occurrences,
      distinct_shops: c.shops.size,
      distinct_vehicles: c.vins.size,
      service_id: verdict.best.serviceId,
      service_name: verdict.best.name,
      confidence: verdict.confidence,
    });
  }

  out.sort((a, b) => b.distinct_vehicles - a.distinct_vehicles);
  return out;
}

/**
 * Every custom job in one cluster, for the detail drawer. Scoped by match_key so
 * a reviewer can read the actual complaints before deciding what the thing is.
 */
export const clusterDetail = query({
  args: { token: v.string(), matchKey: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requireDirector(ctx, args.token);

    const rows = await ctx.db
      .query("custom_jobs")
      .withIndex("by_match_key", (q) => q.eq("match_key", args.matchKey))
      .collect();
    rows.sort((a, b) => b.created_at - a.created_at);

    const limited = rows.slice(0, args.limit ?? 50);
    return await Promise.all(
      limited.map(async (job) => {
        const shop = await ctx.db.get(job.shop_id);
        const config = job.vehicle_config_id
          ? await ctx.db.get(job.vehicle_config_id)
          : null;
        return {
          _id: job._id,
          name: job.name,
          shop_id: job.shop_id,
          shop_name: (shop as any)?.name ?? null,
          vehicle_vin: job.vehicle_vin,
          // Null here means the row came from a pseudo-VIN walk-in, so its
          // labor and price numbers aren't scoped to a real car.
          config_key: (config as any)?.config_key ?? null,
          system_tags: (job.system_tags ?? []) as string[],
          work_type: (job.work_type ?? null) as string | null,
          // What the work actually took. Reading a cluster without this means
          // guessing whether "carbon cleaning" is a labour job or a parts job —
          // which is most of the decision about whether to build the service.
          parts: (job.parts ?? []) as Array<{
            part_name: string;
            oem_number?: string;
            quantity: number;
            line_total_cents?: number;
          }>,
          quoted_parts_cents: job.quoted_parts_cents ?? null,
          complaint: job.complaint ?? null,
          resolution: job.resolution ?? null,
          resolved_complaint: job.resolved_complaint ?? null,
          estimated_minutes: job.estimated_minutes ?? null,
          actual_minutes: job.actual_minutes ?? null,
          charged_price_cents: job.charged_price_cents ?? null,
          from_shortcut: !!job.shop_custom_service_id,
          source: job.source,
          status: job.status,
          created_at: job.created_at,
        };
      }),
    );
  },
});

/**
 * Parts seen on a cluster's jobs, so a reviewer can see that most of the catalog
 * work is already done for them. Joined through the booking rather than stored on
 * custom_jobs — parts already live in parts_quote_snapshots and duplicating them
 * would give us two sources of truth.
 */
export const clusterParts = query({
  args: { token: v.string(), matchKey: v.string() },
  handler: async (ctx, args) => {
    await requireDirector(ctx, args.token);

    const jobs = await ctx.db
      .query("custom_jobs")
      .withIndex("by_match_key", (q) => q.eq("match_key", args.matchKey))
      .collect();

    const counts = new Map<
      string,
      { oem_number: string | null; name: string; count: number }
    >();

    for (const job of jobs) {
      const snapshots = await ctx.db
        .query("parts_quote_snapshots")
        .withIndex("by_booking", (q) => q.eq("booking_id", job.booking_id))
        .collect();
      for (const snap of snapshots) {
        // Only rows the mechanic attributed to this custom line.
        if (serviceMatchKey(snap.custom_service_name ?? "") !== args.matchKey) {
          continue;
        }
        const oem = snap.mechanic_oem_number ?? snap.catalog_oem_number ?? null;
        const label =
          snap.mechanic_part_name ?? snap.catalog_part_name ?? oem ?? "Unnamed";
        const key = oem ?? label.toLowerCase();
        const prior = counts.get(key);
        if (prior) prior.count += 1;
        else counts.set(key, { oem_number: oem, name: label, count: 1 });
      }
    }

    return Array.from(counts.values()).sort((a, b) => b.count - a.count);
  },
});
