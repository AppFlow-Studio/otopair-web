"use client";

/**
 * ActionCard — the inline rider a structured shop reply leaves in the thread
 * (reschedule proposed / approval requested / pickup answer / ETA shared).
 * Mirrors the mobile actionSummary() so both sides read the same line.
 */

import { actionSummary, type TicketAction } from "@/components/messages/shared";

export function ActionCard({ action }: { action: TicketAction }) {
  return (
    <div className="mt-1.5 rounded-lg border border-primary/20 bg-primary/5 px-2.5 py-1.5 text-xs font-medium text-primary">
      {actionSummary(action)}
    </div>
  );
}
