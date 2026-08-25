"use client";

/**
 * /messages — the shop's standalone Message Shop inbox.
 *
 * Two-pane list + thread over the reactive listShopInbox query (unread-first,
 * staff-gated, shop resolved server-side). Filter chips narrow by status;
 * J/K moves the cursor and Enter (or click) opens a conversation. Mirrors the
 * structure of /notifications and reuses the shared message primitives.
 */

import { useState } from "react";
import { useQuery } from "convex/react";
import { Inbox, Loader2, MessageSquare } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { useListKeyboard } from "@/components/dashboard/command-deck";
import { TicketList } from "@/components/messages/ticket-list";
import { TicketThread } from "@/components/messages/ticket-thread";
import { STATUS_FILTERS, type Ticket } from "@/components/messages/shared";

export default function MessagesPage() {
  const [filterId, setFilterId] = useState<string>("all");
  const [selectedId, setSelectedId] = useState<Id<"shop_tickets"> | null>(null);

  const activeFilter =
    STATUS_FILTERS.find((f) => f.id === filterId) ?? STATUS_FILTERS[0];
  const tickets = useQuery(
    api.shop_tickets_web.listShopInbox,
    activeFilter.value ? { statusFilter: activeFilter.value } : {},
  );
  const list: Ticket[] = tickets ?? [];
  const loading = tickets === undefined;

  const { focused, setFocused } = useListKeyboard({
    count: list.length,
    enabled: list.length > 0,
    onOpen: (i) => {
      const t = list[i];
      if (t) setSelectedId(t._id as Id<"shop_tickets">);
    },
  });

  return (
    <div className="flex h-[calc(100vh-6rem)] min-h-0 flex-col gap-4">
      {/* Header */}
      <header className="shrink-0">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-foreground">
          <MessageSquare className="h-6 w-6 text-primary" />
          Messages
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Customer conversations from bookings. Unread first — press J/K to move,
          Enter to open.
        </p>
      </header>

      {/* Filter chips */}
      <div className="flex shrink-0 flex-wrap gap-1.5">
        {STATUS_FILTERS.map((chip) => {
          const isActive = chip.id === filterId;
          const count =
            chip.value === undefined
              ? list.length
              : list.filter((t) => t.status === chip.value).length;
          return (
            <button
              key={chip.id}
              type="button"
              onClick={() => setFilterId(chip.id)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                isActive
                  ? "border-primary bg-primary text-white"
                  : "border-border bg-card text-muted-foreground hover:bg-muted",
              )}
            >
              {chip.label}
              {!activeFilter.value || isActive ? (
                <span
                  className={cn(
                    "rounded-full px-1.5 text-[10px] font-semibold",
                    isActive ? "bg-white/20" : "bg-muted",
                  )}
                >
                  {count}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {/* Two-pane */}
      <div className="flex min-h-0 flex-1 gap-4">
        {/* List */}
        <div className="w-full max-w-sm shrink-0 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center rounded-xl border border-border bg-card py-16 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : (
            <TicketList
              tickets={list}
              selectedId={selectedId}
              focusedIndex={focused}
              onSelect={(t) => {
                const idx = list.findIndex((x) => x._id === t._id);
                if (idx >= 0) setFocused(idx);
                setSelectedId(t._id as Id<"shop_tickets">);
              }}
              emptyLabel="No conversations here yet."
            />
          )}
        </div>

        {/* Thread */}
        <div className="hidden min-w-0 flex-1 overflow-hidden rounded-xl border border-border bg-card md:block">
          {selectedId ? (
            <TicketThread ticketId={selectedId} />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground">
              <Inbox className="h-8 w-8" />
              <p className="text-sm">Select a conversation to read and reply.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
