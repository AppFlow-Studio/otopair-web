/**
 * Write-time guards on the enrichment part-write path:
 *   - upsertPartAndFitment rejects cross-make fitment writes (I1 at the source)
 *   - existing parts never get their make_id / is_current clobbered
 *   - normalized part identity ("5Q0 698 451 A" == "5Q0698451A") — no dup rows
 *   - supersession redirect: a superseded number fits against its successor
 *   - source_domains accrue distinct domains across re-confirmations
 *   - cloneFromChassisMatch skips cross-make parts and never RAISES confidence
 */
import { describe, expect, test } from "vitest";
import { makeT } from "./helpers";
import { internal } from "../convex/_generated/api";

const upsert = internal.vehicleEnrichment.v3mutations.upsertPartAndFitment;
const clone = internal.vehicleEnrichment.v3mutations.cloneFromChassisMatch;

async function seedMakesAndConfig(t: ReturnType<typeof makeT>) {
  return t.run(async (ctx) => {
    const alfaMake = await ctx.db.insert("makes", { name: "Alfa Romeo" } as any);
    const fordMake = await ctx.db.insert("makes", { name: "Ford" } as any);
    const modelId = await ctx.db.insert("models", { make_id: alfaMake, name: "Stelvio" } as any);
    const configId = await ctx.db.insert("vehicle_configs", {
      config_key: `2024_alfa_stelvio_${Date.now()}`,
      year: 2024,
      make_id: alfaMake,
      model_id: modelId,
    } as any);
    return { alfaMake, fordMake, configId };
  });
}

const baseArgs = (makeId: any, configId: any) => ({
  oem_part_number: "68400577AA",
  name: "Front Brake Pad",
  category: "brake",
  subcategory: "front_brake_pad",
  make_id: makeId,
  vehicle_config_id: configId,
  service_type: "brake_pad_replacement",
  quantity_needed: 1,
  confidence: 0.85,
  source_domain: "alfaromeopartsdeal.com",
});

describe("upsertPartAndFitment write-time guard", () => {
  test("rejects a fitment when the existing part belongs to another make", async () => {
    const t = makeT();
    const { alfaMake, fordMake, configId } = await seedMakesAndConfig(t);

    // A FORD-stamped part whose number format is Mopar-plausible — it passes
    // number sanitization for the Alfa config (so this test exercises the
    // make-id guard specifically, not the earlier signature rejection; that
    // path has its own choke-point test below).
    await t.run(async (ctx) => {
      await ctx.db.insert("oem_parts", {
        oem_part_number: "68318394AA",
        oem_part_number_normalized: "68318394AA",
        name: "Battery",
        make_id: fordMake,
        is_current: true,
      } as any);
    });

    const res = await t.mutation(upsert, {
      ...baseArgs(alfaMake, configId),
      oem_part_number: "68318394AA",
      subcategory: "battery",
      service_type: "battery_replacement",
    });

    expect(res.part_id).toBeNull();
    expect((res as any).rejected).toBe("cross_make");

    const fitments = await t.run((ctx) => ctx.db.query("part_fitments").collect());
    expect(fitments).toHaveLength(0);

    // The Ford part's make_id must NOT have been patched to Alfa.
    const part = await t.run(async (ctx) =>
      (await ctx.db.query("oem_parts").collect())[0],
    );
    expect(part.make_id).toBe(fordMake);
  });

  test("choke point: a NEW foreign-signature number is rejected regardless of caller", async () => {
    // The pipeline sanitizes at extraction, but diagnoseVin/admin/future
    // callers may not — the mutation itself must reject a Motorcraft-format
    // number for an Alfa config even when no oem_parts row exists yet.
    const t = makeT();
    const { alfaMake, configId } = await seedMakesAndConfig(t);

    const res = await t.mutation(upsert, {
      ...baseArgs(alfaMake, configId),
      oem_part_number: "BAGM-94RH7-800",
      subcategory: "battery",
      service_type: "battery_replacement",
    });

    expect(res.part_id).toBeNull();
    expect((res as any).rejected).toBe("invalid_number");
    const parts = await t.run((ctx) => ctx.db.query("oem_parts").collect());
    expect(parts).toHaveLength(0);
  });

  test("normalized identity: formatting variants land on ONE part row", async () => {
    // VAG numbers on a VW config — both formatting variants pass the
    // volkswagen pattern, exercising normalized-identity dedup in isolation.
    const t = makeT();
    const { vwMake, vwConfigId } = await t.run(async (ctx) => {
      const vwMake = await ctx.db.insert("makes", { name: "Volkswagen" } as any);
      const modelId = await ctx.db.insert("models", { make_id: vwMake, name: "Golf" } as any);
      const vwConfigId = await ctx.db.insert("vehicle_configs", {
        config_key: `2024_vw_golf_${Date.now()}`,
        year: 2024,
        make_id: vwMake,
        model_id: modelId,
      } as any);
      return { vwMake, vwConfigId };
    });

    await t.mutation(upsert, { ...baseArgs(vwMake, vwConfigId), oem_part_number: "5Q0 698 451 A" });
    await t.mutation(upsert, { ...baseArgs(vwMake, vwConfigId), oem_part_number: "5Q0698451A" });

    const parts = await t.run((ctx) => ctx.db.query("oem_parts").collect());
    expect(parts).toHaveLength(1);
    expect(parts[0].oem_part_number_normalized).toBe("5Q0698451A");
    expect(parts[0].source_count).toBe(2);
  });

  test("supersession redirect: a superseded number fits against the successor", async () => {
    const t = makeT();
    const { alfaMake, configId } = await seedMakesAndConfig(t);

    const { oldId, newId } = await t.run(async (ctx) => {
      const oldId = await ctx.db.insert("oem_parts", {
        oem_part_number: "68152142AA",
        oem_part_number_normalized: "68152142AA",
        name: "Oil Filter",
        make_id: alfaMake,
        is_current: false,
        superseded_by: "68152142AB",
      } as any);
      const newId = await ctx.db.insert("oem_parts", {
        oem_part_number: "68152142AB",
        oem_part_number_normalized: "68152142AB",
        name: "Oil Filter",
        make_id: alfaMake,
        is_current: true,
        supersedes: "68152142AA",
      } as any);
      return { oldId, newId };
    });

    const res = await t.mutation(upsert, {
      ...baseArgs(alfaMake, configId),
      oem_part_number: "68152142AA",
      subcategory: "oil_filter",
      service_type: "oil_change",
    });

    expect(res.part_id).toBe(newId);
    const fitments = await t.run((ctx) => ctx.db.query("part_fitments").collect());
    expect(fitments).toHaveLength(1);
    expect(fitments[0].part_id).toBe(newId);

    // Old part untouched — still superseded, no is_current resurrection.
    const oldPart = await t.run((ctx) => ctx.db.get(oldId));
    expect((oldPart as any).is_current).toBe(false);
  });

  test("source_domains accrues DISTINCT domains across re-confirmations", async () => {
    const t = makeT();
    const { alfaMake, configId } = await seedMakesAndConfig(t);

    await t.mutation(upsert, { ...baseArgs(alfaMake, configId), source_domain: "alfaromeopartsdeal.com" });
    await t.mutation(upsert, { ...baseArgs(alfaMake, configId), source_domain: "www.moparonlineparts.com" });
    await t.mutation(upsert, { ...baseArgs(alfaMake, configId), source_domain: "alfaromeopartsdeal.com" });

    const fitments = await t.run((ctx) => ctx.db.query("part_fitments").collect());
    expect(fitments).toHaveLength(1);
    expect(fitments[0].source_domains).toEqual([
      "alfaromeopartsdeal.com",
      "moparonlineparts.com",
    ]);
    expect(fitments[0].source_count).toBe(3);
  });
});

describe("cloneFromChassisMatch guards", () => {
  test("skips cross-make parts and never raises confidence above source", async () => {
    const t = makeT();
    const { sourceConfig, targetConfig, alfaPartId } = await t.run(async (ctx) => {
      const alfaMake = await ctx.db.insert("makes", { name: "Alfa Romeo" } as any);
      const fordMake = await ctx.db.insert("makes", { name: "Ford" } as any);
      const modelId = await ctx.db.insert("models", { make_id: alfaMake, name: "Stelvio" } as any);
      const sourceConfig = await ctx.db.insert("vehicle_configs", {
        config_key: `src_${Date.now()}`,
        year: 2023,
        make_id: alfaMake,
        model_id: modelId,
        chassis_code: "949",
      } as any);
      const targetConfig = await ctx.db.insert("vehicle_configs", {
        config_key: `tgt_${Date.now()}`,
        year: 2024,
        make_id: alfaMake,
        model_id: modelId,
        chassis_code: "949",
      } as any);
      const alfaPartId = await ctx.db.insert("oem_parts", {
        oem_part_number: "68400577AA",
        name: "Front Brake Pad",
        make_id: alfaMake,
        is_current: true,
      } as any);
      const fordPartId = await ctx.db.insert("oem_parts", {
        oem_part_number: "BXT-94RH7-730",
        name: "Battery",
        make_id: fordMake,
        is_current: true,
      } as any);
      // Source config carries one good Alfa fitment (LOW confidence 0.4) and
      // one Ford contaminant (high confidence).
      await ctx.db.insert("part_fitments", {
        part_id: alfaPartId,
        vehicle_config_id: sourceConfig,
        service_type: "brake_pad_replacement",
        quantity_needed: 1,
        confidence: 0.4,
        mechanic_verified: false,
      } as any);
      await ctx.db.insert("part_fitments", {
        part_id: fordPartId,
        vehicle_config_id: sourceConfig,
        service_type: "battery_replacement",
        quantity_needed: 1,
        confidence: 0.95,
        mechanic_verified: false,
      } as any);
      return { sourceConfig, targetConfig, alfaPartId };
    });

    await t.mutation(clone, {
      source_config_id: sourceConfig,
      target_config_id: targetConfig,
      chassis_code: "949",
    });

    const cloned = await t.run(async (ctx) =>
      (await ctx.db.query("part_fitments").collect()).filter(
        (f: any) => f.vehicle_config_id === targetConfig,
      ),
    );

    // Only the Alfa part cloned; the Ford contaminant was skipped.
    expect(cloned).toHaveLength(1);
    expect(cloned[0].part_id).toBe(alfaPartId);
    // Old floor bug would have produced 0.70 from a 0.40 source; the clone
    // haircut must never RAISE confidence.
    expect(cloned[0].confidence).toBeCloseTo(0.37, 5);
  });
});
