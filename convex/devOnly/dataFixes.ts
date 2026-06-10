/**
 * devOnly/dataFixes — audited one-off data corrections, CLI only.
 *
 * For enrichment data errors a director would otherwise fix through the panel
 * (the panel mutations are token-gated; CLI ops run these internal functions
 * instead). Every fix writes an audit_log row with the reason so corrections
 * are traceable next to regular director edits.
 *
 *   npx convex run devOnly/dataFixes:engineTimingAudit
 *   npx convex run devOnly/dataFixes:fixEngineFields '{"engine_id":"...","timing_system":"belt","reason":"..."}'
 */
import { internalMutation, internalQuery } from "../_generated/server";
import { v } from "convex/values";

/**
 * READ-ONLY spot-check sweep: every vehicle_config with its engine's
 * timing_system / cylinders / displacement so misclassifications (the Jetta's
 * "chain" EA211, cylinders holding displacement) are visible per car.
 */
export const engineTimingAudit = internalQuery({
  args: {},
  handler: async (ctx) => {
    const configs = (await ctx.db.query("vehicle_configs").collect()) as any[];
    const rows: any[] = [];
    for (const c of configs) {
      const engine = c.engine_id ? ((await ctx.db.get(c.engine_id)) as any) : null;
      rows.push({
        config_key: c.config_key,
        enrichment_status: c.enrichment_status,
        engine_id: c.engine_id ?? null,
        engine_code: engine?.engine_code ?? null,
        engine_family: engine?.engine_family ?? null,
        timing_system: engine?.timing_system ?? null,
        cylinders: engine?.cylinders ?? null,
        displacement_l: engine?.displacement_l ?? engine?.displacement_liters ?? null,
        cylinders_suspect:
          engine?.cylinders != null && !Number.isInteger(engine.cylinders),
      });
    }
    return rows;
  },
});

/**
 * Audited one-off engine field correction. Only patches fields that actually
 * change; writes one audit_log `data_fix` row (actor "CLI data fix") with the
 * before → after diff and the caller's reason. No-op (no audit row) when the
 * stored values already match.
 */
export const fixEngineFields = internalMutation({
  args: {
    engine_id: v.id("engines"),
    timing_system: v.optional(v.string()),
    cylinders: v.optional(v.number()),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const engine = await ctx.db.get(args.engine_id);
    if (!engine) return { ok: false as const, reason: "engine_not_found" };

    const patch: Record<string, unknown> = {};
    const changes: string[] = [];
    const tryPatch = (key: "timing_system" | "cylinders", nextVal: unknown) => {
      if (nextVal === undefined) return;
      const cur = (engine as any)[key];
      if (cur === nextVal) return;
      patch[key] = nextVal;
      changes.push(`${key}: ${cur ?? "—"} → ${nextVal}`);
    };
    tryPatch("timing_system", args.timing_system);
    tryPatch("cylinders", args.cylinders);

    // Stamp every PROVIDED field as human-verified — including ones whose
    // stored value already matched (confirming a value is itself a
    // verification). The pipeline writer skips verified keys and the batch
    // field-merge honors them; without the stamp the next re-enrich clobbers
    // the fix (observed live on the Jetta, Jun 10).
    const verified = new Set(((engine as any).verified_fields ?? []) as string[]);
    const before = verified.size;
    if (args.timing_system !== undefined) verified.add("timing_system");
    if (args.cylinders !== undefined) verified.add("cylinders");

    if (Object.keys(patch).length === 0) {
      if (verified.size > before) {
        await ctx.db.patch(args.engine_id, { verified_fields: [...verified] } as any);
      }
      return { ok: true as const, changes: 0 };
    }
    (patch as any).verified_fields = [...verified];

    await ctx.db.patch(args.engine_id, patch as any);
    await ctx.db.insert("audit_log", {
      entity_type: "engine",
      entity_id: String(args.engine_id),
      action: "data_fix",
      actor: "CLI data fix",
      detail: `Engine data fix · ${changes.join(", ")} · reason: ${args.reason}`,
      created_at: Date.now(),
    });
    return { ok: true as const, changes: changes.length };
  },
});
