/**
 * Bug #351 — "Same car, two trims". A 2022 Jeep Cherokee VIN that NHTSA decodes
 * as "Limited" (2.0L, 4 cyl) showed "Jeep Cherokee Limited" to the customer and
 * "2L 2l_4cyl · X trim" to the shop. Two defects:
 *
 * 1. Config reuse by `nhtsa_vin_key` ignored the trim. The key carries NHTSA's
 *    trim; the config is enriched and named for the trim the owner picked. So
 *    an "X" config could sit under a `…_limited_…` key and every later Limited
 *    with that engine attached to it.
 * 2. The shop's vehicle label printed the synthetic engine key "2l_4cyl" and
 *    vPIC's bare "2" as "2L".
 */
import { describe, it, expect } from "vitest";
import { internal } from "../convex/_generated/api";
import { makeT } from "./helpers";
import { trimsAgree, trimIdentityTokens } from "../convex/lib/trimIdentity";
import {
  displayEngineCode,
  formatDisplacementL,
} from "../convex/lib/engineCodeShape";

describe("trimsAgree", () => {
  it("tells sibling trims apart", () => {
    expect(trimsAgree("X", "Limited")).toBe(false);
    expect(trimsAgree("Latitude", "Latitude Lux")).toBe(false);
    expect(trimsAgree("Trailhawk", "Trailhawk Elite")).toBe(false);
    // The live dev-DB case: an SH-AWD car on a front-drive 3.5 config.
    expect(trimsAgree("SH-AWD Tech", "3.5 4dr Front-wheel Drive Sedan Automatic")).toBe(false);
  });

  it("matches a trim to VDB's verbose spelling of it", () => {
    expect(trimsAgree("XSE", "XSE 4dr All-Wheel Drive Sedan Automatic")).toBe(true);
    expect(trimsAgree("2.0T Premium", "2.0T Premium 4dr All-wheel Drive quattro Sedan Automatic")).toBe(true);
    expect(trimsAgree("SLT", "SLT 4x4 Crew Cab 6.6 ft. box 157 in. WB Automatic")).toBe(true);
    expect(trimsAgree("Premium", "Premium 3.8L 4dr Sedan Automatic")).toBe(true);
    expect(trimsAgree("Limited", "Limited 4x4")).toBe(true);
  });

  it("ignores token order, case and C 63 / C63 spacing", () => {
    expect(trimsAgree("AMG GLE 63 S Coupe", "GLE 63 AMG S")).toBe(true);
    expect(trimsAgree("AMG C 63 S", "c63 amg s")).toBe(true);
    expect(trimsAgree("EX-L", "ex-l 4dr Sedan CVT")).toBe(true);
  });

  it("lets an unknown trim agree with anything", () => {
    expect(trimsAgree("Base", "Limited")).toBe(true);
    expect(trimsAgree("", "X")).toBe(true);
    expect(trimsAgree(undefined, "X")).toBe(true);
    expect(trimIdentityTokens("Base AMG GLC 43 Coupe 4dr").has("base")).toBe(false);
  });
});

describe("engine label pieces", () => {
  it("hides synthetic engine keys", () => {
    expect(displayEngineCode("2l_4cyl")).toBeNull();
    expect(displayEngineCode("2.0l_4cyl")).toBeNull();
    expect(displayEngineCode("unknown_unknowncyl")).toBeNull();
    expect(displayEngineCode("EcoBoost")).toBeNull();
    expect(displayEngineCode(null)).toBeNull();
    expect(displayEngineCode(" K24Z6 ")).toBe("K24Z6");
  });

  it("writes displacement with a decimal", () => {
    expect(formatDisplacementL(2)).toBe("2.0L");
    expect(formatDisplacementL("2")).toBe("2.0L");
    expect(formatDisplacementL(3.6)).toBe("3.6L");
    expect(formatDisplacementL("2.4")).toBe("2.4L");
    expect(formatDisplacementL(null)).toBeNull();
    expect(formatDisplacementL("unknown")).toBeNull();
    expect(formatDisplacementL(0)).toBeNull();
  });
});

const KEY = "2022_jeep_cherokee_limited_2l_4cyl_gasoline_automatic";

async function seedSharedKeyConfigs(t: ReturnType<typeof makeT>) {
  return await t.run(async (ctx: any) => {
    const makeId = await ctx.db.insert("makes", { name: "Jeep" });
    const modelId = await ctx.db.insert("models", { make_id: makeId, name: "Cherokee" });
    const base = { year: 2022, make_id: makeId, model_id: modelId, nhtsa_vin_key: KEY };
    // The first owner picked "X" for a VIN NHTSA calls "Limited" — the config
    // is named X but stamped with the Limited key.
    const xId = await ctx.db.insert("vehicle_configs", {
      ...base,
      config_key: "2022_jeep_cherokee_x_2l_4cyl_automatic",
      trim_name: "X",
    });
    const limitedId = await ctx.db.insert("vehicle_configs", {
      ...base,
      config_key: "2022_jeep_cherokee_limited_2l_4cyl_automatic",
      trim_name: "Limited",
    });
    return { xId, limitedId };
  });
}

describe("getVehicleConfigByNhtsaVinKey", () => {
  it("returns only a config enriched for the trim being added", async () => {
    const t = makeT();
    const { xId, limitedId } = await seedSharedKeyConfigs(t);
    const q = internal.vehicleEnrichment.v3queries.getVehicleConfigByNhtsaVinKey;

    const limited = await t.query(q, { nhtsaVinKey: KEY, trim: "Limited" });
    expect(limited?._id).toBe(limitedId);

    const x = await t.query(q, { nhtsaVinKey: KEY, trim: "X" });
    expect(x?._id).toBe(xId);

    // A trim no config was enriched for is a miss — the caller falls back to
    // config_key, then enriches.
    const trailhawk = await t.query(q, { nhtsaVinKey: KEY, trim: "Trailhawk" });
    expect(trailhawk).toBeNull();
  });

  it("returns a Limited miss when only the mislabeled X config exists", async () => {
    const t = makeT();
    const { limitedId } = await seedSharedKeyConfigs(t);
    await t.run(async (ctx: any) => ctx.db.delete(limitedId));
    const hit = await t.query(
      internal.vehicleEnrichment.v3queries.getVehicleConfigByNhtsaVinKey,
      { nhtsaVinKey: KEY, trim: "Limited" },
    );
    expect(hit).toBeNull();
  });

  it("keeps first-match behaviour when no trim is given", async () => {
    const t = makeT();
    const { xId } = await seedSharedKeyConfigs(t);
    const hit = await t.query(
      internal.vehicleEnrichment.v3queries.getVehicleConfigByNhtsaVinKey,
      { nhtsaVinKey: KEY },
    );
    expect(hit?._id).toBe(xId);
  });
});
