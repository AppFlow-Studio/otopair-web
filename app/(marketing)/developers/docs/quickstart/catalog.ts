// =============================================================================
// Quickstart playground catalog — the machine-readable shape of the interactive
// try-it console on /developers/docs/quickstart.
//
//   • ENDPOINTS   — every runnable GET, its accepted identifier modes, extra
//                   params, required scope, structured renderer, and a baked-in
//                   SAMPLE response (real 2019 CR-V data, imported from
//                   convex/lib/dataExamples so it can't drift from the OpenAPI
//                   spec). The sample is what the output panel shows before a
//                   live call — the page is useful with zero requests fired.
//   • DATA_GROUPS — the "what we can return / what we offer" breakdown, each
//                   linked to the endpoint that serves it (its "Try it" jump).
//
// Pure data module — no React. The playground + renderers consume it.
// =============================================================================
import {
  CONFIG_EX,
  FLUID_FIELDS_EX,
  CHASSIS_FIELDS_EX,
  META_EX,
  TIRES_EX,
  INTERVALS_EX,
  SERVICE_ENTRY_EX,
} from "@/convex/lib/dataExamples";

export type Mode = "ymmt" | "vin" | "config_key";

export type ExtraParam = {
  name: string;
  label: string;
  placeholder?: string;
  kind: "text" | "include" | "service";
  help?: string;
};

export type RendererKey =
  | "vehicle"
  | "specs"
  | "fluids"
  | "tires"
  | "intervals"
  | "parts"
  | "decode"
  | "configList"
  | "labor"
  | "image"
  | "history"
  | "enrichment"
  | "json";

export type Endpoint = {
  id: string;
  method: "GET";
  path: string;
  version: "v1" | "v0";
  tag: string;
  summary: string;
  description: string;
  scope: string;
  /** False → a free-tier key can't call it live (it'll 403); still documented + sampleable. */
  freeTier: boolean;
  modes: Mode[];
  extra?: ExtraParam[];
  renderer: RendererKey;
  sample: unknown;
};

// The identifier the playground pre-fills — the documented flagship example.
// (Not `as const`: these are seed values the playground edits into free text.)
export type Identifier = { year: string; make: string; model: string; trim: string; vin: string; config_key: string };
export const DEFAULT_IDENTIFIER: Identifier = {
  year: "2019",
  make: "Honda",
  model: "CR-V",
  trim: "",
  vin: "",
  config_key: "2019_honda_cr_v_ex_l15be",
};

const CONFIG_BRIEF_EX = {
  config_key: CONFIG_EX.config_key,
  year: CONFIG_EX.year,
  make: CONFIG_EX.make,
  model: CONFIG_EX.model,
  trim: CONFIG_EX.trim,
  engine: "1.5L L15BE",
  drivetrain: "4WD",
};

// A single withheld row so the "gate is visible, not silent" story is tangible
// in the specs / maintenance samples.
const EXCLUDED_EX = [
  {
    field: "factory_fill_oil",
    label: "Factory-fill oil",
    blocking_layer: "B",
    reason: 'source_type "vehicle_databases" → structured DB',
  },
];

const SAMPLE = {
  decode: { object: "decode", config: CONFIG_EX },
  configList: {
    object: "config_list",
    year: 2019,
    make: "Honda",
    model: "CR-V",
    trim: null,
    count: 1,
    configs: [
      {
        config_key: "2019_honda_cr_v_ex_l15be",
        year: 2019,
        make: "Honda",
        model: "CR-V",
        trim: "EX",
        drivetrain: "4WD",
        engine: "1.5L L15BE",
        enrichment_status: "complete",
        fill_rate: 92,
      },
    ],
  },
  vehicle: {
    object: "vehicle",
    config: CONFIG_EX,
    specs: [...FLUID_FIELDS_EX, ...CHASSIS_FIELDS_EX],
    excluded: EXCLUDED_EX,
    tires: TIRES_EX,
    intervals: INTERVALS_EX,
    services: [SERVICE_ENTRY_EX],
    history: null,
    meta: META_EX,
  },
  specs: {
    object: "specs",
    config: CONFIG_EX,
    fields: [...FLUID_FIELDS_EX, ...CHASSIS_FIELDS_EX],
    excluded: EXCLUDED_EX,
    meta: META_EX,
  },
  fluids: { object: "fluids", config: CONFIG_EX, fields: FLUID_FIELDS_EX, meta: META_EX },
  tires: { object: "tires", config: CONFIG_EX, tires: TIRES_EX, meta: META_EX },
  maintenanceSchedule: {
    object: "maintenance_schedule",
    config: CONFIG_EX,
    intervals: INTERVALS_EX,
    meta: META_EX,
  },
  parts: { object: "parts", config: CONFIG_EX, services: [SERVICE_ENTRY_EX], meta: META_EX },
  maintenanceSpecs: {
    object: "maintenance_specs",
    config: CONFIG_BRIEF_EX,
    fields: FLUID_FIELDS_EX,
    excluded: EXCLUDED_EX,
    meta: META_EX,
  },
  labor: {
    object: "empirical_labor",
    config_key: "2019_honda_cr_v_ex_l15be",
    services: [
      { service: "front-brake-pads", name: "Front Brake Pads", empirical_hours: 1.2, sample_size: 6, p25_hours: 1.0, p75_hours: 1.4 },
    ],
    estimates: [
      { service: "front-brake-pads", name: "Front Brake Pads", estimated_hours: 1.2, estimate_source: "empirical", estimate_confidence: 0.7 },
      { service: "oil-change", name: "Oil Change", estimated_hours: 0.5, estimate_source: "model_estimate", estimate_confidence: 0.3 },
    ],
    tier: "T1",
    note: "services[] are measured from completed jobs; estimates[] fills every applicable service.",
  },
  image: {
    object: "vehicle_image",
    config: CONFIG_BRIEF_EX,
    image: {
      url: "https://cdn.otopair.com/renders/2019_honda_cr_v_ex.png",
      media_source: "evox",
      licensing_note: "Cached render for display; not for redistribution.",
    },
    meta: META_EX,
  },
  history: {
    object: "service_history",
    vin: "2HKRW2H85KH612345",
    records: [
      { date: "2024-03-12", mileage: 31200, source: "shop_visit", confidence: "high", services: ["oil-change", "tire-rotation"], parts: [{ oem_part_number: "15400-PLM-A02", name: "Oil Filter" }] },
      { date: "2023-09-01", mileage: 24800, source: "owner_reported", confidence: 0.6, services: ["air-filter"], parts: [] },
    ],
    meta: { record_count: 2, sanitization: "No PII, costs, shop identity, or free-text notes.", generated_at: 1787174247134 },
  },
  enrichment: {
    object: "enrichment_status",
    status: "complete",
    config_key: "2019_honda_cr_v_ex_l15be",
    enrichment_status: "complete",
    last_enriched_at: 1787174247134,
    fill_rate: 92,
  },
} as const;

const INCLUDE_PARAM: ExtraParam = {
  name: "include",
  label: "include",
  placeholder: "fluids,tires",
  kind: "include",
  help: "Comma-separated groups. Omit for the whole payload; empty for identity only.",
};
const SERVICE_PARAM: ExtraParam = {
  name: "service",
  label: "service",
  placeholder: "front-brake-pads",
  kind: "service",
  help: "Optional service-slug filter.",
};

export const ENDPOINTS: Endpoint[] = [
  {
    id: "decode",
    method: "GET",
    path: "/v1/decode",
    version: "v1",
    tag: "Identity",
    summary: "Decode a vehicle (identity only)",
    description: "Resolve a VIN, config_key, or year/make/model to its canonical identity — config + engine — with no group joins. The lightest lookup.",
    scope: "maintenance:read",
    freeTier: true,
    modes: ["ymmt", "vin", "config_key"],
    renderer: "decode",
    sample: SAMPLE.decode,
  },
  {
    id: "configs",
    method: "GET",
    path: "/v1/configs",
    version: "v1",
    tag: "Identity",
    summary: "List candidate configs for a YMMT",
    description: "Every enriched config that fits a year/make/model[/trim], always as a list. Turns the 409 disambiguation into a first-class lookup — pick a config_key and switch to exact access.",
    scope: "maintenance:read",
    freeTier: true,
    modes: ["ymmt"],
    renderer: "configList",
    sample: SAMPLE.configList,
  },
  {
    id: "vehicle",
    method: "GET",
    path: "/v1/vehicle",
    version: "v1",
    tag: "Specifications",
    summary: "Full vehicle payload (field-selectable)",
    description: "Everything we hold on one vehicle: identity, layer-tagged specs (served + excluded), OEM tires, service intervals, priced parts with labor per service, and (VIN lookups only) sanitized service history. Use include to return only the groups you need.",
    scope: "maintenance:read",
    freeTier: true,
    modes: ["ymmt", "vin", "config_key"],
    extra: [INCLUDE_PARAM],
    renderer: "vehicle",
    sample: SAMPLE.vehicle,
  },
  {
    id: "fluids",
    method: "GET",
    path: "/v1/fluids",
    version: "v1",
    tag: "Fluids & Capacities",
    summary: "Fluids & capacities",
    description: "The flagship depth slice: engine oil viscosity + capacity, coolant, transmission, brake, power-steering, and differential / transfer-case fluid types and capacities — every value layer-tagged.",
    scope: "maintenance:read",
    freeTier: true,
    modes: ["ymmt", "vin", "config_key"],
    renderer: "fluids",
    sample: SAMPLE.fluids,
  },
  {
    id: "specs",
    method: "GET",
    path: "/v1/specs",
    version: "v1",
    tag: "Specifications",
    summary: "The layer-tagged spec sheet",
    description: "Every populated spec field (fluids + attributes + chassis service points), each tagged with its data layer, confidence, and source domain — plus the excluded[] list of B-licensed / X-flagged fields the gate withheld.",
    scope: "maintenance:read",
    freeTier: true,
    modes: ["ymmt", "vin", "config_key"],
    renderer: "specs",
    sample: SAMPLE.specs,
  },
  {
    id: "tires",
    method: "GET",
    path: "/v1/tires",
    version: "v1",
    tag: "Tires",
    summary: "OEM tire & wheel package",
    description: "Full OEM fitment: tire sizes, recommended pressures, load index, speed rating, run-flat / staggered flags, and battery CCA.",
    scope: "maintenance:read",
    freeTier: true,
    modes: ["ymmt", "vin", "config_key"],
    renderer: "tires",
    sample: SAMPLE.tires,
  },
  {
    id: "maintenance-schedule",
    method: "GET",
    path: "/v1/maintenance-schedule",
    version: "v1",
    tag: "Maintenance",
    summary: "OEM service intervals",
    description: "OEM maintenance intervals by miles and months, each with a confidence score and a mechanic-verified flag.",
    scope: "maintenance:read",
    freeTier: true,
    modes: ["ymmt", "vin", "config_key"],
    renderer: "intervals",
    sample: SAMPLE.maintenanceSchedule,
  },
  {
    id: "parts",
    method: "GET",
    path: "/v1/parts",
    version: "v1",
    tag: "Parts",
    summary: "Parts, prices & labor per service",
    description: "Exact-fit OEM parts grouped per service — part number, role, position, quantity — each with the latest trusted price, alongside the labor answer for that service.",
    scope: "maintenance:read",
    freeTier: true,
    modes: ["ymmt", "vin", "config_key"],
    extra: [SERVICE_PARAM],
    renderer: "parts",
    sample: SAMPLE.parts,
  },
  {
    id: "labor",
    method: "GET",
    path: "/v0/labor",
    version: "v0",
    tag: "Labor",
    summary: "Labor times & estimates",
    description: "services[] are empirical measurements from completed Otopair jobs (hours, sample size, p25–p75). estimates[] adds an estimate for every applicable service — empirical or our Camry-anchored tier model.",
    scope: "labor:read",
    freeTier: true,
    modes: ["vin", "config_key"],
    extra: [SERVICE_PARAM],
    renderer: "labor",
    sample: SAMPLE.labor,
  },
  {
    id: "maintenance",
    method: "GET",
    path: "/v0/maintenance",
    version: "v0",
    tag: "Fluids & Capacities",
    summary: "Maintenance specs (v0, strict gate)",
    description: "Layer-gated maintenance specs. Unlike /v1/specs, a field is served only when it has an evidence trail with a servable layer; everything else is listed in excluded[].",
    scope: "maintenance:read",
    freeTier: true,
    modes: ["vin", "config_key"],
    renderer: "specs",
    sample: SAMPLE.maintenanceSpecs,
  },
  {
    id: "vehicle-image",
    method: "GET",
    path: "/v0/vehicle-image",
    version: "v0",
    tag: "Media",
    summary: "Vehicle exterior render",
    description: "The cached exterior render for a config. Cache-first; a cache miss spends one live upstream fetch (~6s, capped 10/day/key), then caches it. Requires the media:read scope.",
    scope: "media:read",
    freeTier: true,
    modes: ["ymmt", "vin", "config_key"],
    renderer: "image",
    sample: SAMPLE.image,
  },
  {
    id: "service-history",
    method: "GET",
    path: "/v0/service-history",
    version: "v0",
    tag: "Service History",
    summary: "Sanitized service history (by VIN)",
    description: "Carfax-style per-VIN records: completed shop visits, owner-reported maintenance, and accepted document extractions. Sanitized by contract — no PII, costs, shop identity, or free-text notes. Requires the service_history:read scope.",
    scope: "service_history:read",
    freeTier: true,
    modes: ["vin"],
    renderer: "history",
    sample: SAMPLE.history,
  },
  {
    id: "enrich-status",
    method: "GET",
    path: "/v0/enrich",
    version: "v0",
    tag: "Enrichment",
    summary: "Poll enrichment status",
    description: "Free status poll for a VIN or config_key. Growing the dataset (POST /v0/enrich) needs the enrich:write scope, which isn't on free keys — see the reference.",
    scope: "enrich:write",
    freeTier: false,
    modes: ["vin", "config_key"],
    renderer: "enrichment",
    sample: SAMPLE.enrichment,
  },
];

// ── "What we offer" — the data-group breakdown. Each group names the concrete
//    fields the API returns and points at the endpoint that serves them. ──────
export type DataGroup = {
  title: string;
  endpointId: string;
  depth: "deep" | "growing";
  blurb: string;
  fields: string[];
};

export const DATA_GROUPS: DataGroup[] = [
  {
    title: "Identity & engine",
    endpointId: "decode",
    depth: "deep",
    blurb: "Canonical config resolved from a VIN, YMMT, or config_key — with the exact engine.",
    fields: ["config_key", "year / make / model / trim", "chassis code", "engine code", "displacement · cylinders", "aspiration · injection", "drivetrain", "transmission"],
  },
  {
    title: "Fluids & capacities",
    endpointId: "fluids",
    depth: "deep",
    blurb: "Real OEM fluid types and capacities — not a generic 'takes 5 quarts'.",
    fields: ["oil viscosity", "oil capacity (qts)", "coolant type & capacity", "transmission fluid", "brake fluid", "power-steering fluid", "differential / transfer-case fluid"],
  },
  {
    title: "Spec sheet & service points",
    endpointId: "specs",
    depth: "deep",
    blurb: "Layer-tagged attributes and chassis service points — plus the withheld rows.",
    fields: ["lug-nut torque", "battery group & CCA", "wiper sizes", "steering type", "excluded[] (gate-withheld)"],
  },
  {
    title: "Maintenance schedule",
    endpointId: "maintenance-schedule",
    depth: "deep",
    blurb: "OEM service intervals by miles and months, each with a confidence score.",
    fields: ["interval (miles)", "interval (months)", "human display", "confidence", "mechanic-verified"],
  },
  {
    title: "Parts & live prices",
    endpointId: "parts",
    depth: "deep",
    blurb: "Exact-fit OEM part numbers per service, each with a current scraped price.",
    fields: ["OEM part number", "role · position · quantity", "price (amount)", "MSRP", "source domain", "priced as-of", "labor hours"],
  },
  {
    title: "Tires & wheels",
    endpointId: "tires",
    depth: "deep",
    blurb: "Full OEM fitment package for the exact config.",
    fields: ["front / rear size", "recommended pressures", "load index", "speed rating", "run-flat · staggered", "battery CCA"],
  },
  {
    title: "Empirical labor",
    endpointId: "labor",
    depth: "growing",
    blurb: "Labor times measured from completed jobs — plus a tier-model estimate for the rest.",
    fields: ["empirical hours", "sample size", "p25 – p75 spread", "tier-model estimate", "estimate source"],
  },
  {
    title: "Vehicle media",
    endpointId: "vehicle-image",
    depth: "growing",
    blurb: "The cached exterior render for a config.",
    fields: ["render URL", "media source", "licensing note"],
  },
  {
    title: "Service history",
    endpointId: "service-history",
    depth: "growing",
    blurb: "Sanitized per-VIN records — no PII, costs, or shop identity.",
    fields: ["date", "mileage", "source (shop / owner / doc)", "services", "parts", "confidence"],
  },
];

export function endpointById(id: string): Endpoint | undefined {
  return ENDPOINTS.find((e) => e.id === id);
}
