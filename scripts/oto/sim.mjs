/**
 * The agent half of the loop.
 *
 * Runs every persona in fixtures/personas.json against the LIVE agent through
 * ElevenLabs' simulate-conversation API and scores three separate things:
 *
 *   1. criteria  — an LLM judge, for the things only judgement can answer
 *                  ("did it ask for the car?")
 *   2. tools     — did the expected tool actually fire, and did a forbidden one
 *                  stay quiet. Cheap, exact, and never drifts between runs.
 *   3. absolutes — literal patterns that must never appear in a reply.
 *
 * Tool calls are mocked so a client tool that would normally be executed by the
 * browser (decode_vin) does not leave the agent hanging. The mock's RETURN
 * value is not reliably plumbed through, which is exactly why the scoring here
 * asserts on the call rather than the response.
 *
 *   node scripts/oto/sim.mjs [--only <persona-id>] [--repeat 2]
 */

import { pathToFileURL } from "node:url";
import { AGENT_ID, el, fixture, clean, checkAbsolutes, pct } from "./lib.mjs";

/** True when this file was run directly (not imported by loop.mjs). */
const isMain = (url) => !!process.argv[1] && url === pathToFileURL(process.argv[1]).href;

const argv = process.argv.slice(2);
const arg = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i === -1 ? fallback : argv[i + 1];
};

const { personas } = fixture("personas.json");
const { criteria, absolutes } = fixture("criteria.json");

const MOCK = {
  default_return_value: { result: "ok" },
  tool_mock_configs: {
    decode_vin: {
      default_return_value: { result: "Decoded VIN: 2020 BMW 750i xDrive (full specs on file)." },
    },
    save_presignup: {
      default_return_value: { result: "Saved — their car will be waiting when they sign up." },
    },
  },
};

function turnsOf(conv) {
  return conv
    .map((m) => ({
      role: m.role,
      text: clean(m.message),
      tools: (m.tool_calls || []).map((t) => ({ name: t.tool_name, params: t.params_as_json || "" })),
    }))
    .filter((t) => t.text || t.tools.length);
}

export async function runPersona(p) {
  const wanted = p.criteria ? criteria.filter((c) => p.criteria.includes(c.id)) : criteria;
  const body = {
    simulation_specification: {
      simulated_user_config: { first_message: p.first, prompt: { prompt: p.prompt } },
      tool_mock_config: MOCK,
    },
    extra_evaluation_criteria: wanted.map((c) => ({
      id: c.id,
      name: c.id,
      conversation_goal_prompt: c.goal,
    })),
    new_turns_limit: p.turns ?? 16,
  };

  const t0 = Date.now();
  const res = await el(`/v1/convai/agents/${AGENT_ID}/simulate-conversation`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  const conv = res.simulated_conversation || [];
  const turns = turnsOf(conv);
  const called = [...new Set(turns.flatMap((t) => t.tools.map((x) => x.name)))];

  const judged = res.analysis?.evaluation_criteria_results || {};
  const results = {};
  const rationales = {};
  for (const c of wanted) {
    results[c.id] = judged[c.id]?.result ?? "unknown";
    if (judged[c.id]?.rationale) rationales[c.id] = judged[c.id].rationale;
  }

  const toolFailures = [];
  for (const t of p.expectTools ?? []) {
    if (!called.includes(t)) toolFailures.push({ kind: "missing", tool: t });
  }
  for (const t of p.forbidTools ?? []) {
    if (called.includes(t)) toolFailures.push({ kind: "forbidden", tool: t });
  }

  return {
    persona: p.id,
    secs: Math.round((Date.now() - t0) / 1000),
    turns: turns.length,
    toolsCalled: called,
    toolFailures,
    criteria: results,
    rationales,
    absoluteHits: checkAbsolutes(absolutes, turns),
    transcript: turns,
  };
}

export async function runSim({ only, repeat = 1, log = console.log } = {}) {
  const set = only ? personas.filter((p) => p.id === only) : personas;
  if (!set.length) throw new Error(`no persona matching "${only}"`);

  const runs = [];
  for (let r = 0; r < repeat; r++) {
    for (const p of set) {
      try {
        const out = await runPersona(p);
        runs.push(out);
        const fails = Object.entries(out.criteria)
          .filter(([, v]) => v === "failure")
          .map(([k]) => k);
        const flags = [
          ...out.toolFailures.map((f) => `${f.kind}:${f.tool}`),
          ...out.absoluteHits.map((h) => `ABSOLUTE:${h.id}`),
        ];
        log(
          `  ${out.persona.padEnd(18)} ${String(out.secs).padStart(3)}s  ` +
            `${String(out.turns).padStart(2)} turns  ` +
            `${fails.length ? "fail: " + fails.join(",") : "all judged criteria pass"}` +
            (flags.length ? `  [${flags.join(" ")}]` : "")
        );
      } catch (e) {
        log(`  ${p.id.padEnd(18)} ERROR ${String(e.message).slice(0, 150)}`);
        runs.push({ persona: p.id, error: String(e.message).slice(0, 300) });
      }
    }
  }

  // Aggregate: one pass-rate per criterion, plus the hard failures.
  //
  // The rate is pass / (pass + fail). "Unknown" means the criterion did not
  // apply to that conversation — nobody asked about coverage, no safety issue
  // came up — and counting those in the denominator drags a criterion toward
  // zero for reasons that have nothing to do with the agent. That is exactly
  // the disease the audit found in the agent's own dashboard criteria, where
  // two of five returned unknown ~87% of the time and read as failures. A high
  // unknown count is still worth surfacing: it means the criterion is scoped
  // too broadly, or the personas do not exercise it.
  const byCriterion = {};
  for (const c of criteria) {
    const seen = runs.filter((r) => r.criteria && r.criteria[c.id] !== undefined);
    const pass = seen.filter((r) => r.criteria[c.id] === "success").length;
    const fail = seen.filter((r) => r.criteria[c.id] === "failure").length;
    const unknown = seen.filter((r) => r.criteria[c.id] === "unknown").length;
    const judged = pass + fail;
    if (seen.length) {
      byCriterion[c.id] = {
        group: c.group,
        pass,
        fail,
        of: judged,
        unknown,
        rate: judged ? pct(pass, judged) : null,
      };
    }
  }

  const absoluteHits = runs.flatMap((r) =>
    (r.absoluteHits || []).map((h) => ({ persona: r.persona, ...h }))
  );
  const toolFailures = runs.flatMap((r) =>
    (r.toolFailures || []).map((f) => ({ persona: r.persona, ...f }))
  );

  return { byCriterion, absoluteHits, toolFailures, runs, personas: set.length, repeat };
}

if (isMain(import.meta.url)) {
  console.log(`Oto sim — agent ${AGENT_ID}\n`);
  const out = await runSim({ only: arg("--only"), repeat: Number(arg("--repeat", 1)) });
  console.log("\n--- criteria ---");
  for (const [id, v] of Object.entries(out.byCriterion)) {
    console.log(`  ${id.padEnd(22)} ${String(v.pass).padStart(2)}/${v.of}  ${String(v.rate).padStart(3)}%  (${v.group})`);
  }
  if (out.toolFailures.length) {
    console.log("\n--- tool assertions failed ---");
    out.toolFailures.forEach((f) => console.log(`  ${f.persona}: ${f.kind} ${f.tool}`));
  }
  if (out.absoluteHits.length) {
    console.log("\n--- ABSOLUTES VIOLATED ---");
    out.absoluteHits.forEach((h) => console.log(`  ${h.persona}: ${h.desc}\n      "${h.match}"  in: ${h.turn.slice(0, 110)}`));
  }
}
