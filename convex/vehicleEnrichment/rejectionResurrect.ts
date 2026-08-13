/**
 * vehicleEnrichment/rejectionResurrect.ts — resurrect parts our own format
 * gate destroyed (Aug 9 2026, CX-30 round-2 post-mortem).
 *
 * sanitizePartNumber rejections are ledgered verbatim in the run's field_gaps
 * (`validation_dropped:oem_part_rejected: DGY9-33-28Z`). When a pattern bug is
 * later fixed (the Mazda pattern rejected all 6 of the CX-30's core parts —
 * 46 ledgered rejections fleet-wide, 0 passing), the correct numbers are
 * ALREADY IN THE LEDGER: no web research needed. This rung replays them
 * through the CURRENT sanitizer and, for each one that now passes, runs the
 * standard verify + write path:
 *
 *   ledgered raw → sanitizePartNumber (current patterns) → refute-blocklist
 *   filter → verifyPartFitments (confirmed-only, same bar as refute-harvest)
 *   → upsertPartAndFitment (which re-applies every write gate).
 *
 * Deliberately BYPASSES the role-resource lifetime cap: those caps count
 * research attempts against the world, and these failures were ours — the
 * CX-30's roles sat at skipped_lifetime_cap for parts the extractor had
 * found correctly on run 1. Self-noops when no ledgered rejection passes the
 * current sanitizer, so it is cheap to run on every heal.
 *
 * Wired as the FIRST rung of resourceRoles.healAfterRun (cheapest true fill:
 * candidates are ledgered, one verify batch, zero search). Standalone sweep
 * for already-finished configs: devOnly/partResurrectSweep.
 */

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { PART_FIELD_MAP } from "./v3pipeline";
import { sanitizePartNumber } from "./contentSanitization";
import { verifyPartFitments } from "./utils/partFitmentVerifier";
import { normalizeCandidate } from "./utils/refuteHarvest";

export const REJECT_GAP_PREFIX = "validation_dropped:oem_part_rejected: ";

export const resurrectRejectedParts = internalAction({
  args: {
    vehicleConfigId: v.id("vehicle_configs"),
    /** Cap on verify candidates per invocation (default 12). */
    maxParts: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    if (process.env.PARTS_REJECTION_RESURRECT === "off") {
      return { status: "disabled" as const };
    }
    const resolved: any = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.resolveConfigForBackfill,
      { vehicleConfigId: args.vehicleConfigId },
    );
    if (!resolved || !resolved.makeId) return { status: "no_config" as const };

    const latestRun: any = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.getLatestRunForConfig,
      { vehicleConfigId: args.vehicleConfigId },
    );
    const gaps: Array<{ field: string; reason: string }> = latestRun?.field_gaps ?? [];
    const rejected = gaps.filter((g) => g.reason.startsWith(REJECT_GAP_PREFIX));
    if (rejected.length === 0) return { status: "no_ledgered_rejections" as const };

    // Roles that already carry a fitment are NOT re-written — a later heal
    // (or the batch-2 re-ask) may have filled them with a different number,
    // and resurrection must never fight a live winner.
    const fitments: any[] = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.getFitmentsWithPriceFlag,
      { vehicleConfigId: args.vehicleConfigId },
    );
    const filledRoles = new Set<string>(
      fitments.map((f: any) => `${f.service_type}:${f.subcategory}`),
    );

    const blockedRows: any[] = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.getBlockedOemsForConfig,
      { vehicleConfigId: args.vehicleConfigId },
    );
    const blocked = new Set<string>(
      blockedRows.map((b: any) => normalizeCandidate(String(b.oem_part_number_normalized ?? ""))),
    );

    const seen = new Set<string>();
    const toVerify: Array<{ roleKey: string; oem: string; name: string; quantity: number | null; observedTitle: string | null; meta: any }> = [];
    const skipped: string[] = [];
    for (const g of rejected) {
      const meta: any = (PART_FIELD_MAP as any)[g.field];
      if (!meta) continue;
      const raw = g.reason.slice(REJECT_GAP_PREFIX.length).trim();
      const serviceType = meta.serviceSlug ?? meta.subcategory;
      if (filledRoles.has(`${serviceType}:${meta.subcategory}`)) {
        skipped.push(`${meta.subcategory}:role_already_filled`);
        continue;
      }
      // The resurrection gate: only numbers the CURRENT sanitizer accepts.
      // Still-failing values are still wrong (or the pattern is still wrong)
      // — either way they stay in the ledger for the next audit.
      const cleaned = sanitizePartNumber(raw, resolved.make);
      if (!cleaned) {
        skipped.push(`${meta.subcategory}:still_rejected:${raw}`);
        continue;
      }
      const norm = normalizeCandidate(cleaned);
      if (blocked.has(norm)) {
        skipped.push(`${meta.subcategory}:refute_blocked:${cleaned}`);
        continue;
      }
      const dedupeKey = `${meta.subcategory}|${norm}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      toVerify.push({
        roleKey: meta.subcategory,
        oem: cleaned,
        name: meta.name,
        quantity: null,
        observedTitle: null,
        meta,
      });
    }
    const capped = toVerify.slice(0, Math.max(1, args.maxParts ?? 12));
    if (capped.length === 0) {
      return { status: "nothing_resurrectable" as const, skipped };
    }

    console.log(
      `[resurrect] ${resolved.year} ${resolved.make} ${resolved.model}: re-validating ` +
        `${capped.length} ledgered rejection(s): ${capped.map((t) => `${t.roleKey}:${t.oem}`).join(", ")}`,
    );
    const verdicts = await verifyPartFitments(
      {
        year: resolved.year,
        make: resolved.make,
        model: resolved.model,
        trim: resolved.trim ?? "",
        engineCode: resolved.engineCode ?? undefined,
        displacement: resolved.displacement ?? undefined,
      },
      capped.map(({ meta: _m, ...t }) => t),
    );

    const written: string[] = [];
    const outcomes: string[] = [];
    const wroteRole = new Set<string>();
    for (const t of capped) {
      const vd = verdicts.find(
        (x) => x.roleKey === t.roleKey && normalizeCandidate(x.oem) === normalizeCandidate(t.oem),
      );
      const verdict = vd?.verdict ?? "uncertain";
      outcomes.push(`${t.roleKey}:${t.oem}:${verdict}`);
      // Ledger provenance is run-1 extraction that failed OUR format gate —
      // positive confirmation is the write bar, same as refute-harvest.
      if (verdict !== "confirmed" || wroteRole.has(t.roleKey)) continue;
      const res: any = await ctx.runMutation(
        internal.vehicleEnrichment.v3mutations.upsertPartAndFitment,
        {
          oem_part_number: t.oem,
          name: t.meta.name,
          category: t.meta.category,
          subcategory: t.meta.subcategory,
          make_id: resolved.makeId,
          vehicle_config_id: args.vehicleConfigId,
          service_type: t.meta.serviceSlug ?? t.meta.subcategory,
          quantity_needed:
            t.roleKey === "front_rotor" || t.roleKey === "rear_rotor" ? 2 : 1,
          position: t.meta.position,
          service_role: t.meta.serviceRole,
          confidence: 0.7,
        },
      );
      if (res?.part_id && !res?.rejected) {
        wroteRole.add(t.roleKey);
        written.push(`${t.roleKey}:${t.oem}`);
      } else {
        outcomes.push(`${t.roleKey}:${t.oem}:write_rejected_${res?.rejected ?? "unknown"}`);
      }
    }
    const summary = { status: "done" as const, candidates: capped.length, outcomes, written, skipped };
    console.log(`[resurrect]`, JSON.stringify(summary));
    return summary;
  },
});
