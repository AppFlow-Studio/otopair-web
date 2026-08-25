"use client";

/**
 * ReplyComposer — the shop-side send box for a ticket thread.
 *
 * Free-text reply plus three quick-action lanes, all routed through the one
 * `replyToTicket` action (convex/shop_tickets_web.ts):
 *   - canned templates  → prefill the textarea (display copy only)
 *   - Send ETA          → action:{kind:"send_eta"}  (thread-only in v1)
 *   - Pickup response    → action:{kind:"pickup_response"} → respondToPickupRequest
 * Reschedule / mid-job approval intentionally stay on the booking panel's own
 * buttons for v1. Errors from the underlying rail surface inline.
 */

import { useState } from "react";
import { useAction } from "convex/react";
import { Clock, Loader2, Send } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { AlertBanner } from "@/components/settings/primitives";
import {
  ETA_PRESETS,
  PICKUP_RESPONSES,
  templatesForCategory,
} from "@/components/messages/shared";

const PICKUP_CATEGORIES = new Set(["cancel_or_pickup", "pickup_arrangement"]);

const PICKUP_TONE: Record<string, string> = {
  muted: "border-border text-foreground hover:bg-muted",
  success: "border-emerald-300 text-emerald-700 hover:bg-emerald-50",
  danger: "border-red-300 text-red-700 hover:bg-red-50",
};

export function ReplyComposer({
  ticketId,
  category,
  disabled = false,
}: {
  ticketId: Id<"shop_tickets">;
  category: string;
  disabled?: boolean;
}) {
  const reply = useAction(api.shop_tickets_web.replyToTicket);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const templates = templatesForCategory(category);
  const showPickup = PICKUP_CATEGORIES.has(category);

  async function run(fn: () => Promise<unknown>) {
    if (sending) return;
    setSending(true);
    setError(null);
    try {
      await fn();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Couldn't send. Try again.");
    } finally {
      setSending(false);
    }
  }

  async function sendText() {
    const text = draft.trim();
    if (!text) return;
    await run(async () => {
      await reply({ ticketId, text });
      setDraft("");
    });
  }

  async function sendEta(etaLabel: string) {
    await run(() =>
      reply({
        ticketId,
        text: `ETA: ${etaLabel}`,
        action: { kind: "send_eta", params: { etaLabel } },
      }),
    );
  }

  async function sendPickup(response: string) {
    await run(() =>
      reply({
        ticketId,
        action: { kind: "pickup_response", params: { response } },
      }),
    );
  }

  if (disabled) {
    return (
      <div className="border-t border-border px-4 py-3 text-center text-xs text-muted-foreground">
        This conversation is closed.
      </div>
    );
  }

  return (
    <div className="border-t border-border bg-card px-4 pb-4 pt-3">
      {error ? (
        <div className="mb-2">
          <AlertBanner tone="error">{error}</AlertBanner>
        </div>
      ) : null}

      {/* Quick-action lanes */}
      <div className="mb-2 flex flex-col gap-2">
        {/* Canned templates */}
        <div className="flex flex-wrap gap-1.5">
          {templates.map((t) => (
            <button
              key={t}
              type="button"
              disabled={sending}
              onClick={() => setDraft(t)}
              className="rounded-full border border-border bg-card px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted disabled:opacity-50"
              title="Insert this reply"
            >
              {t.length > 42 ? `${t.slice(0, 42)}…` : t}
            </button>
          ))}
        </div>

        {/* ETA + pickup */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="inline-flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            <Clock className="h-3 w-3" /> ETA
          </span>
          {ETA_PRESETS.map((label) => (
            <button
              key={label}
              type="button"
              disabled={sending}
              onClick={() => void sendEta(label)}
              className="rounded-full border border-primary/30 px-2.5 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/5 disabled:opacity-50"
            >
              {label}
            </button>
          ))}
        </div>

        {showPickup ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Pickup
            </span>
            {PICKUP_RESPONSES.map((r) => (
              <button
                key={r.value}
                type="button"
                disabled={sending}
                onClick={() => void sendPickup(r.value)}
                className={cn(
                  "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50",
                  PICKUP_TONE[r.tone],
                )}
              >
                {r.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {/* Free-text */}
      <div className="flex items-end gap-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void sendText();
            }
          }}
          rows={2}
          placeholder="Type a reply…  (⌘/Ctrl+Enter to send)"
          disabled={sending}
          className="min-h-[2.5rem] flex-1 resize-none rounded-lg border border-input bg-white px-3 py-2 text-sm text-foreground placeholder:text-gray-400 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
        />
        <button
          type="button"
          onClick={() => void sendText()}
          disabled={sending || draft.trim().length === 0}
          className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-lg border border-primary bg-primary px-4 text-sm font-medium text-white transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {sending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Send className="h-4 w-4" />
          )}
          Send
        </button>
      </div>
    </div>
  );
}
