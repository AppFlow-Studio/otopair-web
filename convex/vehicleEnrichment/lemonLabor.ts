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
  safeDecode,
  type LemonFetchArgs,
} from "./lemonManuals";

const LABOR_INDEX_TIMEOUT_MS = 40_000;
const LABOR_LEAF_TIMEOUT_MS = 20_000;
/** Cap on leaf fetches per vehicle — each requested service costs at most one. */
export const MAX_LEMON_LABOR_LEAVES = 20;

/**
 * Curated service → LEMON labor-operation rules.
 *
 * `test` matches the pipeline's service (we test against "slug name"); `op`
 * matches the operation's decoded "Component / Action" tail. The op regexes are
 * grounded in the REAL MOTOR-style names verified on the 2021 CR-V labor index
 * (e.g. engine air filter is "Air Cleaner Element", a rotor R&R is "Disc Rotor /
 * Remove & Replace" — distinct from the "/ Refinish" variant). Order matters:
 * the FIRST rule whose `test` matches wins, so put specific before generic
 * (cabin filter before the generic air filter).
 */
export const LEMON_LABOR_RULES: ReadonlyArray<{ test: RegExp; op: RegExp; label: string }> = [
  { test: /spark[\s_-]?plug/i, op: /^spark plugs? \/ remove & replace$/i, label: "spark_plugs" },
  { test: /cabin/i, op: /^cabin air filter \/ remove & replace$/i, label: "cabin_air_filter" },
  { test: /air[\s_-]?(filter|cleaner)/i, op: /^air cleaner element \/ remove & replace$/i, label: "engine_air_filter" },
  { test: /battery/i, op: /^battery \/ remove & replace$/i, label: "battery" },
  { test: /alternator/i, op: /^alternator(?: assembly)? \/ remove & replace$/i, label: "alternator" },
  { test: /starter/i, op: /^starter assembly \/ remove & replace$/i, label: "starter" },
  { test: /water[\s_-]?pump/i, op: /^water pump \/ remove & replace$/i, label: "water_pump" },
  { test: /thermostat/i, op: /^thermostat(?: housing)? \/ remove & replace$/i, label: "thermostat" },
  { test: /(serpentine|accessory|drive)[\s_-]?belt/i, op: /^(?:serpentine belt|accessory drive belt|drive belt) \/ remove & replace$/i, label: "serpentine_belt" },
  { test: /brake[\s_-]?pad/i, op: /^disc brake pads? \/ remove & replace$/i, label: "brake_pads" },
  { test: /rotor|\bdisc\b/i, op: /^disc rotor \/ remove & replace$/i, label: "brake_rotor" },
  { test: /transmission[\s_-]?fluid|trans[\s_-]?fluid/i, op: /^automatic transmission fluid \/ drain & refill$/i, label: "transmission_fluid" },
];

/**
 * Parse the "Standard Hours" value from a labor leaf's table.
 *
 * Table shape: header row + one-or-more data rows, columns "Applies To | Note |
 * Standard Hours | Warranty Hours | Skill Level". Finds the Standard-Hours
 * column by header text and returns the first positive value. Returns null if
 * absent (fail-closed: no hours beats a wrong number). Never throws.
 */
export function parseLaborLeafHours(html: string): number | null {
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

  for (let r = 1; r < rows.length; r++) {
    const raw = rows[r][idx];
    if (!raw) continue;
    const n = parseFloat(raw.replace(/[^0-9.]/g, ""));
    if (Number.isFinite(n) && n > 0) return Math.round(n * 100) / 100;
  }
  return null;
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

  const laborIndexUrl = resolved.trimBaseUrl + `${encodeURIComponent("Labor Times")}/`;
  const idx = await lemonFetch(laborIndexUrl, LABOR_INDEX_TIMEOUT_MS);
  if (!idx.ok || idx.body.length === 0) {
    return fail("labor_index_unreachable", { host: resolved.host, resolved_trim: resolved.trim });
  }

  // Every operation's decoded "component / action" tail, once.
  const ops: Array<{ href: string; tail: string }> = [];
  for (const href of extractLeafHrefs(idx.body)) {
    const segs = safeDecode(href).split("/").filter(Boolean);
    if (segs.length < 2) continue;
    ops.push({ href, tail: `${segs[segs.length - 2]} / ${segs[segs.length - 1]}` });
  }

  const hours: Record<string, number> = {};
  const matched: LemonLaborResult["matched"] = [];
  const usedOp = new Set<string>();
  let attempted = 0;

  for (const svc of args.services) {
    if (attempted >= MAX_LEMON_LABOR_LEAVES) break;
    if (hours[svc.slug] != null) continue;
    const rule = LEMON_LABOR_RULES.find((r) => r.test.test(`${svc.slug} ${svc.name}`));
    if (!rule) continue;
    const op = ops.find((o) => rule.op.test(o.tail));
    if (!op || usedOp.has(op.href)) continue;
    usedOp.add(op.href);
    attempted++;
    const url = new URL(op.href, laborIndexUrl).toString();
    const leaf = await lemonFetch(url, LABOR_LEAF_TIMEOUT_MS);
    if (!leaf.ok || leaf.body.length === 0) continue;
    const h = parseLaborLeafHours(leaf.body);
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

/** A representative service set for the preview action (proof without a config). */
const DEFAULT_PREVIEW_SERVICES = [
  { slug: "spark_plugs", name: "Spark Plug Replacement" },
  { slug: "cabin_air_filter", name: "Cabin Air Filter Replacement" },
  { slug: "engine_air_filter", name: "Engine Air Filter Replacement" },
  { slug: "battery", name: "Battery Replacement" },
  { slug: "alternator", name: "Alternator Replacement" },
  { slug: "starter", name: "Starter Replacement" },
  { slug: "water_pump", name: "Water Pump Replacement" },
  { slug: "serpentine_belt", name: "Serpentine Belt Replacement" },
  { slug: "brake_rotor", name: "Brake Rotor Replacement" },
  { slug: "transmission_fluid", name: "Transmission Fluid Service" },
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
