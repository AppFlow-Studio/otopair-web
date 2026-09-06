/**
 * scanMessageLeaks — dev-only forensic sweep of ai_messages for internal
 * vocabulary that should never reach a customer.
 *
 * Two leak classes:
 *   code identifiers   — self_reported, conversation_state, render_* … (the
 *                        underscore guard row added 2026-08-13 covers these
 *                        going forward; this scan finds historical hits)
 *   shareholder vocab  — "booking flow", "quick replies", "service slug" …
 *                        team language for features the customer just *uses*
 *                        (Waleed, 2026-08-13: "booking flow … is just internal
 *                        language between shareholders").
 *
 * Read-only. Run:
 *   npx convex run devOnly/scanMessageLeaks:scan '{"limit": 4000}'
 */
import { internalQuery } from "../_generated/server";
import { v } from "convex/values";

const LEAK_PATTERNS: { label: string; re: RegExp }[] = [
  // shareholder vocabulary
  { label: "booking flow", re: /\bbooking flow\b/i },
  { label: "quick repl(y|ies)", re: /\bquick[- ]repl(?:y|ies)\b/i },
  { label: "service slug", re: /\bslug s?\b|\bservice[- _]slugs?\b|\bslugs?\b/i },
  { label: "prefill", re: /\bpre-?fill(?:ed|s|ing)?\b/i },
  { label: "intent ladder", re: /\bintent ladder\b/i },
  { label: "trust gate", re: /\btrust[- ]gat(?:e|ing)\b/i },
  { label: "diagnostic domain", re: /\bdiagnostic domain\b/i },
  { label: "narrowing (jargon)", re: /\bnarrowing (?:mode|question|protocol)\b/i },
  { label: "terminal render", re: /\bterminal (?:render|tool)\b/i },
  { label: "render tool/call", re: /\brender (?:tool|call|directive|envelope)\b/i },
  { label: "state tool", re: /\bstate tool\b/i },
  { label: "escalate/handoff to model", re: /\b(?:escalat\w+|hand(?:off|back))\b[^.!?\n]{0,30}\b(?:sonnet|haiku|model)\b/i },
  // code identifiers (historical — new output is guard-stripped)
  { label: "render_* tool name", re: /\brender_[a-z_]+\b/ },
  { label: "underscore identifiers", re: /\bself_reported\b|\bconversation_state\b|\brecord_provenance\b|\bestablished_facts\b|\bopen_symptoms\b|\bsafety_override\b|\bcustomer_notes\b|\bservice_claims\b|\bfault_lights\b|\bdiagnostic_scan\b/ },
  { label: "model/vendor names", re: /\bHaiku\b|\bSonnet\b|\bAnthropic\b|\bConvex\b/ },
  { label: "system prompt / KB", re: /\bsystem prompt\b|\bknowledge base\b|\bKB\b/ },
];

export const scan = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = Math.min(args.limit ?? 2000, 8000);
    // Newest first so a truncated scan still covers recent behavior.
    const rows = await ctx.db.query("ai_messages").order("desc").take(limit);
    const hits: Record<
      string,
      { count: number; samples: { snippet: string; role: string }[] }
    > = {};
    let assistantRows = 0;
    for (const row of rows) {
      if (row.role !== "assistant") continue; // user text can say anything
      assistantRows++;
      const content = row.content ?? "";
      for (const p of LEAK_PATTERNS) {
        const m = content.match(p.re);
        if (!m) continue;
        const bucket = (hits[p.label] ??= { count: 0, samples: [] });
        bucket.count++;
        if (bucket.samples.length < 3) {
          const i = Math.max(0, (m.index ?? 0) - 60);
          bucket.samples.push({
            snippet: content.slice(i, (m.index ?? 0) + 80).replace(/\n/g, " "),
            role: row.role,
          });
        }
      }
    }
    return {
      scanned_total: rows.length,
      scanned_assistant: assistantRows,
      leaks: hits,
    };
  },
});
