/**
 * convex/snapshotRevalidation.ts — ONE-TIME cleanup sweep.
 *
 * `bookings.priced_parts_snapshot` rows are frozen at booking time so catalog
 * and pricing edits can't shift the customer's contract. That also means
 * snapshots frozen BEFORE the Jul 2026 cross-make hardening can still carry
 * contaminated parts (e.g. a Ford brake pad quoted on an Alfa Romeo), and the
 * existing null-only backfill never re-touches them.
 *
 * This sweep re-runs the I1 read guard over every existing snapshot row and
 * STAMPS failing rows with `integrity_flag` ("cross_make" |
 * "foreign_signature"). Rows are never stripped or zeroed — the frozen price
 * is the customer's contract and `quoted_breakdown` totals stay untouched;
 * display/itemization surfaces (getOemPartsForBooking, booking_approvals
 * fallback itemization, job_actuals suggestedParts seed) filter on the stamp.
 * Mechanic-verified fitments are exempt, mirroring fitmentQuarantine.
 * ACTIVE bookings additionally get `low_confidence_parts: true` so the
 * existing post-job review signal fires; terminal bookings get an audit-only
 * stamp.
 *
 * NOT a cron: post-hardening snapshots are computed through the guarded
 * resolver, so new contamination can't freeze in.
 *
 * Usage (dry run first — counts only, zero writes):
 *   npx convex run snapshotRevalidation:runSnapshotRevalidation '{"dryRun":true}'
 * Then live:
 *   npx convex run snapshotRevalidation:runSnapshotRevalidation '{"dryRun":false}'
 * Post-run check:
 *   npx convex run snapshotRevalidation:snapshotIntegrityReport '{}'
 */

import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { partFitsConfigMake } from "./partSelector";
import { matchesForeignBrandSignature } from "./vehicleEnrichment/contentSanitization";

// Each booking fans out into per-row part + fitment reads, so pages are small.
const SWEEP_BATCH_DEFAULT = 100;

const TERMINAL_BOOKING_STATUSES = new Set([
  "cancelled",
  "completed",
  "no_show",
  "declined",
]);

// ---------------------------------------------------------------------------
// Pure classifier (unit-tested in tests/snapshotRevalidation.test.ts)
// ---------------------------------------------------------------------------

export type SnapshotRowVerdict =
  | "ok"
  | "cross_make"
  | "foreign_signature"
  | "verified_exempt"
  | "unresolvable";

/**
 * Classify one frozen snapshot row against the I1 read guard.
 *
 * - `verified_exempt`: a mechanic physically confirmed this part on this
 *   config — never stamped (mirrors quarantine's verified_skipped).
 * - `unresolvable`: the config's make is unknown, so a mismatch can't be
 *   proven — never stamped (fail-open, same posture as partFitsConfigMake).
 * - Rows without a resolvable part (part_id missing or part deleted) pass
 *   `partMakeId: null` and get the brand-signature check only.
 */
export function classifySnapshotRow(args: {
  partMakeId: Id<"makes"> | null | undefined;
  configMakeId: Id<"makes"> | null | undefined;
  oemNumber: string;
  configMakeName: string | null | undefined;
  fitmentMechanicVerified: boolean;
}): SnapshotRowVerdict {
  if (args.configMakeId == null && !args.configMakeName) return "unresolvable";
  if (args.fitmentMechanicVerified) return "verified_exempt";
  if (!partFitsConfigMake(args.partMakeId, args.configMakeId)) {
    return "cross_make";
  }
  if (matchesForeignBrandSignature(args.oemNumber, args.configMakeName) !== null) {
    return "foreign_signature";
  }
  return "ok";
}

// ---------------------------------------------------------------------------
// Page mutation — one page of bookings per transaction
// ---------------------------------------------------------------------------

type SweepExample = {
  bookingId: string;
  bookingStatus: string;
  oemNumber: string;
  partName: string;
  verdict: "cross_make" | "foreign_signature";
  configMake: string;
};

type SweepPageSummary = {
  scanned: number;
  withSnapshot: number;
  rowsChecked: number;
  crossMake: number;
  foreignSignature: number;
  verifiedExempt: number;
  unresolvable: number;
  alreadyStamped: number;
  bookingsStamped: number;
  activeFlagged: number;
  byMakePair: Record<string, number>;
  examples: SweepExample[];
  continueCursor: string;
  isDone: boolean;
};

export const revalidateSnapshotsPage = internalMutation({
  args: {
    dryRun: v.boolean(),
    cursor: v.optional(v.string()),
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<SweepPageSummary> => {
    const numItems = args.batchSize ?? SWEEP_BATCH_DEFAULT;
    const res = await ctx.db
      .query("bookings")
      .paginate({ cursor: args.cursor ?? null, numItems });

    // Memoize the small lookup chains — a page of bookings often shares a
    // handful of vehicles/configs/makes.
    const makeNameCache = new Map<string, string>();
    const makeName = async (
      makeId: Id<"makes"> | null | undefined,
    ): Promise<string | null> => {
      if (makeId == null) return null;
      const key = String(makeId);
      const hit = makeNameCache.get(key);
      if (hit !== undefined) return hit;
      const make = await ctx.db.get(makeId);
      const name = make?.name ?? key;
      makeNameCache.set(key, name);
      return name;
    };
    const configByVin = new Map<
      string,
      { configId: Id<"vehicle_configs">; makeId: Id<"makes"> | null } | null
    >();
    const resolveConfig = async (vin: string) => {
      const hit = configByVin.get(vin);
      if (hit !== undefined) return hit;
      const vehicle = await ctx.db
        .query("vehicles")
        .withIndex("by_vin", (q) => q.eq("vin", vin))
        .first();
      const config = vehicle?.vehicle_config_id
        ? await ctx.db.get(vehicle.vehicle_config_id)
        : null;
      const out = config
        ? { configId: config._id, makeId: config.make_id ?? null }
        : null;
      configByVin.set(vin, out);
      return out;
    };

    let withSnapshot = 0;
    let rowsChecked = 0;
    let crossMake = 0;
    let foreignSignature = 0;
    let verifiedExempt = 0;
    let unresolvable = 0;
    let alreadyStamped = 0;
    let bookingsStamped = 0;
    let activeFlagged = 0;
    const byMakePair: Record<string, number> = {};
    const examples: SweepExample[] = [];

    for (const booking of res.page) {
      const snapshot = ((booking as any).priced_parts_snapshot ?? []) as Array<
        Record<string, unknown>
      >;
      if (snapshot.length === 0) continue;
      withSnapshot++;

      const cfg = await resolveConfig(booking.vin);
      const configMakeName = await makeName(cfg?.makeId);

      let bookingDirty = false;
      const patched = [];
      for (const row of snapshot) {
        if (row.integrity_flag != null) {
          alreadyStamped++;
          patched.push(row);
          continue;
        }
        rowsChecked++;

        const partId = row.part_id as Id<"oem_parts"> | undefined;
        const part = partId ? await ctx.db.get(partId) : null;
        // mechanic_verified lives on the fitment for THIS config. Fitments may
        // have been deleted/repointed by the dedupe sweep — a missing fitment
        // is conservatively "not verified" (stamp is reversible).
        let mechanicVerified = false;
        if (partId && cfg) {
          const fits = await ctx.db
            .query("part_fitments")
            .withIndex("by_part", (q) => q.eq("part_id", partId))
            .collect();
          mechanicVerified = fits.some(
            (f) =>
              f.vehicle_config_id === cfg.configId &&
              f.mechanic_verified === true,
          );
        }

        const verdict = classifySnapshotRow({
          partMakeId: part?.make_id ?? null,
          configMakeId: cfg?.makeId ?? null,
          oemNumber: String(row.oem_number ?? ""),
          configMakeName,
          fitmentMechanicVerified: mechanicVerified,
        });

        if (verdict === "verified_exempt") verifiedExempt++;
        if (verdict === "unresolvable") unresolvable++;
        if (verdict === "cross_make" || verdict === "foreign_signature") {
          if (verdict === "cross_make") {
            crossMake++;
            const partMake = (await makeName(part?.make_id)) ?? "(none)";
            const pair = `${partMake}->${configMakeName ?? "(unknown)"}`;
            byMakePair[pair] = (byMakePair[pair] ?? 0) + 1;
          } else {
            foreignSignature++;
          }
          if (examples.length < 20) {
            examples.push({
              bookingId: String(booking._id),
              bookingStatus: booking.status,
              oemNumber: String(row.oem_number ?? ""),
              partName: String(row.part_name ?? ""),
              verdict,
              configMake: configMakeName ?? "(unknown)",
            });
          }
          bookingDirty = true;
          patched.push({ ...row, integrity_flag: verdict });
          continue;
        }
        patched.push(row);
      }

      if (bookingDirty && !args.dryRun) {
        const patch: Record<string, unknown> = {
          priced_parts_snapshot: patched,
        };
        // Active bookings get the existing post-job review signal so the
        // mechanic confirmation re-prices reality; terminal bookings keep an
        // audit-only stamp (never touch totals or captured amounts).
        if (!TERMINAL_BOOKING_STATUSES.has(booking.status)) {
          patch.low_confidence_parts = true;
          activeFlagged++;
        }
        await ctx.db.patch(booking._id, patch);
        bookingsStamped++;
      } else if (bookingDirty) {
        if (!TERMINAL_BOOKING_STATUSES.has(booking.status)) activeFlagged++;
        bookingsStamped++;
      }
    }

    return {
      scanned: res.page.length,
      withSnapshot,
      rowsChecked,
      crossMake,
      foreignSignature,
      verifiedExempt,
      unresolvable,
      alreadyStamped,
      bookingsStamped,
      activeFlagged,
      byMakePair,
      examples,
      continueCursor: res.continueCursor,
      isDone: res.isDone,
    };
  },
});

// ---------------------------------------------------------------------------
// Driver action — loop pages to completion, aggregate
// ---------------------------------------------------------------------------

const EXAMPLES_CAP = 50;
// Hard stop so a cursor bug can never loop the action forever.
const MAX_PAGES = 5000;

type RevalidationReport = {
  dryRun: boolean;
  pages: number;
  scanned: number;
  withSnapshot: number;
  rowsChecked: number;
  crossMake: number;
  foreignSignature: number;
  verifiedExempt: number;
  unresolvable: number;
  alreadyStamped: number;
  bookingsStamped: number;
  activeFlagged: number;
  byMakePair: Record<string, number>;
  examples: SweepExample[];
};

export const runSnapshotRevalidation = internalAction({
  args: {
    dryRun: v.boolean(),
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<RevalidationReport> => {
    const mode = args.dryRun ? "DRY RUN" : "LIVE";
    console.log(`[snapshot-revalidation] starting sweep (${mode})`);

    const report: RevalidationReport = {
      dryRun: args.dryRun,
      pages: 0,
      scanned: 0,
      withSnapshot: 0,
      rowsChecked: 0,
      crossMake: 0,
      foreignSignature: 0,
      verifiedExempt: 0,
      unresolvable: 0,
      alreadyStamped: 0,
      bookingsStamped: 0,
      activeFlagged: 0,
      byMakePair: {},
      examples: [],
    };
    let cursor: string | undefined = undefined;
    for (let i = 0; i < MAX_PAGES; i++) {
      const page: SweepPageSummary = await ctx.runMutation(
        internal.snapshotRevalidation.revalidateSnapshotsPage,
        { dryRun: args.dryRun, cursor, batchSize: args.batchSize },
      );
      report.pages++;
      report.scanned += page.scanned;
      report.withSnapshot += page.withSnapshot;
      report.rowsChecked += page.rowsChecked;
      report.crossMake += page.crossMake;
      report.foreignSignature += page.foreignSignature;
      report.verifiedExempt += page.verifiedExempt;
      report.unresolvable += page.unresolvable;
      report.alreadyStamped += page.alreadyStamped;
      report.bookingsStamped += page.bookingsStamped;
      report.activeFlagged += page.activeFlagged;
      for (const [pair, n] of Object.entries(page.byMakePair)) {
        report.byMakePair[pair] = (report.byMakePair[pair] ?? 0) + n;
      }
      for (const ex of page.examples) {
        if (report.examples.length < EXAMPLES_CAP) report.examples.push(ex);
      }
      console.log(
        `[snapshot-revalidation] page ${report.pages}: scanned=${page.scanned} snapshots=${page.withSnapshot} cross_make=${page.crossMake} foreign_sig=${page.foreignSignature} stamped=${page.bookingsStamped}`,
      );
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
    console.log(
      `[snapshot-revalidation] complete: ${JSON.stringify({ ...report, examples: report.examples.length })}`,
    );
    return report;
  },
});

// ---------------------------------------------------------------------------
// Report — how many rows carry the stamp?
// ---------------------------------------------------------------------------

export const snapshotIntegrityReport = internalQuery({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    bookingsFlagged: number;
    rowsFlagged: number;
    byFlag: Record<string, number>;
    sampleBookingIds: string[];
  }> => {
    // Index-less walk is acceptable: internal one-off diagnostic, bounded
    // corpus (mirrors fitmentQuarantine.quarantineReport).
    const bookings = await ctx.db.query("bookings").collect();
    let bookingsFlagged = 0;
    let rowsFlagged = 0;
    const byFlag: Record<string, number> = {};
    const sampleBookingIds: string[] = [];
    for (const b of bookings) {
      const snapshot = ((b as any).priced_parts_snapshot ?? []) as Array<
        Record<string, unknown>
      >;
      const flagged = snapshot.filter((r) => r.integrity_flag != null);
      if (flagged.length === 0) continue;
      bookingsFlagged++;
      rowsFlagged += flagged.length;
      for (const r of flagged) {
        const f = String(r.integrity_flag);
        byFlag[f] = (byFlag[f] ?? 0) + 1;
      }
      if (sampleBookingIds.length < 20) sampleBookingIds.push(String(b._id));
    }
    return { bookingsFlagged, rowsFlagged, byFlag, sampleBookingIds };
  },
});
