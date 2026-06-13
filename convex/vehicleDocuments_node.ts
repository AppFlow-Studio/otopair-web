/**
 * vehicleDocuments_node.ts — Reducto-driven document parser (Node runtime).
 *
 * Action surface:
 *   - parseDocument({ documentId })  → internalAction, called from
 *     vehicleDocuments.recordUpload via the scheduler.
 *
 * Flow:
 *   1. Read upload metadata (vin, signed storage URL).
 *   2. Mark parse_status = "parsing".
 *   3. POST file URL + extraction schema to Reducto /extract.
 *   4. Compute overall_confidence (min over required fields).
 *   5. Call internalWriteExtraction — that mutation handles auto_accepted vs
 *      pending_review routing per AUTO_ACCEPT_THRESHOLD.
 *   6. On non-2xx or schema mismatch → mark "failed" with parse_error.
 *
 * The Reducto contract (see RECEIPT_EXTRACTION_SCHEMA below) mirrors the
 * extraction spec in the plan. Field names use the same casing as the spec
 * so downstream derivation can map 1:1.
 */

"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { canonicalQuestionKey } from "./oto/canonicalize";

const REDUCTO_BASE = "https://platform.reducto.ai";
const REQUEST_TIMEOUT_MS = 60_000;
const CLASSIFY_TIMEOUT_MS = 30_000;
const REQUIRED_FIELDS_FOR_CONFIDENCE = [
  "document_type",
  "service_date",
  "shop.name",
  "vehicle.odometer_in",
  "total_cents",
] as const;

// ───────────────────────────────────────────────────────────────────────────
// Pre-parse classification (A2) — a cheap /classify call gates the expensive
// /extract. If a document is confidently NOT vehicle-related, we short-circuit
// before spending extract credits. The gate is fail-OPEN: any classify error,
// ambiguity, or unexpected response shape proceeds to extract, so a real
// receipt is never dropped on a classifier hiccup.
// ───────────────────────────────────────────────────────────────────────────

const VEHICLE_DOC_CATEGORY = "vehicle_service_document";
const OTHER_DOC_CATEGORY = "other_document";
// Only reject when the winning category is "other" with at least this much
// confidence. Tuned above the ~0.5 a blank/ambiguous doc scores so uncertain
// scans fall through to extract rather than being rejected.
const CLASSIFY_REJECT_CONFIDENCE = 0.6;

const CLASSIFICATION_CATEGORIES = [
  {
    category: VEHICLE_DOC_CATEGORY,
    criteria: [
      "mentions a vehicle, car, truck, VIN, license plate, or odometer reading",
      "lists automotive repair or maintenance services, parts, or labor",
      "issued by an auto repair shop, dealership, tire shop, or service center",
      "is a state vehicle inspection or emissions report",
    ],
  },
  {
    category: OTHER_DOC_CATEGORY,
    criteria: [
      "not related to vehicles, auto repair, or maintenance",
      "e.g. a utility bill, restaurant receipt, medical record, or general retail purchase",
    ],
  },
] as const;

// ───────────────────────────────────────────────────────────────────────────
// JSON SCHEMA (the parser contract — mirrors plan Sections A–J)
// ───────────────────────────────────────────────────────────────────────────

const RECEIPT_EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    document_type: {
      type: "string",
      enum: [
        "service_invoice",
        "inspection_report",
        "tire_receipt",
        "oil_change_receipt",
        "quote_estimate",
        "warranty_doc",
        "other",
      ],
    },
    service_date: { type: "string", description: "ISO date (YYYY-MM-DD)" },
    invoice_number: { type: "string" },
    language: { type: "string" },
    currency: { type: "string", default: "USD" },

    shop: {
      type: "object",
      properties: {
        name: { type: "string" },
        street: { type: "string" },
        city: { type: "string" },
        state: { type: "string" },
        zip: { type: "string" },
        phone: { type: "string" },
        email: { type: "string" },
        website: { type: "string" },
        labor_rate_hourly: { type: "number" },
      },
    },
    technician: {
      type: "object",
      properties: {
        name: { type: "string" },
        cert: { type: "string" },
      },
    },
    service_advisor: {
      type: "object",
      properties: { name: { type: "string" } },
    },

    vehicle: {
      type: "object",
      properties: {
        vin: { type: "string" },
        year: { type: "number" },
        make: { type: "string" },
        model: { type: "string" },
        trim: { type: "string" },
        license_plate: { type: "string" },
        plate_state: { type: "string" },
        odometer_in: { type: "number" },
        odometer_out: { type: "number" },
        engine_code: { type: "string" },
      },
    },

    customer_concern: { type: "string" },
    technician_findings: { type: "string" },
    corrections_performed: { type: "string" },

    line_items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: [
              "service",
              "part",
              "fluid",
              "tax",
              "discount",
              "shop_supplies",
              "disposal_fee",
              "tip",
            ],
          },
          description: { type: "string" },
          raw_text: { type: "string" },
          qty: { type: "number" },
          unit_price_cents: { type: "number" },
          line_total_cents: { type: "number" },
          labor_hours: { type: "number" },
          labor_rate_cents: { type: "number" },
          oem_number: { type: "string" },
          brand: { type: "string" },
          part_tier: {
            type: "string",
            enum: ["oem", "aftermarket", "oe", "economy"],
          },
          warranty_months: { type: "number" },
          fluid_type: {
            type: "string",
            enum: [
              "engine_oil",
              "atf",
              "coolant",
              "brake",
              "power_steering",
              "differential",
              "transfer_case",
            ],
          },
          viscosity: { type: "string" },
          spec: { type: "string" },
          quantity_qts: { type: "number" },
        },
        required: ["kind", "description"],
      },
    },

    parts_subtotal_cents: { type: "number" },
    labor_subtotal_cents: { type: "number" },
    tax_cents: { type: "number" },
    discounts_cents: { type: "number" },
    shop_supplies_cents: { type: "number" },
    total_cents: { type: "number" },

    brake_measurements: {
      type: "array",
      items: {
        type: "object",
        properties: {
          position: { type: "string", enum: ["fl", "fr", "rl", "rr"] },
          pad_mm: { type: "number" },
          rotor_mm: { type: "number" },
          condition: { type: "string", enum: ["red", "yellow", "green"] },
        },
      },
    },
    tire_measurements: {
      type: "array",
      items: {
        type: "object",
        properties: {
          position: { type: "string", enum: ["fl", "fr", "rl", "rr"] },
          tread_32nds: { type: "number" },
          pressure_psi: { type: "number" },
          brand: { type: "string" },
          model: { type: "string" },
          size: { type: "string" },
          dot_date: { type: "string" },
        },
      },
    },
    battery_test: {
      type: "object",
      properties: {
        cca_measured: { type: "number" },
        cca_rated: { type: "number" },
        voltage: { type: "number" },
        state: { type: "string", enum: ["pass", "weak", "fail"] },
        replaced: { type: "boolean" },
        install_date: { type: "string" },
      },
    },
    alignment: {
      type: "object",
      properties: {
        performed: { type: "boolean" },
        before: { type: "object" },
        after: { type: "object" },
      },
    },
    fluids_serviced: {
      type: "array",
      items: {
        type: "object",
        properties: {
          fluid_type: { type: "string" },
          action: {
            type: "string",
            enum: ["change", "top_off", "flush"],
          },
          notes: { type: "string" },
        },
      },
    },
    filters_replaced: {
      type: "array",
      items: {
        type: "string",
        enum: ["engine_air", "cabin", "oil", "fuel", "transmission"],
      },
    },
    wiper_blades_replaced: { type: "boolean" },
    spark_plugs_replaced: {
      type: "object",
      properties: {
        count: { type: "number" },
        gap_mm: { type: "number" },
        brand: { type: "string" },
      },
    },
    belts_inspected: {
      type: "object",
      properties: {
        serpentine: { type: "string" },
        timing: { type: "string" },
      },
    },
    inspection_result: {
      type: "object",
      properties: {
        pass: { type: "boolean" },
        expiration_date: { type: "string" },
        state: { type: "string" },
        sticker_number: { type: "string" },
      },
    },
    dtcs_observed: {
      type: "array",
      items: {
        type: "object",
        properties: {
          code: { type: "string" },
          description: { type: "string" },
          status: {
            type: "string",
            enum: ["stored", "pending", "history"],
          },
        },
      },
    },
    warning_lights_observed: {
      type: "array",
      items: {
        type: "string",
        enum: [
          "oil_pressure",
          "temperature",
          "check_engine",
          "battery_charging",
          "abs",
          "airbag_srs",
          "transmission",
          "tpms",
        ],
      },
    },

    recommendations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          description: { type: "string" },
          severity: { type: "string", enum: ["red", "yellow", "green"] },
          est_cost_cents: { type: "number" },
        },
        required: ["description"],
      },
    },
  },
  required: ["document_type", "service_date", "total_cents"],
} as const;

// ───────────────────────────────────────────────────────────────────────────
// Reducto extract call
//
// Real response shape (validated against an actual auto-shop invoice run via
// the Reducto MCP — see /Users/.../tool-results/toolu_01Jpm8mSjdnPiCzn83zyXPxz.json):
//
//   {
//     job_id, studio_link,
//     usage: { num_pages, num_fields, credits },
//     result: [               // ← array, even for single-doc extractions
//       {                     // ← the extraction; with citations=true every
//                             //   leaf is wrapped as { value, citations[] }
//         document_type: { value: "...", citations: [{ granular_confidence: { extract_confidence: 0.98 } }] },
//         shop: { name: { value: "...", citations: [...] }, ... },
//         line_items: [ { kind: { value: "..." }, ... }, ... ],
//         ...
//       }
//     ]
//   }
//
// We send citations=true to get per-field extract_confidence, then unwrap
// values for storage and aggregate confidences into a flat map keyed by
// dotted path (mirrors REQUIRED_FIELDS_FOR_CONFIDENCE).
// ───────────────────────────────────────────────────────────────────────────

interface ReductoCitation {
  confidence?: "high" | "low";
  granular_confidence?: {
    extract_confidence?: number | null;
    parse_confidence?: number | null;
  };
}

interface ReductoWrappedValue {
  value: unknown;
  citations?: ReductoCitation[];
}

interface ReductoExtractResponse {
  job_id?: string;
  studio_link?: string;
  // Without `settings.array_extract`, /extract returns the extraction as a
  // SINGLE object; with it, an array. We send a single-receipt schema, so the
  // object form is the norm — but accept both (Reducto's docs warn the result
  // "may be a single object or an array depending on the schema").
  result?: Record<string, unknown> | Array<Record<string, unknown>>;
  usage?: { num_pages?: number; num_fields?: number; credits?: number };
}

/** True if shape is `{ value, citations }`. */
function isWrappedValue(v: unknown): v is ReductoWrappedValue {
  return (
    typeof v === "object" &&
    v !== null &&
    "value" in (v as Record<string, unknown>) &&
    "citations" in (v as Record<string, unknown>)
  );
}

/** Walk the wrapped extraction and produce (a) a clean payload with raw
 *  values and (b) a flat confidence map keyed by dotted path. */
function unwrapExtraction(
  node: unknown,
  path: string,
  confidenceMap: Record<string, number>,
): unknown {
  if (Array.isArray(node)) {
    return node.map((item, i) => unwrapExtraction(item, `${path}[${i}]`, confidenceMap));
  }
  if (isWrappedValue(node)) {
    const ec = node.citations?.[0]?.granular_confidence?.extract_confidence;
    if (typeof ec === "number") confidenceMap[path] = ec;
    return unwrapExtraction(node.value, path, confidenceMap);
  }
  if (typeof node === "object" && node !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      const sub = path ? `${path}.${k}` : k;
      out[k] = unwrapExtraction(v, sub, confidenceMap);
    }
    return out;
  }
  return node;
}

async function callReductoExtract(
  apiKey: string,
  documentUrl: string,
): Promise<{
  payload: Record<string, unknown>;
  confidenceMap: Record<string, number>;
  jobId?: string;
}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(`${REDUCTO_BASE}/extract`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      // Reducto's live /extract reads the JSON schema from `instructions.schema`.
      // A top-level `schema` field is SILENTLY IGNORED — the API returns 200 but
      // falls back to generic auto-extraction (company_name / total_amount_due /
      // invoice_line_items…), so none of our keys (shop, *_subtotal_cents,
      // line_items) populate and the receipt renders empty. Do NOT add
      // `settings.array_extract`: it routes the body onto the legacy config path
      // that 422s ("Legacy config requires async_config.enabled=true"); we want a
      // single receipt object (line_items is a nested array), not row extraction.
      // `settings.citations.enabled` wraps each leaf as { value, citations[] } so
      // unwrapExtraction() can harvest per-field extract_confidence.
      body: JSON.stringify({
        input: documentUrl,
        instructions: { schema: RECEIPT_EXTRACTION_SCHEMA },
        settings: { citations: { enabled: true } },
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Reducto /extract ${res.status}: ${errBody}`);
    }

    const body = (await res.json()) as ReductoExtractResponse;
    const first = Array.isArray(body.result) ? body.result[0] : body.result;
    if (!first) throw new Error("Reducto returned no extraction result");

    const confidenceMap: Record<string, number> = {};
    const payload = unwrapExtraction(first, "", confidenceMap) as Record<
      string,
      unknown
    >;

    return {
      payload,
      confidenceMap,
      jobId: body.job_id,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/** Walk a dotted path through a payload object. */
function readPath(obj: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object" && key in (acc as object)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

function computeOverallConfidence(
  payload: Record<string, unknown>,
  confidenceMap: Record<string, number>,
): number {
  const required = REQUIRED_FIELDS_FOR_CONFIDENCE;
  let min = 1;
  let counted = 0;
  for (const field of required) {
    const value = readPath(payload, field);
    if (value === undefined || value === null || value === "") {
      // Missing required field caps overall confidence at 0.5
      min = Math.min(min, 0.5);
      continue;
    }
    const c = confidenceMap[field];
    if (typeof c === "number") {
      min = Math.min(min, c);
      counted++;
    }
  }
  // If Reducto didn't return per-field confidence, default to 0.9 when all
  // required fields are present (rely on auto-accept threshold to gate).
  if (counted === 0 && min === 1) return 0.9;
  return min;
}

// ───────────────────────────────────────────────────────────────────────────
// Reducto classify call (A2 pre-parse gate)
// ───────────────────────────────────────────────────────────────────────────

interface CategoryConfidence {
  category: string;
  confidence: number;
}

/** Pull a flat [{category, confidence}] list out of whatever shape the
 *  /classify endpoint returns (raw shape isn't pinned in the docs). Handles:
 *  a top-level `category_confidences` array, a `result` array, a
 *  `result.category_confidences`, or a single `{category}` + `response_confidence`. */
function readCategoryConfidences(body: Record<string, unknown>): CategoryConfidence[] {
  const coerce = (arr: unknown): CategoryConfidence[] =>
    Array.isArray(arr)
      ? arr
          .map((e) => {
            const o = (e ?? {}) as Record<string, unknown>;
            const category = typeof o.category === "string" ? o.category : undefined;
            const confidence =
              typeof o.confidence === "number" ? o.confidence : undefined;
            return category !== undefined && confidence !== undefined
              ? { category, confidence }
              : null;
          })
          .filter((x): x is CategoryConfidence => x !== null)
      : [];

  const top = coerce(body.category_confidences);
  if (top.length) return top;

  const result = body.result as Record<string, unknown> | unknown[] | undefined;
  if (Array.isArray(result)) {
    const fromResult = coerce(result);
    if (fromResult.length) return fromResult;
  } else if (result && typeof result === "object") {
    const nested = coerce((result as Record<string, unknown>).category_confidences);
    if (nested.length) return nested;
    const category =
      typeof (result as Record<string, unknown>).category === "string"
        ? ((result as Record<string, unknown>).category as string)
        : undefined;
    const confidence =
      typeof body.response_confidence === "number" ? body.response_confidence : 1;
    if (category) return [{ category, confidence }];
  }

  // Top-level single-category fallback.
  if (typeof body.category === "string") {
    const confidence =
      typeof body.response_confidence === "number" ? body.response_confidence : 1;
    return [{ category: body.category, confidence }];
  }
  return [];
}

/** Fail-open classify: returns whether to reject the doc as non-vehicle.
 *  Never throws — on any error/timeout/odd-shape it returns { reject:false }. */
async function classifyDocument(
  apiKey: string,
  documentUrl: string,
): Promise<{ reject: boolean; category?: string; confidence?: number; jobId?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CLASSIFY_TIMEOUT_MS);
  try {
    const res = await fetch(`${REDUCTO_BASE}/classify`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      // Mirrors the working extract contract: flat body with the same field
      // names the Reducto MCP / published curl example use.
      body: JSON.stringify({
        document_url: documentUrl,
        categories: CLASSIFICATION_CATEGORIES,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[vehicleDocuments] classify ${res.status}; proceeding to extract`);
      return { reject: false };
    }
    const body = (await res.json()) as Record<string, unknown>;
    const confidences = readCategoryConfidences(body);
    if (confidences.length === 0) {
      console.warn("[vehicleDocuments] classify returned no usable categories; proceeding");
      return { reject: false };
    }
    const winner = confidences.reduce((a, b) => (b.confidence > a.confidence ? b : a));
    const jobId = typeof body.job_id === "string" ? body.job_id : undefined;
    const reject =
      winner.category === OTHER_DOC_CATEGORY &&
      winner.confidence >= CLASSIFY_REJECT_CONFIDENCE;
    return { reject, category: winner.category, confidence: winner.confidence, jobId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[vehicleDocuments] classify failed (${message}); proceeding to extract`);
    return { reject: false };
  } finally {
    clearTimeout(timeout);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// ACTION
// ───────────────────────────────────────────────────────────────────────────

export const parseDocument = internalAction({
  args: { documentId: v.id("vehicle_documents") },
  handler: async (ctx, { documentId }) => {
    const apiKey = process.env.REDUCTO_API_KEY;
    if (!apiKey) {
      await ctx.runMutation(internal.vehicleDocuments.internalSetParseStatus, {
        documentId,
        parseStatus: "failed",
        parseError: "REDUCTO_API_KEY not set in Convex env",
      });
      return;
    }

    const meta = await ctx.runQuery(
      internal.vehicleDocuments.internalGetDocumentMeta,
      { documentId },
    );
    if (!meta || !meta.url) {
      await ctx.runMutation(internal.vehicleDocuments.internalSetParseStatus, {
        documentId,
        parseStatus: "failed",
        parseError: "Document or storage URL missing",
      });
      return;
    }

    await ctx.runMutation(internal.vehicleDocuments.internalSetParseStatus, {
      documentId,
      parseStatus: "parsing",
    });

    // A2 — pre-parse classification gate. Reject confidently non-vehicle docs
    // (e.g. a phone bill uploaded by mistake) before paying for /extract.
    // Fail-open: classifyDocument never throws, so a classifier hiccup just
    // falls through to extract.
    const classification = await classifyDocument(apiKey, meta.url);
    if (classification.reject) {
      await ctx.runMutation(internal.vehicleDocuments.internalSetParseStatus, {
        documentId,
        parseStatus: "failed",
        parseError: "Not a vehicle service document",
      });
      return;
    }

    try {
      const { payload, confidenceMap, jobId } = await callReductoExtract(
        apiKey,
        meta.url,
      );

      // VIN sanity: if extracted VIN doesn't match the upload's VIN, drop
      // overall confidence so it routes to review.
      const extractedVin = (
        (payload.vehicle as Record<string, unknown> | undefined)?.vin ??
        ""
      ) as string;
      const vinMismatch =
        extractedVin && extractedVin.toUpperCase().trim() !== meta.vin;

      let overallConfidence = computeOverallConfidence(payload, confidenceMap);
      if (vinMismatch) overallConfidence = Math.min(overallConfidence, 0.6);

      if (jobId) {
        await ctx.runMutation(
          internal.vehicleDocuments.internalSetParseStatus,
          { documentId, parseStatus: "parsing", reductoJobId: jobId },
        );
      }

      await ctx.runMutation(
        internal.vehicleDocuments.internalWriteExtraction,
        {
          documentId,
          payload: { ...payload, _confidence_map: confidenceMap },
          overallConfidence,
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await ctx.runMutation(internal.vehicleDocuments.internalSetParseStatus, {
        documentId,
        parseStatus: "failed",
        parseError: message.slice(0, 500),
      });
    }
  },
});

// ───────────────────────────────────────────────────────────────────────────
// SEMANTIC DERIVATION (V2 Wave 1 — B6 + B1/B10)
//
// Runs after internalDeriveMaintenance (scheduled from its tail). Two writes:
//   B1/B10 — customer_concern + technician_findings → user_semantic_facts
//            (surfaces in Oto's <recent_context> with no prompt change).
//   B6     — engine_code + oil viscosity → vehicle_facts canonical KB.
//
// This lives in the node action (not the mutation) because canonical_question_key
// needs async SHA-256 and the semantic-fact helper runs a payload sanitizer that
// throws. Each write is scheduled (runAfter 0) so a single rejection is isolated
// and can't roll back the maintenance/odometer writes that already committed.
// ───────────────────────────────────────────────────────────────────────────

const SEMANTIC_PAYLOAD_MAX = 480;

function str(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function datePrefix(serviceDate: unknown): string {
  const d = str(serviceDate);
  return d ? `[${d}] ` : "";
}

export const internalDeriveSemantics = internalAction({
  args: { documentId: v.id("vehicle_documents") },
  handler: async (ctx, { documentId }) => {
    const input = await ctx.runQuery(
      internal.vehicleDocuments.internalGetSemanticInput,
      { documentId },
    );
    if (!input) return;
    // Only derive from extractions the system or the user has accepted.
    if (
      input.reviewState !== "auto_accepted" &&
      input.reviewState !== "user_confirmed"
    ) {
      return;
    }

    const payload = (input.payload ?? {}) as Record<string, any>;
    const vehicle = (payload.vehicle ?? {}) as Record<string, any>;
    const vehicleId = input.vehicleId ?? undefined;
    const vehicleConfigId = input.vehicleConfigId ?? undefined;

    // ── B1/B10 — verbatim findings + concern → user_semantic_facts ──────────
    const semanticWrites: Array<{ label: string; text: string }> = [];
    const concern = str(payload.customer_concern);
    if (concern) {
      semanticWrites.push({
        label: "Customer concern",
        text: concern,
      });
    }
    const findings = str(payload.technician_findings);
    if (findings) {
      semanticWrites.push({
        label: "Mechanic findings",
        text: findings,
      });
    }
    for (const w of semanticWrites) {
      const body = `${datePrefix(payload.service_date)}${w.label}: ${w.text}`;
      const payloadText = body.slice(0, SEMANTIC_PAYLOAD_MAX);
      // Scheduled — recordUserSemanticFact sanitizes and may throw; isolate it.
      await ctx.scheduler.runAfter(
        0,
        internal.oto.memoryEditing.recordUserSemanticFact,
        {
          user_id: input.userId,
          ...(vehicleId ? { vehicle_id: vehicleId } : {}),
          fact_type: "history_anchor" as const,
          payload: payloadText,
          source: "inferred_behavior" as const,
          written_by: "system" as const,
        },
      );
    }

    // ── B6 — confirmed hardware/fluid specs → vehicle_facts canonical KB ─────
    // Require make + model so question_text encodes vehicle identity; the KB
    // dedups globally on canonical_question_key, so a generic question would
    // collide across vehicles. Scope fields (config id, engine, make/model/year)
    // mirror the chat-agent writer in oto/chat.ts.
    const make = str(vehicle.make);
    const model = str(vehicle.model);
    const year =
      typeof vehicle.year === "number" && Number.isFinite(vehicle.year)
        ? vehicle.year
        : undefined;

    if (make && model) {
      const vehicleLabel = `${year ? `${year} ` : ""}${make} ${model}`;
      const scope = {
        ...(vehicleConfigId ? { vehicle_config_id: vehicleConfigId } : {}),
        make,
        model,
        ...(year !== undefined ? { year_min: year, year_max: year } : {}),
      };

      const factWrites: Array<{
        topic: string;
        topic_axis: "vehicle" | "engine";
        question_text: string;
        fact_text: string;
        engine_code?: string;
      }> = [];

      const engineCode = str(vehicle.engine_code);
      if (engineCode) {
        factWrites.push({
          topic: "engine_code",
          topic_axis: "engine",
          question_text: `What engine code does the ${vehicleLabel} use?`,
          fact_text: `Engine code ${engineCode}, confirmed from the owner's shop invoice.`,
          engine_code: engineCode,
        });
      }

      // Oil viscosity from the engine_oil line item (B6).
      const lineItems: any[] = Array.isArray(payload.line_items)
        ? payload.line_items
        : [];
      const oilLine = lineItems.find((i) => i?.fluid_type === "engine_oil");
      const viscosity = str(oilLine?.viscosity);
      if (viscosity) {
        const spec = str(oilLine?.spec);
        factWrites.push({
          topic: "fluid_spec_oil",
          topic_axis: "vehicle",
          question_text: `What engine oil viscosity does the ${vehicleLabel} use?`,
          fact_text: `Owner's shop invoice lists ${viscosity} engine oil${
            spec ? ` (${spec})` : ""
          }.`,
        });
      }

      for (const f of factWrites) {
        const key = await canonicalQuestionKey(f.question_text);
        await ctx.scheduler.runAfter(
          0,
          internal.oto.vehicleFactsEditing.recordVehicleFact,
          {
            topic: f.topic,
            topic_axis: f.topic_axis,
            question_text: f.question_text,
            fact_text: f.fact_text,
            canonical_question_key: key,
            source: "user_confirmed" as const,
            written_by: "system" as const,
            confidence: 0.9,
            ...(f.engine_code ? { engine_code: f.engine_code } : {}),
            ...scope,
            asked_by_user_id: input.userId,
          },
        );
      }
    }
  },
});
