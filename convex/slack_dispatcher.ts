/**
 * slack_dispatcher.ts — Drains pending `channel: "slack"` rows from
 * `notification_outbox` and hands them to `lib/slack_provider.sendSlack`.
 *
 * This is the dispatcher that never existed (see notifications.ts) — the reason
 * ops alerts written with `channel:"slack"` (SLO breaches, enrichment
 * error-outs, canonical-shortcut nudges) sat `pending` forever. Mirrors
 * sms_dispatcher / email_dispatcher: claim → render → send → record, on a
 * 1-min cron. Idempotent: rows are flipped to `dispatching` before send.
 *
 * Unlike SMS/email there is NO per-user recipient — Slack alerts go to one ops
 * channel configured on the provider (SLACK_WEBHOOK_URL or bot token). So the
 * dispatcher only renders + sends; it never resolves a user address.
 *
 * STALE-ON-ENABLE GUARD: these categories may have accumulated a backlog while
 * no dispatcher existed. Draining weeks of old SLO breaches into the channel
 * the moment this ships would be a spam incident, so rows older than
 * SLACK_ALERT_MAX_AGE_MS (default 2h) are resolved WITHOUT sending. New alerts
 * flow normally.
 */

import { internal } from "./_generated/api";
import { internalAction, internalMutation } from "./_generated/server";
import { v } from "convex/values";

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

/** category → Slack message text (mrkdwn). Fallback below for unmapped ones. */
export const SLACK_BODY_TEMPLATES: Record<string, (payload: any) => string> = {
  // portalStats.evaluateSlo — a windowed SLO threshold was crossed.
  slo_breach: (p) =>
    `:rotating_light: *SLO breach* — \`${p?.key ?? "?"}\` = ${p?.value ?? "?"} ` +
    `(target ${p?.target ?? "?"}, alert ${p?.alert ?? "?"}) · ${p?.samples ?? 0} samples`,

  // v3mutations._alertEnrichmentErrorOut — a Batch 2 error-out left a config thin.
  enrich_errorout: (p) => {
    const q = p?.quotabilityPct != null ? String(p.quotabilityPct) : "—";
    const batch = p?.batchId ? ` · batch \`${p.batchId}\`` : "";
    return (
      `:warning: *Enrichment error-out* — ${p?.label ?? "unknown vehicle"}\n` +
      `> ${String(p?.error ?? "unknown").slice(0, 300)}\n` +
      `quotability ${q} · ${p?.unpricedCoreRoles ?? 0} unpriced core role(s) · run \`${p?.runId ?? "?"}\`${batch}`
    );
  },

  // shopCustomServices — a shop's custom shortcut looks like a catalog service.
  custom_shortcut_override: (p) =>
    `:information_source: *Custom shortcut looks canonical* — ` +
    `"${p?.shortcut_name ?? "?"}" ≈ ${p?.looks_like ?? "?"} (${p?.confidence ?? "?"})`,
};

function renderSlackText(category: string, payload: any): string {
  const tmpl = SLACK_BODY_TEMPLATES[category];
  if (tmpl) return tmpl(payload);
  // Unknown category — surface it rather than dropping it. A missing template
  // is a "someone added a new slack category" signal, not a reason to go dark.
  let tail = "";
  try {
    tail = JSON.stringify(payload ?? {}).slice(0, 300);
  } catch {
    tail = "(unserializable payload)";
  }
  return `:bell: Otopair alert [${category}] ${tail}`;
}

export const claimPendingSlackRows = internalMutation({
  args: {},
  handler: async (ctx) => {
    const pending = await ctx.db
      .query("notification_outbox")
      .withIndex("by_status", (q: any) => q.eq("status", "pending"))
      .collect();

    const now = Date.now();
    const rawMaxAge = Number(process.env.SLACK_ALERT_MAX_AGE_MS ?? String(TWO_HOURS_MS));
    const maxAge = Number.isFinite(rawMaxAge) && rawMaxAge > 0 ? rawMaxAge : TWO_HOURS_MS;

    const claimed: Array<{ outboxId: any; category: string; payload: any }> = [];
    let staleResolved = 0;

    for (const row of pending) {
      if ((row as any).channel !== "slack") continue;

      // Backlog guard — resolve (don't send) alerts older than the window.
      if (now - ((row as any).created_at ?? now) > maxAge) {
        await ctx.db.patch(row._id, {
          status: "resolved",
          resolved_at: now,
          resolved_reason: "stale_on_enable",
          updated_at: now,
        } as any);
        staleResolved++;
        continue;
      }

      await ctx.db.patch(row._id, { status: "dispatching", updated_at: now } as any);
      claimed.push({
        outboxId: row._id,
        category: (row as any).category,
        payload: (row as any).payload,
      });
    }

    if (staleResolved > 0) {
      console.log(`[slack_dispatcher] resolved ${staleResolved} stale row(s) without sending (backlog guard)`);
    }
    return claimed;
  },
});

export const recordSlackResult = internalMutation({
  args: {
    outboxId: v.id("notification_outbox"),
    status: v.string(), // "sent" | "stubbed" | "failed"
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    await ctx.db.patch(args.outboxId, {
      status: args.status === "sent" || args.status === "stubbed" ? "resolved" : "failed",
      processed_at: now,
      updated_at: now,
      ...(args.error ? { resolved_reason: args.error.slice(0, 120) } : {}),
    } as any);
  },
});

export const dispatchPendingSlack = internalAction({
  args: {},
  handler: async (ctx) => {
    // `(internal as any)` — this module is new, so `internal.slack_dispatcher`
    // is absent from _generated/api.d.ts until the next codegen (same escape the
    // crons.ts sms/email/push entries use). Tighten after codegen.
    const claimed: any[] = await ctx.runMutation(
      (internal as any).slack_dispatcher.claimPendingSlackRows,
      {},
    );

    for (const row of claimed) {
      const text = renderSlackText(row.category, row.payload);
      let result: any = { status: "failed", error: "dispatch threw" };
      try {
        result = await ctx.runAction((internal as any).lib.slack_provider.sendSlack, {
          text,
          category: row.category,
          outboxId: row.outboxId,
        });
      } catch (e) {
        result = { status: "failed", error: e instanceof Error ? e.message : String(e) };
      }
      await ctx.runMutation((internal as any).slack_dispatcher.recordSlackResult, {
        outboxId: row.outboxId,
        status: result.status,
        error: result.error ?? undefined,
      });
    }

    return { dispatched: claimed.length };
  },
});
