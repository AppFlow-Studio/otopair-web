/**
 * repairpalEndpointSibling.ts — Tier 2 engine-sibling selector. When RepairPal
 * has no entry for our exact trim (e.g. BMW M550i), ask Haiku to pick the
 * closest ENGINE-equivalent RP base vehicle from the make+year candidate list.
 * The answer is validated against the list (pickValidSibling) — no hallucinated
 * vehicles. Graceful: returns null when ANTHROPIC_API_KEY is absent or on error.
 * Mirrors the Haiku pattern in lib/vehicleDatabases.ts. Not unit-tested (network);
 * verified by the live backfill integration run.
 */
import Anthropic from "@anthropic-ai/sdk";
import { pickValidSibling } from "./repairpalEndpointMatch";

const HAIKU_MODEL = "claude-haiku-4-5-20251001";

function getHaikuClient(): Anthropic | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  return apiKey ? new Anthropic({ apiKey }) : null;
}

const SYSTEM =
  "You are a vehicle powertrain expert mapping a vehicle a labor database does NOT list to the closest engine-equivalent vehicle it DOES list, for service-labor estimation. Match on engine displacement, cylinder count, and forced-induction class first; prefer the same drivetrain. Only ever answer with a model spelled EXACTLY as it appears in the provided list. If none truly shares the engine, answer null. Output JSON only.";

export async function selectEngineSiblingLLM(
  cfg: {
    year: number;
    make: string;
    model: string;
    trim?: string | null;
    displacementL?: number | null;
    cylinders?: number | null;
    drivetrain?: string | null;
  },
  candidates: { id: number; modelName: string }[],
): Promise<{ id: number; modelName: string } | null> {
  if (!candidates.length) return null;
  const client = getHaikuClient();
  if (!client) {
    console.log("[repairpal-sibling] No ANTHROPIC_API_KEY — no engine-sibling");
    return null;
  }

  const engine =
    [cfg.displacementL ? `${cfg.displacementL}L` : null, cfg.cylinders ? `${cfg.cylinders}-cyl` : null]
      .filter(Boolean)
      .join(" / ") || "unknown engine";
  const label = `${cfg.year} ${cfg.make} ${cfg.model} ${cfg.trim ?? ""}`.trim();
  const drive = cfg.drivetrain ? ` (${cfg.drivetrain})` : "";

  const userPrompt = `Our vehicle: ${label}${drive}, engine ${engine}.
RepairPal has no listing for it. From this list of RepairPal ${cfg.make} ${cfg.year} models, pick the ONE that is the closest engine-equivalent for service labor, or null if none shares the engine:
${candidates.map((c) => `  - ${c.modelName}`).join("\n")}

Return JSON: { "sibling": "<exact modelName from the list>" | null, "reason": "<short>" }`;

  try {
    const res = await client.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 512,
      temperature: 0,
      system: SYSTEM,
      messages: [{ role: "user", content: userPrompt }],
    });
    let raw = "";
    for (const block of res.content) if (block.type === "text") raw += block.text;
    raw = raw.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
    const parsed = JSON.parse(raw);
    const name = typeof parsed?.sibling === "string" ? parsed.sibling : null;
    const picked = pickValidSibling(name, candidates);
    console.log(`[repairpal-sibling] ${label}: LLM -> ${name ?? "null"} ${picked ? "(valid)" : "(no/invalid)"}`);
    return picked;
  } catch (e) {
    console.warn(`[repairpal-sibling] Haiku failed (${e}) — no engine-sibling`);
    return null;
  }
}
