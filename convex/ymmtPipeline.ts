/**
 * ymmtPipeline.ts — enrichment entry point for vehicles added WITHOUT a VIN.
 *
 * This is the sibling of `vehicle_pipeline.processVin` + `confirmVehicleForUser`
 * for cars the owner or shop entered by year/make/model[/trim]. It ends in the
 * same place the VIN path does — a `vehicle_configs` row attached to the
 * `vehicles` row — so bookings, part fitments, labor times and the enrichment
 * gate in bookings.ts all behave identically regardless of how the car arrived.
 *
 * WHY THIS PATH EXISTED AS A DEAD END
 * -----------------------------------
 * Every enrichment entry (confirmVehicleForUser, runPublic/runHeadless,
 * dataApiEnrich, POST /v0/enrich) begins with a VIN decode. The walk-in drawer
 * minted `SHOP${Date.now()}` for a missing VIN and then scheduled a decode of
 * that string, which of course failed — silently, with the mechanic's typed
 * year/make/model never reaching the pipeline at all. Manual cars could
 * therefore never satisfy the `enrichment_status === "complete"` gate at
 * bookings.ts, so they could never book a parts-dependent service.
 *
 * THE DEDUP THAT MAKES THIS CHEAP
 * -------------------------------
 * `buildNhtsaVinKey` is misleadingly named: it is a pure YMMT + displacement +
 * cylinders + fuel fingerprint with no VIN in it. So a manually-entered
 * "2020 Honda CR-V EX" produces the SAME key as a VIN-decoded one, and the
 * lookup below attaches the manual car to the already-enriched config for free.
 * In a mature dataset most manual entries should cache-hit rather than enrich.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ----------------------------------
 * It does not guess a powertrain. See ymmtIdentity.ts — when a model year
 * offered several engines and the trim doesn't narrow it to one, we record the
 * ambiguity in vin_queue and stop. A confidently-wrong config is far more
 * damaging than an unenriched one: it looks complete, so nothing downstream
 * flags it, and every part number and capacity quoted off it is wrong.
 *
 * It also does not write a drivetrain. One engine frequently ships in both 2WD
 * and 4WD, and a wrong drivetrain ships phantom transfer-case and differential
 * services (the batch-3 regression). We leave `drivetrain` undefined and let
 * the enrichment pipeline resolve it, exactly as it does for VINs whose NHTSA
 * decode is silent on DriveType.
 */

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal, api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { buildEngineKey, buildNhtsaVinKey } from "./vehicleEnrichment/types";
import {
  fetchNhtsaModels,
  normalizeModelName,
  pickPowertrainCandidate,
  researchYmmtPowertrain,
  type PowertrainCandidate,
} from "./vehicleEnrichment/ymmtIdentity";
import { findHaloVariant } from "./lib/haloVariantRules";
import { canonicalizeTransmissionType } from "./lib/transmissionTypeInference";
import { isRealVin } from "./lib/vinIdentity";

/** Freshness window for reusing an existing config — mirrors confirmVehicleForUser. */
const STALE_MS = 180 * 24 * 60 * 60 * 1000;

type ResolvedYmmtIdentity = {
  makeId: Id<"makes">;
  modelId: Id<"models">;
  trimId: Id<"trims">;
  engineId: Id<"engines">;
  transmissionId: Id<"transmissions"> | null;
  year: number;
  make: string;
  model: string;
  trim: string;
  engineCode: string;
  displacement: string;
  cylinders: number;
  fuelType: string;
  nhtsaVinKey: string;
  /** How the single powertrain was settled on — carried into logs for audit. */
  disambiguatedBy: "sole_option" | "trim" | "powertrain_named" | "conventional_default";
  confidence: number;
};

type YmmtFailure = { ok: false; reason: string; detail?: string };
type YmmtSuccess = { ok: true; identity: ResolvedYmmtIdentity };

/**
 * Resolve a year/make/model[/trim] into the same catalog rows a VIN decode
 * produces (makes → models → trims → engines → transmissions).
 *
 * Written as a plain helper rather than its own action on purpose: an action in
 * this module calling a sibling action through `internal.ymmtPipeline.*` is the
 * TS7022 circular-inference trap documented in vehicle_pipeline.ts's header.
 */
async function resolveIdentity(
  ctx: ActionCtx,
  args: { year: number; make: string; model: string; trim?: string },
): Promise<YmmtSuccess | YmmtFailure> {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    return { ok: false, reason: "no_anthropic_key" };
  }

  const make = args.make.trim();
  const typedModel = args.model.trim();
  const typedTrim = args.trim?.trim() || "";
  if (!make || !typedModel || !args.year) {
    return { ok: false, reason: "incomplete_ymmt" };
  }

  // ── 1. Normalize the model against NHTSA's catalog ──────────────────────
  // The picker accepts free text, so live rows hold "CRV" where every enriched
  // sibling says "CR-V". Left alone that difference propagates into config_key
  // and the manual car can never dedup against the VIN-decoded one.
  const catalog = await fetchNhtsaModels(make, args.year);
  const normalized = normalizeModelName(typedModel, catalog);
  const model = normalized ?? typedModel;
  if (normalized && normalized.toLowerCase() !== typedModel.toLowerCase()) {
    console.log(`[ymmt] model normalized: "${typedModel}" → "${normalized}" (NHTSA catalog)`);
  } else if (!normalized && catalog.length > 0) {
    console.warn(
      `[ymmt] model "${typedModel}" not in NHTSA catalog for ${args.year} ${make} ` +
        `(${catalog.length} entries) — proceeding with the typed value`,
    );
  }

  // ── 2. Enumerate every powertrain this model year was sold with ─────────
  let candidates: PowertrainCandidate[] = [];
  let researchRaw = "";
  try {
    const research = await researchYmmtPowertrain(anthropicKey, {
      year: args.year,
      make,
      model,
      trim: typedTrim || null,
    });
    candidates = research.candidates;
    researchRaw = research.raw || `[no text emitted] ${research.diagnostics}`;
    console.log(
      `[ymmt] ${args.year} ${make} ${model}: ${candidates.length} powertrain(s) — ` +
        candidates
          .map((c) => `${c.engine_code || "(no code)"}(${c.displacement_l ?? "?"}L)`)
          .join(", ") +
        ` | ${research.diagnostics}`,
    );
  } catch (err) {
    console.error("[ymmt] powertrain research failed:", err);
    return { ok: false, reason: "powertrain_research_failed", detail: String(err) };
  }

  // ── 3. Commit only when exactly one powertrain survives ─────────────────
  // Both spellings are scanned for powertrain words. normalizeModelName already
  // refuses to drop one, but reading the raw text too means a future change
  // there can't quietly cost us the right engine.
  const picked = pickPowertrainCandidate(
    candidates,
    typedTrim || null,
    `${typedModel} ${model}`,
  );
  if (!picked.ok) {
    console.warn(
      `[ymmt] REFUSED ${args.year} ${make} ${model}${typedTrim ? ` ${typedTrim}` : ""}: ${picked.reason}`,
    );
    return {
      ok: false,
      reason: picked.reason,
      // Fall back to the raw research when there were no candidates at all —
      // "nothing found" is otherwise undiagnosable from the ledger alone.
      detail:
        picked.candidates.length > 0
          ? picked.candidates
              .map(
                (c) =>
                  `${c.engine_code || "(no code)"} ${c.displacement_l ?? "?"}L [${c.trims_offered.join("|") || "all trims"}]`,
              )
              .join("; ")
          : `raw: ${researchRaw.slice(0, 500)}`,
    };
  }
  const chosen = picked.chosen;

  // ── 4. Halo-variant promotion ───────────────────────────────────────────
  // Same rule as the decode path: every external spec source treats an M3 /
  // AMG / Type R as its own model line, not a trim of the base car.
  let finalModel = model;
  const finalTrim = typedTrim || "Base";
  const halo = findHaloVariant(make, finalModel, finalTrim);
  if (halo && halo.promotedModel.toLowerCase() !== finalModel.toLowerCase()) {
    console.log(
      `[ymmt] halo promoted: "${finalModel}" → "${halo.promotedModel}" (rule=${halo.ruleId}, trim="${finalTrim}")`,
    );
    finalModel = halo.promotedModel;
  }

  const displacement = chosen.displacement_l != null ? String(chosen.displacement_l) : "";
  const cylinders = chosen.cylinders ?? 0;

  // Synthetic engine code, byte-for-byte the same last resort processVin uses
  // (`${displacement}l_${cylinders}cyl`). Several American makes publish no
  // internal engine code at all — every public source for a 2020 F-150 says
  // "3.5L EcoBoost" — and the research correctly declines to invent one. The
  // VIN path has always fallen back this way; matching it keeps both paths
  // producing the same config_key for the same car.
  let engineCode = chosen.engine_code;
  if (!engineCode) {
    engineCode = `${displacement || "unknown"}l_${cylinders || "unknown"}cyl`;
    console.log(
      `[ymmt] no published engine code for ${chosen.marketing_name ?? "this engine"} — ` +
        `using synthetic code: ${engineCode}`,
    );
  }

  // ── 5. Write the catalog rows (same sequence as processVin) ─────────────
  const makeId: Id<"makes"> = await ctx.runMutation(internal.vehicle_mutations.upsertMake, {
    name: make,
  });
  const modelId: Id<"models"> = await ctx.runMutation(internal.vehicle_mutations.upsertModel, {
    makeId,
    name: finalModel,
  });
  const trimId: Id<"trims"> = await ctx.runMutation(internal.vehicle_mutations.upsertTrim, {
    modelId,
    name: finalTrim,
    year: args.year,
  });
  const engineId: Id<"engines"> = await ctx.runMutation(internal.vehicle_mutations.upsertEngine, {
    trimId,
    engineCode,
    cylinders,
    displacement,
    fuelType: chosen.fuel_type,
  });

  // Engine extras. `make_id` matters: the cross-make fitment guard in
  // v3mutations rejects parts whose make_id disagrees with the config's.
  const enginePatch: Record<string, unknown> = { make_id: makeId };
  if (chosen.displacement_l != null) enginePatch.displacement_l = chosen.displacement_l;
  if (chosen.aspiration?.toLowerCase().includes("turbo")) enginePatch.aspiration = "turbo";
  else if (chosen.aspiration?.toLowerCase().includes("supercharg")) enginePatch.aspiration = "supercharged";
  await ctx.runMutation(internal.vehicleEnrichment.v3mutations.updateEngineSpecs, {
    engine_id: engineId,
    ...enginePatch,
  } as any);

  // Transmission — always create one, mirroring processVin. Confidence is
  // lower than the decode path's 0.70 because this is researched, not decoded.
  const transTypeRaw = chosen.transmission_type || "unknown";
  const transDoc: { _id: Id<"transmissions"> } | null = await ctx.runMutation(
    api.transmissions.upsertTransmission,
    {
      trim_id: trimId,
      transmission_type: transTypeRaw,
      confidence_score: transTypeRaw !== "unknown" ? 0.55 : 0.1,
    },
  );
  const transmissionId: Id<"transmissions"> | null = transDoc?._id ?? null;
  if (transmissionId && transTypeRaw !== "unknown") {
    const mapped = await canonicalizeTransmissionType(transTypeRaw);
    if (mapped) {
      await ctx.runMutation(internal.vehicleEnrichment.v3mutations.updateTransmissionSpecs, {
        transmission_id: transmissionId,
        type: mapped,
      } as any);
    }
  }

  // NOTE: no chassis_variants write. See the module header — a guessed
  // drivetrain ships phantom transfer-case/differential services, so we leave
  // it to the enrichment pipeline's own research.

  const nhtsaVinKey = buildNhtsaVinKey({
    year: args.year,
    make,
    model: finalModel,
    trim: finalTrim,
    displacementL: chosen.displacement_l ?? undefined,
    cylinders: chosen.cylinders ?? undefined,
    fuelType: chosen.fuel_type,
  });

  console.log(
    `[ymmt] resolved ${args.year} ${make} ${finalModel} ${finalTrim} | ` +
      `engine=${engineCode} (${chosen.displacement_l ?? "?"}L ${cylinders}cyl ${chosen.fuel_type}) | ` +
      `via=${picked.disambiguated_by} | conf=${chosen.confidence.toFixed(2)} | key=${nhtsaVinKey}`,
  );

  return {
    ok: true,
    identity: {
      makeId,
      modelId,
      trimId,
      engineId,
      transmissionId,
      year: args.year,
      make,
      model: finalModel,
      trim: finalTrim,
      engineCode,
      displacement,
      cylinders,
      fuelType: chosen.fuel_type,
      nhtsaVinKey,
      disambiguatedBy: picked.disambiguated_by,
      confidence: chosen.confidence,
    },
  };
}

type EnrichFromYmmtResult = {
  status: "cache_hit" | "scheduled" | "skipped" | "failed";
  reason?: string;
  config_key?: string;
  vehicle_config_id?: string;
};

/**
 * Resolve a no-VIN vehicle's identity and get it a `vehicle_configs` row.
 *
 * Owner attachment is explicitly NOT done here — the caller owns that. This is
 * the same separation `runHeadless.go` draws, and the reason the walk-in path
 * must not call `runPublic.go`: that one attaches a hardcoded test user as a
 * primary owner of the customer's car.
 */
export const enrichVehicleFromYmmt = internalAction({
  args: {
    /** Placeholder VIN the vehicles row is keyed on (see lib/vinIdentity). */
    vin: v.string(),
    year: v.float64(),
    make: v.string(),
    model: v.string(),
    trim: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<EnrichFromYmmtResult> => {
    const vin = args.vin.trim().toUpperCase();

    // A real VIN reaching this path means a caller mis-routed: the VIN decode
    // is strictly better (it pins the powertrain instead of researching it), so
    // refuse rather than silently deliver the weaker identity.
    if (isRealVin(vin)) {
      console.warn(`[ymmt] ${vin} is a real VIN — use runHeadless.go, not the YMMT path`);
      return { status: "skipped", reason: "real_vin_should_use_decode" };
    }

    const resolved = await resolveIdentity(ctx, {
      year: args.year,
      make: args.make,
      model: args.model,
      trim: args.trim,
    });

    if (!resolved.ok) {
      await ctx.runMutation(internal.vehicle_mutations.recordYmmtOutcome, {
        vin,
        year: args.year,
        make: args.make,
        model: args.model,
        trim: args.trim,
        status: "skipped",
        skip_reason: resolved.reason,
        error: resolved.detail,
      });
      return { status: "skipped", reason: resolved.reason };
    }

    const id = resolved.identity;

    // Stamp the resolved FK chain + normalized YMMT onto the existing row. The
    // vehicles row was created inside the booking mutation so the booking stays
    // transactional; this action fills in what only research could supply.
    const vehicleId: Id<"vehicles"> | null = await ctx.runMutation(
      internal.vehicle_mutations.attachResolvedIdentity,
      {
        vin,
        trim_id: id.trimId,
        engine_id: id.engineId,
        transmission_id: id.transmissionId ?? undefined,
        year: id.year,
        make: id.make,
        model: id.model,
        trim: id.trim,
      },
    );
    if (!vehicleId) {
      await ctx.runMutation(internal.vehicle_mutations.recordYmmtOutcome, {
        vin,
        year: args.year,
        make: args.make,
        model: args.model,
        trim: args.trim,
        status: "failed",
        error: "vehicle_row_missing",
      });
      return { status: "failed", reason: "vehicle_row_missing" };
    }

    // ── Dedup, identical in spirit to confirmVehicleForUser ────────────────
    // nhtsa_vin_key first: it's the YMMT-level fingerprint, so this is exactly
    // where a manual entry meets an already-enriched VIN-decoded twin.
    let existingConfig: any = await ctx.runQuery(
      internal.vehicleEnrichment.v3queries.getVehicleConfigByNhtsaVinKey,
      { nhtsaVinKey: id.nhtsaVinKey },
    );
    let dedupSource: "nhtsa_vin_key" | "config_key" | "none" = existingConfig
      ? "nhtsa_vin_key"
      : "none";

    const configKey = buildEngineKey({
      vehicleId: vehicleId as any,
      year: id.year,
      make: id.make,
      model: id.model,
      trim: id.trim,
      engineCode: id.engineCode,
      displacement: id.displacement,
    });
    if (!existingConfig) {
      existingConfig = await ctx.runQuery(
        internal.vehicleEnrichment.v3queries.getVehicleConfigByKey,
        { configKey },
      );
      if (existingConfig) dedupSource = "config_key";
    }

    const status = existingConfig?.enrichment_status;
    const fresh =
      existingConfig &&
      (status === "complete" || status === "verified") &&
      (existingConfig.last_enriched_at ?? 0) >= Date.now() - STALE_MS;

    if (fresh && existingConfig?._id) {
      await ctx.runMutation(internal.vehicleEnrichment.v3mutations.attachVehicleConfig, {
        vehicle_id: vehicleId,
        vehicle_config_id: existingConfig._id,
      });
      await ctx.runMutation(internal.vehicle_mutations.recordYmmtOutcome, {
        vin,
        year: id.year,
        make: id.make,
        model: id.model,
        trim: id.trim,
        status: "complete",
        vehicle_config_id: existingConfig._id,
      });
      console.log(
        `[ymmt] cache_hit: attached ${vin} to existing config ${existingConfig._id} (via=${dedupSource})`,
      );
      return {
        status: "cache_hit",
        config_key: existingConfig.config_key,
        vehicle_config_id: String(existingConfig._id),
      };
    }

    await ctx.scheduler.runAfter(0, internal.vehicleEnrichment.v3pipeline.enrichVehicleBatchV3, {
      vehicleId,
      year: id.year,
      make: id.make,
      model: id.model,
      trim: id.trim,
      engineCode: id.engineCode,
      displacement: id.displacement,
      // drivetrain intentionally omitted — see module header.
      nhtsaVinKey: id.nhtsaVinKey,
    });
    await ctx.runMutation(internal.vehicle_mutations.recordYmmtOutcome, {
      vin,
      year: id.year,
      make: id.make,
      model: id.model,
      trim: id.trim,
      status: "enriching",
    });
    console.log(`[ymmt] scheduled enrichment for ${vin} (configKey=${configKey})`);

    return { status: "scheduled", config_key: configKey };
  },
});

/**
 * Diagnostic: resolve a YMMT identity and report it without touching any
 * vehicles row or scheduling enrichment.
 *
 * Usage:
 *   npx convex run ymmtPipeline:probeYmmt '{"year":2020,"make":"Ford","model":"F-150"}'
 */
export const probeYmmt = internalAction({
  args: {
    year: v.float64(),
    make: v.string(),
    model: v.string(),
    trim: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<any> => {
    const r = await resolveIdentity(ctx, args);
    if (!r.ok) return { ok: false, reason: r.reason, detail: r.detail };
    const { makeId, modelId, trimId, engineId, transmissionId, ...rest } = r.identity;
    return { ok: true, ...rest };
  },
});
