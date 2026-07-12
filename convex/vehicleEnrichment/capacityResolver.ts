/**
 * vehicleEnrichment/capacityResolver.ts — Authoritative fluid-capacity resolver
 *
 * Guards alone left the app showing a wrong coolant capacity (16.9 qt from a
 * forum): sanity checks dropped the value but nothing re-fetched the correct
 * one. This module ACTIVELY fetches oil_capacity_qts / coolant_capacity_qts at
 * enrichment time from authoritative sources, corroborates across independent
 * domains, and writes a trustworthy value — so customers can book confidently.
 *
 * Called from _pollBatch2V3 AFTER runSanityChecks and BEFORE writeNormalizedData
 * (so its result is what gets stored). Fires on a null / just-rejected capacity
 * AND on any batch value whose sole source is not high-authority (corroboration
 * mode — the batch value is seeded as one observation and must find agreement
 * or be outranked). Synchronous Firecrawl search is used (not a batch) because
 * we need the per-source URLs to count independent corroboration.
 *
 * Accept policy (product-confirmed):
 *   - trusted:     authoritative domain OR >=2 independent non-forum domains agree.
 *   - best_effort: otherwise, store the best in-band NON-FORUM candidate, flagged
 *                  low-confidence "unverified" (unless SPECS_STRICT_CAPACITY=on).
 *   - none:        no in-band non-forum candidate → leave null+flagged so the
 *                  write path erases any stored poison (prefer no-data over wrong).
 * A forum-only value is NEVER stored.
 */

import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { FieldResult, VehicleInput } from "./types";
import { sanitizeCapacityQuarts } from "./contentSanitization";
import {
  isLowAuthorityDomain,
  isHighAuthorityDomain,
  toHostname,
} from "./validation/sourceAuthority";
import { isSyntheticEngineCode } from "./utils/engineLookup";
import {
  getCapacityBand,
  isDieselFromFields,
  type CapacityBand,
  type CapacityField,
} from "./validation/sanityChecks";
import { searchAndFetch, firecrawlJsonExtract } from "./firecrawl";

/** Max pages we run the (paid) structured extraction on, to bound cost/time. */
const MAX_EXTRACT_PAGES = 6;

const round2 = (x: number) => Math.round(x * 100) / 100;

export interface CapacityObservation {
  value_qts: number;
  source_url: string;
  domain: string;
  authoritative: boolean;
  engine_code_matches: boolean;
}

export type CapacityTier = "trusted" | "best_effort" | "none";

export interface CapacityDecision {
  field: CapacityField;
  tier: CapacityTier;
  value_qts: number | null;
  source_url: string | null;
  source_count: number; // distinct domains in the winning cluster
  authoritative: boolean;
  confidence: number | null;
  reason: string;
  observations: CapacityObservation[];
}

// ─── Pure: query construction ────────────────────────────────────

/**
 * Engine-code-pinned + authority-scoped search queries. Pinning the engine code
 * (e.g. L84) is the key lever: it disambiguates the 5.3L L84 from the 6.2L L87
 * and the HD siblings whose (wrong) figures poisoned this record.
 *
 * A synthetic/marketing code ("TFSI", "2.0l_4cyl") is worse than no code: it
 * matches every engine of the brand, steering search toward generic all-model
 * capacity tables (the exact page class that produced the A4's wrong 9.5 qt).
 * Those are dropped and displacement-only phrasing is used instead.
 */
export function buildCapacityQueries(v: VehicleInput, field: CapacityField): string[] {
  const base = `${v.year} ${v.make} ${v.model}`;
  const realCode = v.engineCode && !isSyntheticEngineCode(v.engineCode) ? v.engineCode : null;
  const eng = realCode || `${v.displacement}L`;
  const noun = field === "coolant_capacity_qts" ? "cooling system coolant capacity" : "engine oil capacity";
  const short = field === "coolant_capacity_qts" ? "coolant" : "oil";
  return [
    `${base} ${realCode ?? ""} ${v.displacement}L ${noun} quarts specification`.replace(/\s+/g, " "),
    `${base} ${eng} ${noun} liters`,
    `${eng} engine ${noun} oem specification`,
    `${base} ${eng} ${short} capacity site:alldata.com OR site:carcarekiosk.com`,
  ];
}

// ─── Pure: clustering + decision ─────────────────────────────────

/** Two capacities agree if within max(0.5 qt, 3%). Capacities are continuous, so
 *  exact-value grouping (as computeConsensus does for strings) won't cluster. */
function agree(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(0.5, 0.03 * a);
}

function clusterByTolerance(obs: CapacityObservation[]): CapacityObservation[][] {
  const clusters: CapacityObservation[][] = [];
  for (const o of [...obs].sort((a, b) => a.value_qts - b.value_qts)) {
    const c = clusters.find((cl) => agree(cl[0].value_qts, o.value_qts));
    if (c) c.push(o);
    else clusters.push([o]);
  }
  return clusters;
}

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/**
 * Decide the winning value + tier from gathered observations. Pure & unit-tested.
 * Observations are assumed already in-band and NON-forum (gather drops forums).
 */
export function decideCapacity(
  field: CapacityField,
  obs: CapacityObservation[],
  band: CapacityBand,
  opts: { strict: boolean },
): CapacityDecision {
  const inBand = obs.filter((o) => o.value_qts >= band.rejectMin && o.value_qts <= band.rejectMax);
  if (inBand.length === 0) {
    return {
      field, tier: "none", value_qts: null, source_url: null, source_count: 0,
      authoritative: false, confidence: null,
      reason: "no in-band non-forum candidate found", observations: obs,
    };
  }

  const mid = (band.typicalMin + band.typicalMax) / 2;
  const withinTypical = (v: number) => v >= band.typicalMin && v <= band.typicalMax;
  const scored = clusterByTolerance(inBand).map((c) => {
    const distinctDomains = new Set(c.map((o) => o.domain)).size;
    const hasAuthority = c.some((o) => o.authoritative);
    const med = median(c.map((o) => o.value_qts));
    return { c, distinctDomains, hasAuthority, med, typical: withinTypical(med) };
  });
  // Composite trust score — three independent signals, one point each:
  // engine-typical, contains an authoritative source, corroborated by 2+
  // distinct domains. No single signal may dominate, because each has a
  // known live failure when it does:
  //   - typicality-first let a lone in-band 13.8 (drain-and-fill figure) beat
  //     two agreeing sources at 17.4/17.6 — the TRUE total, just above the V8
  //     typical ceiling (2019 Silverado L84, stress fleet 2026-07-11);
  //   - domains-first would let two content farms echoing 16.9 beat an
  //     authoritative 13.8 (the original Sierra poison);
  //   - authority-first would let a mis-extracted 7.6 from one OEM PDF beat a
  //     multi-domain typical cluster.
  // Ties break toward more distinct domains, then closeness to the typical
  // midpoint.
  const trustScore = (c: (typeof scored)[number]) =>
    Number(c.typical) + Number(c.hasAuthority) + Number(c.distinctDomains >= 2);
  scored.sort(
    (a, b) =>
      trustScore(b) - trustScore(a) ||
      b.distinctDomains - a.distinctDomains ||
      Math.abs(a.med - mid) - Math.abs(b.med - mid),
  );
  const top = scored[0];
  const best = [...top.c].sort(
    (a, b) =>
      Number(b.authoritative) - Number(a.authoritative) ||
      Number(b.engine_code_matches) - Number(a.engine_code_matches),
  )[0];

  // Within the engine-typical band: a single authoritative source OR 2+ independent
  // domains is enough. OUTSIDE it (atypical, e.g. a legit HD/diesel ~20 qt — or a bad
  // extraction): require 2+ agreeing domains; a lone authoritative outlier is NOT
  // trusted (it's the 7.6 failure mode). Atypical values otherwise fall to best-effort.
  const trusted = top.typical
    ? top.hasAuthority || top.distinctDomains >= 2
    : top.distinctDomains >= 2;
  if (trusted) {
    const conf = top.typical ? (top.hasAuthority ? 0.9 : 0.85) : 0.8;
    return {
      field, tier: "trusted", value_qts: round2(top.med), source_url: best.source_url,
      source_count: top.distinctDomains, authoritative: top.hasAuthority,
      confidence: conf,
      reason: top.distinctDomains >= 2
        ? `${top.distinctDomains} independent sources agree${top.typical ? "" : " (atypical, corroborated)"}`
        : "authoritative source",
      observations: obs,
    };
  }

  if (opts.strict) {
    return {
      field, tier: "none", value_qts: null, source_url: null, source_count: top.distinctDomains,
      authoritative: false, confidence: null,
      reason: "strict mode: single non-authoritative source, not accepted", observations: obs,
    };
  }

  // best-effort: store the value but flag it unverified.
  return {
    field, tier: "best_effort", value_qts: round2(top.med), source_url: best.source_url,
    source_count: top.distinctDomains, authoritative: false, confidence: 0.5,
    reason: "unverified: single non-authoritative source", observations: obs,
  };
}

// ─── I/O: gather observations from the web ───────────────────────

export async function gatherCapacityObservations(
  vehicle: VehicleInput,
  field: CapacityField,
  band: CapacityBand,
  maxPages: number = MAX_EXTRACT_PAGES,
): Promise<CapacityObservation[]> {
  const queries = buildCapacityQueries(vehicle, field);
  const searchResults = await Promise.allSettled(queries.map((q) => searchAndFetch(q, 5)));

  // Dedup URLs across queries; drop blocked + low-authority (forum) hosts —
  // a forum is never authoritative and never counts toward corroboration.
  const urlToDomain = new Map<string, string>();
  for (const r of searchResults) {
    if (r.status !== "fulfilled") continue;
    for (const item of r.value) {
      if (!item.url) continue;
      if (isLowAuthorityDomain(item.url)) continue;
      const domain = toHostname(item.url);
      if (!domain) continue;
      if (!urlToDomain.has(item.url)) urlToDomain.set(item.url, domain);
    }
  }

  const pages = [...urlToDomain.entries()].slice(0, maxPages);
  if (pages.length === 0) return [];

  const noun =
    field === "coolant_capacity_qts"
      ? "cooling system TOTAL coolant/antifreeze capacity"
      : "engine oil capacity WITH filter change";
  // Same synthetic-code rule as buildCapacityQueries: pinning "TFSI" tells the
  // extractor every 2.0T/3.0T row on a brand-wide table "matches".
  const realCode =
    vehicle.engineCode && !isSyntheticEngineCode(vehicle.engineCode) ? vehicle.engineCode : null;
  const engineDesc = realCode
    ? `${realCode} ${vehicle.displacement}L`
    : `${vehicle.displacement}L`;
  const engineTie = realCode ? `${realCode} (or ${vehicle.displacement}L)` : `${vehicle.displacement}L`;
  const prompt =
    `Extract the ${noun} for the ${vehicle.year} ${vehicle.make} ${vehicle.model} ` +
    `with the ${engineDesc} engine SPECIFICALLY. ` +
    `Return the numeric value and its unit exactly as stated on the page (do not convert). ` +
    `Set engine_code_matches=true only if the page ties this capacity to the ${engineTie} ` +
    `engine. If the page does not give this exact engine's capacity, return value=null.`;
  const schema = {
    type: "object",
    properties: {
      value: { type: ["number", "null"] },
      unit: { type: ["string", "null"] },
      engine_code_matches: { type: "boolean" },
    },
    required: ["value"],
  };

  const extractions = await Promise.allSettled(
    pages.map(([url]) => firecrawlJsonExtract(url, prompt, schema)),
  );

  const obs: CapacityObservation[] = [];
  extractions.forEach((res, i) => {
    if (res.status !== "fulfilled" || !res.value) return;
    const j = res.value;
    if (j.value == null) return;
    // Convert to quarts using the page's stated unit (sanitizeCapacityQuarts
    // converts liters/ml/gal; a missing unit is treated as quarts).
    const qts = sanitizeCapacityQuarts(`${j.value} ${j.unit ?? ""}`.trim());
    if (qts == null) return;
    if (qts < band.rejectMin || qts > band.rejectMax) return;
    const [url, domain] = pages[i];
    obs.push({
      value_qts: qts,
      source_url: url,
      domain,
      authoritative: isHighAuthorityDomain(url),
      engine_code_matches: j.engine_code_matches === true,
    });
  });
  return obs;
}

// ─── Orchestrator ────────────────────────────────────────────────

interface ResolveParams {
  vehicle: VehicleInput;
  engineId: Id<"engines">;
  cylinders: number;
  fields: Record<string, FieldResult>;
  runId: Id<"enrichment_runs">;
  verifiedFields: string[];
}

const CAPACITY_FIELDS: CapacityField[] = ["coolant_capacity_qts", "oil_capacity_qts"];

/**
 * For each capacity field that is currently null (genuinely absent OR just
 * rejected by sanity checks), fetch + decide + write the result into the
 * `fields` map in place. The caller's writeNormalizedData then persists an
 * accepted value or erases a still-unresolved one via its clear-on-reject path.
 */
export async function resolveCapacities(
  ctx: { runMutation: (ref: any, args: any) => Promise<any> },
  params: ResolveParams,
): Promise<CapacityDecision[]> {
  const { vehicle, engineId, cylinders, fields, runId, verifiedFields } = params;
  const strict = process.env.SPECS_STRICT_CAPACITY === "on";
  const verified = new Set(verifiedFields);
  const decisions: CapacityDecision[] = [];

  for (const field of CAPACITY_FIELDS) {
    // Never touch a human-verified value. Work on a field that is missing, that
    // sanity checks flagged (null-and-rejected, or an out-of-typical-band value
    // the batch supplied), OR — since the A4 9.5 qt incident — any value whose
    // sole source is not a high-authority domain. An in-band wrong figure from
    // one mid-tier blog (ricksfreeautorepairadvice.com's all-Audi table) used to
    // sail straight to the DB because "in-band + unflagged" skipped resolution;
    // now only a high-authority single source earns that skip.
    if (verified.has(field)) continue;
    const current = fields[field];
    const needsResolve =
      current?.value == null ||
      current?.flagged === true ||
      !isHighAuthorityDomain(current?.source_url);
    if (!needsResolve) continue;

    const band = getCapacityBand(field, cylinders, { diesel: isDieselFromFields(fields) });
    // Corroboration mode: the batch supplied a clean in-band value from a real
    // (non-forum) URL — we only need 1-2 agreeing independent domains, so fetch
    // fewer pages. Full resolution (missing/flagged/training-data value) keeps
    // the deeper sweep.
    const batchUrl = current?.source_url ?? null;
    const seedable =
      current?.value != null &&
      current?.flagged !== true &&
      !!batchUrl &&
      !isLowAuthorityDomain(batchUrl);
    const obs = await gatherCapacityObservations(
      vehicle, field, band, seedable ? 4 : MAX_EXTRACT_PAGES,
    );

    // Seed the batch value as one observation so decideCapacity arbitrates:
    // batch + one agreeing web domain → trusted (2 independent domains); a
    // disagreeing web cluster (larger / authoritative) simply outranks it.
    if (seedable) {
      const qts = sanitizeCapacityQuarts(current!.value);
      const domain = toHostname(batchUrl!);
      if (
        qts != null &&
        qts >= band.rejectMin &&
        qts <= band.rejectMax &&
        domain &&
        !obs.some((o) => o.domain === domain)
      ) {
        obs.push({
          value_qts: qts,
          source_url: batchUrl!,
          domain,
          authoritative: false, // high-authority sources never reach this branch
          engine_code_matches: false,
        });
      }
    }

    const decision = decideCapacity(field, obs, band, { strict });
    decisions.push(decision);

    if (decision.tier === "trusted" || decision.tier === "best_effort") {
      fields[field] = {
        value: decision.value_qts,
        source_url: decision.source_url,
        source_type: "web_search",
        confidence: decision.confidence,
        flagged: decision.tier === "best_effort",
        flag_reason: decision.tier === "best_effort" ? decision.reason : null,
      };
    } else {
      // none → the resolver found nothing trustworthy. If the batch had supplied a
      // value, KEEP it but flag it for review (best available — per "show flagged
      // data" preference). If there was no value (or it was a rejected poison that
      // sanity nulled), leave it null+flagged so writeNormalizedData erases it.
      const original = fields[field];
      if (original?.value != null) {
        fields[field] = { ...original, flagged: true, flag_reason: `needs_review: ${decision.reason}` };
      } else {
        fields[field] = {
          value: null,
          source_url: null,
          source_type: original?.source_type ?? null,
          confidence: null,
          flagged: true,
          flag_reason: `needs_review: ${decision.reason}`,
        };
      }
    }

    // Persist ALL in-band observations as evidence (auditable corroboration).
    const now = Date.now();
    const rows = decision.observations.map((o) => ({
      entity_type: "engine",
      entity_id: String(engineId),
      field_name: field,
      observed_value: String(o.value_qts),
      observed_type: "number",
      source_url: o.source_url,
      source_domain: o.domain,
      source_type: "web_search",
      confidence: o.authoritative ? 0.9 : 0.7,
      enrichment_run_id: runId,
      observed_at: now,
    }));
    if (rows.length > 0) {
      await ctx.runMutation(internal.vehicleEnrichment.v3mutations.addEvidenceBatch, {
        evidence_rows: rows,
      });
    }
  }

  return decisions;
}
