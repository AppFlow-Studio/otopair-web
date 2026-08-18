/**
 * devOnly/round3IdentityProbe.ts — re-resolve the two round-3 identity defects
 * through the REAL decode path and report what the pipeline now produces.
 *
 * Defect 1 — JA4J4UA85NZ067758, 2022 Mitsubishi Outlander: stored as model
 *            "Outlander Sport" (config `2022_mitsubishi_outlander_sport_se_2_5l_4cyl`)
 *            though vPIC and VDB both decode "Outlander". Expect model
 *            "Outlander" and engine PR25DD.
 * Defect 2 — WP1AA2A59NLB00450, 2022 Porsche Macan: stored engine EA839, the
 *            2.9L V6 of the Macan S/GTS, on a VIN vPIC decodes as 2.0L/4-cyl.
 *            Expect EA839 rejected — anything but EA839.
 *
 * Runs processVin, which is the resolution path itself (it upserts make/model/
 * engine rows as it goes — that is the re-resolution, not a side effect).
 */
import { internalAction, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import {
  contradictsDecodedEngine,
  lookupKnownEngineCode,
} from "../vehicleEnrichment/utils/engineLookup";
import { acceptNormalizedModel } from "../vehicleEnrichment/identityResolution";

export const reresolve = internalAction({
  args: { vin: v.string() },
  handler: async (ctx, { vin }) => {
    const decoded: any = await ctx.runAction(internal.vehicle_pipeline.processVin, { vin });
    if (!decoded) return { vin, ok: false as const, reason: "decode_failed" };
    return {
      vin,
      ok: true as const,
      make: decoded.make,
      model: decoded.model,
      trim: decoded.trim,
      year: decoded.year,
      engineCode: decoded.engineCode,
      displacement: decoded.displacement,
      cylinders: decoded.cylinders,
      nhtsaVinKey: decoded.nhtsaVinKey,
    };
  },
});

/**
 * Exercise the two new gates on the DEPLOYED build, using each VIN's exact
 * decoded values. Proves the guards are live and firing — the end-to-end
 * decode above only shows the outcome, not which guard produced it.
 */
export const gateCheck = internalQuery({
  args: {},
  handler: async () => ({
    macan_ea839_rejected: contradictsDecodedEngine("EA839", {
      displacementL: "2",
      cylinders: 4,
    }),
    macan_ea888_accepted: contradictsDecodedEngine("EA888", {
      displacementL: "2",
      cylinders: 4,
    }),
    outlander_sport_model_rejected: acceptNormalizedModel("Outlander Sport", "Outlander", [
      "Outlander", "SE", "", "", "Wagon body style", "Outlander", "SE",
    ]),
    outlander_engine_from_table: lookupKnownEngineCode("Mitsubishi", "Outlander", 2022, {
      displacementL: "2.5",
      cylinders: 4,
    }),
  }),
});
