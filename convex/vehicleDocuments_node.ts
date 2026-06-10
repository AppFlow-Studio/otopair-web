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

const REDUCTO_BASE = "https://platform.reducto.ai";
const REQUEST_TIMEOUT_MS = 60_000;
const REQUIRED_FIELDS_FOR_CONFIDENCE = [
  "document_type",
  "service_date",
  "shop.name",
  "vehicle.odometer_in",
  "total_cents",
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
  result?: Array<Record<string, unknown>>;
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
      body: JSON.stringify({
        input: documentUrl,
        instructions: { schema: RECEIPT_EXTRACTION_SCHEMA },
        settings: {
          array_extract: { enabled: true },
          citations: { enabled: true },
        },
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Reducto /extract ${res.status}: ${errBody}`);
    }

    const body = (await res.json()) as ReductoExtractResponse;
    const first = body.result?.[0];
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
