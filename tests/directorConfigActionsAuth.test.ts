/**
 * Token-gate sweep for directorConfigActions.ts (Jun-9 review, deferred item
 * from the security commit).
 *
 * Contract under test: every director config-edit mutation validates a
 * director session token SERVER-SIDE (director_sessions lookup, expiry
 * checked) and derives the audit actor FROM the session — caller-supplied
 * actorName/actorId are no longer accepted. Mirrors the requireDirector gate
 * in directorConfigBackfills.ts.
 */
import { describe, test, expect } from "vitest";
import { api } from "../convex/_generated/api";
import { makeT } from "./helpers";

const HOUR = 60 * 60 * 1000;
const VALID_TOKEN = "tok_valid_0123456789abcdef";
const EXPIRED_TOKEN = "tok_expired_0123456789abcd";

async function seedDirectorWorld(t: ReturnType<typeof makeT>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const directorId = await ctx.db.insert("director_users", {
      name: "Real Director",
      role: "superadmin",
      totp_secret: "JBSWY3DPEHPK3PXP",
      created_at: now,
    });
    await ctx.db.insert("director_sessions", {
      user_id: directorId,
      token: VALID_TOKEN,
      created_at: now,
      expires_at: now + 12 * HOUR,
    });
    await ctx.db.insert("director_sessions", {
      user_id: directorId,
      token: EXPIRED_TOKEN,
      created_at: now - 24 * HOUR,
      expires_at: now - 12 * HOUR,
    });

    const makeId = await ctx.db.insert("makes", { name: "Testmake" });
    const modelId = await ctx.db.insert("models", {
      make_id: makeId,
      name: "Testmodel",
    });
    const engineId = await ctx.db.insert("engines", {
      engine_code: "EA211",
      make_id: makeId,
      timing_system: "chain",
    });
    const transmissionId = await ctx.db.insert("transmissions", {
      code: "AQ250",
    });
    const configId = await ctx.db.insert("vehicle_configs", {
      config_key: "2022_volkswagen_testmodel_s_ea211",
      year: 2022,
      make_id: makeId,
      model_id: modelId,
      engine_id: engineId,
      trim_name: "S",
      enrichment_status: "complete",
      fill_rate: 90,
    });
    return { directorId, makeId, modelId, engineId, transmissionId, configId };
  });
}

describe("directorConfigActions token gate", () => {
  test("every config-edit mutation rejects an invalid token", async () => {
    const t = makeT();
    const seed = await seedDirectorWorld(t);

    const calls: Array<[string, () => Promise<any>]> = [
      ["updateConfigBasics", () =>
        t.mutation(api.directorConfigActions.updateConfigBasics, {
          id: seed.configId, trim_name: "SE", token: "bogus",
        } as any)],
      ["updateEngineFields", () =>
        t.mutation(api.directorConfigActions.updateEngineFields, {
          id: seed.engineId, timing_system: "belt", token: "bogus",
        } as any)],
      ["updateTransmissionFields", () =>
        t.mutation(api.directorConfigActions.updateTransmissionFields, {
          id: seed.transmissionId, code: "DQ381", token: "bogus",
        } as any)],
      ["updateChassisSpecsFields", () =>
        t.mutation(api.directorConfigActions.updateChassisSpecsFields, {
          chassis_code: "MQB", brake_fluid_type: "DOT 4", token: "bogus",
        } as any)],
      ["updateTrimSpecsFields", () =>
        t.mutation(api.directorConfigActions.updateTrimSpecsFields, {
          vehicle_config_id: seed.configId, tire_size_front: "205/55R16", token: "bogus",
        } as any)],
      ["markConfigVerified", () =>
        t.mutation(api.directorConfigActions.markConfigVerified, {
          id: seed.configId, token: "bogus",
        } as any)],
    ];

    for (const [name, call] of calls) {
      await expect(call(), `${name} must reject an invalid token`).rejects.toThrow(
        /unauthorized/,
      );
    }

    // Nothing was written: the engine edit above must NOT have landed.
    const engine = await t.run(async (ctx) => ctx.db.get(seed.engineId));
    expect(engine!.timing_system).toBe("chain");
  });

  test("an expired session is rejected", async () => {
    const t = makeT();
    const seed = await seedDirectorWorld(t);

    await expect(
      t.mutation(api.directorConfigActions.markConfigVerified, {
        id: seed.configId,
        token: EXPIRED_TOKEN,
      } as any),
    ).rejects.toThrow(/unauthorized/);
  });

  test("a valid session applies the edit and stamps the SESSION actor on the audit row", async () => {
    const t = makeT();
    const seed = await seedDirectorWorld(t);

    const res = await t.mutation(api.directorConfigActions.updateEngineFields, {
      id: seed.engineId,
      timing_system: "belt",
      token: VALID_TOKEN,
    } as any);
    expect(res).toEqual({ ok: true, changes: 1 });

    const { engine, audit } = await t.run(async (ctx) => ({
      engine: await ctx.db.get(seed.engineId),
      audit: await ctx.db.query("audit_log").collect(),
    }));
    expect(engine!.timing_system).toBe("belt");
    expect(audit).toHaveLength(1);
    // Actor derived from the session — not from anything the caller sent.
    expect(audit[0].actor).toBe("Real Director");
    expect(audit[0].actor_id).toBe(seed.directorId);
    expect(audit[0].detail).toContain("timing_system: chain → belt");
  });

  test("caller-supplied actorName is no longer an accepted argument", async () => {
    const t = makeT();
    const seed = await seedDirectorWorld(t);

    await expect(
      t.mutation(api.directorConfigActions.markConfigVerified, {
        id: seed.configId,
        token: VALID_TOKEN,
        actorName: "Forged Admin",
      } as any),
    ).rejects.toThrow(); // unknown arg → validator error
  });
});
