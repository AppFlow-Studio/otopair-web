import type { Id } from "@/convex/_generated/dataModel";

/* ------------------------------------------------------------------ */
/*  Activity log types                                                  */
/* ------------------------------------------------------------------ */

export type ActivityActor = {
  userId: Id<"users"> | null;
  label: string;
};

export type ActivityEvent =
  | {
      type: "booking_created";
      at: number;
      actor: ActivityActor;
      data: {
        quotedSetPriceCents: number | null;
        quotedBreakdown: {
          parts_cents: number;
          labor_cents: number;
          tax_cents: number;
          service_fee_cents: number;
        } | null;
        disclosedRangeLowCents: number | null;
        disclosedRangeHighCents: number | null;
        pricedPartsSnapshot: Array<{
          part_name: string;
          oem_number: string;
          quantity: number;
          unit_price_cents: number;
          line_total_cents: number;
        }> | null;
        services: string[];
      };
    }
  | {
      type: "status_change";
      at: number;
      actor: ActivityActor;
      data: { from: string | null; to: string; reason: string | null };
    }
  | {
      type: "estimate_submitted";
      at: number;
      actor: ActivityActor;
      data: {
        cycle: string;
        approvalId: Id<"booking_approvals">;
        totalCents: number;
        partsSubtotalCents: number | null;
        laborCents: number | null;
        taxCents: number | null;
        serviceFeeCents: number | null;
        priorCeilingCents: number;
        partsSnapshot: Array<{
          part_name?: string;
          oem_number?: string;
          quantity?: number;
          cost?: number;
        }>;
        notes: string | null;
        slaExpiresAtMs: number | null;
        autoApprovedInRange: boolean;
      };
    }
  | {
      type: "estimate_decision";
      at: number;
      actor: ActivityActor;
      data: {
        cycle: string;
        approvalId: Id<"booking_approvals">;
        decision: string;
        totalCents: number;
        ceilingAfterDecisionCents: number | null;
      };
    }
  | {
      type: "part_edit";
      at: number;
      actor: ActivityActor;
      data: {
        editType:
          | "added"
          | "removed"
          | "price"
          | "quantity"
          | "supplied_by"
          | "swap"
          | "not_used";
        partKey: string;
        partName: string | null;
        oemNumber: string | null;
        oldValue: string | null;
        newValue: string | null;
      };
    };

/* ------------------------------------------------------------------ */
/*  Formatters                                                          */
/* ------------------------------------------------------------------ */

export function formatActivityTimestamp(ms: number): string {
  return new Date(ms).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

export function formatCycleLabel(cycle: string): string {
  if (cycle === "pre_job") return "Pre-Job";
  if (cycle === "mid_job") return "Mid-Job";
  if (cycle === "post_job") return "Post-Job";
  return cycle;
}

export function formatDecisionLabel(decision: string): string {
  switch (decision) {
    case "approved":
      return "Approved";
    case "declined":
      return "Declined";
    case "withdrawn":
      return "Withdrawn";
    case "auto_approved_within_range":
      return "Auto-approved (in range)";
    case "sla_expired":
      return "SLA expired";
    default:
      return decision;
  }
}

export function formatEditType(editType: string): string {
  switch (editType) {
    case "added":
      return "Added part";
    case "removed":
      return "Removed part";
    case "price":
      return "Changed price";
    case "quantity":
      return "Changed quantity";
    case "supplied_by":
      return "Changed supplier";
    case "swap":
      return "Swapped part";
    case "not_used":
      return "Marked not-used";
    default:
      return editType;
  }
}

export function isForcedDelayReason(reason?: string | null): boolean {
  return reason?.startsWith("forced_delay_") ?? false;
}

export function humanizeStatus(
  status: string,
  reason?: string | null,
  oldStatus?: string | null,
): string {
  if (status === "confirmed" && reason === "shop_cancelled_reschedule") return "Reschedule Withdrawn";
  if (status === "confirmed" && reason === "customer_declined_reschedule") return "Reschedule Declined";
  if (status === "confirmed" && reason === "reschedule_auto_reverted_24h") return "Reschedule Expired";
  if (status === "pending_customer_acceptance" && isForcedDelayReason(reason)) {
    return "Late-Start Delay Pending Customer Acceptance";
  }
  const map: Record<string, string> = {
    pending: "Pending",
    pending_shop_acceptance: "Pending Shop Acceptance",
    pending_customer_acceptance: "Pending Customer Acceptance",
    confirmed: "Confirmed",
    vehicle_at_shop: "Vehicle Here",
    in_progress: "In Progress",
    completed: "Completed",
    no_show: "No-show",
    cancelled:
      oldStatus === "pending" || oldStatus === "pending_shop_acceptance"
        ? "Declined"
        : "Cancelled",
  };
  return map[status] ?? status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

const SYSTEM_REASONS = new Set([
  "cancelled_by_shop",
  "shop_cancelled_reschedule",
  "customer_declined_reschedule",
  "reschedule_auto_reverted_24h",
  "customer_approved_reschedule",
  "forced_delay_proposed_by_shop",
  "forced_delay_proposed_by_system",
  "forced_delay_updated_by_shop",
  "forced_delay_updated_by_system",
]);

export function isSystemReason(reason: string): boolean {
  return SYSTEM_REASONS.has(reason) || reason.startsWith("seed_");
}

export function getStatusDescription(
  status: string,
  reason?: string | null,
  scheduleChangeMode?: string | null,
): string | null {
  if (status === "pending" || status === "pending_shop_acceptance") return "Awaiting shop review";
  if (status === "pending_customer_acceptance" && (scheduleChangeMode === "forced_delay" || isForcedDelayReason(reason))) {
    return "Automatic late-start delay pending customer response";
  }
  if (status === "pending_customer_acceptance") return "Shop proposed reschedule";
  if (status === "cancelled" && reason === "cancelled_by_shop") return "Shop cancelled booking";
  if (status === "cancelled" && reason && !isSystemReason(reason)) return reason;
  return null;
}
