/**
 * vehicleEnrichment/lemonLabor.ts — LEMON Manuals LABOR-TIME source
 *
 * Sibling to lemonManuals.ts (which does Vehicle Specs). LEMON publishes a
 * per-trim "Labor Times" section: a flat index of ~400 operations, each a leaf
 * page with a MOTOR-style table (Applies To | Note | Standard Hours | Warranty
 * Hours | Skill Level). This module resolves the trim (shared resolver), maps a
 * requested service to its operation leaf via curated rules grounded in the real
 * op names, reads the Standard Hours, and returns a {serviceSlug: hours} map —
 * the exact shape laborResearch.ts's mergeLaborSources() consumes. It plugs in
 * as a new weighted labor source alongside OLP / web / Estimator.
 *
 * PROVENANCE: LEMON is a low-trust mirror. Its labor times ARE factory
 * (MOTOR-grade) "Standard Hours", so the source weight is meaningful, but it
 * never claims OEM identity — it is one weighted voice the median reconciles.
 *
 * PIPELINE LAW: fail open. Every network path returns an empty map, never throws.
 */

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import {
  resolveLemonVehicle,
  lemonFetch,
  extractLeafHrefs,
  hrefTail,
  resolveLeafUrl,
  encodeLemonSegment,
  type LemonFetchArgs,
} from "./lemonManuals";

const LABOR_INDEX_TIMEOUT_MS = 40_000;
const LABOR_LEAF_TIMEOUT_MS = 20_000;
/** Cap on leaf fetches per vehicle — each requested service costs at most one. */
export const MAX_LEMON_LABOR_LEAVES = 20;

export type LemonLaborRule = {
  /** EXACT canonical service slug — the key laborAllSources actually passes. */
  slug: string;
  /** Disambiguator for the one slug that covers two service names. */
  nameTest?: RegExp;
  /** Operation "Component / Action" tails, most-preferred first. */
  ops: readonly RegExp[];
  /** Row preferences against the leaf's "Applies To" cells, tried BEFORE the
   *  axle preferences derived from the service name. For leaves whose variant
   *  axis isn't an axle — the wiper leaf rows are Arm/Blade × Both/One, and the
   *  bookable service is specifically blades-both. */
  rows?: readonly RegExp[];
  label: string;
};

/**
 * Canonical service slug → LEMON labor-operation rules.
 *
 * KEYED ON SLUG, NOT ON A LOOSE NAME REGEX. The previous table matched a regex
 * against "slug name" and was written against invented slugs (`brake_rotor`,
 * `water_pump`, `alternator`), none of which the pipeline emits. The real keys
 * come from SERVICE_NAME_TO_SLUG (v3pipeline.ts) and tests/lemonLabor.test.ts
 * asserts every `slug` below is one of them. Two concrete bugs that killed:
 *   - `rotor_replacement`'s NAME is "Brake Pad + Rotor Replacement - Front", so
 *     the loose /brake[\s_-]?pad/ rule won it and routed rotors to the pad op.
 *   - `alternator`/`starter`/`water_pump`/`thermostat` are not bookable
 *     services, so four of the twelve rules could never fire at all.
 *
 * Every `ops` regex is anchored and grounded in labor indexes verified live on
 * 2021 Honda CR-V, 2021 Honda Odyssey, and 2020 BMW 330i — MOTOR's vocabulary
 * is consistent across makes. Anchoring is what excludes the near-misses:
 * "Disc Rotor (On Vehicle) / Refinish", "Serpentine Belt TENSIONER /…",
 * "Battery / Testing", "Battery Cable /…".
 *
 * Deliberately UNMAPPED catalog slugs (no honest LEMON equivalent; no hours
 * beats wrong hours): oil_change (MOTOR publishes no drain-and-refill op — the
 * nearest, "Engine Oil Filter / Remove & Replace", is a different operation),
 * power_steering_flush, tire_rotation, wheel_alignment, fuel_system_cleaning,
 * ac_recharge ("A/C Refrigerant / Recover" is recovery only),
 * engine_intake_cleaning, multi_point_inspection.
 */
export const LEMON_LABOR_RULES: readonly LemonLaborRule[] = [
  { slug: "spark_plugs", ops: [/^spark plugs? \/ remove & replace$/i], label: "spark_plugs" },
  // One slug, two service names — cabin first so the engine rule gets the rest.
  { slug: "filter_replacement", nameTest: /cabin/i, ops: [/^cabin air filter \/ remove & replace$/i], label: "cabin_air_filter" },
  { slug: "filter_replacement", ops: [/^air cleaner element \/ remove & replace$/i], label: "engine_air_filter" },
  { slug: "brake_pad_replacement", ops: [/^brake shoes &\/or pads \/ remove & replace$/i], label: "brake_pads" },
  { slug: "rotor_replacement", ops: [/^disc rotor \/ remove & replace$/i], label: "brake_rotor" },
  { slug: "brake_fluid_flush", ops: [/^brake system \/ bleed$/i], label: "brake_fluid" },
  { slug: "coolant_flush", ops: [/^cooling system \/ flush$/i, /^cooling system \/ drain & refill$/i], label: "coolant" },
  { slug: "transmission_service", ops: [/^automatic transmission fluid \/ drain & refill$/i], label: "transmission_fluid" },
  { slug: "differential_service", ops: [/^differential fluid \/ drain & refill$/i], label: "differential_fluid" },
  { slug: "transfer_case_service", ops: [/^transfer case fluid \/ drain & refill$/i], label: "transfer_case_fluid" },
  { slug: "serpentine_belt", ops: [/^serpentine drive belt \/ remove & replace$/i], label: "serpentine_belt" },
  { slug: "timing_belt", ops: [/^timing belt \/ remove & replace$/i, /^timing chain \/ remove & replace$/i], label: "timing_belt" },
  { slug: "battery_replacement", ops: [/^battery \/ remove & replace$/i], label: "battery" },
  { slug: "wheel_bearing_replacement", ops: [/^wheel bearing \/ remove & replace$/i], label: "wheel_bearing" },
  // The wiper leaf's rows are Arm/Blade × Both/One — and its FIRST row is
  // "Arm,Both" (0.4 h), which is a different job than replacing the blades
  // (0.3 h). The row preference targets the variant the service actually books.
  { slug: "wiper_blade_replacement", ops: [/^wiper arm &\/or blades \/ remove & replace$/i], rows: [/blade[^|]*\bboth\b/i], label: "wiper_blades" },
];

/** The rule for a service, or null. Slug is exact; nameTest disambiguates. */
export function matchLemonLaborRule(svc: { slug: string; name: string }): LemonLaborRule | null {
  return (
    LEMON_LABOR_RULES.find((r) => r.slug === svc.slug && (!r.nameTest || r.nameTest.test(svc.name))) ?? null
  );
}

/**
 * Row preferences implied by a service NAME.
 *
 * The catalog books brakes per axle ("Brake Pad Replacement - Front"), and so
 * does MOTOR — but its FIRST row is the whole-car variant. On a 2021 CR-V the
 * pad table reads: "All,Both Axles 1.8" / "Front,Both Sides 1.0" / "Rear,Both
 * Sides 1.0". Taking the first row billed a front pad job at 1.8 h instead of
 * 1.0. Prefer the axle the service names, and within it the both-sides row (a
 * per-axle job is both sides; "One Side" is the half job).
 */
export function axlePreferences(name: string): RegExp[] {
  if (/\bfront\b/i.test(name)) return [/front[^|]*\bboth\b/i, /\bfront\b/i];
  if (/\brear\b/i.test(name)) return [/rear[^|]*\bboth\b/i, /\brear\b/i];
  return [];
}

type LaborRow = { applies: string; hours: number };

/**
 * Parse the "Standard Hours" value from a labor leaf's table.
 *
 * Table shape: header row + one-or-more data rows, columns "Applies To | Note |
 * Standard Hours | Warranty Hours | Skill Level".
 *
 * Row selection, in order:
 *   1. Stop at the first "Combination Procedure:" separator — everything after
 *      it is an ADD-ON operation (bleed, caliper overhaul, EPB disable), not the
 *      base job, and must never be mistaken for it.
 *   2. If the caller supplies preferences (axle, etc.), the first row matching
 *      the first matching preference wins.
 *   3. Otherwise: one distinct value → use it; SEVERAL different values and
 *      nothing to choose between them → null. An arbitrary pick out of a
 *      variant table is exactly the wrong-number-at-weight-0.7 case.
 *
 * Returns null when absent or ambiguous. Never throws.
 */
export function parseLaborLeafHours(html: string, prefs: readonly RegExp[] = []): number | null {
  const start = html.indexOf('<div class="main">');
  let body = start >= 0 ? html.slice(start) : html;
  const cut = body.search(/<div class="theme-colors footer"|<div class="other-warning/i);
  if (cut >= 0) body = body.slice(0, cut);

  const rows: string[][] = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let tr: RegExpExecArray | null;
  while ((tr = trRe.exec(body)) !== null) {
    const cells: string[] = [];
    const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let c: RegExpExecArray | null;
    while ((c = cellRe.exec(tr[1])) !== null) {
      cells.push(
        c[1]
          .replace(/<[^>]*>/g, " ")
          .replace(/&nbsp;/g, " ")
          .replace(/&amp;/g, "&")
          .replace(/\s+/g, " ")
          .trim(),
      );
    }
    if (cells.length > 0) rows.push(cells);
  }
  if (rows.length < 2) return null;

  const header = rows[0].map((h) => h.toLowerCase());
  let idx = header.findIndex((h) => /standard\s*hours/.test(h));
  if (idx < 0) idx = header.findIndex((h) => /\bhours\b/.test(h)); // fallback
  if (idx < 0) return null;

  const candidates: LaborRow[] = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    // A combination-procedure separator ends the base-operation rows.
    if (cells.some((c) => /^combination procedure:/i.test(c))) break;
    const raw = cells[idx];
    if (!raw) continue;
    const n = parseFloat(raw.replace(/[^0-9.]/g, ""));
    if (!Number.isFinite(n) || n <= 0) continue;
    candidates.push({ applies: cells[0] ?? "", hours: Math.round(n * 100) / 100 });
  }
  if (candidates.length === 0) return null;

  for (const pref of prefs) {
    const hit = candidates.find((c) => pref.test(c.applies));
    if (hit) return hit.hours;
  }

  const distinct = new Set(candidates.map((c) => c.hours));
  return distinct.size === 1 ? candidates[0].hours : null;
}

export type LemonLaborResult = {
  ok: boolean;
  reason: string;
  host: string | null;
  resolved_trim: string | null;
  /** serviceSlug → Standard Hours (the merge-ready map). */
  hours: Record<string, number>;
  matched: Array<{ slug: string; op: string; hours: number; url: string }>;
  attempted: number;
};

/**
 * Resolve → labor index → per-service op match → read Standard Hours.
 * Returns a {slug: hours} map ready for mergeLaborSources. Fail-open.
 */
export async function fetchLemonLaborHours(
  args: LemonFetchArgs & { services: ReadonlyArray<{ slug: string; name: string }> },
): Promise<LemonLaborResult> {
  const fail = (reason: string, extra: Partial<LemonLaborResult> = {}): LemonLaborResult => ({
    ok: false,
    reason,
    host: null,
    resolved_trim: null,
    hours: {},
    matched: [],
    attempted: 0,
    ...extra,
  });

  const resolved = await resolveLemonVehicle(args);
  if (!resolved) return fail("unresolved");

  const laborIndexUrl = resolved.trimBaseUrl + `${encodeLemonSegment("Labor Times")}/`;
  const idx = await lemonFetch(laborIndexUrl, LABOR_INDEX_TIMEOUT_MS);
  if (!idx.ok || idx.body.length === 0) {
    return fail("labor_index_unreachable", { host: resolved.host, resolved_trim: resolved.trim });
  }

  // Every operation's "component / action" tail, once. hrefTail splits the RAW
  // href before decoding — folder names like "Brake Shoes &/Or Pads" and "A/C
  // Compressor Drive Belt" contain an encoded slash, and decoding first split
  // them into two segments and produced a wrong tail.
  const ops: Array<{ href: string; tail: string }> = [];
  for (const href of extractLeafHrefs(idx.body)) {
    const tail = hrefTail(href);
    if (tail) ops.push({ href, tail });
  }

  const hours: Record<string, number> = {};
  const matched: LemonLaborResult["matched"] = [];
  const usedOp = new Set<string>();
  let attempted = 0;

  for (const svc of args.services) {
    if (attempted >= MAX_LEMON_LABOR_LEAVES) break;
    // One hours value per SLUG, first match wins. "Air Filter Replacement" and
    // "Cabin Air Filter Replacement" both collapse to `filter_replacement`, so
    // they resolve to the same services row and can only carry one
    // labor_observations value — taking the first is the honest behaviour, not
    // a silent overwrite.
    if (hours[svc.slug] != null) continue;
    const rule = matchLemonLaborRule(svc);
    if (!rule) continue;
    // Walk the rule's op preferences in order, skipping ops already consumed by
    // an earlier service, so a taken first choice falls through to the next.
    const op = rule.ops.reduce<{ href: string; tail: string } | undefined>(
      (found, rx) => found ?? ops.find((o) => rx.test(o.tail) && !usedOp.has(o.href)),
      undefined,
    );
    if (!op) continue;
    usedOp.add(op.href);
    attempted++;
    // resolveLeafUrl normalises parens to LEMON's canonical %28 form — a trim
    // folder containing parens would otherwise cost a 308 on every leaf.
    const url = resolveLeafUrl(laborIndexUrl, op.href);
    if (!url) continue;
    const leaf = await lemonFetch(url, LABOR_LEAF_TIMEOUT_MS);
    if (!leaf.ok || leaf.body.length === 0) continue;
    const h = parseLaborLeafHours(leaf.body, [...(rule.rows ?? []), ...axlePreferences(svc.name)]);
    if (h == null) continue;
    hours[svc.slug] = h;
    matched.push({ slug: svc.slug, op: op.tail, hours: h, url });
  }

  const got = Object.keys(hours).length;
  return {
    ok: got > 0,
    reason: got > 0 ? "ok" : "no_matches",
    host: resolved.host,
    resolved_trim: resolved.trim,
    hours,
    matched,
    attempted,
  };
}

/**
 * The preview action's service set.
 *
 * These are REAL (slug, name) pairs straight out of SERVICE_NAME_TO_SLUG — the
 * previous set was invented, which is precisely why a preview could report 9/10
 * while production matched almost nothing. A preview that doesn't speak the
 * pipeline's vocabulary isn't proof of anything.
 */
export const DEFAULT_PREVIEW_SERVICES: ReadonlyArray<{ slug: string; name: string }> = [
  { slug: "spark_plugs", name: "Spark Plug Replacement" },
  { slug: "filter_replacement", name: "Cabin Air Filter Replacement" },
  { slug: "filter_replacement", name: "Air Filter Replacement" },
  { slug: "brake_pad_replacement", name: "Brake Pad Replacement - Front" },
  { slug: "rotor_replacement", name: "Brake Pad + Rotor Replacement - Front" },
  { slug: "brake_fluid_flush", name: "Brake Fluid Flush" },
  { slug: "coolant_flush", name: "Coolant Flush" },
  { slug: "transmission_service", name: "Transmission Fluid Service" },
  { slug: "differential_service", name: "Differential Fluid Service" },
  { slug: "transfer_case_service", name: "Transfer Case Fluid Service" },
  { slug: "serpentine_belt", name: "Serpentine Belt Replacement" },
  { slug: "timing_belt", name: "Timing Belt/Chain Service" },
  { slug: "battery_replacement", name: "Battery Replacement" },
  { slug: "wheel_bearing_replacement", name: "Wheel Bearing Replacement" },
  { slug: "wiper_blade_replacement", name: "Wiper Blade Replacement (set)" },
];

/**
 * Preview action — run from `npx convex run` to inspect the labor hours LEMON
 * yields for a vehicle. Writes nothing. Pass `services` or use the default set.
 */
export const previewLemonLabor = internalAction({
  args: {
    make: v.string(),
    model: v.string(),
    year: v.float64(),
    trim: v.optional(v.string()),
    drivetrain: v.optional(v.string()),
    displacement_l: v.optional(v.float64()),
    services: v.optional(v.array(v.object({ slug: v.string(), name: v.string() }))),
  },
  handler: async (_ctx, args): Promise<LemonLaborResult> =>
    fetchLemonLaborHours({
      make: args.make,
      model: args.model,
      year: args.year,
      trim: args.trim ?? null,
      drivetrain: args.drivetrain ?? null,
      displacement_l: args.displacement_l ?? null,
      services: args.services ?? DEFAULT_PREVIEW_SERVICES,
    }),
});

/**
 * Config-shaped resolver for laborAllSources — mirrors the OLP/web resolvers'
 * contract: `{ resolved, services: {slug: hours} }`. Fail-open.
 */
export const resolveLemonLaborForConfig = internalAction({
  args: {
    make: v.string(),
    model: v.string(),
    year: v.number(),
    trim: v.optional(v.string()),
    drivetrain: v.optional(v.union(v.string(), v.null())),
    displacementL: v.optional(v.union(v.number(), v.null())),
    services: v.array(v.object({ slug: v.string(), name: v.string() })),
  },
  handler: async (
    _ctx,
    args,
  ): Promise<{ resolved: boolean; services: Record<string, number>; matched: number }> => {
    const r = await fetchLemonLaborHours({
      make: args.make,
      model: args.model,
      year: args.year,
      trim: args.trim ?? null,
      drivetrain: args.drivetrain ?? null,
      displacement_l: args.displacementL ?? null,
      services: args.services,
    });
    return { resolved: r.ok, services: r.hours, matched: r.matched.length };
  },
});
