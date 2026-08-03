/**
 * vehicleEnrichment/nhtsaOdi.ts — NHTSA ODI recalls + complaints (Phase 0.1).
 *
 * Free public-domain data from api.nhtsa.gov (no auth key). Two endpoints:
 *   - /recalls/recallsByVehicle?make=&model=&modelYear=
 *   - /complaints/complaintsByVehicle?make=&model=&modelYear=
 *
 * Pipeline law: FAIL OPEN. An NHTSA outage / timeout / malformed body must
 * never fail an enrichment — every fetch has a 15s abort, every error path
 * console.warns and returns null (fetch level) or empty (parse level), and
 * the actions store nothing rather than guesses. A null fetch leaves existing
 * rows untouched; only a successful fetch (including a genuine zero-result
 * response) writes.
 *
 * Storage:
 *   - vehicle_recalls: one row per (vehicle_config_id, nhtsa_campaign_number),
 *     upsert updates text fields + fetched_at, never duplicates a campaign.
 *   - config_reliability_signals: one row per config, complaint volume rolled
 *     up by normalized top-level component group.
 *
 * Wire-in points:
 *   - internal.vehicleEnrichment.nhtsaOdi.refreshOdiForConfig  (per-config)
 *   - internal.vehicleEnrichment.nhtsaOdi.refreshStaleOdi      (daily cron)
 */

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

const NHTSA_API_BASE = "https://api.nhtsa.gov";
const FETCH_TIMEOUT_MS = 15_000;
/** Re-pull a config's ODI data once its signals row is older than this. */
const ODI_STALE_AGE_DAYS = 30;
/** Gap between scheduled per-config refreshes in the stale sweep — keeps the
 *  daily batch well under any NHTSA rate limit (~1 config / 3s → 2 req / 3s). */
const STALE_SWEEP_STAGGER_MS = 3_000;

// This module is new — `internal.vehicleEnrichment.nhtsaOdi` is absent from
// _generated/api.d.ts until `npx convex dev` regenerates it. Same pattern as
// crons.ts's `(internal as any).lib.push_dispatcher`; tighten after codegen.
const selfApi = () => (internal as any).vehicleEnrichment.nhtsaOdi;

// ============================================================================
// Pure helpers (exported for tests — no ctx, no fetch)
// ============================================================================

export type NhtsaRecall = {
  nhtsa_campaign_number: string;
  component: string;
  summary: string;
  consequence: string | null;
  remedy: string | null;
  report_received_date: string | null;
};

export type ComplaintComponentRollup = {
  component: string;
  count: number;
  crash_count: number;
  fire_count: number;
  /** band label → complaint count. Bands: "0-30k" | "30k-60k" | "60k-100k"
   *  | "100k+" | "unknown". Most complaintsByVehicle rows carry no mileage,
   *  so "unknown" dominates; kept for the flat-file backfill which does. */
  odometer_band_counts: Record<string, number>;
};

export type ComplaintSummary = {
  complaint_total: number;
  complaints_by_component: ComplaintComponentRollup[];
  top_component: string | null;
};

const asString = (x: unknown): string | null =>
  typeof x === "string" && x.trim().length > 0 ? x.trim() : null;

/**
 * Normalize an ODI component string to its top-level component group.
 * ODI uses colon-delimited hierarchies — "FUEL SYSTEM, GASOLINE:DELIVERY:FUEL
 * PUMP" → "FUEL SYSTEM, GASOLINE". Collapses whitespace, uppercases, and
 * returns "UNKNOWN" for empty/absent input so rollups never key on "".
 */
export function normalizeComponentName(raw: string | null | undefined): string {
  if (typeof raw !== "string") return "UNKNOWN";
  const topLevel = raw.split(":")[0] ?? "";
  const cleaned = topLevel
    .replace(/\s+/g, " ")
    .replace(/^[\s,]+|[\s,]+$/g, "")
    .toUpperCase();
  return cleaned.length > 0 ? cleaned : "UNKNOWN";
}

/**
 * A single complaint's `components` field can carry several components joined
 * by commas WITHOUT a following space ("ELECTRICAL SYSTEM,ENGINE"), while
 * component names themselves contain comma-space ("FUEL SYSTEM, GASOLINE").
 * Split only on comma-not-followed-by-space, then normalize + dedupe.
 */
export function splitComplaintComponents(raw: string | null | undefined): string[] {
  if (typeof raw !== "string" || raw.trim().length === 0) return ["UNKNOWN"];
  const parts = raw.split(/,(?=\S)/);
  const out: string[] = [];
  for (const part of parts) {
    const norm = normalizeComponentName(part);
    if (!out.includes(norm)) out.push(norm);
  }
  return out.length > 0 ? out : ["UNKNOWN"];
}

/**
 * Parse the recallsByVehicle response body into recall records.
 * Fails open: anything that isn't the expected `{ results: [...] }` shape —
 * or any entry missing a campaign number — yields []/is skipped, never throws.
 * Response fields observed live (Jul 2026): NHTSACampaignNumber, Component,
 * Summary, Consequence, Remedy, ReportReceivedDate ("MM/DD/YYYY").
 */
export function parseRecallResponse(json: unknown): NhtsaRecall[] {
  const results = (json as { results?: unknown } | null | undefined)?.results;
  if (!Array.isArray(results)) return [];

  const out: NhtsaRecall[] = [];
  const seen = new Set<string>();
  for (const entry of results) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const campaign = asString(e.NHTSACampaignNumber);
    if (!campaign) continue; // dedup key — a recall without it is unusable
    if (seen.has(campaign)) continue;
    seen.add(campaign);
    out.push({
      nhtsa_campaign_number: campaign,
      component: asString(e.Component) ?? "UNKNOWN",
      summary: asString(e.Summary) ?? "",
      consequence: asString(e.Consequence),
      remedy: asString(e.Remedy),
      report_received_date: asString(e.ReportReceivedDate),
    });
  }
  return out;
}

/**
 * Parse the complaintsByVehicle response body into its raw results array.
 * Fails open to [] on any non-conforming shape. Entries are left raw —
 * summarizeComplaintsByComponent does the per-entry validation.
 */
export function parseComplaintResponse(json: unknown): unknown[] {
  const results = (json as { results?: unknown } | null | undefined)?.results;
  return Array.isArray(results) ? results : [];
}

const flagIsSet = (x: unknown): boolean => x === true || x === "Yes" || x === "Y";

function odometerBand(miles: unknown): string {
  const n = typeof miles === "number" && Number.isFinite(miles) && miles >= 0 ? miles : null;
  if (n === null) return "unknown";
  if (n < 30_000) return "0-30k";
  if (n < 60_000) return "30k-60k";
  if (n < 100_000) return "60k-100k";
  return "100k+";
}

/**
 * Roll complaint results up by normalized component group.
 * complaint_total counts COMPLAINTS (valid entries), while a multi-component
 * complaint increments each of its groups once — so component counts can sum
 * to more than complaint_total. Sorted count-desc then name-asc so
 * top_component (and the stored array order) is deterministic.
 * Fails open: non-object entries are skipped; no input ever throws.
 */
export function summarizeComplaintsByComponent(results: unknown[]): ComplaintSummary {
  const byComponent = new Map<string, ComplaintComponentRollup>();
  let complaintTotal = 0;

  const list = Array.isArray(results) ? results : [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    complaintTotal++;

    const crash = flagIsSet(e.crash);
    const fire = flagIsSet(e.fire);
    const band = odometerBand(e.miles);

    for (const component of splitComplaintComponents(e.components as string | undefined)) {
      let rollup = byComponent.get(component);
      if (!rollup) {
        rollup = { component, count: 0, crash_count: 0, fire_count: 0, odometer_band_counts: {} };
        byComponent.set(component, rollup);
      }
      rollup.count++;
      if (crash) rollup.crash_count++;
      if (fire) rollup.fire_count++;
      rollup.odometer_band_counts[band] = (rollup.odometer_band_counts[band] ?? 0) + 1;
    }
  }

  const complaints_by_component = [...byComponent.values()].sort(
    (a, b) => b.count - a.count || a.component.localeCompare(b.component),
  );
  return {
    complaint_total: complaintTotal,
    complaints_by_component,
    top_component: complaints_by_component[0]?.component ?? null,
  };
}

// ============================================================================
// Fetch layer — 15s abort, fail open to null on ANY error
// ============================================================================

/**
 * Shared GET → parsed-JSON with the fail-open discipline. Returns the parsed
 * body only when it is the expected `{ results: [...] }` shape; null otherwise
 * (so callers can distinguish "API said zero results" — a valid [] — from
 * "we don't know" — null — and store nothing in the latter case).
 */
async function fetchOdiJson(url: string, label: string): Promise<unknown | null> {
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.warn(`[nhtsa-odi] ${label} HTTP ${response.status} for ${url}`);
      return null;
    }
    const data: unknown = await response.json();
    if (!Array.isArray((data as { results?: unknown } | null)?.results)) {
      console.warn(`[nhtsa-odi] ${label} malformed body (no results array) for ${url}`);
      return null;
    }
    return data;
  } catch (e) {
    // Covers abort/timeout, DNS, TLS, and JSON parse errors alike.
    console.warn(`[nhtsa-odi] ${label} fetch failed for ${url}:`, e);
    return null;
  }
}

/** Recalls for one YMM. null = fetch failed (store nothing); [] = genuinely none. */
export async function fetchRecallsForVehicle(
  make: string,
  model: string,
  year: number,
): Promise<NhtsaRecall[] | null> {
  const url =
    `${NHTSA_API_BASE}/recalls/recallsByVehicle` +
    `?make=${encodeURIComponent(make)}&model=${encodeURIComponent(model)}&modelYear=${encodeURIComponent(String(year))}`;
  const data = await fetchOdiJson(url, "recalls");
  return data === null ? null : parseRecallResponse(data);
}

/** Complaints for one YMM. null = fetch failed; [] = genuinely none. */
export async function fetchComplaintsForVehicle(
  make: string,
  model: string,
  year: number,
): Promise<unknown[] | null> {
  const url =
    `${NHTSA_API_BASE}/complaints/complaintsByVehicle` +
    `?make=${encodeURIComponent(make)}&model=${encodeURIComponent(model)}&modelYear=${encodeURIComponent(String(year))}`;
  const data = await fetchOdiJson(url, "complaints");
  return data === null ? null : parseComplaintResponse(data);
}

// ============================================================================
// Mutations (idempotent upserts)
// ============================================================================

/**
 * Upsert recall rows for one config, keyed on (vehicle_config_id,
 * nhtsa_campaign_number). Existing campaigns get their text fields +
 * fetched_at refreshed; new campaigns insert. Never duplicates. Rows for
 * campaigns absent from this fetch are left alone (NHTSA recalls only grow;
 * a transiently-short response must not delete history).
 */
export const upsertRecallsForConfig = internalMutation({
  args: {
    vehicle_config_id: v.id("vehicle_configs"),
    recalls: v.array(
      v.object({
        nhtsa_campaign_number: v.string(),
        component: v.string(),
        summary: v.string(),
        consequence: v.optional(v.string()),
        remedy: v.optional(v.string()),
        report_received_date: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    // Bounded read: recalls per config are a few dozen at most.
    const existing = await ctx.db
      .query("vehicle_recalls")
      .withIndex("by_config", (q) => q.eq("vehicle_config_id", args.vehicle_config_id))
      .collect();
    const byCampaign = new Map(existing.map((r) => [r.nhtsa_campaign_number, r]));

    let inserted = 0;
    let updated = 0;
    const seen = new Set<string>();
    for (const recall of args.recalls) {
      if (seen.has(recall.nhtsa_campaign_number)) continue;
      seen.add(recall.nhtsa_campaign_number);

      const row = byCampaign.get(recall.nhtsa_campaign_number);
      if (row) {
        await ctx.db.patch(row._id, {
          component: recall.component,
          summary: recall.summary,
          consequence: recall.consequence,
          remedy: recall.remedy,
          report_received_date: recall.report_received_date,
          fetched_at: now,
        });
        updated++;
      } else {
        await ctx.db.insert("vehicle_recalls", {
          vehicle_config_id: args.vehicle_config_id,
          nhtsa_campaign_number: recall.nhtsa_campaign_number,
          component: recall.component,
          summary: recall.summary,
          consequence: recall.consequence,
          remedy: recall.remedy,
          report_received_date: recall.report_received_date,
          source: "nhtsa" as const,
          fetched_at: now,
        });
        inserted++;
      }
    }
    return { inserted, updated };
  },
});

/** Upsert the single reliability-signals row for a config. */
export const upsertReliabilitySignals = internalMutation({
  args: {
    vehicle_config_id: v.id("vehicle_configs"),
    complaint_total: v.float64(),
    complaints_by_component: v.array(
      v.object({
        component: v.string(),
        count: v.float64(),
        crash_count: v.float64(),
        fire_count: v.float64(),
      }),
    ),
    top_component: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("config_reliability_signals")
      .withIndex("by_config", (q) => q.eq("vehicle_config_id", args.vehicle_config_id))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        complaint_total: args.complaint_total,
        complaints_by_component: args.complaints_by_component,
        top_component: args.top_component,
        fetched_at: now,
      });
      return existing._id;
    }
    return await ctx.db.insert("config_reliability_signals", {
      vehicle_config_id: args.vehicle_config_id,
      complaint_total: args.complaint_total,
      complaints_by_component: args.complaints_by_component,
      top_component: args.top_component,
      fetched_at: now,
      source: "nhtsa_odi" as const,
    });
  },
});

// ============================================================================
// Queries
// ============================================================================

/**
 * Oldest-first page of stale signals rows (fetched_at < cutoff). Index-ordered
 * (by_fetched_at ascends) + .take(limit) — no unbounded .collect(). Configs
 * with NO signals row yet are invisible here by design: fresh configs get
 * their first pull from the in-run enrichment hook, not the stale sweep.
 */
export const staleOdiSignalsPage = internalQuery({
  args: { cutoff: v.float64(), limit: v.float64() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("config_reliability_signals")
      .withIndex("by_fetched_at", (q) => q.lt("fetched_at", args.cutoff))
      .take(Math.max(1, Math.min(500, Math.floor(args.limit))));
    return rows.map((r) => ({
      vehicle_config_id: r.vehicle_config_id,
      fetched_at: r.fetched_at,
    }));
  },
});

// ============================================================================
// Actions
// ============================================================================

type RefreshOdiResult = {
  ok: boolean;
  recallsFetched: number | null; // null = recalls fetch failed (nothing stored)
  complaintTotal: number | null; // null = complaints fetch failed (nothing stored)
  skippedReason?: string;
};

/**
 * Fetch + store both ODI datasets for one config. Idempotent (pure upserts).
 * Fail open end to end: an unresolvable config or a dead API logs a warn and
 * returns — this action NEVER throws, so it is safe to await from inside an
 * enrichment run without risking the run.
 */
export const refreshOdiForConfig = internalAction({
  args: { vehicleConfigId: v.id("vehicle_configs") },
  handler: async (ctx, args): Promise<RefreshOdiResult> => {
    const result: RefreshOdiResult = { ok: false, recallsFetched: null, complaintTotal: null };
    try {
      // Same YMM resolution the pipeline uses (make/model names via ctx.db.get
      // on make_id/model_id inside the query).
      const labels: { year: number; make: string; model: string } | null = await ctx.runQuery(
        internal.vehicleEnrichment.v3queries.getVehicleLabels,
        { vehicleConfigId: args.vehicleConfigId },
      );
      if (!labels || !labels.make || !labels.model || !labels.year) {
        console.warn(
          `[nhtsa-odi] config ${args.vehicleConfigId} unresolvable (labels=${JSON.stringify(labels)}) — skipping`,
        );
        result.skippedReason = "unresolvable_config";
        return result;
      }
      const { year, make, model } = labels;

      // ── Recalls ──────────────────────────────────────────────────────
      const recalls = await fetchRecallsForVehicle(make, model, year);
      if (recalls !== null) {
        try {
          await ctx.runMutation(selfApi().upsertRecallsForConfig, {
            vehicle_config_id: args.vehicleConfigId,
            recalls: recalls.map((r) => ({
              nhtsa_campaign_number: r.nhtsa_campaign_number,
              component: r.component,
              summary: r.summary,
              consequence: r.consequence ?? undefined,
              remedy: r.remedy ?? undefined,
              report_received_date: r.report_received_date ?? undefined,
            })),
          });
          result.recallsFetched = recalls.length;
        } catch (e) {
          console.warn(`[nhtsa-odi] recall upsert failed for ${args.vehicleConfigId}:`, e);
        }
      }

      // ── Complaints → reliability signals ─────────────────────────────
      // A failed complaints fetch stores nothing (no zero-guess row) — the
      // existing signals row, if any, keeps its old fetched_at so the stale
      // sweep naturally retries it next run.
      const complaints = await fetchComplaintsForVehicle(make, model, year);
      if (complaints !== null) {
        const summary = summarizeComplaintsByComponent(complaints);
        try {
          await ctx.runMutation(selfApi().upsertReliabilitySignals, {
            vehicle_config_id: args.vehicleConfigId,
            complaint_total: summary.complaint_total,
            complaints_by_component: summary.complaints_by_component.map((c) => ({
              component: c.component,
              count: c.count,
              crash_count: c.crash_count,
              fire_count: c.fire_count,
            })),
            top_component: summary.top_component ?? undefined,
          });
          result.complaintTotal = summary.complaint_total;
        } catch (e) {
          console.warn(`[nhtsa-odi] signals upsert failed for ${args.vehicleConfigId}:`, e);
        }
      }

      result.ok = result.recallsFetched !== null || result.complaintTotal !== null;
      console.log(
        `[nhtsa-odi] ${year} ${make} ${model}: ` +
          `recalls=${result.recallsFetched ?? "FAILED"}, complaints=${result.complaintTotal ?? "FAILED"}`,
      );
      return result;
    } catch (e) {
      // Belt-and-braces: nothing above should throw, but the pipeline law says
      // this action never does.
      console.warn(`[nhtsa-odi] refreshOdiForConfig failed for ${args.vehicleConfigId}:`, e);
      return result;
    }
  },
});

/**
 * Daily sweep: re-pull configs whose signals row is older than 30 days,
 * oldest first. Each config runs as its own scheduled refreshOdiForConfig
 * (staggered) so one slow/failing config can't eat the sweep's action budget
 * and NHTSA sees a gentle request rate.
 */
export const refreshStaleOdi = internalAction({
  args: { limit: v.optional(v.float64()) },
  handler: async (ctx, args): Promise<{ scheduled: number }> => {
    try {
      const limit = args.limit ?? 50;
      const cutoff = Date.now() - ODI_STALE_AGE_DAYS * 24 * 60 * 60 * 1000;
      const stale: Array<{ vehicle_config_id: Id<"vehicle_configs">; fetched_at: number }> =
        await ctx.runQuery(selfApi().staleOdiSignalsPage, { cutoff, limit });

      for (let i = 0; i < stale.length; i++) {
        await ctx.scheduler.runAfter(i * STALE_SWEEP_STAGGER_MS, selfApi().refreshOdiForConfig, {
          vehicleConfigId: stale[i].vehicle_config_id,
        });
      }
      console.log(
        `[nhtsa-odi] stale sweep: ${stale.length} config(s) scheduled (limit ${limit}, age > ${ODI_STALE_AGE_DAYS}d)`,
      );
      return { scheduled: stale.length };
    } catch (e) {
      console.warn("[nhtsa-odi] refreshStaleOdi failed:", e);
      return { scheduled: 0 };
    }
  },
});
