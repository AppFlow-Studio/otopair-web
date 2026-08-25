"use client";

/**
 * TicketList — the shared inbox list, used by both the in-booking Messages
 * drawer and the standalone /messages page. One row per ticket: an unread dot,
 * the subject, the last-message preview, a status chip, and a relative time.
 */

import { cn } from "@/lib/utils";
import { ticketSubject } from "@/convex/lib/shopTicketConstants";
import {
  relativeTime,
  ticketStatusMeta,
  type Ticket,
} from "@/components/messages/shared";

export function TicketList({
  tickets,
  selectedId,
  focusedIndex,
  onSelect,
  emptyLabel = "No messages yet.",
}: {
  tickets: Ticket[];
  selectedId?: string | null;
  /** Keyboard cursor row (distinct from the opened selection). */
  focusedIndex?: number | null;
  onSelect: (ticket: Ticket) => void;
  emptyLabel?: string;
}) {
  if (tickets.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card px-3 py-10 text-center text-sm text-muted-foreground">
        {emptyLabel}
      </div>
    );
  }
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
      {tickets.map((t, i) => {
        const unread = (t.shop_unread_count ?? 0) > 0;
        const selected = selectedId === t._id;
        const focused = focusedIndex === i && !selected;
        const status = ticketStatusMeta(t.status);
        const contextLine = [
          t.context?.customerName,
          t.context?.vehicleLabel,
          t.context?.serviceLabel,
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <li key={t._id}>
            <button
              type="button"
              onClick={() => onSelect(t)}
              className={cn(
                "flex w-full items-start gap-3 border-l-2 px-3 py-3 text-left transition-colors",
                selected
                  ? "border-primary bg-muted"
                  : focused
                    ? "border-transparent bg-muted/40"
                    : "border-transparent hover:bg-muted/60",
              )}
            >
              <span
                className={cn(
                  "mt-1.5 h-2 w-2 shrink-0 rounded-full",
                  unread ? "bg-amber-500" : "bg-transparent",
                )}
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p
                    className={cn(
                      "truncate text-sm",
                      unread
                        ? "font-semibold text-foreground"
                        : "font-medium text-foreground",
                    )}
                  >
                    {t.subject || ticketSubject(t.category)}
                  </p>
                  <span
                    className={cn(
                      "ml-auto shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold",
                      status.chip,
                    )}
                  >
                    {status.label}
                  </span>
                </div>
                {contextLine ? (
                  <p className="mt-0.5 truncate text-xs font-medium text-foreground/80">
                    {contextLine}
                  </p>
                ) : null}
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {t.last_message_preview || "—"}
                </p>
                <p className="mt-0.5 text-[11px] text-muted-foreground/80">
                  {relativeTime(t.last_message_at ?? t.started_at)}
                </p>
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
