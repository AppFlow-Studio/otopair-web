/**
 * P1 IDOR sweep for the Oto modules (OTO_HANDOFF.md §B-P1, OTO_REVIEW.md
 * findings 1, 9, 26, 38).
 *
 * Contract under test: every Oto memory/fact/KB/telemetry/eval writer and
 * server-plumbing reader is registered INTERNAL. As public mutations these
 * let any anonymous caller with the deployment URL write to any user's
 * persistent memory (user_semantic_facts at confidence 1.0 — stored prompt
 * injection), the shared cross-user KB (vehicle_facts as "verified"), the
 * forensic audit log (conversation_audit), and telemetry. All runtime
 * callers are server-side (chat.ts tool dispatch, migrations, eval harness),
 * so nothing client-facing changes.
 *
 * Also locked in: the dead legacy KB writers insertFact/recordFact
 * (vehicleFactsKB.ts) are deleted outright — the sanctioned write path is
 * vehicleFactsEditing.recordVehicleFact.
 */
import { describe, test, expect } from "vitest";
import { internal } from "../convex/_generated/api";
import { makeT } from "./helpers";

import * as memoryEditing from "../convex/oto/memoryEditing";
import * as vehicleFactsEditing from "../convex/oto/vehicleFactsEditing";
import * as telemetry from "../convex/oto/telemetry";
import * as vehicleFactsKB from "../convex/oto/vehicleFactsKB";
import * as lookupVehicleSpecModule from "../convex/oto/lookupVehicleSpec";
import * as evalHarness from "../convex/oto/evalHarness";
import * as promptChangelog from "../convex/oto/promptChangelog";

const MUST_BE_INTERNAL: Array<
  [string, Record<string, unknown>, string[]]
> = [
  [
    "oto/memoryEditing",
    memoryEditing,
    [
      "recordConversationFact",
      "recordSelectionFact",
      "retractConversationFact",
      "recordUserSemanticFact",
      "reinforceUserSemanticFact",
      "retractUserSemanticFact",
      "getEpisodicControl",
      "initEpisodicControl",
      "commitEpisodic",
      "commitControl",
      "recordTurn",
      "registerKbTopic",
      "deprecateKbTopic",
    ],
  ],
  [
    "oto/vehicleFactsEditing",
    vehicleFactsEditing,
    [
      "recordVehicleFact",
      "editVehicleFact",
      "reportVehicleFact",
      "resolveFactReport",
    ],
  ],
  ["oto/telemetry", telemetry, ["recordTurn"]],
  [
    "oto/vehicleFactsKB",
    vehicleFactsKB,
    [
      "lookupFactsByCanonicalHash",
      "lookupFactsStructural",
      "lookupFactsByText",
      "cascadeTier2",
    ],
  ],
  ["oto/lookupVehicleSpec", lookupVehicleSpecModule, ["lookupVehicleSpec"]],
  ["oto/evalHarness", evalHarness, ["runFullCascade"]],
  [
    "oto/promptChangelog",
    promptChangelog,
    ["setActivePromptVersion", "listRecentChanges"],
  ],
];

describe("P1 IDOR sweep — registration visibility", () => {
  for (const [moduleName, mod, names] of MUST_BE_INTERNAL) {
    for (const name of names) {
      test(`${moduleName}.${name} is internal, not public`, () => {
        const fn = mod[name] as
          | { isPublic?: boolean; isInternal?: boolean }
          | undefined;
        expect(fn, `${moduleName}.${name} should exist`).toBeDefined();
        expect(
          fn!.isPublic,
          `${moduleName}.${name} must NOT be registered public`,
        ).not.toBe(true);
        expect(
          fn!.isInternal,
          `${moduleName}.${name} must be registered internal`,
        ).toBe(true);
      });
    }
  }

  test("dead legacy KB writers are deleted (insertFact / recordFact)", () => {
    expect((vehicleFactsKB as Record<string, unknown>).insertFact).toBeUndefined();
    expect((vehicleFactsKB as Record<string, unknown>).recordFact).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Internal path still works — representative behavioral checks. (chat.ts and
// the migrations flip from api.oto.* to internal.oto.*; these prove the
// converted functions execute unchanged through the internal reference.)
// ---------------------------------------------------------------------------

async function seedConversation(t: ReturnType<typeof makeT>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const userId = await ctx.db.insert("users", {
      clerkUserId: `clerk_oto_${now}`,
      email: "oto@test.local",
      first_name: "Oto",
      role: "user",
      createdAt: now,
    });
    const conversationId = await ctx.db.insert("ai_conversations", {
      user_id: userId,
      session_id: `sess_${now}`,
      started_at: now,
      led_to_booking: false,
      message_count: 0,
    });
    return { userId, conversationId };
  });
}

describe("P1 IDOR sweep — internal paths still work", () => {
  test("internal.oto.telemetry.recordTurn inserts an oto_telemetry row", async () => {
    const t = makeT();
    const { userId, conversationId } = await seedConversation(t);

    const res = await t.mutation(internal.oto.telemetry.recordTurn, {
      conversation_id: conversationId,
      user_id: userId,
      model: "haiku",
      system_prompt_version: "v-test",
      iterations_used: 1,
      hit_cap: false,
      input_tokens: 1200,
      output_tokens: 240,
      total_latency_ms: 900,
      tools_called: ["update_conversation_state"],
      final_branch: "text_reply",
    });
    expect(res).toEqual({ ok: true });

    const rows = await t.run(async (ctx) =>
      ctx.db.query("oto_telemetry").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].input_tokens).toBe(1200);
    expect(rows[0].user_id).toBe(userId);
  });

  test("internal.oto.memoryEditing.recordTurn appends to conversation_audit", async () => {
    const t = makeT();
    const { conversationId } = await seedConversation(t);

    const auditId = await t.mutation(internal.oto.memoryEditing.recordTurn, {
      conversation_id: conversationId,
      turn_number: 0,
      role: "user",
      content: "my brakes squeal",
    });
    expect(auditId).toBeDefined();

    const rows = await t.run(async (ctx) =>
      ctx.db.query("conversation_audit").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].turn_number).toBe(0);
    expect(rows[0].role).toBe("user");
  });

  test("internal.oto.vehicleFactsEditing.recordVehicleFact inserts a KB fact", async () => {
    const t = makeT();

    await t.mutation(internal.oto.vehicleFactsEditing.recordVehicleFact, {
      topic: "oil_capacity",
      topic_axis: "engine",
      engine_code: "N63",
      fact_text: "The N63 takes 10.2 quarts of 0W-30.",
      question_text: "How much oil does the N63 take?",
      canonical_question_key: "engine:n63:oil_capacity",
      source: "manufacturer",
      written_by: "system",
      confidence: 0.95,
    });

    const rows = await t.run(async (ctx) =>
      ctx.db.query("vehicle_facts").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].canonical_question_key).toBe("engine:n63:oil_capacity");
    expect(rows[0].verification_status).toBe("verified");
  });
});
