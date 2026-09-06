// =============================================================================
// OpenAPI 3.1 spec for the Otopair Car Data API — the single machine-readable
// source of truth for the public /v0 + /v1 surface. Served (with the server URL
// injected per deployment) at GET /v1/openapi.json by convex/http.ts, and
// rendered as the interactive reference at /developers/docs (Scalar). Keep this
// in lockstep with convex/dataApi.ts + convex/http.ts response shapes.
//
// This is a plain data module (no Convex functions) so both http.ts and the
// Next.js docs page can import it.
// =============================================================================
import { LAYER_FORMULA } from "./lib/dataLayers";
import {
  CONFIG_EX,
  FLUID_FIELDS_EX,
  CHASSIS_FIELDS_EX,
  META_EX,
  TIRES_EX,
  INTERVALS_EX,
  SERVICE_ENTRY_EX,
} from "./lib/dataExamples";

const DESCRIPTION = `
Maintenance-grade vehicle data with **tracked provenance**. Not a VIN decoder —
real OEM fluid capacities, exact-fit OEM part numbers with live prices, OEM
service intervals, and labor times measured from completed jobs. Every value
carries a **data layer**, a confidence score, and a source domain.

### Authentication
Send your key on every request as a Bearer token **or** an \`x-api-key\` header:

\`\`\`
Authorization: Bearer otp_live_4f2a9c…
# or
x-api-key: otp_live_4f2a9c…
\`\`\`

Mint a free key on the [developer dashboard](/developers) — one key, all read
scopes, 60 requests/min, no card. The plaintext is shown **once** at mint time
(only its SHA-256 hash is stored); lose it → rotate.

### The provenance gate
Every field is tagged a layer. The API serves **A + C + D + E**; **B**
(licensed third-party DB) and **X** (flagged / low-confidence) are *excluded* —
and every exclusion is listed per response with its blocking layer, so the gate
is visible, never silent.

| Layer | Meaning | Served |
| --- | --- | --- |
| A | OEM / official — owner's manuals, manufacturer data | ✅ |
| B | Licensed structured DB — internal-use only | ❌ (public NHTSA is carved in) |
| C | Web-derived — our own research / scraping | ✅ |
| D | Empirical — measured from completed Otopair jobs | ✅ |
| E | Human-verified — mechanic / director confirmed | ✅ |
| X | Flagged — anomalies or confidence < 0.4 | ❌ |

Derivation: \`${LAYER_FORMULA}\`

### Versions
- **v1** — granular, group-scoped endpoints. Pull one slice (fluids, tires,
  parts…) so you never pay for joins you don't need; or field-select the full
  payload with \`GET /v1/vehicle?include=\`.
- **v0** — the original flagship + specialised endpoints (labor, media,
  enrichment, service history). Still fully supported.

### Rate limits & errors
Per-key, per-minute (free tier: 60/min → \`429 rate_limited\`). Errors are JSON:
\`{ "error": "<code>", "message": "…" }\`.
`.trim();

const TAGS = [
  { name: "Identity", description: "Decode a VIN or list candidate configs for a year/make/model." },
  { name: "Specifications", description: "The full vehicle payload and the layer-tagged spec sheet." },
  { name: "Fluids & Capacities", description: "Oil, coolant, transmission, brake, PS and driveline fluids + capacities." },
  { name: "Maintenance", description: "OEM service intervals." },
  { name: "Parts", description: "Exact-fit OEM parts with live prices and labor per service." },
  { name: "Tires", description: "OEM tire & wheel fitment package." },
  { name: "Labor", description: "Empirical labor times + tier-model estimates." },
  { name: "Media", description: "Vehicle exterior renders." },
  { name: "Service History", description: "Sanitized per-VIN service records." },
  { name: "Enrichment", description: "Grow the dataset for a VIN we haven't seen." },
];

// ── Reusable parameter refs ─────────────────────────────────────────────────
const P = {
  vin: {
    name: "vin",
    in: "query",
    description: "17-char VIN of a vehicle we've seen. The only mode that adds the service-history section.",
    schema: { type: "string", minLength: 11, maxLength: 17, example: "2HKRW2H85KH612345" },
  },
  configKey: {
    name: "config_key",
    in: "query",
    description: "Canonical vehicle-config key — exact and unambiguous. 409 responses hand these back.",
    schema: { type: "string", example: "2019_honda_cr_v_ex_l15be" },
  },
  year: { name: "year", in: "query", description: "Model year.", schema: { type: "integer", example: 2019 } },
  make: { name: "make", in: "query", description: "Make (case-insensitive).", schema: { type: "string", example: "Honda" } },
  model: { name: "model", in: "query", description: "Model (case-insensitive).", schema: { type: "string", example: "CR-V" } },
  trim: { name: "trim", in: "query", description: "Optional trim filter to narrow YMMT matches.", schema: { type: "string", example: "EX" } },
  service: {
    name: "service",
    in: "query",
    description: "Optional service-slug filter (e.g. front-brake-pads).",
    schema: { type: "string", example: "front-brake-pads" },
  },
  include: {
    name: "include",
    in: "query",
    description:
      "Comma-separated groups to return (omit for the whole payload; empty for identity only). " +
      "Aliases resolve: specs·fluids·attributes·chassis→specs, tires·wheels, " +
      "intervals·maintenance·schedule, services·parts·labor, history.",
    style: "form",
    explode: false,
    schema: {
      type: "array",
      items: { type: "string", enum: ["specs", "fluids", "tires", "intervals", "maintenance", "services", "parts", "history"] },
      example: ["fluids", "tires"],
    },
  },
} as const;

// A vehicle identifier is any one of: config_key, vin, or year+make+model[+trim].
const VEHICLE_PARAMS = [{ $ref: "#/components/parameters/vin" }, { $ref: "#/components/parameters/year" }, { $ref: "#/components/parameters/make" }, { $ref: "#/components/parameters/model" }, { $ref: "#/components/parameters/trim" }, { $ref: "#/components/parameters/config_key" }];
const CONFIG_OR_VIN = [{ $ref: "#/components/parameters/config_key" }, { $ref: "#/components/parameters/vin" }];

// ── Shared response refs ────────────────────────────────────────────────────
const ERR = (desc: string, code: string, message: string) => ({
  description: desc,
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" }, example: { error: code, message } } },
});
const AUTH_ERRORS = {
  "401": ERR("Missing, invalid, or revoked key.", "invalid_api_key", "Unknown API key."),
  "403": ERR("The key lacks the required scope.", "insufficient_scope", "This key lacks the 'maintenance:read' scope."),
  "429": ERR("Per-key per-minute rate limit exceeded.", "rate_limited", "Limit is 60 requests/minute for this key."),
};
const NOT_FOUND = ERR("No enriched vehicle matches that identifier.", "not_found", "No enriched vehicle config matches that identifier.");
const MULTI = {
  description: "More than one config matched a YMMT lookup — retry with a config_key from `matches` (or add &trim=).",
  content: { "application/json": { schema: { $ref: "#/components/schemas/MultipleMatches" } } },
};

// Example objects (real 2019 Honda CR-V EX data) live in ./lib/dataExamples —
// shared verbatim with the interactive playground so the spec and the "try it"
// samples never drift.

// ── The spec builder ────────────────────────────────────────────────────────
export function buildOpenApiSpec(serverUrl: string): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "Otopair Car Data API",
      version: "1.0.0",
      description: DESCRIPTION,
      contact: { name: "Otopair Developers", url: "https://otopair.com/developers" },
    },
    servers: [{ url: serverUrl, description: "Otopair Data API" }],
    security: [{ bearerAuth: [] }, { apiKeyHeader: [] }],
    tags: TAGS,
    paths: {
      // ── Identity ──
      "/v1/decode": {
        get: {
          tags: ["Identity"], operationId: "decode", summary: "Decode a vehicle (identity only)",
          description: "Resolve a VIN (or config_key / YMMT) to its canonical identity — config + engine — with no group joins. The lightest lookup.",
          parameters: VEHICLE_PARAMS,
          responses: {
            "200": { description: "Vehicle identity.", content: { "application/json": { schema: { $ref: "#/components/schemas/DecodeResponse" }, example: { object: "decode", config: CONFIG_EX } } } },
            "400": ERR("No usable identifier was provided.", "missing_param", "Pass ?vin=… OR ?year=&make=&model=[&trim=] OR ?config_key=…"),
            "404": NOT_FOUND, "409": MULTI, ...AUTH_ERRORS,
          },
        },
      },
      "/v1/configs": {
        get: {
          tags: ["Identity"], operationId: "listConfigs", summary: "List candidate configs for a YMMT",
          description: "Every enriched config that fits a year/make/model[/trim], always as a list. Turns the 409 disambiguation into a first-class lookup — pick a config_key and switch to exact access.",
          parameters: [{ $ref: "#/components/parameters/year" }, { $ref: "#/components/parameters/make" }, { $ref: "#/components/parameters/model" }, { $ref: "#/components/parameters/trim" }],
          responses: {
            "200": { description: "Candidate configs.", content: { "application/json": { schema: { $ref: "#/components/schemas/ConfigListResponse" }, example: { object: "config_list", year: 2019, make: "Honda", model: "CR-V", trim: null, count: 2, configs: [{ config_key: "2019_honda_cr_v_ex_l15be", year: 2019, make: "Honda", model: "CR-V", trim: "EX", drivetrain: "4WD", engine: "1.5L L15BE", enrichment_status: "complete", fill_rate: 92 }] } } } },
            "400": ERR("Missing YMMT.", "missing_param", "Pass ?year=&make=&model=[&trim=]"),
            "404": ERR("No config matches that YMMT.", "not_found", "No enriched config matches that year/make/model — POST /v0/enrich {vin} to add one."),
            ...AUTH_ERRORS,
          },
        },
      },
      // ── Specifications ──
      "/v1/vehicle": {
        get: {
          tags: ["Specifications"], operationId: "getVehicle", summary: "Full vehicle payload (field-selectable)",
          description: "Everything we hold on one vehicle: identity, layer-tagged specs (served + excluded), OEM tires, service intervals, priced parts with labor per service, and (VIN lookups only) sanitized service history. Use `?include=` to return only the groups you need — omit it for the whole payload (identical to `/v0/vehicle`).",
          parameters: [...VEHICLE_PARAMS, { $ref: "#/components/parameters/include" }],
          responses: {
            "200": { description: "The vehicle payload.", content: { "application/json": { schema: { $ref: "#/components/schemas/VehicleResponse" } } } },
            "400": ERR("No usable identifier.", "missing_param", "Pass ?vin=… OR ?year=&make=&model=[&trim=] OR ?config_key=…"),
            "404": NOT_FOUND, "409": MULTI, ...AUTH_ERRORS,
          },
        },
      },
      "/v1/specs": {
        get: {
          tags: ["Specifications"], operationId: "getSpecs", summary: "The layer-tagged spec sheet",
          description: "Every populated spec field (fluids + attributes + chassis service points), each tagged with its data layer, confidence and source domain — plus the `excluded[]` list of B-licensed / X-flagged fields the gate withheld.",
          parameters: CONFIG_OR_VIN,
          responses: {
            "200": { description: "Spec sheet.", content: { "application/json": { schema: { $ref: "#/components/schemas/SpecsResponse" }, example: { object: "specs", config: CONFIG_EX, fields: [...FLUID_FIELDS_EX, ...CHASSIS_FIELDS_EX], excluded: [], meta: META_EX } } } },
            "400": ERR("Missing identifier.", "missing_param", "Pass ?config_key=… or ?vin=…"), "404": NOT_FOUND, ...AUTH_ERRORS,
          },
        },
      },
      // ── Fluids ──
      "/v1/fluids": {
        get: {
          tags: ["Fluids & Capacities"], operationId: "getFluids", summary: "Fluids & capacities",
          description: "The flagship depth slice: engine oil viscosity + capacity, coolant, transmission, brake, power-steering, and differential / transfer-case fluid types and capacities — layer-tagged.",
          parameters: CONFIG_OR_VIN,
          responses: {
            "200": { description: "Fluid specs.", content: { "application/json": { schema: { $ref: "#/components/schemas/FluidsResponse" }, example: { object: "fluids", config: CONFIG_EX, fields: FLUID_FIELDS_EX, meta: META_EX } } } },
            "400": ERR("Missing identifier.", "missing_param", "Pass ?config_key=… or ?vin=…"), "404": NOT_FOUND, ...AUTH_ERRORS,
          },
        },
      },
      // ── Maintenance ──
      "/v1/maintenance-schedule": {
        get: {
          tags: ["Maintenance"], operationId: "getMaintenanceSchedule", summary: "OEM service intervals",
          description: "OEM maintenance intervals by miles and months, each with confidence and a mechanic-verified flag.",
          parameters: CONFIG_OR_VIN,
          responses: {
            "200": { description: "Intervals.", content: { "application/json": { schema: { $ref: "#/components/schemas/MaintenanceScheduleResponse" }, example: { object: "maintenance_schedule", config: CONFIG_EX, intervals: INTERVALS_EX, meta: META_EX } } } },
            "400": ERR("Missing identifier.", "missing_param", "Pass ?config_key=… or ?vin=…"), "404": NOT_FOUND, ...AUTH_ERRORS,
          },
        },
      },
      // ── Parts ──
      "/v1/parts": {
        get: {
          tags: ["Parts"], operationId: "getParts", summary: "Parts, prices & labor per service",
          description: "Exact-fit OEM parts grouped per service — part number, role, position, quantity — each with the latest trusted price, alongside the labor answer for that service.",
          parameters: [...CONFIG_OR_VIN, { $ref: "#/components/parameters/service" }],
          responses: {
            "200": { description: "Parts + labor per service.", content: { "application/json": { schema: { $ref: "#/components/schemas/PartsResponse" }, example: { object: "parts", config: CONFIG_EX, services: [SERVICE_ENTRY_EX], meta: META_EX } } } },
            "400": ERR("Missing identifier.", "missing_param", "Pass ?config_key=… or ?vin=…"), "404": NOT_FOUND, ...AUTH_ERRORS,
          },
        },
      },
      // ── Tires ──
      "/v1/tires": {
        get: {
          tags: ["Tires"], operationId: "getTires", summary: "OEM tire & wheel package",
          description: "Full OEM fitment: tire sizes, recommended pressures, load index, run-flat / staggered flags, and battery CCA.",
          parameters: CONFIG_OR_VIN,
          responses: {
            "200": { description: "Tire package.", content: { "application/json": { schema: { $ref: "#/components/schemas/TiresResponse" }, example: { object: "tires", config: CONFIG_EX, tires: TIRES_EX, meta: META_EX } } } },
            "400": ERR("Missing identifier.", "missing_param", "Pass ?config_key=… or ?vin=…"), "404": NOT_FOUND, ...AUTH_ERRORS,
          },
        },
      },
      // ── v0 flagship ──
      "/v0/vehicle": {
        get: {
          tags: ["Specifications"], operationId: "getVehicleV0", summary: "Full vehicle payload (v0)",
          description: "The original flagship — the whole vehicle payload in one response. Identical shape to `/v1/vehicle` with no `include` filter; kept for back-compat.",
          parameters: VEHICLE_PARAMS,
          responses: {
            "200": { description: "The vehicle payload.", content: { "application/json": { schema: { $ref: "#/components/schemas/VehicleResponse" } } } },
            "400": ERR("No usable identifier.", "missing_param", "Pass ?vin=… OR ?year=&make=&model=[&trim=] OR ?config_key=…"),
            "404": NOT_FOUND, "409": MULTI, ...AUTH_ERRORS,
          },
        },
      },
      "/v0/maintenance": {
        get: {
          tags: ["Fluids & Capacities"], operationId: "getMaintenanceV0", summary: "Maintenance specs (v0, strict gate)",
          description: "Layer-gated maintenance specs. Unlike `/v1/specs`, a field is only served when it has an evidence trail with a servable layer; everything else is listed in `excluded[]`.",
          parameters: CONFIG_OR_VIN,
          responses: {
            "200": { description: "Maintenance specs.", content: { "application/json": { schema: { $ref: "#/components/schemas/MaintenanceResponse" } } } },
            "400": ERR("Missing identifier.", "missing_param", "Pass ?config_key=… or ?vin=…"), "404": NOT_FOUND, ...AUTH_ERRORS,
          },
        },
      },
      // ── Labor ──
      "/v0/labor": {
        get: {
          tags: ["Labor"], operationId: "getLabor", summary: "Labor times & estimates",
          description: "`services[]` are empirical measurements from completed Otopair jobs (hours, sample size, p25–p75). `estimates[]` adds an estimate for every applicable service — `empirical` or our own Camry-anchored tier model (`model_estimate`). Licensed book-time blends are never served.",
          parameters: [...CONFIG_OR_VIN, { $ref: "#/components/parameters/service" }],
          responses: {
            "200": { description: "Labor.", content: { "application/json": { schema: { $ref: "#/components/schemas/LaborResponse" } } } },
            "400": ERR("Missing identifier.", "missing_param", "Pass ?config_key=… or ?vin=…"), "404": NOT_FOUND, ...AUTH_ERRORS,
          },
        },
      },
      // ── Media ──
      "/v0/vehicle-image": {
        get: {
          tags: ["Media"], operationId: "getVehicleImage", summary: "Vehicle exterior render",
          description: "The cached exterior render for a config. Cache-first; a cache miss spends one live upstream fetch (~6s, capped 10/day/key), then caches it. Requires the `media:read` scope.",
          parameters: VEHICLE_PARAMS,
          responses: {
            "200": { description: "Vehicle image.", content: { "application/json": { schema: { $ref: "#/components/schemas/VehicleImageResponse" } } } },
            "400": ERR("No usable identifier.", "missing_param", "Pass ?vin=… OR ?year=&make=&model=[&trim=] OR ?config_key=…"),
            "404": ERR("No vehicle or image.", "no_image", "Vehicle resolved but no image is cached, and this key's live-fetch cap is reached."),
            "409": MULTI, ...AUTH_ERRORS,
          },
        },
      },
      // ── Service history ──
      "/v0/service-history": {
        get: {
          tags: ["Service History"], operationId: "getServiceHistory", summary: "Sanitized service history (by VIN)",
          description: "Carfax-style per-VIN records: completed shop visits, owner-reported maintenance, and accepted document extractions. **Sanitized by contract** — no PII, costs, shop identity or free-text notes. Requires the `service_history:read` scope.",
          parameters: [{ $ref: "#/components/parameters/vin" }],
          responses: {
            "200": { description: "Service history.", content: { "application/json": { schema: { $ref: "#/components/schemas/ServiceHistoryResponse" } } } },
            "400": ERR("Missing VIN.", "missing_param", "Pass ?vin=…"),
            "404": ERR("Unknown VIN.", "not_found", "No vehicle or service records are known for that VIN."), ...AUTH_ERRORS,
          },
        },
      },
      // ── Enrichment ──
      "/v0/enrich": {
        post: {
          tags: ["Enrichment"], operationId: "enrich", summary: "Enrich a VIN on demand",
          description: "POST a VIN we haven't seen (or whose data is stale) and the full enrichment pipeline runs. Fresh cache hits → 200 (free). A scheduled run → 202; poll `GET /v0/enrich?vin=…` until `complete`. Requires the `enrich:write` scope (granted separately).",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["vin"], properties: { vin: { type: "string", example: "2HKRW2H85KH612345" } } } } } },
          responses: {
            "200": { description: "Cache hit or already in-flight.", content: { "application/json": { schema: { $ref: "#/components/schemas/EnrichmentStatus" } } } },
            "202": { description: "Enrichment scheduled (consumes daily quota).", content: { "application/json": { schema: { $ref: "#/components/schemas/EnrichmentQueued" } } } },
            "400": ERR("Bad VIN.", "invalid_vin", "A VIN is exactly 17 characters."),
            "422": ERR("Decoded but unsupported.", "unsupported_vehicle", "The VIN decoded but no engine code could be resolved."),
            ...AUTH_ERRORS,
            // Overrides AUTH_ERRORS' 429 (rate_limited) — enrich's 429 is quota_exceeded.
            "429": ERR("Daily enrichment quota spent.", "quota_exceeded", "Daily enrichment quota (5 scheduled runs/day/key) reached."),
          },
        },
        get: {
          tags: ["Enrichment"], operationId: "enrichStatus", summary: "Poll enrichment status",
          description: "Free status poll for a VIN or config_key.",
          parameters: [{ $ref: "#/components/parameters/vin" }, { $ref: "#/components/parameters/config_key" }],
          responses: {
            "200": { description: "Status.", content: { "application/json": { schema: { $ref: "#/components/schemas/EnrichmentStatus" } } } },
            "400": ERR("Missing identifier.", "missing_param", "Pass ?vin=… or ?config_key=…"),
            "404": ERR("Unknown.", "not_found", "Nothing is known for that identifier — POST /v0/enrich {vin} to enrich it."), ...AUTH_ERRORS,
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", description: "Your key as `Authorization: Bearer otp_live_…`." },
        apiKeyHeader: { type: "apiKey", in: "header", name: "x-api-key", description: "Your key in the `x-api-key` header." },
      },
      parameters: {
        vin: P.vin, config_key: P.configKey, year: P.year, make: P.make, model: P.model, trim: P.trim, service: P.service, include: P.include,
      },
      schemas: {
        Error: { type: "object", properties: { error: { type: "string" }, message: { type: "string" } }, required: ["error", "message"] },
        Layer: { type: "string", enum: ["A", "B", "C", "D", "E", "X"], description: "Provenance layer. A OEM · B licensed DB (excluded) · C web-derived · D empirical · E verified · X flagged (excluded)." },
        Meta: { type: "object", properties: { gate: { type: "string" }, layer_formula: { type: "string" }, generated_at: { type: "integer" } } },
        SpecField: {
          type: "object",
          properties: {
            field: { type: "string", example: "oil_capacity_qts" }, label: { type: "string", example: "Oil capacity (qts)" },
            group: { type: "string", enum: ["Fluids", "Attributes", "Chassis"] }, value: { type: "string", example: "3.7" },
            layer: { $ref: "#/components/schemas/Layer" }, confidence: { type: ["number", "null"], example: 0.9 }, source_domain: { type: ["string", "null"], example: "hondainfo.com" },
          },
        },
        ExcludedField: {
          type: "object",
          properties: { field: { type: "string" }, label: { type: "string" }, blocking_layer: { type: "string", example: "B" }, reason: { type: "string", example: "source_type \"vehicle_databases\" → structured DB" } },
        },
        Engine: {
          type: ["object", "null"],
          properties: { label: { type: ["string", "null"] }, code: { type: ["string", "null"] }, cylinders: { type: ["integer", "null"] }, displacement_l: { type: ["number", "null"] }, aspiration: { type: ["string", "null"] }, fuel_injection: { type: ["string", "null"] } },
        },
        VehicleConfig: {
          type: "object",
          properties: {
            config_key: { type: ["string", "null"] }, year: { type: "integer" }, make: { type: "string" }, model: { type: "string" }, trim: { type: ["string", "null"] },
            chassis_code: { type: ["string", "null"] }, drivetrain: { type: ["string", "null"] }, engine: { $ref: "#/components/schemas/Engine" }, transmission: { type: ["string", "null"] },
            enrichment: { type: "object", properties: { status: { type: ["string", "null"] }, fill_rate: { type: ["number", "null"] }, confidence_avg: { type: ["number", "null"] } } },
          },
          example: CONFIG_EX,
        },
        ConfigBrief: {
          type: "object",
          properties: { config_key: { type: ["string", "null"] }, year: { type: "integer" }, make: { type: "string" }, model: { type: "string" }, trim: { type: ["string", "null"] }, engine: { type: ["string", "null"] }, drivetrain: { type: ["string", "null"] } },
        },
        Tires: {
          type: ["object", "null"],
          properties: {
            options: { type: ["array", "null"], items: { type: "object" } }, front_size: { type: ["string", "null"] }, rear_size: { type: ["string", "null"] },
            pressure_front_psi: { type: ["number", "null"] }, pressure_rear_psi: { type: ["number", "null"] }, is_staggered: { type: ["boolean", "null"] }, is_run_flat: { type: ["boolean", "null"] }, battery_cca: { type: ["number", "null"] }, source: { type: ["string", "null"] },
          },
          example: TIRES_EX,
        },
        Interval: {
          type: "object",
          properties: { service: { type: "string" }, name: { type: "string" }, interval_miles: { type: ["integer", "null"] }, interval_months: { type: ["integer", "null"] }, display: { type: ["string", "null"] }, confidence: { type: ["number", "null"] }, mechanic_verified: { type: "boolean" } },
        },
        Price: { type: ["object", "null"], properties: { amount: { type: "number" }, msrp: { type: ["number", "null"] }, source_domain: { type: ["string", "null"] }, as_of: { type: ["integer", "null"] } } },
        Part: {
          type: "object",
          properties: {
            oem_part_number: { type: "string" }, name: { type: ["string", "null"] }, subcategory: { type: ["string", "null"] }, role: { type: ["string", "null"] }, position: { type: ["string", "null"] },
            quantity: { type: ["number", "null"] }, mechanic_verified: { type: "boolean" }, confidence: { type: ["number", "null"] }, price: { $ref: "#/components/schemas/Price" },
          },
        },
        ServiceEntry: {
          type: "object",
          properties: {
            service: { type: "string" }, name: { type: ["string", "null"] }, applicable: { type: "boolean" },
            parts: { type: "array", items: { $ref: "#/components/schemas/Part" } },
            labor: { type: "object", properties: { hours: { type: ["number", "null"] }, source: { type: "string" }, confidence: { type: ["number", "null"] }, sample_size: { type: ["integer", "null"] }, tier_floor_applied: { type: "boolean" } } },
          },
        },
        VehicleResponse: {
          type: "object",
          properties: {
            object: { type: "string", const: "vehicle" }, config: { $ref: "#/components/schemas/VehicleConfig" },
            specs: { type: "array", items: { $ref: "#/components/schemas/SpecField" } }, excluded: { type: "array", items: { $ref: "#/components/schemas/ExcludedField" } },
            tires: { $ref: "#/components/schemas/Tires" }, intervals: { type: "array", items: { $ref: "#/components/schemas/Interval" } }, services: { type: "array", items: { $ref: "#/components/schemas/ServiceEntry" } },
            history: { type: ["object", "null"], properties: { passport: { type: ["object", "null"] }, visits: { type: "array", items: { type: "object" } } } }, meta: { $ref: "#/components/schemas/Meta" },
          },
          example: { object: "vehicle", config: CONFIG_EX, specs: [...FLUID_FIELDS_EX, ...CHASSIS_FIELDS_EX], excluded: [], tires: TIRES_EX, intervals: INTERVALS_EX, services: [SERVICE_ENTRY_EX], history: null, meta: META_EX },
        },
        FluidsResponse: { type: "object", properties: { object: { type: "string", const: "fluids" }, config: { $ref: "#/components/schemas/VehicleConfig" }, fields: { type: "array", items: { $ref: "#/components/schemas/SpecField" } }, meta: { $ref: "#/components/schemas/Meta" } } },
        SpecsResponse: { type: "object", properties: { object: { type: "string", const: "specs" }, config: { $ref: "#/components/schemas/VehicleConfig" }, fields: { type: "array", items: { $ref: "#/components/schemas/SpecField" } }, excluded: { type: "array", items: { $ref: "#/components/schemas/ExcludedField" } }, meta: { $ref: "#/components/schemas/Meta" } } },
        TiresResponse: { type: "object", properties: { object: { type: "string", const: "tires" }, config: { $ref: "#/components/schemas/VehicleConfig" }, tires: { $ref: "#/components/schemas/Tires" }, meta: { $ref: "#/components/schemas/Meta" } } },
        MaintenanceScheduleResponse: { type: "object", properties: { object: { type: "string", const: "maintenance_schedule" }, config: { $ref: "#/components/schemas/VehicleConfig" }, intervals: { type: "array", items: { $ref: "#/components/schemas/Interval" } }, meta: { $ref: "#/components/schemas/Meta" } } },
        PartsResponse: { type: "object", properties: { object: { type: "string", const: "parts" }, config: { $ref: "#/components/schemas/VehicleConfig" }, services: { type: "array", items: { $ref: "#/components/schemas/ServiceEntry" } }, meta: { $ref: "#/components/schemas/Meta" } } },
        DecodeResponse: { type: "object", properties: { object: { type: "string", const: "decode" }, config: { $ref: "#/components/schemas/VehicleConfig" } } },
        ConfigCandidate: {
          type: "object",
          properties: { config_key: { type: "string" }, year: { type: "integer" }, make: { type: "string" }, model: { type: "string" }, trim: { type: ["string", "null"] }, drivetrain: { type: ["string", "null"] }, engine: { type: ["string", "null"] }, enrichment_status: { type: ["string", "null"] }, fill_rate: { type: ["number", "null"] } },
        },
        ConfigListResponse: { type: "object", properties: { object: { type: "string", const: "config_list" }, year: { type: "integer" }, make: { type: "string" }, model: { type: "string" }, trim: { type: ["string", "null"] }, count: { type: "integer" }, configs: { type: "array", items: { $ref: "#/components/schemas/ConfigCandidate" } } } },
        MaintenanceResponse: { type: "object", properties: { object: { type: "string", const: "maintenance_specs" }, config: { $ref: "#/components/schemas/ConfigBrief" }, fields: { type: "array", items: { $ref: "#/components/schemas/SpecField" } }, excluded: { type: "array", items: { $ref: "#/components/schemas/ExcludedField" } }, meta: { $ref: "#/components/schemas/Meta" } } },
        LaborResponse: {
          type: "object",
          properties: {
            object: { type: "string", const: "empirical_labor" }, config_key: { type: ["string", "null"] },
            services: { type: "array", items: { type: "object", properties: { service: { type: "string" }, name: { type: "string" }, empirical_hours: { type: "number" }, sample_size: { type: ["integer", "null"] }, p25_hours: { type: ["number", "null"] }, p75_hours: { type: ["number", "null"] } } } },
            estimates: { type: "array", items: { type: "object", properties: { service: { type: "string" }, name: { type: "string" }, estimated_hours: { type: "number" }, estimate_source: { type: "string", enum: ["empirical", "model_estimate"] }, estimate_confidence: { type: ["number", "null"] } } } },
            tier: { type: ["string", "null"] }, note: { type: "string" },
          },
        },
        VehicleImageResponse: {
          type: "object",
          properties: { object: { type: "string", const: "vehicle_image" }, config: { $ref: "#/components/schemas/ConfigBrief" }, image: { type: ["object", "null"], properties: { url: { type: "string" }, media_source: { type: "string" }, licensing_note: { type: "string" } } }, meta: { $ref: "#/components/schemas/Meta" } },
        },
        ServiceHistoryResponse: {
          type: "object",
          properties: {
            object: { type: "string", const: "service_history" }, vin: { type: "string" },
            records: { type: "array", items: { type: "object", properties: { date: { type: ["string", "null"] }, mileage: { type: ["integer", "null"] }, source: { type: "string", enum: ["shop_visit", "owner_reported", "document"] }, confidence: { type: ["string", "number", "null"] }, services: { type: "array", items: { type: "string" } }, parts: { type: "array", items: { type: "object" } } } } },
            meta: { type: "object", properties: { record_count: { type: "integer" }, sanitization: { type: "string" }, generated_at: { type: "integer" } } },
          },
        },
        MultipleMatches: { type: "object", properties: { error: { type: "string", const: "multiple_matches" }, message: { type: "string" }, matches: { type: "array", items: { type: "object", properties: { config_key: { type: ["string", "null"] }, label: { type: "string" } } } } } },
        EnrichmentQueued: { type: "object", properties: { object: { type: "string", const: "enrichment" }, status: { type: "string", example: "queued" }, vin: { type: "string" }, poll: { type: "object", properties: { method: { type: "string" }, url: { type: "string" }, interval_seconds: { type: "integer" } } } } },
        EnrichmentStatus: { type: "object", properties: { object: { type: "string" }, status: { type: "string", enum: ["complete", "enriching", "failed", "incomplete"] }, config_key: { type: ["string", "null"] }, enrichment_status: { type: ["string", "null"] }, last_enriched_at: { type: ["integer", "null"] }, fill_rate: { type: ["number", "null"] } } },
      },
    },
  };
}
