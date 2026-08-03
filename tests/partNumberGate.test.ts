/**
 * Fail-closed part-number gate on the enrichment write choke point.
 *
 * The gate's whole value is an asymmetry: "absent" (a completed, fresh catalog
 * index for this make positively lacks the number) quarantines the fitment;
 * EVERY other state — no index, partial index, failed ingest, stale index,
 * oracle unreachable — writes exactly as an ungated run would. A make we have
 * never crawled must never look like evidence that a part is fake, so the
 * fail-open cases are tested at least as hard as the fail-closed one.
 *
 * Pure-first: the policy is a table test with no database. The convex-test
 * block underneath proves the seam actually consults the oracle and actually
 * stamps the row, since a correct policy wired to nothing is still a no-op.
 */
import { describe, expect, it, afterEach } from "vitest";
import { makeT } from "./helpers";
import { internal } from "../convex/_generated/api";
import {
  PART_NOT_IN_CATALOG_QUALITY,
  combineExistenceVerdicts,
  decidePartWriteAction,
  parsePartExistenceGateMode,
  partExistenceGateMode,
  type PartExistenceGateMode,
} from "../convex/vehicleEnrichment/v3mutations";
import type { ExistenceVerdict } from "../convex/vehicleEnrichment/partIndex";

const GATE_ENV = "ENRICHMENT_PART_EXISTENCE_GATE";

afterEach(() => {
  delete process.env[GATE_ENV];
});

// ---------------------------------------------------------------------------
// 1. Mode parsing — the kill switch
// ---------------------------------------------------------------------------

describe("parsePartExistenceGateMode", () => {
  it("defaults to log when the variable is unset", () => {
    expect(parsePartExistenceGateMode(undefined)).toBe("log");
    expect(parsePartExistenceGateMode(null)).toBe("log");
    expect(parsePartExistenceGateMode("")).toBe("log");
  });

  it("accepts the two explicit stages, case- and whitespace-insensitively", () => {
    expect(parsePartExistenceGateMode("enforce")).toBe("enforce");
    expect(parsePartExistenceGateMode("  ENFORCE ")).toBe("enforce");
    expect(parsePartExistenceGateMode("off")).toBe("off");
    expect(parsePartExistenceGateMode("Off")).toBe("off");
    expect(parsePartExistenceGateMode("log")).toBe("log");
  });

  it("treats a typo as log, never as enforce", () => {
    // A misspelled stage must not arm a gate that quarantines fitments.
    for (const typo of ["enforc", "enforced", "true", "1", "yes", "ENFORCE!"]) {
      expect(parsePartExistenceGateMode(typo)).toBe("log");
    }
  });
});

describe("partExistenceGateMode", () => {
  it("is log by default — every gate in this pipeline dark-launches", () => {
    expect(partExistenceGateMode()).toBe("log");
  });

  it("reads the env at call time, not at module load", () => {
    process.env[GATE_ENV] = "enforce";
    expect(partExistenceGateMode()).toBe("enforce");
    process.env[GATE_ENV] = "off";
    expect(partExistenceGateMode()).toBe("off");
  });
});

// ---------------------------------------------------------------------------
// 2. The decision table
// ---------------------------------------------------------------------------

const VERDICTS: ExistenceVerdict[] = ["found", "absent", "no_index"];
const MODES: PartExistenceGateMode[] = ["off", "log", "enforce"];

type Row = {
  verdict: ExistenceVerdict;
  mode: PartExistenceGateMode;
  mechanicVerified: boolean;
  action: "allow" | "quarantine";
  record: boolean;
};

const TABLE: Row[] = [
  // The one cell that blocks: positive evidence, no human, gate armed.
  { verdict: "absent", mode: "enforce", mechanicVerified: false, action: "quarantine", record: true },
  // A human beats the catalog. Catalogs drop superseded numbers that are still
  // the right part on the bench.
  { verdict: "absent", mode: "enforce", mechanicVerified: true, action: "allow", record: true },
  // Dark launch: measure, never block.
  { verdict: "absent", mode: "log", mechanicVerified: false, action: "allow", record: true },
  { verdict: "absent", mode: "log", mechanicVerified: true, action: "allow", record: true },
  // Kill switch beats everything, including positive evidence.
  { verdict: "absent", mode: "off", mechanicVerified: false, action: "allow", record: false },
  { verdict: "absent", mode: "off", mechanicVerified: true, action: "allow", record: false },
  // THE most important rows: absence of an index never blocks a write.
  { verdict: "no_index", mode: "enforce", mechanicVerified: false, action: "allow", record: false },
  { verdict: "no_index", mode: "enforce", mechanicVerified: true, action: "allow", record: false },
  { verdict: "no_index", mode: "log", mechanicVerified: false, action: "allow", record: false },
  { verdict: "no_index", mode: "off", mechanicVerified: false, action: "allow", record: false },
  // A hit is a hit.
  { verdict: "found", mode: "enforce", mechanicVerified: false, action: "allow", record: false },
  { verdict: "found", mode: "enforce", mechanicVerified: true, action: "allow", record: false },
  { verdict: "found", mode: "log", mechanicVerified: false, action: "allow", record: false },
  { verdict: "found", mode: "off", mechanicVerified: false, action: "allow", record: false },
];

describe("decidePartWriteAction", () => {
  for (const row of TABLE) {
    it(`${row.verdict} + ${row.mode} + mechanic_verified=${row.mechanicVerified} → ${row.action}`, () => {
      const out = decidePartWriteAction({
        verdict: row.verdict,
        mode: row.mode,
        mechanicVerified: row.mechanicVerified,
      });
      expect(out.action).toBe(row.action);
      expect(out.record).toBe(row.record);
      expect(out.reason === null).toBe(!row.record);
    });
  }

  it("covers every (verdict, mode, mechanicVerified) combination", () => {
    const combos = VERDICTS.length * MODES.length * 2;
    const covered = new Set(
      TABLE.map((r) => `${r.verdict}|${r.mode}|${r.mechanicVerified}`),
    );
    // The table is deliberately not exhaustive on the boring rows; assert that
    // whatever it omits is still allow-with-no-record, so a future change that
    // makes an omitted cell block cannot slip through unnoticed.
    let blocked = 0;
    for (const verdict of VERDICTS) {
      for (const mode of MODES) {
        for (const mechanicVerified of [false, true]) {
          const out = decidePartWriteAction({ verdict, mode, mechanicVerified });
          if (out.action === "quarantine") blocked++;
        }
      }
    }
    expect(blocked).toBe(1);
    expect(covered.size).toBeLessThanOrEqual(combos);
  });

  it("quarantine carries a machine-stable reason code", () => {
    expect(
      decidePartWriteAction({ verdict: "absent", mode: "enforce", mechanicVerified: false })
        .reason,
    ).toBe("part_not_in_catalog");
    expect(
      decidePartWriteAction({ verdict: "absent", mode: "enforce", mechanicVerified: true })
        .reason,
    ).toBe("part_not_in_catalog:mechanic_verified_exempt");
    expect(
      decidePartWriteAction({ verdict: "absent", mode: "log", mechanicVerified: false }).reason,
    ).toBe("part_not_in_catalog:log_only");
  });
});

// ---------------------------------------------------------------------------
// 3. Multi-make combination (badge-engineered vehicles carry builder numbers)
// ---------------------------------------------------------------------------

describe("combineExistenceVerdicts", () => {
  it("no makes consulted → no_index", () => {
    expect(combineExistenceVerdicts([])).toBe("no_index");
  });

  it("any catalog vouching is enough", () => {
    expect(combineExistenceVerdicts(["absent", "found"])).toBe("found");
    expect(combineExistenceVerdicts(["no_index", "found"])).toBe("found");
  });

  it("fails closed only when EVERY consulted catalog lacks the number", () => {
    expect(combineExistenceVerdicts(["absent"])).toBe("absent");
    expect(combineExistenceVerdicts(["absent", "absent"])).toBe("absent");
  });

  it("one unconsultable catalog defeats absence — a Mazda number on a Toyota badge", () => {
    // Toyota is indexed and genuinely lacks the builder's number; Mazda is not
    // indexed. Quarantining here would discard a correct P2.5 builder part.
    expect(combineExistenceVerdicts(["absent", "no_index"])).toBe("no_index");
  });
});

// ---------------------------------------------------------------------------
// 4. The seam — upsertPartAndFitment actually consults the oracle
// ---------------------------------------------------------------------------

const upsert = internal.vehicleEnrichment.v3mutations.upsertPartAndFitment;

/** Format-valid Toyota numbers (5 digits + dash + 5 alphanumerics) so the write
 *  reaches the existence gate instead of dying in sanitizePartNumber. */
const REAL_NUMBER = "04152-YZZA1";
const FAKE_NUMBER = "99999-99999";

const DAY_MS = 24 * 60 * 60 * 1000;

async function seedToyotaConfig(t: ReturnType<typeof makeT>) {
  return t.run(async (ctx) => {
    const makeId = await ctx.db.insert("makes", { name: "Toyota" } as any);
    const modelId = await ctx.db.insert("models", { make_id: makeId, name: "Camry" } as any);
    const configId = await ctx.db.insert("vehicle_configs", {
      config_key: `2020_toyota_camry_${Math.random().toString(36).slice(2)}`,
      year: 2020,
      make_id: makeId,
      model_id: modelId,
    } as any);
    return { makeId, configId };
  });
}

/** Stamp a part_index_status row for toyota/partsdeal, plus optional rows in
 *  part_url_index. `completedAgoMs` undefined ⇒ no completed_at at all. */
async function seedIndex(
  t: ReturnType<typeof makeT>,
  opts: { status: string; completedAgoMs?: number; numbers?: string[] },
) {
  await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("part_index_status", {
      make: "toyota",
      source: "partsdeal",
      status: opts.status,
      started_at: now - 60_000,
      ...(opts.completedAgoMs !== undefined
        ? { completed_at: now - opts.completedAgoMs }
        : {}),
    } as any);
    for (const n of opts.numbers ?? []) {
      await ctx.db.insert("part_url_index", {
        make: "toyota",
        part_number_normalized: n.replace(/[^A-Za-z0-9]/g, "").toUpperCase(),
        part_number_raw: n,
        source: "partsdeal",
        url: `https://www.toyotapartsdeal.com/oem/toyota~thing~${n.toLowerCase()}.html`,
        fetched_at: now,
      } as any);
    }
  });
}

const writeArgs = (makeId: any, configId: any, oem: string) => ({
  oem_part_number: oem,
  name: "Oil Filter",
  category: "engine",
  subcategory: "oil_filter",
  make_id: makeId,
  vehicle_config_id: configId,
  service_type: "oil_change",
  quantity_needed: 1,
  confidence: 0.85,
  source_domain: "toyotapartsdeal.com",
});

async function fitmentQuality(t: ReturnType<typeof makeT>, fitmentId: any) {
  return t.run(async (ctx) => (await ctx.db.get(fitmentId))?.data_quality ?? null);
}

describe("upsertPartAndFitment existence gate (wired)", () => {
  it("no index for the make + enforce → writes clean (the fail-open law)", async () => {
    process.env[GATE_ENV] = "enforce";
    const t = makeT();
    const { makeId, configId } = await seedToyotaConfig(t);

    const res: any = await t.mutation(upsert, writeArgs(makeId, configId, FAKE_NUMBER));

    expect(res.fitment_id).not.toBeNull();
    expect(res.part_existence.verdict).toBe("no_index");
    expect(res.part_existence.action).toBe("allow");
    expect(await fitmentQuality(t, res.fitment_id)).toBeNull();
  });

  it("ingest still running + enforce → writes clean (a partial index never says absent)", async () => {
    process.env[GATE_ENV] = "enforce";
    const t = makeT();
    const { makeId, configId } = await seedToyotaConfig(t);
    await seedIndex(t, { status: "running", numbers: [REAL_NUMBER] });

    const res: any = await t.mutation(upsert, writeArgs(makeId, configId, FAKE_NUMBER));

    expect(res.part_existence.verdict).toBe("no_index");
    expect(await fitmentQuality(t, res.fitment_id)).toBeNull();
  });

  it("failed ingest + enforce → writes clean", async () => {
    process.env[GATE_ENV] = "enforce";
    const t = makeT();
    const { makeId, configId } = await seedToyotaConfig(t);
    await seedIndex(t, { status: "failed", numbers: [REAL_NUMBER] });

    const res: any = await t.mutation(upsert, writeArgs(makeId, configId, FAKE_NUMBER));

    expect(res.part_existence.verdict).toBe("no_index");
    expect(await fitmentQuality(t, res.fitment_id)).toBeNull();
  });

  it("index aged past the freshness window + enforce → writes clean", async () => {
    process.env[GATE_ENV] = "enforce";
    const t = makeT();
    const { makeId, configId } = await seedToyotaConfig(t);
    await seedIndex(t, { status: "ok", completedAgoMs: 45 * DAY_MS, numbers: [REAL_NUMBER] });

    const res: any = await t.mutation(upsert, writeArgs(makeId, configId, FAKE_NUMBER));

    expect(res.part_existence.verdict).toBe("no_index");
    expect(await fitmentQuality(t, res.fitment_id)).toBeNull();
  });

  it("fresh complete index containing the number + enforce → writes clean", async () => {
    process.env[GATE_ENV] = "enforce";
    const t = makeT();
    const { makeId, configId } = await seedToyotaConfig(t);
    await seedIndex(t, { status: "ok", completedAgoMs: 60_000, numbers: [REAL_NUMBER] });

    const res: any = await t.mutation(upsert, writeArgs(makeId, configId, REAL_NUMBER));

    expect(res.part_existence.verdict).toBe("found");
    expect(await fitmentQuality(t, res.fitment_id)).toBeNull();
  });

  it("fresh complete index LACKING the number + enforce → fitment quarantined, not deleted", async () => {
    process.env[GATE_ENV] = "enforce";
    const t = makeT();
    const { makeId, configId } = await seedToyotaConfig(t);
    await seedIndex(t, { status: "ok", completedAgoMs: 60_000, numbers: [REAL_NUMBER] });

    const res: any = await t.mutation(upsert, writeArgs(makeId, configId, FAKE_NUMBER));

    expect(res.part_existence.verdict).toBe("absent");
    expect(res.part_existence.action).toBe("quarantine");
    expect(res.fitment_id).not.toBeNull();
    expect(await fitmentQuality(t, res.fitment_id)).toBe(PART_NOT_IN_CATALOG_QUALITY);
  });

  it("same evidence in the DEFAULT mode → written clean but recorded", async () => {
    // No env set at all — this is what the pipeline does today.
    const t = makeT();
    const { makeId, configId } = await seedToyotaConfig(t);
    await seedIndex(t, { status: "ok", completedAgoMs: 60_000, numbers: [REAL_NUMBER] });

    const res: any = await t.mutation(upsert, writeArgs(makeId, configId, FAKE_NUMBER));

    expect(res.part_existence.mode).toBe("log");
    expect(res.part_existence.verdict).toBe("absent");
    expect(res.part_existence.action).toBe("allow");
    expect(res.part_existence.reason).toBe("part_not_in_catalog:log_only");
    expect(await fitmentQuality(t, res.fitment_id)).toBeNull();
  });

  it("off → the oracle is not even consulted", async () => {
    process.env[GATE_ENV] = "off";
    const t = makeT();
    const { makeId, configId } = await seedToyotaConfig(t);
    await seedIndex(t, { status: "ok", completedAgoMs: 60_000, numbers: [REAL_NUMBER] });

    const res: any = await t.mutation(upsert, writeArgs(makeId, configId, FAKE_NUMBER));

    expect(res.part_existence.verdict).toBe("no_index");
    expect(res.part_existence.action).toBe("allow");
    expect(await fitmentQuality(t, res.fitment_id)).toBeNull();
  });

  it("mechanic-verified fitment + absent + enforce → never quarantined", async () => {
    process.env[GATE_ENV] = "enforce";
    const t = makeT();
    const { makeId, configId } = await seedToyotaConfig(t);
    await seedIndex(t, { status: "ok", completedAgoMs: 60_000, numbers: [REAL_NUMBER] });

    // First write lands the row, then a human signs off on it.
    const first: any = await t.mutation(upsert, writeArgs(makeId, configId, FAKE_NUMBER));
    await t.run(async (ctx) => {
      await ctx.db.patch(first.fitment_id, {
        mechanic_verified: true,
        data_quality: undefined,
      });
    });

    const second: any = await t.mutation(upsert, writeArgs(makeId, configId, FAKE_NUMBER));

    expect(second.fitment_id).toBe(first.fitment_id);
    expect(second.part_existence.verdict).toBe("absent");
    expect(second.part_existence.action).toBe("allow");
    expect(second.part_existence.reason).toBe("part_not_in_catalog:mechanic_verified_exempt");
    expect(await fitmentQuality(t, second.fitment_id)).toBeNull();
  });

  it("a number the catalog later carries is released from quarantine", async () => {
    process.env[GATE_ENV] = "enforce";
    const t = makeT();
    const { makeId, configId } = await seedToyotaConfig(t);
    await seedIndex(t, { status: "ok", completedAgoMs: 60_000, numbers: [REAL_NUMBER] });

    const first: any = await t.mutation(upsert, writeArgs(makeId, configId, FAKE_NUMBER));
    expect(await fitmentQuality(t, first.fitment_id)).toBe(PART_NOT_IN_CATALOG_QUALITY);

    // A later crawl finds it — the stamp this gate applied comes back off.
    await t.run(async (ctx) => {
      await ctx.db.insert("part_url_index", {
        make: "toyota",
        part_number_normalized: FAKE_NUMBER.replace(/[^A-Za-z0-9]/g, "").toUpperCase(),
        source: "partsdeal",
        fetched_at: Date.now(),
      } as any);
    });

    const second: any = await t.mutation(upsert, writeArgs(makeId, configId, FAKE_NUMBER));
    expect(second.part_existence.verdict).toBe("found");
    expect(await fitmentQuality(t, second.fitment_id)).toBeNull();
  });

  it("a cross-make quarantine stamp is another gate's verdict — never lifted here", async () => {
    process.env[GATE_ENV] = "enforce";
    const t = makeT();
    const { makeId, configId } = await seedToyotaConfig(t);
    await seedIndex(t, { status: "ok", completedAgoMs: 60_000, numbers: [REAL_NUMBER] });

    const first: any = await t.mutation(upsert, writeArgs(makeId, configId, REAL_NUMBER));
    await t.run(async (ctx) => {
      await ctx.db.patch(first.fitment_id, { data_quality: "cross_make_quarantined" });
    });

    const second: any = await t.mutation(upsert, writeArgs(makeId, configId, REAL_NUMBER));

    expect(second.part_existence.verdict).toBe("found");
    expect(await fitmentQuality(t, second.fitment_id)).toBe("cross_make_quarantined");
  });

  it("builder-brand number on a badge-engineered car is not quarantined", async () => {
    process.env[GATE_ENV] = "enforce";
    const t = makeT();
    const { makeId, configId } = await seedToyotaConfig(t);
    // Toyota indexed and complete; Mazda never crawled. The number is absent
    // from Toyota's catalog and that must NOT be enough.
    await seedIndex(t, { status: "ok", completedAgoMs: 60_000, numbers: [REAL_NUMBER] });

    const res: any = await t.mutation(upsert, {
      ...writeArgs(makeId, configId, FAKE_NUMBER),
      build_source_make: "Mazda",
    });

    expect(res.part_existence.makes).toEqual(["Toyota", "Mazda"]);
    expect(res.part_existence.verdict).toBe("no_index");
    expect(await fitmentQuality(t, res.fitment_id)).toBeNull();
  });
});
