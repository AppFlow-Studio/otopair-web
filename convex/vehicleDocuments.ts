/**
 * vehicleDocuments.ts — Shop-receipt upload + Reducto parse pipeline.
 *
 * SURFACE (public, called from mobile):
 *   - generateUploadUrl()           → mutation, signed URL for direct upload to Convex storage
 *   - recordUpload(args)            → mutation, persists metadata + schedules parse action
 *   - listByVin({ vin })            → query, returns docs (+ extractions joined) for a VIN
 *   - confirmExtraction(args)       → mutation, applies user edits, writes maintenance_records
 *   - rejectExtraction({ docId })   → mutation, display-only, no health writes
 *
 * SURFACE (internal, called from vehicleDocuments_node.parseDocument):
 *   - internalGetDocumentMeta       → internalQuery, action reads storageId + vin
 *   - internalSetParseStatus        → internalMutation, action updates parse_status / parse_error
 *   - internalWriteExtraction       → internalMutation, action persists the structured payload
 *
 * The auto-accept threshold is gated upstream in the action; this file only
 * persists the result and routes derivation downstream (see deriveMaintenance).
 */

import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";

const SCHEMA_VERSION = 1;
const AUTO_ACCEPT_THRESHOLD = 0.85;

// ───────────────────────────────────────────────────────────────────────────
// PUBLIC: upload URL
// ───────────────────────────────────────────────────────────────────────────

export const generateUploadUrl = mutation(async (ctx) => {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Not authenticated");
  return await ctx.storage.generateUploadUrl();
});

// ───────────────────────────────────────────────────────────────────────────
// PUBLIC: recordUpload — persist row, schedule parse action
// ───────────────────────────────────────────────────────────────────────────

export const recordUpload = mutation({
  args: {
    storageId: v.id("_storage"),
    vehicleOwnerId: v.id("vehicle_owners"),
    vin: v.string(),
    mimeType: v.string(),
    filename: v.string(),
    sizeBytes: v.number(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", identity.subject))
      .unique();
    if (!user) throw new Error("User not found");

    // Sanity: vehicle_owner must belong to this user.
    const owner = await ctx.db.get(args.vehicleOwnerId);
    if (!owner || owner.user_id !== user._id) {
      throw new Error("Vehicle owner not found for this user");
    }

    const documentId = await ctx.db.insert("vehicle_documents", {
      user_id: user._id,
      vehicle_owner_id: args.vehicleOwnerId,
      vin: args.vin.toUpperCase().trim(),
      storage_id: args.storageId,
      mime_type: args.mimeType,
      original_filename: args.filename,
      size_bytes: args.sizeBytes,
      uploaded_at: Date.now(),
      source: "user_upload",
      parse_status: "queued",
    });

    await ctx.scheduler.runAfter(
      0,
      internal.vehicleDocuments_node.parseDocument,
      { documentId },
    );

    return documentId;
  },
});

// ───────────────────────────────────────────────────────────────────────────
// PUBLIC: listByVin — for VehicleServiceHistory merge
// ───────────────────────────────────────────────────────────────────────────

export const listByVin = query({
  args: { vin: v.string() },
  handler: async (ctx, { vin }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];

    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", identity.subject))
      .unique();
    if (!user) return [];

    const normalized = vin.toUpperCase().trim();
    const docs = await ctx.db
      .query("vehicle_documents")
      .withIndex("by_vin", (q) => q.eq("vin", normalized))
      .collect();

    // Scope to current user. Cheaper than a compound index for the volumes
    // we expect per VIN (single-digit doc count in steady state).
    const mine = docs.filter((d) => d.user_id === user._id);

    return await Promise.all(
      mine.map(async (doc) => {
        const extraction = await ctx.db
          .query("vehicle_document_extractions")
          .withIndex("by_document", (q) => q.eq("document_id", doc._id))
          .order("desc")
          .first();
        const storage_url = await ctx.storage.getUrl(doc.storage_id);
        return { doc, extraction, storage_url };
      }),
    );
  },
});

// ───────────────────────────────────────────────────────────────────────────
// PUBLIC: confirmExtraction — user accepts a needs_review extraction
// ───────────────────────────────────────────────────────────────────────────

export const confirmExtraction = mutation({
  args: {
    documentId: v.id("vehicle_documents"),
    edits: v.optional(v.any()),
  },
  handler: async (ctx, { documentId, edits }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", identity.subject))
      .unique();
    if (!user) throw new Error("User not found");

    const doc = await ctx.db.get(documentId);
    if (!doc || doc.user_id !== user._id) throw new Error("Document not found");

    const extraction = await ctx.db
      .query("vehicle_document_extractions")
      .withIndex("by_document", (q) => q.eq("document_id", documentId))
      .order("desc")
      .first();
    if (!extraction) throw new Error("No parsed extraction to confirm");

    const mergedPayload = edits
      ? { ...(extraction.payload as object), ...(edits as object) }
      : extraction.payload;

    await ctx.db.patch(extraction._id, {
      payload: mergedPayload,
      review_state: "user_confirmed",
      reviewed_at: Date.now(),
      reviewed_by: user._id,
    });
    await ctx.db.patch(documentId, {
      parse_status: "parsed",
      parsed_at: Date.now(),
    });

    // Derivation runs only after confirmation for the needs_review path.
    await ctx.scheduler.runAfter(
      0,
      internal.vehicleDocuments.internalDeriveMaintenance,
      { documentId },
    );

    return { ok: true };
  },
});

// ───────────────────────────────────────────────────────────────────────────
// PUBLIC: rejectExtraction — keep doc visible, skip health writes
// ───────────────────────────────────────────────────────────────────────────

export const rejectExtraction = mutation({
  args: { documentId: v.id("vehicle_documents") },
  handler: async (ctx, { documentId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkUserId", (q) => q.eq("clerkUserId", identity.subject))
      .unique();
    if (!user) throw new Error("User not found");

    const doc = await ctx.db.get(documentId);
    if (!doc || doc.user_id !== user._id) throw new Error("Document not found");

    const extraction = await ctx.db
      .query("vehicle_document_extractions")
      .withIndex("by_document", (q) => q.eq("document_id", documentId))
      .order("desc")
      .first();
    if (extraction) {
      await ctx.db.patch(extraction._id, {
        review_state: "rejected",
        reviewed_at: Date.now(),
        reviewed_by: user._id,
      });
    }
    return { ok: true };
  },
});

// ───────────────────────────────────────────────────────────────────────────
// INTERNAL: surface for the Reducto action
// ───────────────────────────────────────────────────────────────────────────

export const internalGetDocumentMeta = internalQuery({
  args: { documentId: v.id("vehicle_documents") },
  handler: async (ctx, { documentId }) => {
    const doc = await ctx.db.get(documentId);
    if (!doc) return null;
    const url = await ctx.storage.getUrl(doc.storage_id);
    return {
      storageId: doc.storage_id,
      url,
      vin: doc.vin,
      mimeType: doc.mime_type,
      filename: doc.original_filename,
      vehicleOwnerId: doc.vehicle_owner_id,
    };
  },
});

// Bundles everything internalDeriveSemantics (the node action) needs in a
// single read: the confirmed extraction payload plus the resolved vehicles
// catalog row for the doc's VIN (so facts scope to the right car).
export const internalGetSemanticInput = internalQuery({
  args: { documentId: v.id("vehicle_documents") },
  handler: async (ctx, { documentId }) => {
    const doc = await ctx.db.get(documentId);
    if (!doc) return null;

    const extraction = await ctx.db
      .query("vehicle_document_extractions")
      .withIndex("by_document", (q) => q.eq("document_id", documentId))
      .order("desc")
      .first();
    if (!extraction) return null;

    const vehicle = await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q) => q.eq("vin", doc.vin))
      .first();

    return {
      userId: doc.user_id,
      vin: doc.vin,
      vehicleId: vehicle?._id ?? null,
      vehicleConfigId: vehicle?.vehicle_config_id ?? null,
      reviewState: extraction.review_state,
      payload: extraction.payload,
    };
  },
});

export const internalSetParseStatus = internalMutation({
  args: {
    documentId: v.id("vehicle_documents"),
    parseStatus: v.union(
      v.literal("queued"),
      v.literal("parsing"),
      v.literal("parsed"),
      v.literal("needs_review"),
      v.literal("failed"),
    ),
    parseError: v.optional(v.string()),
    reductoJobId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const patch: Record<string, unknown> = { parse_status: args.parseStatus };
    if (args.parseError !== undefined) patch.parse_error = args.parseError;
    if (args.reductoJobId !== undefined) patch.reducto_job_id = args.reductoJobId;
    if (args.parseStatus === "parsed" || args.parseStatus === "needs_review") {
      patch.parsed_at = Date.now();
    }
    await ctx.db.patch(args.documentId, patch);
  },
});

export const internalWriteExtraction = internalMutation({
  args: {
    documentId: v.id("vehicle_documents"),
    payload: v.any(),
    overallConfidence: v.number(),
  },
  handler: async (ctx, { documentId, payload, overallConfidence }) => {
    const autoAccept = overallConfidence >= AUTO_ACCEPT_THRESHOLD;
    const reviewState = autoAccept ? "auto_accepted" : "pending_review";

    await ctx.db.insert("vehicle_document_extractions", {
      document_id: documentId,
      schema_version: SCHEMA_VERSION,
      payload,
      overall_confidence: overallConfidence,
      review_state: reviewState,
      created_at: Date.now(),
    });

    await ctx.db.patch(documentId, {
      parse_status: autoAccept ? "parsed" : "needs_review",
      parsed_at: Date.now(),
    });

    if (autoAccept) {
      await ctx.scheduler.runAfter(
        0,
        internal.vehicleDocuments.internalDeriveMaintenance,
        { documentId },
      );
    }
  },
});

// ───────────────────────────────────────────────────────────────────────────
// INTERNAL: maintenance derivation — writes maintenance_records, bumps
// vehicle_owners.mileage, increments rec_penalty, and merges warning_lights.
// Source for the routing table: plan §"Maintenance-record derivation".
// ───────────────────────────────────────────────────────────────────────────

const OPEN_ISSUE_PENALTY_MAX = 15;
const REC_SEVERITY_POINTS: Record<string, number> = {
  red: 5,
  yellow: 3,
  green: 1,
};

type MaintenanceType = "oil" | "brakes" | "tires" | "battery" | "inspection";

interface LineItem {
  kind?: string;
  description?: string;
  fluid_type?: string;
  viscosity?: string;
  spec?: string;
  brand?: string;
  size?: string;
}

interface BrakeMeasurement {
  position?: string;
  pad_mm?: number;
  rotor_mm?: number;
  condition?: string;
}

interface TireMeasurement {
  position?: string;
  tread_32nds?: number;
  pressure_psi?: number;
  brand?: string;
  size?: string;
  dot_date?: string;
}

interface BatteryTest {
  cca_measured?: number;
  state?: string;
  replaced?: boolean;
  install_date?: string;
}

interface InspectionResult {
  pass?: boolean;
  expiration_date?: string;
}

interface Recommendation {
  description?: string;
  severity?: string;
}

interface ExtractionPayload {
  service_date?: string;
  vehicle?: { odometer_in?: number };
  line_items?: LineItem[];
  brake_measurements?: BrakeMeasurement[];
  tire_measurements?: TireMeasurement[];
  battery_test?: BatteryTest;
  inspection_result?: InspectionResult;
  recommendations?: Recommendation[];
  warning_lights_observed?: string[];
}

function isoToMs(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : t;
}

// DOT tire codes end in WWYY (week + 2-digit year, e.g. "2419" → 2024). Also
// tolerate a plain ISO date or a 4-digit year. Returns a 4-digit year or undefined.
function parseDotYear(dot: string | undefined): number | undefined {
  if (!dot) return undefined;
  const digits = dot.replace(/\D/g, "");
  if (digits.length >= 4) {
    const yy = Number(digits.slice(-2));
    if (!Number.isNaN(yy)) {
      // DOT codes have only run with a 2-digit year since 2000; map to 20xx.
      return 2000 + yy;
    }
  }
  const ms = isoToMs(dot);
  if (ms !== undefined) return new Date(ms).getUTCFullYear();
  return undefined;
}

function matchesAlias(desc: string, aliases: string[]): boolean {
  const lower = desc.toLowerCase();
  return aliases.some((a) => lower.includes(a));
}

// Minimal slug matcher — broader matching lives in
// constants/serviceTaxonomy.ts on the mobile side; this only needs the
// 5 categories that drive maintenance_records.
const OIL_ALIASES = ["oil change", "oil & filter", "lof", "lube"];
const BRAKE_ALIASES = ["brake pad", "rotor", "brake job", "brake service"];
const TIRE_ALIASES = ["tire", "tires", "tyre"];
const BATTERY_ALIASES = ["battery"];
const INSPECTION_ALIASES = ["inspection", "state inspection", "smog"];

function hasService(items: LineItem[] | undefined, aliases: string[]): boolean {
  if (!items) return false;
  return items.some(
    (i) =>
      i.kind === "service" &&
      typeof i.description === "string" &&
      matchesAlias(i.description, aliases),
  );
}

function hasFluidChange(
  items: LineItem[] | undefined,
  fluidType: string,
): boolean {
  if (!items) return false;
  return items.some((i) => i.kind === "fluid" && i.fluid_type === fluidType);
}

interface Derivation {
  type: MaintenanceType;
  customInputs: Record<string, unknown>;
}

function deriveCategories(payload: ExtractionPayload): Derivation[] {
  const out: Derivation[] = [];

  // OIL — fluid change w/ engine_oil or matching service line
  if (
    hasFluidChange(payload.line_items, "engine_oil") ||
    hasService(payload.line_items, OIL_ALIASES)
  ) {
    const oilLine = payload.line_items?.find(
      (i) => i.fluid_type === "engine_oil",
    );
    out.push({
      type: "oil",
      customInputs: {
        viscosity: oilLine?.viscosity,
        spec: oilLine?.spec,
      },
    });
  }

  // BRAKES — explicit measurements or matching service line
  if (
    (payload.brake_measurements && payload.brake_measurements.length > 0) ||
    hasService(payload.line_items, BRAKE_ALIASES)
  ) {
    const padByWheel: Record<string, number | undefined> = {};
    payload.brake_measurements?.forEach((m) => {
      if (m.position) padByWheel[m.position] = m.pad_mm;
    });
    out.push({
      type: "brakes",
      customInputs: {
        brakeFeel: "fine",
        pad_mm_by_wheel: padByWheel,
      },
    });
  }

  // TIRES — measurements or matching service line
  if (
    (payload.tire_measurements && payload.tire_measurements.length > 0) ||
    hasService(payload.line_items, TIRE_ALIASES)
  ) {
    const pressureByWheel: Record<string, number | undefined> = {};
    const treadByWheel: Record<string, number | undefined> = {};
    const dotDateByWheel: Record<string, string | undefined> = {};
    let brand: string | undefined;
    let size: string | undefined;
    let dotYear: number | undefined;
    payload.tire_measurements?.forEach((m) => {
      if (m.position) {
        pressureByWheel[m.position] = m.pressure_psi;
        treadByWheel[m.position] = m.tread_32nds;
        if (m.dot_date) dotDateByWheel[m.position] = m.dot_date;
      }
      if (m.brand) brand = m.brand;
      if (m.size) size = m.size;
      // DOT date is a 4-digit week+year stamp (e.g. "2419" = week 24 of 2024)
      // or a free-form date; keep the freshest 4-digit year we can parse.
      const year = parseDotYear(m.dot_date);
      if (year !== undefined && (dotYear === undefined || year > dotYear)) {
        dotYear = year;
      }
    });
    out.push({
      type: "tires",
      customInputs: {
        tirePressure: pressureByWheel,
        tread_32nds_by_wheel: treadByWheel,
        dot_year: dotYear,
        dot_date_by_wheel: dotDateByWheel,
        brand,
        size,
      },
    });
  }

  // BATTERY — replaced or passed test
  const bt = payload.battery_test;
  if (
    bt?.replaced === true ||
    bt?.state === "pass" ||
    hasService(payload.line_items, BATTERY_ALIASES)
  ) {
    out.push({
      type: "battery",
      customInputs: {
        batteryReplaced: bt?.replaced === true ? "yes" : "no",
        cca_measured: bt?.cca_measured,
      },
    });
  }

  // INSPECTION — passed state inspection
  if (
    payload.inspection_result?.pass === true ||
    hasService(payload.line_items, INSPECTION_ALIASES)
  ) {
    out.push({
      type: "inspection",
      customInputs: {
        expirationDate: payload.inspection_result?.expiration_date,
      },
    });
  }

  return out;
}

function recommendationsPenalty(recs: Recommendation[] | undefined): number {
  if (!recs || recs.length === 0) return 0;
  let total = 0;
  for (const r of recs) {
    const sev = (r.severity ?? "yellow").toLowerCase();
    total += REC_SEVERITY_POINTS[sev] ?? REC_SEVERITY_POINTS.yellow;
  }
  return Math.min(total, OPEN_ISSUE_PENALTY_MAX);
}

export const internalDeriveMaintenance = internalMutation({
  args: { documentId: v.id("vehicle_documents") },
  handler: async (ctx, { documentId }) => {
    const doc = await ctx.db.get(documentId);
    if (!doc) return;

    const extraction = await ctx.db
      .query("vehicle_document_extractions")
      .withIndex("by_document", (q) => q.eq("document_id", documentId))
      .order("desc")
      .first();
    if (!extraction) return;
    if (
      extraction.review_state !== "auto_accepted" &&
      extraction.review_state !== "user_confirmed"
    ) {
      return;
    }

    const payload = extraction.payload as ExtractionPayload;
    const owner = await ctx.db.get(doc.vehicle_owner_id);
    if (!owner) return;

    const serviceDateMs = isoToMs(payload.service_date);
    const odometer = payload.vehicle?.odometer_in;
    const sourceLabel = `doc_parse:${documentId}`;
    const recordConfidence =
      extraction.review_state === "user_confirmed"
        ? "self_reported"
        : "unverified";

    // 1. Write/upsert maintenance_records per derived category
    const derivations = deriveCategories(payload);
    for (const d of derivations) {
      const existing = await ctx.db
        .query("maintenance_records")
        .withIndex("by_vehicle_and_type", (q) =>
          q.eq("vehicleOwnerId", doc.vehicle_owner_id).eq("type", d.type),
        )
        .first();

      const next = {
        vehicleOwnerId: doc.vehicle_owner_id,
        type: d.type,
        lastServiceDate: serviceDateMs,
        lastServiceMileage: odometer,
        customInputs: d.customInputs,
        serviceSource: sourceLabel,
        confidence: recordConfidence,
        updatedAt: Date.now(),
      };

      if (existing) {
        // Don't regress to older data — only overwrite if this doc's date
        // is newer (or the existing row has no date).
        const existingMs =
          typeof existing.lastServiceDate === "number"
            ? existing.lastServiceDate
            : typeof existing.lastServiceDate === "string"
              ? isoToMs(existing.lastServiceDate)
              : undefined;
        if (!existingMs || (serviceDateMs && serviceDateMs >= existingMs)) {
          await ctx.db.patch(existing._id, next);
        }
      } else {
        await ctx.db.insert("maintenance_records", {
          ...next,
          createdAt: Date.now(),
        });
      }
    }

    // 2. Bump vehicle_owners.mileage if odometer_in is newer
    const ownerPatch: Record<string, unknown> = {};
    if (
      typeof odometer === "number" &&
      odometer > 0 &&
      (owner.mileage === undefined || odometer > owner.mileage)
    ) {
      ownerPatch.mileage = odometer;
    }

    // 3. Increment health_score_rec_penalty (capped)
    const addedPenalty = recommendationsPenalty(payload.recommendations);
    if (addedPenalty > 0) {
      const current = owner.health_score_rec_penalty ?? 0;
      ownerPatch.health_score_rec_penalty = Math.min(
        OPEN_ISSUE_PENALTY_MAX,
        current + addedPenalty,
      );
      ownerPatch.health_score_rec_penalty_updated_at = Date.now();
    }

    // 4. Merge warning_lights into knownIssues
    const observed = payload.warning_lights_observed;
    if (observed && observed.length > 0) {
      const existing = Array.isArray(owner.knownIssues)
        ? (owner.knownIssues as string[])
        : [];
      const cleaned = existing.filter((x) => x !== "none_lit");
      const merged = Array.from(new Set([...cleaned, ...observed]));
      ownerPatch.knownIssues = merged;
    }

    if (Object.keys(ownerPatch).length > 0) {
      await ctx.db.patch(doc.vehicle_owner_id, ownerPatch);
    }

    // 5. (B3) Odometer-history backfill — record the receipt's mileage point.
    // Idempotent: skip if a row already exists at this exact recordedAt so
    // re-deriving a confirmed doc doesn't duplicate the data point.
    if (
      typeof odometer === "number" &&
      odometer > 0 &&
      typeof serviceDateMs === "number"
    ) {
      const dupe = await ctx.db
        .query("odometer_history")
        .withIndex("by_vehicle_and_date", (q) =>
          q
            .eq("vehicleOwnerId", doc.vehicle_owner_id)
            .eq("recordedAt", serviceDateMs),
        )
        .first();
      if (!dupe) {
        await ctx.db.insert("odometer_history", {
          vehicleOwnerId: doc.vehicle_owner_id,
          distance: odometer,
          unit: "mi",
          recordedAt: serviceDateMs,
        });
      }
    }

    // 6. (B6 + B1/B10) Semantic derivation — engine/fluid specs → vehicle_facts,
    // mechanic findings + customer concern → user_semantic_facts. Runs in an
    // action (async SHA-256 for canonical keys + payload sanitizer that may
    // throw), scheduled so a rejection there can't roll back the writes above.
    await ctx.scheduler.runAfter(
      0,
      internal.vehicleDocuments_node.internalDeriveSemantics,
      { documentId },
    );
  },
});
