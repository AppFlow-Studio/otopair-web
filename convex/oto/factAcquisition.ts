// =============================================================================
// Oto AI — Background fact acquisition on a retrieval miss
// =============================================================================
//
// WHY THIS EXISTS
// ---------------
// Before this module, a catalog/KB miss was a dead end. `lookup_vehicle_spec`
// returned `matched: null`, Oto answered the user from training knowledge, and
// the answer was discarded — so the next user asking the same question paid for
// the same unsourced guess. `vehicle_facts` had not grown in 28 days.
//
// The system prompt does describe an acquisition path (retrieve → catalog →
// web_search → record_vehicle_fact). It never runs. The web_search step is
// gated in the prompt on "`retrieve_vehicle_facts` returned empty", but the
// model frequently skips `retrieve_vehicle_facts` altogether, so that
// precondition can never be established and the gate is unreachable in
// practice. Measured: 0 web_search invocations across 30 consecutive real
// turns plus targeted probes.
//
// Rather than instruct the model harder (two prompt revisions moved this 0/4),
// acquisition is triggered by the MISS ITSELF, which is a deterministic event
// in code: `matched === null && candidates.length === 0`.
//
// SHAPE
// -----
// Fire-and-forget via `ctx.scheduler.runAfter(0, ...)` from the chat action.
// The turn in flight does NOT wait: the user still gets their answer from
// training knowledge at normal latency. What changes is that the fact is on
// hand for the NEXT person, cited, served free from Tier 2.
//
// HARD RULES
// ----------
//   * NEVER throws into the caller. A failed acquisition must not affect a
//     chat turn — it is a background nicety, not part of the response path.
//   * Writes ONLY `source: "web_search"` with a real `cited_url`. If the
//     search yields no URL, nothing is written. We do not launder training
//     knowledge into the KB as though it were sourced — a row without
//     provenance is worse than a missing row, because Tier 2 will serve it
//     later as if it were retrieved fact.
//   * `written_by: "system"` — this is the backend acquiring, not the chat
//     agent answering. Keeps the audit trail honest.
//   * `confidence: 0.7` — the ceiling `recordVehicleFact` enforces for
//     web_search rows (it throws above 0.7). Combined with
//     `verification_status: "unverified"`, Tier 2 computes
//     `render_disclaim_tag: true`, so the mobile renderer discloses it.
//   * SUPERSEDES the unsourced squatter rather than writing beside it. While
//     the chat agent's `oto_inferred` guess holds the canonical key,
//     `recordVehicleFact` degrades to a telemetry patch and the citation is
//     lost silently — so the squatter is retracted through `editVehicleFact`
//     (which audits it) before the sourced row is inserted. The KB check is
//     re-run immediately BEFORE the write, because the racing write lands
//     during the web search, not before it. See the pre-write block below.
// =============================================================================

import { internalAction } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { canonicalQuestionKey } from "./canonicalize";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
// Same beta header chat.ts sends; web_search is still a beta server tool.
const WEB_SEARCH_BETA = "web-search-2025-03-05";
const ACQUISITION_MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 1200;
// Deliberately lower than chat's max_uses: 3. Acquisition answers ONE narrow
// factual question; more searches means more cost for the same single row.
const MAX_WEB_SEARCHES = 2;

const topicAxisValidator = v.union(
  v.literal("vehicle"),
  v.literal("trim"),
  v.literal("chassis"),
  v.literal("engine"),
  v.literal("model_year"),
);

interface ExtractedFact {
  fact_text: string;
  cited_url: string;
  /** Model-supplied slug. The caller (a miss handler) usually can't infer a
   *  good one — it only saw a raw query string — so the researcher names it. */
  topic: string;
}

/** Shape of the fields we read off a Tier 2 row when judging provenance. */
type ProvenanceRow = {
  fact_id: string;
  source?: string;
  cited_url?: string | null;
};

/**
 * A row is "sourced" if it carries a real citation, or arrived by a channel
 * trustworthy without one. Anything else — notably the chat agent's
 * `oto_inferred` training-knowledge guess — is an UNSOURCED SQUATTER: it holds
 * the canonical key without provenance, and is exactly what this module exists
 * to replace.
 */
function isSourcedRow(row: ProvenanceRow): boolean {
  const hasUrl =
    typeof row.cited_url === "string" && row.cited_url.trim() !== "";
  return (
    hasUrl || row.source === "manufacturer" || row.source === "user_confirmed"
  );
}

/** Fallback slug when the model omits `topic`. Never produces an empty string. */
function slugify(text: string): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return s || "vehicle_spec";
}

/**
 * Pull the last well-formed JSON object out of the model's text. The model is
 * asked to close with one; web_search turns tend to prepend prose regardless
 * of instruction, so we scan from the end rather than parsing the whole body.
 */
function extractJsonBlock(text: string): ExtractedFact | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/g) ?? [];
  const candidates: string[] = fenced.map((b) =>
    b.replace(/```(?:json)?/g, "").trim(),
  );
  // Unfenced fallback: last {...} span in the text.
  const lastOpen = text.lastIndexOf("{");
  if (lastOpen !== -1) candidates.push(text.slice(lastOpen));

  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(candidates[i]) as Record<string, unknown>;
      const factText =
        typeof parsed.fact_text === "string" ? parsed.fact_text.trim() : "";
      const citedUrl =
        typeof parsed.cited_url === "string" ? parsed.cited_url.trim() : "";
      const topic =
        typeof parsed.topic === "string" ? slugify(parsed.topic) : "";
      if (!factText || !citedUrl) continue;
      // Reject anything that isn't a real http(s) URL — this is the only
      // guard standing between the KB and a hallucinated citation.
      if (!/^https?:\/\//i.test(citedUrl)) continue;
      return { fact_text: factText, cited_url: citedUrl, topic };
    } catch {
      // try the next candidate
    }
  }
  return null;
}

export const acquireFactViaWebSearch = internalAction({
  args: {
    /** The user's actual question, verbatim — used for canonicalization. */
    question_text: v.string(),
    /**
     * Stable topic slug, e.g. "oil_capacity_qts". OPTIONAL: a miss handler
     * typically only saw a raw query ("Audi RS5") and cannot infer the topic
     * of the underlying question. When omitted, the researcher names it and
     * we fall back to a slug of the question.
     */
    topic: v.optional(v.string()),
    topic_axis: v.optional(topicAxisValidator),
    /** Scoping hints; all optional — a miss often has only a raw query. */
    make: v.optional(v.string()),
    model: v.optional(v.string()),
    trim_name: v.optional(v.string()),
    year_min: v.optional(v.number()),
    year_max: v.optional(v.number()),
    /**
     * REQUIRED, unlike the scoping hints above. Two jobs: attribution on the
     * acquired row, and — load-bearing — the `editor_id` for the retraction
     * that clears an unsourced squatter off the canonical key. `editVehicleFact`
     * writes a paired audit row whose `edited_by` is a hard v.id("users"), and
     * there is no system-user sentinel in this deployment (`users` is
     * Clerk-synced; a synthetic row would surface in counts and admin lists).
     *
     * So an acquisition without an identity could not retract, and would fall
     * back to a `recordVehicleFact` call that silently no-ops against the
     * squatter. Requiring the id here makes that state unrepresentable rather
     * than handled at runtime. The sole caller (chat.ts's lookup_vehicle_spec
     * miss hook) always has the asking user, so nothing is lost.
     */
    asked_by_user_id: v.id("users"),
  },
  handler: async (ctx, args): Promise<{ ok: boolean; reason?: string }> => {
    try {
      const questionText = args.question_text.trim();
      if (!questionText) return { ok: false, reason: "empty question_text" };

      const canonical_question_key = await canonicalQuestionKey(questionText);

      // Unscoped read: the acquisition path often has no vehicle_config_id
      // (the whole point is that the config missed).
      const readKb = async (): Promise<ProvenanceRow[]> => {
        const rows = await ctx.runQuery(
          internal.oto.vehicleFactsKB.lookupFactsByCanonicalHash,
          { canonical_question_key, limit: 5 },
        );
        return Array.isArray(rows) ? (rows as ProvenanceRow[]) : [];
      };

      // ── Pre-search bail-out ─────────────────────────────────────────────
      // Cheap check so a question already answered with provenance doesn't
      // re-run a paid search on every miss. Only a SOURCED row short-circuits:
      // presence alone is the wrong test, because an unsourced squatter means
      // "not yet acquired", which is precisely when we DO want to search.
      //
      // This is not the authoritative check — see the pre-write re-read below.
      if ((await readKb()).some(isSourcedRow)) {
        return { ok: false, reason: "already sourced in KB" };
      }

      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        console.warn("[oto/factAcquisition] ANTHROPIC_API_KEY unset; skipping.");
        return { ok: false, reason: "no api key" };
      }

      const scope = [
        args.year_min ? String(args.year_min) : null,
        args.make ?? null,
        args.model ?? null,
        args.trim_name ?? null,
      ]
        .filter(Boolean)
        .join(" ");

      const instruction = [
        "You are a research worker for an automotive knowledge base. You are NOT talking to a user.",
        "",
        `Question: ${questionText}`,
        scope ? `Vehicle scope: ${scope}` : "",
        "",
        "Use web_search to find this from an authoritative automotive source (manufacturer documentation, owner's manual, or a reputable marque/spec publication).",
        "",
        "Then reply with ONE fenced json block and nothing after it:",
        '```json',
        '{"topic": "<short_stable_slug>", "fact_text": "<one self-contained sentence stating the fact, including the vehicle it applies to>", "cited_url": "<the exact source URL you used>"}',
        '```',
        "",
        'topic must be a short snake_case slug naming WHAT the fact is, not the vehicle — e.g. "oil_capacity_qts", "timing_belt_or_chain", "recommended_tire_pressure". Reuse the obvious conventional name so future lookups for the same question match.',
        "",
        "Rules:",
        "- cited_url MUST be a real URL returned by web_search. Never invent one.",
        "- If the search does not produce a confident, sourced answer, reply with exactly: NO_RESULT",
        "- Do not answer from your own training knowledge. No source, no answer.",
      ]
        .filter((l) => l !== "")
        .join("\n");

      const resp = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          "anthropic-beta": WEB_SEARCH_BETA,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: ACQUISITION_MODEL,
          max_tokens: MAX_TOKENS,
          messages: [{ role: "user", content: instruction }],
          tools: [
            {
              type: "web_search_20250305",
              name: "web_search",
              max_uses: MAX_WEB_SEARCHES,
            },
          ],
        }),
      });

      if (!resp.ok) {
        console.warn(
          `[oto/factAcquisition] Anthropic ${resp.status}; skipping acquisition.`,
        );
        return { ok: false, reason: `anthropic ${resp.status}` };
      }

      const body = (await resp.json()) as {
        content?: Array<{ type?: string; text?: string }>;
      };
      const text = (body.content ?? [])
        .filter((b) => b?.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string)
        .join("\n");

      if (!text || /NO_RESULT/.test(text)) {
        return { ok: false, reason: "no sourced result" };
      }

      const extracted = extractJsonBlock(text);
      if (!extracted) {
        return { ok: false, reason: "no parseable fact+url" };
      }

      // ── Pre-write re-read: settle the race ──────────────────────────────
      // The bail-out above ran BEFORE the web search — seconds ago. The racing
      // write lands inside exactly that window: the chat agent emits
      // `record_vehicle_fact` for its training-knowledge answer while we are
      // still searching. So the KB state observed at entry is stale by now,
      // and checking only there would miss the very row we must displace.
      const rowsNow = await readKb();

      // Someone else acquired provenance while we searched. Theirs stands.
      if (rowsNow.some(isSourcedRow)) {
        return { ok: false, reason: "sourced row appeared during search" };
      }

      // ── Retract the unsourced squatter ──────────────────────────────────
      // `recordVehicleFact` dedupes on canonical_question_key and, on a hit,
      // patches only asked_at/updated_at — it will NOT overwrite fact_text,
      // source, or cited_url. So while a squatter holds the key, the sourced
      // row cannot be written at all: the insert degrades to a telemetry touch
      // and the citation is lost with no error raised.
      //
      // Retract-then-insert, NOT edit-in-place. The squatter was created with
      // verification_status "verified" (recordVehicleFact derives status from
      // source, and only web_search starts "unverified"). Flipping just its
      // source to "web_search" would leave (web_search, verified), making the
      // locked F.5 predicate `render_disclaim_tag` compute FALSE — serving a
      // web-scraped fact with no disclosure. editVehicleFact offers no
      // verified→unverified transition to undo that, and `edit_meta` is barred
      // from touching verification_status at all. A fresh insert derives
      // "unverified" from the source rule correctly.
      const squatter = rowsNow.find((r) => !isSourcedRow(r)) ?? null;
      if (squatter) {
        // Attributed to the asking user, not to a machine actor: `edited_by`
        // is a hard v.id("users") and this deployment has no system sentinel
        // (see the arg doc above). The audit row's `reason` carries the real
        // provenance, so the trail still reads honestly — the retraction was
        // made on this user's turn, by the acquisition path.
        await ctx.runMutation(
          internal.oto.vehicleFactsEditing.editVehicleFact,
          {
            fact_id: squatter.fact_id as Id<"vehicle_facts">,
            action: "retract" as const,
            editor_id: args.asked_by_user_id,
            reason:
              "Unsourced answer superseded by a web-sourced fact acquired on retrieval miss.",
            changes: { verification_status: "retracted" as const },
          },
        );
      }

      // ── Write ───────────────────────────────────────────────────────────
      // Caller hint wins when supplied; otherwise the researcher's slug;
      // otherwise a slug of the question itself.
      const resolvedTopic =
        (args.topic && args.topic.trim()) ||
        extracted.topic ||
        slugify(questionText);

      const writeArgs: Record<string, unknown> = {
        topic: resolvedTopic,
        topic_axis: args.topic_axis ?? "vehicle",
        fact_text: extracted.fact_text,
        question_text: questionText,
        canonical_question_key,
        source: "web_search",
        cited_url: extracted.cited_url,
        written_by: "system",
        // Ceiling enforced by recordVehicleFact (throws above 0.7).
        confidence: 0.7,
        // Always present — the arg is required. Unconditional, unlike the
        // optional scoping hints appended below.
        asked_by_user_id: args.asked_by_user_id,
      };
      for (const k of ["make", "model", "trim_name"] as const) {
        const val = args[k];
        if (typeof val === "string" && val.trim()) writeArgs[k] = val;
      }
      for (const k of ["year_min", "year_max"] as const) {
        const val = args[k];
        if (typeof val === "number" && Number.isFinite(val)) writeArgs[k] = val;
      }

      await ctx.runMutation(
        internal.oto.vehicleFactsEditing.recordVehicleFact,
        writeArgs as any,
      );

      console.log(
        `[oto/factAcquisition] acquired topic="${resolvedTopic}" url=${extracted.cited_url}`,
      );
      return { ok: true };
    } catch (e) {
      // Swallow: acquisition is best-effort background work. It must never
      // surface as an error on a chat turn that already answered the user.
      console.warn(
        "[oto/factAcquisition] swallowed error:",
        e instanceof Error ? e.message : String(e),
      );
      return { ok: false, reason: "exception" };
    }
  },
});
