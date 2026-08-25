"use client";

/**
 * TicketThread — the shop-side reactive read of one Message Shop ticket.
 *
 * Renders the conversation from the SHOP's point of view (our replies right /
 * primary, the customer left / muted, system centered), keeps the thread read
 * (markTicketReadByShop) while it's open, exposes Resolve / Close, and hosts the
 * ReplyComposer. Fills its parent's height — the drawer and the /messages page
 * both give it a bounded column.
 */

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { ChevronLeft, Loader2, MoreHorizontal } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { ticketSubject } from "@/convex/lib/shopTicketConstants";
import { ActionCard } from "@/components/messages/action-card";
import { BookingContextBar } from "@/components/messages/booking-context";
import { ReplyComposer } from "@/components/messages/reply-composer";
import {
  relativeTime,
  senderIsShop,
  ticketStatusMeta,
  type TicketMessage,
} from "@/components/messages/shared";

export function TicketThread({
  ticketId,
  onBack,
}: {
  ticketId: Id<"shop_tickets">;
  /** Shown as a back chevron in the header (drawer list→thread nav). */
  onBack?: () => void;
}) {
  const data = useQuery(api.shop_tickets_web.getShopTicketThread, { ticketId });
  const markRead = useMutation(api.shop_tickets_web.markTicketReadByShop);
  const resolveTicket = useMutation(api.shop_tickets_web.resolveTicket);
  const closeTicket = useMutation(api.shop_tickets_web.closeTicketShop);

  const [menuOpen, setMenuOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const ticket = data?.ticket;
  const messages = data?.messages;
  const unread = ticket?.shop_unread_count ?? 0;
  const lastAt = ticket?.last_message_at ?? 0;

  // Keep the thread marked read while it's open — re-fires when a new customer
  // message lands (last_message_at moves) so the badge stays honest.
  useEffect(() => {
    if (unread > 0) void markRead({ ticketId });
  }, [ticketId, unread, lastAt, markRead]);

  // Stick to the bottom as messages arrive.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages?.length, ticketId]);

  if (data === undefined) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  if (data === null || !ticket) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
        This conversation could not be loaded.
      </div>
    );
  }

  const status = ticketStatusMeta(ticket.status);
  const isClosed = ticket.status === "closed";
  const canResolve = ticket.status === "open" || ticket.status === "shop_responded";

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            className="-ml-1 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="Back to messages"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-foreground">
              {ticket.subject || ticketSubject(ticket.category)}
            </h3>
            <span
              className={cn(
                "shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold",
                status.chip,
              )}
            >
              {status.label}
            </span>
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {relativeTime(ticket.last_message_at ?? ticket.started_at)}
          </p>
        </div>
        <div className="relative">
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="Ticket actions"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
          {menuOpen ? (
            <>
              <div
                className="fixed inset-0 z-10"
                onClick={() => setMenuOpen(false)}
                aria-hidden="true"
              />
              <div className="absolute right-0 top-full z-20 mt-1 w-40 overflow-hidden rounded-lg border border-border bg-card py-1 text-sm shadow-lg">
                <button
                  type="button"
                  disabled={!canResolve}
                  onClick={() => {
                    setMenuOpen(false);
                    void resolveTicket({ ticketId });
                  }}
                  className="block w-full px-3 py-1.5 text-left text-foreground transition-colors hover:bg-muted disabled:opacity-40"
                >
                  Mark resolved
                </button>
                <button
                  type="button"
                  disabled={isClosed}
                  onClick={() => {
                    setMenuOpen(false);
                    void closeTicket({ ticketId });
                  }}
                  className="block w-full px-3 py-1.5 text-left text-destructive transition-colors hover:bg-destructive/5 disabled:opacity-40"
                >
                  Close conversation
                </button>
              </div>
            </>
          ) : null}
        </div>
      </div>

      {/* Booking context — customer, vehicle/VIN, status, time, mechanic,
          services + open-booking / car-info actions. */}
      <BookingContextBar bookingId={ticket.booking_id} />

      {/* Messages */}
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {(messages ?? []).map((m) => (
          <MessageBubble key={m._id} message={m} />
        ))}
        {(messages ?? []).length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No messages in this conversation yet.
          </p>
        ) : null}
      </div>

      {/* Composer */}
      <ReplyComposer
        ticketId={ticketId}
        category={ticket.category}
        disabled={isClosed}
      />
    </div>
  );
}

function MessageBubble({ message }: { message: TicketMessage }) {
  if (message.sender_role === "system") {
    return (
      <div className="flex justify-center">
        <span className="rounded-full bg-muted px-3 py-1 text-[11px] text-muted-foreground">
          {message.content}
        </span>
      </div>
    );
  }

  const mine = senderIsShop(message.sender_role);
  return (
    <div className={cn("flex", mine ? "justify-end" : "justify-start")}>
      <div className={cn("max-w-[80%]", mine ? "items-end" : "items-start")}>
        <div
          className={cn(
            "rounded-2xl px-3 py-2 text-sm",
            mine
              ? "rounded-br-sm bg-primary text-white"
              : "rounded-bl-sm bg-muted text-foreground",
          )}
        >
          {message.content ? (
            <p className="whitespace-pre-wrap leading-relaxed">
              {message.content}
            </p>
          ) : null}
          {message.action ? <ActionCard action={message.action} /> : null}
        </div>
        <p
          className={cn(
            "mt-0.5 text-[11px] text-muted-foreground",
            mine ? "text-right" : "text-left",
          )}
        >
          {message.sender_role === "mechanic" ? "Mechanic · " : ""}
          {relativeTime(message.timestamp)}
        </p>
      </div>
    </div>
  );
}
