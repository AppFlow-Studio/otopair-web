/**
 * repairpalEndpointMatch.ts — PURE matcher + parser for the RepairPal estimate
 * endpoint. NO Convex imports, so it is unit-testable in isolation
 * (tests/repairpalEndpointMatch.test.ts). The network action
 * (repairpalEndpoint.ts) composes these helpers.
 *
 * Pipeline: resolveMakeId → resolveBaseVehicleId → (fetch /estimate) →
 * extractVariants → selectVariant → endpointPartCategory (to map the endpoint's
 * named parts back onto the part_fitments we already gathered).
 */

/** Dimension keys RepairPal nests estimates under — excluded from variant labels. */
const STRUCT = new Set([
  "estimates", "estimate", "submodel", "engine_base",
  "position_count", "qualifiers", "drive_type", "ranged_estimate",
]);

export type EndpointVariant = {
  label: string;
  minutes: number;
  hours: number;
  laborLow?: number;
  laborHigh?: number;
  total?: any;
  parts: any[];
};

/**
 * Walk the whole `estimates` tree and collect every `labor.minutes`-bearing
 * node (≥6 shapes; ranged_estimate.labor has no minutes → naturally skipped).
 * Label = the non-structural path keys (the human-meaningful dimension values).
 */
export function extractVariants(payload: any): EndpointVariant[] {
  const out: EndpointVariant[] = [];
  (function walk(o: any, path: string[]) {
    if (o == null || typeof o !== "object") return;
    if (o.labor && typeof o.labor.minutes === "number") {
      out.push({
        label: path.filter((k) => !STRUCT.has(k)).join(" · ") || "all configs",
        minutes: o.labor.minutes,
        hours: o.labor.minutes / 60,
        laborLow: o.labor.low,
        laborHigh: o.labor.high,
        total: o.total,
        parts: o.parts ?? [],
      });
    }
    for (const [k, v] of Object.entries(o)) if (v && typeof v === "object") walk(v, [...path, k]);
  })(payload?.estimates ?? {}, []);
  return out;
}

type Selector = { displacementL?: number | null; cylinders?: number | null; trim?: string | null; position?: string | null };

/**
 * Pick the variant matching a config's engine / position / trim. Returns the
 * lone variant when there's no dimension to match, and null when there are
 * multiple variants and none match (caller decides whether to skip).
 */
export function selectVariant<T extends { label: string }>(variants: T[], sel: Selector): T | null {
  if (!variants.length) return null;
  const hasEngine = sel.displacementL != null && sel.cylinders != null;
  const engStr = hasEngine ? `${(sel.displacementL as number).toFixed(1)} Liter, ${sel.cylinders} Cylinder` : null;
  const matchesPos = (label: string) => {
    if (!sel.position) return false;
    const p = sel.position.toLowerCase();
    const l = label.toLowerCase();
    if (p === "front") return l.includes("front") && !l.includes("rear");
    if (p === "rear") return l.includes("rear") && !l.includes("front");
    if (p === "all" || p === "both") return l.includes("front and rear") || l.includes("all");
    return false;
  };
  if (engStr && sel.position) {
    const m = variants.find((v) => v.label.includes(engStr) && matchesPos(v.label));
    if (m) return m;
  }
  if (engStr) {
    const m = variants.find((v) => v.label.includes(engStr));
    if (m) return m;
  }
  if (sel.position) {
    const m = variants.find((v) => matchesPos(v.label));
    if (m) return m;
  }
  if (sel.trim) {
    const t = sel.trim.toLowerCase();
    const m = variants.find((v) => v.label.toLowerCase() === t) || variants.find((v) => v.label.toLowerCase().includes(t));
    if (m) return m;
  }
  if (variants.length === 1) return variants[0];
  return null;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Normalize a trim/model string to an order-independent token SET, collapsing
 * a 1-2 letter token immediately followed by a digit-leading token ("C 63" ->
 * "c63") so our "AMG C 63 S" aligns with RP's "C63 AMG S". Pure; used by the
 * token-set matching rung in resolveBaseVehicleId.
 */
export function trimTokenSet(s: string): Set<string> {
  const raw = s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
  const merged: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i];
    const next = raw[i + 1];
    if (/^[a-z]{1,2}$/.test(t) && next && /^[0-9]/.test(next)) {
      merged.push(t + next);
      i++; // consume the number token we just merged
    } else {
      merged.push(t);
    }
  }
  return new Set(merged);
}

const setEq = (a: Set<string>, b: Set<string>): boolean =>
  a.size === b.size && [...a].every((x) => b.has(x));

/** make name → makeId (case-insensitive). */
export function resolveMakeId(makes: { id: number; name: string }[], makeName: string): number | null {
  const n = norm(makeName);
  const m = makes.find((x) => norm(x.name) === n);
  return m ? m.id : null;
}

/**
 * (model, trim) → baseVehicleId. Handles trim-as-model makes (BMW/Mercedes,
 * where RP's modelName is "330i"/"M340i", not "3 Series"): exact model-line
 * match first, then the trim as an exact model name (preferred over a variant
 * like "330i xDrive"), then a loose model prefix/substring.
 */
export function resolveBaseVehicleId(
  baseVehicles: { id: number; modelName: string }[],
  cfg: { model: string; trim?: string | null },
): number | null {
  const model = norm(cfg.model);
  let m = baseVehicles.find((b) => norm(b.modelName) === model);
  if (m) return m.id;
  if (cfg.trim) {
    const trim = norm(cfg.trim);
    m = baseVehicles.find((b) => norm(b.modelName) === trim)
      || baseVehicles.find((b) => norm(b.modelName).startsWith(trim));
    if (m) return m.id;
  }
  m = baseVehicles.find((b) => norm(b.modelName).startsWith(model))
    || baseVehicles.find((b) => norm(b.modelName).includes(model));
  return m ? m.id : null;
}

/**
 * Map an endpoint part NAME onto a fitment category (+ position for brakes), so
 * the endpoint's price can be attached to the part_id we already gathered.
 * Returns null for names outside otopair's parts set.
 */
export function endpointPartCategory(name: string): { category: string; position?: string } | null {
  const n = name.toLowerCase();
  const position = n.includes("front") ? "front" : n.includes("rear") ? "rear" : undefined;
  let category: string | null = null;
  if (n.includes("cabin")) category = "cabin_filter";
  else if (n.includes("air filter")) category = "air_filter";
  else if (n.includes("oil filter")) category = "oil_filter";
  else if (n.includes("spark plug")) category = "spark_plug";
  else if (n.includes("battery")) category = "battery";
  else if (n.includes("coolant") || n.includes("antifreeze")) category = "coolant";
  else if (n.includes("brake pad")) category = "brake_pad";
  else if (n.includes("rotor")) category = "brake_rotor";
  else if (n.includes("transmission") && n.includes("filter")) category = "transmission_filter";
  if (!category) return null;
  return position && (category === "brake_pad" || category === "brake_rotor") ? { category, position } : { category };
}

/** otopair service slug → RepairPal serviceId(s). Multi-id = scope (sum/prefer).
 *  Source: docs/superpowers/reviews/2026-06-15-otopair-services-repairpal-coverage.md. */
export const SERVICE_REPAIRPAL_IDS: Record<string, { serviceIds: number[] }> = {
  oil_change: { serviceIds: [107] },
  filter_replacement: { serviceIds: [14, 35] },   // air (14) + cabin (35)
  spark_plugs: { serviceIds: [128] },
  timing_belt: { serviceIds: [144] },
  coolant_flush: { serviceIds: [52] },
  transmission_service: { serviceIds: [507] },     // full-pan (higher coverage than drain&fill 158)
  tire_rotation: { serviceIds: [569] },
  tire_balance: { serviceIds: [971] },
  wheel_alignment: { serviceIds: [169] },
  brake_pad_replacement: { serviceIds: [30] },
  rotor_replacement: { serviceIds: [31, 4453439] }, // standalone (31) + composite pad+rotor
  brake_fluid_flush: { serviceIds: [33] },
  battery_replacement: { serviceIds: [590] },
  battery_test: { serviceIds: [261] },
  check_engine_diagnosis: { serviceIds: [5520] },
};
