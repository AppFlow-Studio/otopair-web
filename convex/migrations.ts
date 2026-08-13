import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
// One-shot backfill: any job_actuals row that already has a postjob_report
// submitted but never got finalized_at_ms stamped (because completeWithPostjob
// used to skip the finalize step) gets retroactively closed. Clears the
// historical "Needs Attention" backlog without rewriting any data values.
export const backfillFinalizePostjobActuals = mutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("job_actuals").collect();
    let patched = 0;
    for (const row of rows) {
      if (row.finalized_at_ms != null) continue;
      if (!row.postjob_report) continue;
      const stamp =
        row.logged_at_ms ??
        row.completed_at_ms ??
        row.updated_at ??
        Date.now();
      await ctx.db.patch(row._id, { finalized_at_ms: stamp });
      patched++;
    }
    return { patched, scanned: rows.length };
  },
});

// One-shot backfill for the new time_slots.block_kind discriminator. Any
// existing row that was a legitimate manual block (has title or note set)
// gets classified so the tightened getManualBlockedSlotsForShop predicate
// still recognises it. Rows with no title/note and no booking link are
// treated as orphans and left unflagged.
export const backfillTimeSlotBlockKind = mutation({
  args: {},
  handler: async (ctx) => {
    const slots = await ctx.db.query("time_slots").collect();
    let manual = 0;
    let reserved = 0;
    for (const slot of slots) {
      if (slot.is_available) continue;
      if (slot.block_kind !== undefined) continue;
      const hasTitle = slot.title !== undefined && slot.title !== null && slot.title !== "";
      const hasNote = slot.note !== undefined && slot.note !== null && slot.note !== "";
      if (!hasTitle && !hasNote) continue;
      if (slot.title === "Reserved pending customer approval") {
        await ctx.db.patch(slot._id, { block_kind: "reserved_pending" });
        reserved += 1;
      } else {
        await ctx.db.patch(slot._id, { block_kind: "manual" });
        manual += 1;
      }
    }
    return { manual, reserved, scanned: slots.length };
  },
});

export const backfillModelMakeId = mutation({
  args: { makeId: v.id("makes") },
  handler: async (ctx, args) => {
    const models = await ctx.db.query("models").collect();
    let updated = 0;

    for (const model of models) {
      if (model.make_id === undefined || model.make_id === null) {
        await ctx.db.patch(model._id, { make_id: args.makeId });
        updated += 1;
      }
    }

    return { updated };
  },
});

export const backfillBookingAssignmentPreferenceAny = mutation({
  args: {},
  handler: async (ctx) => {
    const bookings = await ctx.db.query("bookings").collect();
    let updated = 0;

    for (const booking of bookings) {
      if (booking.assignment_preference === undefined) {
        await ctx.db.patch(booking._id, { assignment_preference: "any" });
        updated += 1;
      }
    }

    return { updated };
  },
});

/**
 * Ensure has_options=true on the services that need driver-side option selection
 * (brake pads, brake rotors, tire rotation, etc.) and (re)seed their service_options
 * with the correct labels. Idempotent — safe to re-run.
 *
 * Run: npx convex run migrations:backfillServiceOptions
 */
export const backfillServiceOptions = mutation({
  args: {},
  handler: async (ctx) => {
    const PLAN: Array<{
      slug: string;
      options: Array<{
        option_type: string;
        option_label: string;
        labor_hours: number;
        parts_cost_low: number;
        parts_cost_high: number;
        display_order: number;
      }>;
    }> = [
      {
        slug: "brake-pad-replacement",
        options: [
          { option_type: "position", option_label: "Front", labor_hours: 0.8, parts_cost_low: 75, parts_cost_high: 95, display_order: 1 },
          { option_type: "position", option_label: "Rear", labor_hours: 0.8, parts_cost_low: 55, parts_cost_high: 75, display_order: 2 },
          { option_type: "position", option_label: "Front and rear", labor_hours: 1.5, parts_cost_low: 130, parts_cost_high: 170, display_order: 3 },
        ],
      },
      {
        slug: "brake-rotor-replacement",
        options: [
          { option_type: "position", option_label: "Front", labor_hours: 1.2, parts_cost_low: 200, parts_cost_high: 260, display_order: 1 },
          { option_type: "position", option_label: "Rear", labor_hours: 1.2, parts_cost_low: 170, parts_cost_high: 220, display_order: 2 },
          { option_type: "position", option_label: "Front and rear", labor_hours: 2.2, parts_cost_low: 370, parts_cost_high: 480, display_order: 3 },
        ],
      },
      {
        // Tire rotation: pick which tires are being moved. Most rotations are
        // all 4; per-pair options support shops that only have time/budget
        // for a partial rotation (e.g. matched-pair replacement scenarios).
        slug: "tire-rotation",
        options: [
          { option_type: "tire_set", option_label: "All 4 tires", labor_hours: 0.3, parts_cost_low: 0, parts_cost_high: 0, display_order: 1 },
          { option_type: "tire_set", option_label: "All 4 tires + balance", labor_hours: 0.9, parts_cost_low: 8, parts_cost_high: 12, display_order: 2 },
          { option_type: "tire_set", option_label: "Front 2 only", labor_hours: 0.2, parts_cost_low: 0, parts_cost_high: 0, display_order: 3 },
          { option_type: "tire_set", option_label: "Rear 2 only", labor_hours: 0.2, parts_cost_low: 0, parts_cost_high: 0, display_order: 4 },
        ],
      },
      {
        // Battery Replacement: tier by battery technology, which drives parts cost.
        slug: "battery-replacement",
        options: [
          { option_type: "battery_type", option_label: "Standard (flooded)", labor_hours: 0.3, parts_cost_low: 130, parts_cost_high: 180, display_order: 1 },
          { option_type: "battery_type", option_label: "AGM", labor_hours: 0.3, parts_cost_low: 200, parts_cost_high: 280, display_order: 2 },
          { option_type: "battery_type", option_label: "EFB", labor_hours: 0.3, parts_cost_low: 180, parts_cost_high: 240, display_order: 3 },
        ],
      },
    ];

    let servicesPatched = 0;
    let optionsDeleted = 0;
    let optionsInserted = 0;
    const missingSlugs: string[] = [];

    for (const entry of PLAN) {
      const svc = await ctx.db
        .query("services")
        .withIndex("by_slug", (q) => q.eq("slug", entry.slug))
        .first();
      if (!svc) {
        missingSlugs.push(entry.slug);
        continue;
      }

      if (svc.has_options !== true) {
        await ctx.db.patch(svc._id, { has_options: true });
        servicesPatched += 1;
      }

      const existing = await ctx.db
        .query("service_options")
        .withIndex("by_service_id", (q) => q.eq("service_id", svc._id))
        .collect();
      for (const o of existing) {
        await ctx.db.delete(o._id);
        optionsDeleted += 1;
      }

      for (const opt of entry.options) {
        await ctx.db.insert("service_options", {
          service_id: svc._id,
          option_type: opt.option_type,
          option_label: opt.option_label,
          labor_hours: opt.labor_hours,
          parts_cost_low: opt.parts_cost_low,
          parts_cost_high: opt.parts_cost_high,
          display_order: opt.display_order,
        });
        optionsInserted += 1;
      }
    }

    return { servicesPatched, optionsDeleted, optionsInserted, missingSlugs };
  },
});

/**
 * One-shot cleanup for the inferred-availability model. Positive/free
 * availability rows are no longer persisted; only negative blocked/hold rows
 * stay in `time_slots`.
 *
 * Run: npx convex run migrations:cleanupGeneratedAvailableTimeSlots
 */
export const cleanupGeneratedAvailableTimeSlots = mutation({
  args: {},
  handler: async (ctx) => {
    const available = await ctx.db
      .query("time_slots")
      .withIndex("by_availability", (q) => q.eq("is_available", true))
      .collect();
    for (const row of available) {
      await ctx.db.delete(row._id);
    }

    return { deleted: available.length };
  },
});

/**
 * Backward-compatible alias. This used to rebuild positive 15-minute rows; it
 * now only removes them.
 */
export const regenerateSlotsFifteenMinGrid = mutation({
  args: { days: v.optional(v.number()) },
  handler: async (ctx) => {
    const available = await ctx.db
      .query("time_slots")
      .withIndex("by_availability", (q) => q.eq("is_available", true))
      .collect();
    for (const row of available) {
      await ctx.db.delete(row._id);
    }
    return { created: 0, deleted: available.length };
  },
});

/**
 * One-shot: strip legacy Smartcar fields from vehicle_owners rows.
 *
 * This intentionally does not re-add Smartcar fields to the schema; it only
 * removes old persisted fields so rows conform to the current validator.
 *
 * Run: npx convex run migrations:stripSmartcarFieldsFromVehicleOwners
 */
export const stripSmartcarFieldsFromVehicleOwners = mutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("vehicle_owners").collect();
    let cleared = 0;
    for (const row of rows) {
      const r = row as Record<string, unknown>;
      if (
        r.smartcarVehicleId === undefined &&
        r.connectionStatus === undefined &&
        r.connectedAt === undefined
      ) continue;
      await ctx.db.patch(row._id, {
        smartcarVehicleId: undefined,
        connectionStatus: undefined,
        connectedAt: undefined,
      } as any);
      cleared += 1;
    }
    return { cleared, total: rows.length };
  },
});

/**
 * One-shot: convert legacy vehicle_owners.lastServiceWhat values written as
 * a single string into the new string[] shape. Schema field is now array-only;
 * rows written under the previous (string) schema will fail validation on read
 * until this runs.
 *
 * Run: npx convex run migrations:migrateLastServiceWhatToArray
 */
export const migrateLastServiceWhatToArray = mutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("vehicle_owners").collect();
    let converted = 0;
    let alreadyArray = 0;
    let empty = 0;
    for (const row of rows) {
      const r = row as Record<string, unknown>;
      const raw = r.lastServiceWhat;
      if (raw === undefined || raw === null) {
        empty += 1;
        continue;
      }
      if (Array.isArray(raw)) {
        alreadyArray += 1;
        continue;
      }
      if (typeof raw === "string") {
        const next = raw.length > 0 ? [raw] : [];
        await ctx.db.patch(row._id, { lastServiceWhat: next });
        converted += 1;
      }
    }
    return { converted, alreadyArray, empty, scanned: rows.length };
  },
});

/**
 * One-shot backfill: for every vehicle that has a vehicle_config_id but is
 * missing engine_id or transmission_id (typical of mechanic walk-in created rows),
 * copy those IDs from the linked vehicle_config and seed the vehicle_passport
 * with OEM fluid specs.
 *
 * Run: npx convex run migrations:backfillWalkInVehicleEngineIds
 */
export const backfillWalkInVehicleEngineIds = mutation({
  args: {},
  handler: async (ctx) => {
    const vehicles = await ctx.db.query("vehicles").collect();
    let patched = 0;
    let skipped = 0;

    for (const vehicle of vehicles) {
      // Resolve engine_id: prefer vehicle.engine_id, fall back to vehicle_config.engine_id
      let engineId = vehicle.engine_id ?? null;
      let transmissionId = vehicle.transmission_id ?? null;

      let configId = vehicle.vehicle_config_id ?? null;

      if (!engineId && vehicle.vehicle_config_id) {
        const config = await ctx.db.get(vehicle.vehicle_config_id as any) as any;
        if (config?.engine_id) {
          engineId = config.engine_id;
          transmissionId = transmissionId ?? config.transmission_id ?? null;
        }
      }

      // Nothing to backfill with if we still have no engine_id
      if (!engineId) { skipped++; continue; }

      await ctx.scheduler.runAfter(
        0,
        internal.vehicleEnrichment.v3mutations.backfillVehicleEngineIds,
        {
          vehicle_id: vehicle._id,
          engine_id: engineId,
          ...(transmissionId ? { transmission_id: transmissionId } : {}),
          ...(configId ? { vehicle_config_id: configId as any } : {}),
        },
      );
      patched++;
    }

    return { patched, skipped, total: vehicles.length };
  },
});

/**
 * One-shot cleanup: collapse duplicate `vehicles` rows that share a VIN.
 *
 * Background: `vehicles.vin` is indexed but not constrained unique, so a mix
 * of seed re-runs, walk-in shop inserts, and parallel onboarding flows has
 * landed multiple rows on the same VIN. `vehicles:listVehiclesByUser` then
 * crashes when its `.unique()` lookup sees >1 row.
 *
 * Strategy per VIN with >1 row:
 *   1. Pick a canonical row, preferring (in order): vehicle_config_id set,
 *      then most populated optional fields, then newest updated_at /
 *      _creationTime.
 *   2. Repoint FKs on `part_snapshots`, `labor_quote_snapshots`, and
 *      `user_semantic_facts` from each duplicate `_id` → canonical `_id`.
 *   3. Delete the duplicate `vehicles` row.
 *
 * Defaults to dry-run; pass `{ apply: true }` to actually mutate.
 *
 * Run dry:     npx convex run migrations:dedupeVehiclesByVin
 * Run apply:   npx convex run migrations:dedupeVehiclesByVin '{"apply": true}'
 */
export const dedupeVehiclesByVin = mutation({
  args: { apply: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const apply = args.apply === true;

    const vehicles = await ctx.db.query("vehicles").collect();

    // Group rows by VIN.
    const byVin = new Map<string, typeof vehicles>();
    for (const v of vehicles) {
      const key = (v.vin ?? "").toUpperCase().trim();
      if (!key) continue;
      const bucket = byVin.get(key);
      if (bucket) bucket.push(v);
      else byVin.set(key, [v]);
    }

    // Score a row by how "rich" it is — more populated optional fields wins.
    const richness = (row: (typeof vehicles)[number]) => {
      let score = 0;
      if (row.vehicle_config_id) score += 100; // strongest signal — enrichment ran
      if (row.trim_id) score += 1;
      if (row.engine_id) score += 1;
      if (row.transmission_id) score += 1;
      if (row.chassis_id) score += 1;
      if (row.year != null) score += 1;
      if (row.image_url) score += 1;
      if (row.enriched_engine_config_id) score += 1;
      if (row.metadata) score += 1;
      return score;
    };

    const lastTouched = (row: (typeof vehicles)[number]) =>
      row.updated_at ?? row.created_at ?? row._creationTime ?? 0;

    type DupReport = {
      vin: string;
      kept: string;
      dropped: string[];
      fkRepointed: {
        part_snapshots: number;
        labor_quote_snapshots: number;
        user_semantic_facts: number;
      };
    };

    const report: DupReport[] = [];
    let scanned = 0;
    let duplicateRowsFound = 0;
    let duplicateRowsDeleted = 0;

    for (const [vin, rows] of byVin) {
      scanned += rows.length;
      if (rows.length < 2) continue;

      // Choose canonical: max(richness, lastTouched) — stable tiebreak on _id.
      const sorted = [...rows].sort((a, b) => {
        const ra = richness(a);
        const rb = richness(b);
        if (ra !== rb) return rb - ra;
        const ta = lastTouched(a);
        const tb = lastTouched(b);
        if (ta !== tb) return tb - ta;
        return String(a._id).localeCompare(String(b._id));
      });
      const canonical = sorted[0];
      const dups = sorted.slice(1);
      duplicateRowsFound += dups.length;

      const dupIds = new Set(dups.map((d) => String(d._id)));

      // Repoint FK references. Scan target tables once per VIN; cheap on dev,
      // and these tables are sparse relative to vehicles.
      let partRepoints = 0;
      let laborRepoints = 0;
      let factRepoints = 0;

      const partSnaps = await ctx.db.query("part_snapshots").collect();
      for (const row of partSnaps) {
        if (dupIds.has(String(row.vehicle_id))) {
          if (apply) await ctx.db.patch(row._id, { vehicle_id: canonical._id });
          partRepoints += 1;
        }
      }

      const laborSnaps = await ctx.db.query("labor_quote_snapshots").collect();
      for (const row of laborSnaps) {
        if (dupIds.has(String(row.vehicle_id))) {
          if (apply) await ctx.db.patch(row._id, { vehicle_id: canonical._id });
          laborRepoints += 1;
        }
      }

      const facts = await ctx.db.query("user_semantic_facts").collect();
      for (const row of facts) {
        if (row.vehicle_id && dupIds.has(String(row.vehicle_id))) {
          if (apply) await ctx.db.patch(row._id, { vehicle_id: canonical._id });
          factRepoints += 1;
        }
      }

      // Drop the duplicate vehicles rows.
      if (apply) {
        for (const d of dups) {
          await ctx.db.delete(d._id);
          duplicateRowsDeleted += 1;
        }
      }

      report.push({
        vin,
        kept: String(canonical._id),
        dropped: dups.map((d) => String(d._id)),
        fkRepointed: {
          part_snapshots: partRepoints,
          labor_quote_snapshots: laborRepoints,
          user_semantic_facts: factRepoints,
        },
      });
    }

    return {
      mode: apply ? "applied" : "dry-run",
      scanned,
      vinsAffected: report.length,
      duplicateRowsFound,
      duplicateRowsDeleted,
      report,
    };
  },
});
