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

// ── Presentation helpers ─────────────────────────────────────────────────────

/** Where the panel lives — the CONVEX env (actions don't read Next's .env). */
function appBase(): string {
  return (process.env.NEXT_PUBLIC_APP_URL ?? "https://otopair.com").replace(/\/+$/, "");
}

/**
 * Deep-link that opens Director → Enrichment → Deep-Dive already focused on this
 * exact run. The `#enrichment` hash selects the tab; the query params are read
 * by TabEnrichment on mount (goDeepDive). Falls back to the console root when a
 * run/config id is missing.
 */
function runDeepLink(p: any): string {
  const base = `${appBase()}/director`;
  if (!p?.runId || !p?.vehicleConfigId) return `${base}#enrichment`;
  const q = new URLSearchParams();
  q.set("ddc", String(p.vehicleConfigId));
  q.set("ddr", String(p.runId));
  if (p.configKey) q.set("ddk", String(p.configKey));
  return `${base}?${q.toString()}#enrichment`;
}

/** Epoch ms → "Sep 16, 2026, 3:24 PM ET" (ops team is US-eastern). */
function fmtWhen(ms: number | null | undefined): string {
  if (!ms || !Number.isFinite(ms)) return "—";
  try {
    return (
      new Date(ms).toLocaleString("en-US", {
        timeZone: "America/New_York",
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }) + " ET"
    );
  } catch {
    return new Date(ms).toISOString();
  }
}

/** Duration ms → "1h 23m" / "4m 12s" / "45s". */
function fmtDur(ms: number | null | undefined): string {
  if (!ms || !Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/** Who kicked the run off, human-readable. Prefers the person, falls back to origin. */
function fmtWho(p: any): string {
  const TRIGGER_LABEL: Record<string, string> = {
    new_vehicle: "New vehicle add",
    marketplace: "Marketplace queue",
    director_reenrich: "Director re-run",
    director_purge: "Director purge + re-enrich",
    claim: "Driver VIN claim",
    mechanic: "Mechanic VIN capture",
    heal_after_run: "Post-run heal",
    price_sweep: "Nightly price sweep",
    cohort_dispatch: "Nightly cohort dispatch",
    seed: "Seed",
  };
  const origin = p?.trigger ? (TRIGGER_LABEL[p.trigger] ?? p.trigger) : null;
  if (p?.actorName) {
    const kind = p.actorKind ? ` · ${p.actorKind}` : "";
    return `${p.actorName}${kind}${origin ? ` · ${origin}` : ""}`;
  }
  return origin ?? "system";
}

const SLO_DESCRIPTIONS: Record<string, string> = {
  "slo.enrichment_success_rate_7d": "Share of enrichment runs completing (7d)",
  "slo.avg_confidence": "Average field confidence across configs",
  "slo.review_queue_depth": "Open items in the manual review queue",
  "slo.spec_variance_rate_7d": "Rate of spec values disagreeing with source (7d)",
  "slo.job_confirmation_rate_7d": "Share of jobs confirmed by the shop (7d)",
  "slo.custom_job_exposure": "Vehicles carrying work that should be a catalog service",
};

// ── Renderers ────────────────────────────────────────────────────────────────
// Each returns { text, blocks? }: `text` is the required notification fallback
// (also what non-Block-Kit clients show); `blocks` is the rich layout.

type Rendered = { text: string; blocks?: any[] };

/** Trim a mrkdwn string to Slack's per-section ceiling. */
function cap(s: string, n = 2800): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function renderEnrichErrorout(p: any): Rendered {
  const label = p?.label || "unknown vehicle";
  const q = p?.quotabilityPct != null ? `${Math.round(p.quotabilityPct * 100)}%` : "—";
  const fill = p?.fillPct != null ? `${Math.round(p.fillPct * 100)}%` : "—";
  const url = runDeepLink(p);

  // Fallback text — richer than the old one-liner, still one message.
  const text =
    `:warning: Enrichment error-out — ${label}\n` +
    `${String(p?.error ?? "unknown").slice(0, 300)}\n` +
    `who: ${fmtWho(p)} · quotability ${q} · ${p?.unpricedCoreRoles ?? 0} unpriced core role(s)\n` +
    `View run: ${url}`;

  const blocks: any[] = [
    { type: "header", text: { type: "plain_text", text: ":warning: Enrichment error-out", emoji: true } },
    {
      type: "section",
      text: { type: "mrkdwn", text: cap(`*${label}*\n> ${String(p?.error ?? "unknown").slice(0, 500)}`) },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Who*\n${fmtWho(p)}` },
        { type: "mrkdwn", text: `*When*\n${fmtWhen(p?.startedAt)}${p?.durationMs ? ` · ${fmtDur(p.durationMs)}` : ""}` },
        { type: "mrkdwn", text: `*Quotability*\n${q} · fill ${fill}` },
        { type: "mrkdwn", text: `*Unpriced core roles*\n${p?.unpricedCoreRoles ?? 0}` },
      ],
    },
  ];

  // Deeper issue 1 — parts gaps per service.
  const byService: any[] = Array.isArray(p?.missingRolesByService) ? p.missingRolesByService : [];
  if (byService.length) {
    const lines = byService.map((s) => {
      const miss = s.missingFitment?.length ? ` · missing fitment: \`${s.missingFitment.join("`, `")}\`` : "";
      const unpriced = s.unpricedCount ? ` · ${s.unpricedCount} unpriced` : "";
      return `• *${s.slug}* (${s.coreTotal} core)${unpriced}${miss}`;
    });
    blocks.push({ type: "section", text: { type: "mrkdwn", text: cap(`*Parts gaps*\n${lines.join("\n")}`) } });
  }

  // Deeper issue 2 — sanity flags (rejects/flags).
  const flags: any[] = Array.isArray(p?.sanityFlags) ? p.sanityFlags : [];
  if (flags.length) {
    const lines = flags.map((f) => `• \`${f.severity}\` *${f.field}* — ${f.reason}`);
    blocks.push({ type: "section", text: { type: "mrkdwn", text: cap(`*Sanity flags*\n${lines.join("\n")}`) } });
  }

  // Deeper issue 3 — field gaps (why fields ended empty).
  const gaps: any[] = Array.isArray(p?.fieldGaps) ? p.fieldGaps : [];
  if (gaps.length) {
    const lines = gaps.map((g) => `• *${g.field}* — ${g.reason}`);
    blocks.push({ type: "section", text: { type: "mrkdwn", text: cap(`*Field gaps*\n${lines.join("\n")}`) } });
  }

  // Deeper issue 4 — other run errors beyond the headline.
  const extra: string[] = Array.isArray(p?.extraErrors) ? p.extraErrors : [];
  if (extra.length) {
    const lines = extra.map((e) => `• ${String(e).slice(0, 200)}`);
    blocks.push({ type: "section", text: { type: "mrkdwn", text: cap(`*Other errors*\n${lines.join("\n")}`) } });
  }

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: cap(
          `run \`${p?.runId ?? "?"}\`` +
            (p?.batchId ? ` · batch \`${p.batchId}\`` : "") +
            (p?.configKey ? ` · config \`${p.configKey}\`` : ""),
          900,
        ),
      },
    ],
  });
  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "View run on otopair.com", emoji: true },
        url,
        style: "primary",
      },
    ],
  });

  return { text, blocks: blocks.slice(0, 50) };
}

function renderSloBreach(p: any): Rendered {
  const key = p?.key ?? "?";
  const desc = SLO_DESCRIPTIONS[key] ?? "SLO";
  const url = `${appBase()}/director#overview`;
  const text =
    `:rotating_light: SLO breach — ${desc} (\`${key}\`)\n` +
    `value ${p?.value ?? "?"} · target ${p?.target ?? "?"} · alert ${p?.alert ?? "?"} · ${p?.samples ?? 0} samples`;
  const blocks: any[] = [
    { type: "header", text: { type: "plain_text", text: ":rotating_light: SLO breach", emoji: true } },
    { type: "section", text: { type: "mrkdwn", text: `*${desc}*\n\`${key}\`` } },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Value*\n${p?.value ?? "?"}` },
        { type: "mrkdwn", text: `*Target / alert*\n${p?.target ?? "?"} / ${p?.alert ?? "?"}` },
        { type: "mrkdwn", text: `*Samples*\n${p?.samples ?? 0}` },
      ],
    },
    {
      type: "actions",
      elements: [
        { type: "button", text: { type: "plain_text", text: "Open director", emoji: true }, url },
      ],
    },
  ];
  return { text, blocks };
}

function renderCustomShortcut(p: any): Rendered {
  return {
    text:
      `:information_source: *Custom shortcut looks canonical* — ` +
      `"${p?.shortcut_name ?? "?"}" ≈ ${p?.looks_like ?? "?"} (${p?.confidence ?? "?"})`,
  };
}

const RENDERERS: Record<string, (payload: any) => Rendered> = {
  slo_breach: renderSloBreach,
  enrich_errorout: renderEnrichErrorout,
  custom_shortcut_override: renderCustomShortcut,
};

function renderSlack(category: string, payload: any): Rendered {
  const r = RENDERERS[category];
  if (r) return r(payload);
  // Unknown category — surface it rather than dropping it. A missing renderer
  // is a "someone added a new slack category" signal, not a reason to go dark.
  let tail = "";
  try {
    tail = JSON.stringify(payload ?? {}).slice(0, 300);
  } catch {
    tail = "(unserializable payload)";
  }
  return { text: `:bell: Otopair alert [${category}] ${tail}` };
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

/**
 * Direct send test — bypasses the outbox, templates, and stale guard so you can
 * confirm the provider + webhook actually deliver:
 *   npx convex run slack_dispatcher:sendTestSlack '{}'
 *   npx convex run slack_dispatcher:sendTestSlack '{"text":"hello from otopair"}'
 * Returns { status: "sent" | "stubbed" | "failed", ... }. "stubbed" means no
 * SLACK_WEBHOOK_URL / bot token is configured on this deployment.
 */
export const sendTestSlack = internalAction({
  args: { text: v.optional(v.string()) },
  handler: async (ctx, args): Promise<any> => {
    const text =
      args.text ??
      ":white_check_mark: Otopair Slack test — if you can read this, the dispatcher + webhook work.";
    const result = await ctx.runAction((internal as any).lib.slack_provider.sendSlack, {
      text,
      category: "test",
    });
    console.log("[slack_dispatcher] sendTestSlack result:", JSON.stringify(result));
    return result;
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
      const rendered = renderSlack(row.category, row.payload);
      let result: any = { status: "failed", error: "dispatch threw" };
      try {
        result = await ctx.runAction((internal as any).lib.slack_provider.sendSlack, {
          text: rendered.text,
          ...(rendered.blocks ? { blocks: rendered.blocks } : {}),
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
