/**
 * I1 make-guard integration tests for serviceParts.resolveWinningPartForService.
 *
 * Proves the customer-facing safety property end-to-end: a cross-make part can
 * never win a quote — not via the scorer, and (the focus here) not via the
 * director-pin or VIN-sticky OVERRIDES. The override sites pick only from the
 * already make-filtered hydration pool (serviceParts.ts:804), so a wrong-make
 * pinned/sticky part is dropped before either override can serve it.
 *
 * Mirrors the live finding: a 2024 Alfa Romeo Stelvio config whose
 * front_brake_pad role carries an Audi (8R0698151L) cross-make contaminant
 * cloned in alongside the correct Alfa part (68400577AA).
 */
import { describe, expect, test } from "vitest";
import { makeT } from "./helpers";
import { resolveWinningPartForService } from "../convex/serviceParts";

// Unknown slug → no SERVICE_PARTS_REFERENCE spec → simple single-role grouping
// by subcategory, no front/rear position split to reason about.
const SLUG = "make_guard_test_service";
const SUBCATEGORY = "front_brake_pad";

type Fixture = {
  vin: string;
  serviceId: any;
  vehicleConfigId: any;
  alfaPartId: any;
  audiPartId: any;
  alfaMake: any;
  audiMake: any;
};

/**
 * Alfa config with two front_brake_pad fitments: the make-correct Alfa part and
 * a cross-make Audi contaminant. The Audi part is given the HIGHER fitment
 * confidence (0.95 vs 0.85) so that — absent the guard — an override pointing at
 * it (or the scorer) would prefer it. The guard is what keeps it out.
 */
async function seedFixture(t: ReturnType<typeof makeT>): Promise<Fixture> {
  return t.run(async (ctx) => {
    const now = Date.now();
    const alfaMake = await ctx.db.insert("makes", { name: "Alfa Romeo" } as any);
    const audiMake = await ctx.db.insert("makes", { name: "Audi" } as any);
    const modelId = await ctx.db.insert("models", {
      make_id: alfaMake,
      name: "Stelvio",
    } as any);
    const vehicleConfigId = await ctx.db.insert("vehicle_configs", {
      config_key: `2024_alfa_stelvio_ti_${now}`,
      year: 2024,
      make_id: alfaMake,
      model_id: modelId,
    } as any);
    const serviceId = await ctx.db.insert("services", {
      name: "Make-guard test service",
      default_labor_hours: 1,
      created_at: now,
    } as any);

    const alfaPartId = await ctx.db.insert("oem_parts", {
      oem_part_number: "68400577AA",
      name: "Alfa front brake pad",
      subcategory: SUBCATEGORY,
      category: "brake",
      make_id: alfaMake,
      data_quality: "oem",
    } as any);
    const audiPartId = await ctx.db.insert("oem_parts", {
      oem_part_number: "8R0698151L",
      name: "Audi front brake pad (cross-make contaminant)",
      subcategory: SUBCATEGORY,
      category: "brake",
      make_id: audiMake,
      data_quality: "oem",
    } as any);

    for (const [partId, conf] of [
      [alfaPartId, 0.85],
      [audiPartId, 0.95],
    ] as const) {
      await ctx.db.insert("part_fitments", {
        part_id: partId,
        vehicle_config_id: vehicleConfigId,
        service_type: SLUG,
        position: "front",
        confidence: conf,
        mechanic_verified: false,
        data_quality: "oem",
        created_at: now,
      } as any);
    }

    return {
      vin: `ALFAVIN${now}`,
      serviceId,
      vehicleConfigId,
      alfaPartId,
      audiPartId,
      alfaMake,
      audiMake,
    };
  });
}

async function resolve(t: ReturnType<typeof makeT>, fx: Fixture): Promise<any> {
  return t.run(async (ctx) =>
    resolveWinningPartForService(ctx as any, {
      vin: fx.vin,
      serviceId: fx.serviceId,
      serviceSlug: SLUG,
      vehicleConfigId: fx.vehicleConfigId,
      confirmedPackages: new Set<string>(),
    }),
  );
}

function frontPadWinner(result: any) {
  const rw = result.roleWinners.find((r: any) => r.roleKey === SUBCATEGORY);
  expect(rw).toBeTruthy();
  return rw;
}

describe("I1 make guard — serviceParts overrides cannot serve a cross-make part", () => {
  test("wrong-make VIN-sticky default is ignored; make-correct part wins", async () => {
    const t = makeT();
    const fx = await seedFixture(t);
    // VIN-sticky default points at the WRONG-make (Audi) part. Without the
    // guard, this override would force the Audi part to win outright.
    await t.run(async (ctx) => {
      await ctx.db.insert("vehicle_part_preferences", {
        vin: fx.vin,
        service_id: fx.serviceId,
        part_id: fx.audiPartId,
        is_default: true,
        use_count: 1,
      } as any);
    });

    const rw = frontPadWinner(await resolve(t, fx));
    expect(rw.candidate.part._id).toBe(fx.alfaPartId); // Alfa, not the Audi sticky
    expect(rw.candidate.part.make_id).toBe(fx.alfaMake);
    expect(rw.candidate.part._id).not.toBe(fx.audiPartId);
  });

  test("wrong-make director-pin is ignored; make-correct part wins", async () => {
    const t = makeT();
    const fx = await seedFixture(t);
    // Director pins the WRONG-make (Audi) part for this subcategory role.
    await t.run(async (ctx) => {
      await ctx.db.insert("service_parts_rules", {
        service_id: fx.serviceId,
        parts_kind: "per_axle",
        core_subcategories: [SUBCATEGORY], // keep both parts billable pre-guard
        as_needed_subcategories: [],
        pinned_parts: [
          { subcategory: SUBCATEGORY, part_id: fx.audiPartId, is_core: true },
        ],
        updated_at: Date.now(),
      } as any);
    });

    const rw = frontPadWinner(await resolve(t, fx));
    expect(rw.candidate.part._id).toBe(fx.alfaPartId); // Alfa, not the Audi pin
    expect(rw.candidate.part.make_id).toBe(fx.alfaMake);
    expect(rw.candidate.part._id).not.toBe(fx.audiPartId);
  });

  test("the cross-make Audi part is dropped before grouping — absent from winner AND losers", async () => {
    const t = makeT();
    const fx = await seedFixture(t);
    const rw = frontPadWinner(await resolve(t, fx));
    const involved = [
      rw.candidate.part._id,
      ...rw.losers.map((l: any) => l.part._id),
    ];
    expect(involved).not.toContain(fx.audiPartId); // guard dropped it at hydration
    expect(rw.candidate.part._id).toBe(fx.alfaPartId);
  });
});
