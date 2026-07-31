// =============================================================================
// enrichment_run_steps writer — the per-stage trace the Enrichment Console
// Deep-Dive replays. Called (best-effort, non-fatal) from v3pipeline at each
// stage boundary. One row per (run, step), UPSERTED so the submit pass and the
// poll pass of a batch collapse into a single row (submit writes request_text +
// started_at; poll patches response_text + ended_at + tokens).
//
// Text is capped so a step doc can't approach Convex's ~1MB document limit —
// batch-1 prompts embed scraped source markdown and can be large. When a cap is
// hit the row's `truncated` flag is set.
// =============================================================================
import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

/** Per text field cap. Two capped fields + metadata stays well under the doc
 *  size limit. Batch-1 prompts (with embedded scrape markdown) are the only
 *  thing that regularly exceeds this. */
export const STEP_TEXT_CAP = 200_000;

function cap(s: string | undefined): { text: string | undefined; truncated: boolean } {
  if (s == null) return { text: undefined, truncated: false };
  if (s.length <= STEP_TEXT_CAP) return { text: s, truncated: false };
  return { text: `${s.slice(0, STEP_TEXT_CAP)}\n\n…[truncated ${s.length - STEP_TEXT_CAP} chars]`, truncated: true };
}

export const recordRunStep = internalMutation({
  args: {
    run_id: v.id("enrichment_runs"),
    vehicle_config_id: v.optional(v.id("vehicle_configs")),
    step: v.string(),
    seq: v.number(),
    status: v.optional(v.string()),
    started_at: v.optional(v.number()),
    ended_at: v.optional(v.number()),
    summary: v.optional(v.string()),
    tokens_in: v.optional(v.number()),
    tokens_out: v.optional(v.number()),
    web_searches: v.optional(v.number()),
    request_text: v.optional(v.string()),
    response_text: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const now = Date.now();
    const existing = await ctx.db
      .query("enrichment_run_steps")
      .withIndex("by_run_step", (q) => q.eq("enrichment_run_id", a.run_id).eq("step", a.step))
      .first();

    const req = cap(a.request_text);
    const res = cap(a.response_text);

    // Merge: only overwrite a field when this call supplies it (submit vs poll
    // pass each carry a different half). Duration is derived once both ends known.
    const merged = {
      enrichment_run_id: a.run_id,
      vehicle_config_id: a.vehicle_config_id ?? existing?.vehicle_config_id,
      step: a.step,
      seq: a.seq,
      status: a.status ?? existing?.status,
      started_at: a.started_at ?? existing?.started_at,
      ended_at: a.ended_at ?? existing?.ended_at,
      summary: a.summary ?? existing?.summary,
      tokens_in: a.tokens_in ?? existing?.tokens_in,
      tokens_out: a.tokens_out ?? existing?.tokens_out,
      web_searches: a.web_searches ?? existing?.web_searches,
      request_text: req.text ?? existing?.request_text,
      response_text: res.text ?? existing?.response_text,
      truncated: req.truncated || res.truncated || existing?.truncated || undefined,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    } as const;

    const startedAt = merged.started_at;
    const endedAt = merged.ended_at;
    const duration_ms = startedAt != null && endedAt != null ? Math.max(0, endedAt - startedAt) : undefined;

    if (existing) await ctx.db.patch(existing._id, { ...merged, duration_ms });
    else await ctx.db.insert("enrichment_run_steps", { ...merged, duration_ms });
  },
});
