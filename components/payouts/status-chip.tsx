import {
  AlertTriangle,
  ArrowRight,
  Ban,
  Check,
  Clock,
  HelpCircle,
  Undo2,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { STATUS_STYLE } from "./shared";
import type { PaymentDisplayStatus } from "./types";

const ICONS: Record<PaymentDisplayStatus, typeof Check> = {
  captured: Check,
  authorized: Clock,
  partially_refunded: Undo2,
  refunded: Undo2,
  disputed: AlertTriangle,
  dispute_lost: XCircle,
  dispute_won: Check,
  failed: XCircle,
  cancelled: Ban,
  unknown: HelpCircle,
};

/**
 * Always icon + text, never colour alone. Several of these tints sit near the
 * contrast floor for a small graphical object, and colour-blind users would
 * otherwise have nothing to go on.
 */
export function StatusChip({
  status,
  size = "sm",
  className,
}: {
  status: PaymentDisplayStatus;
  size?: "sm" | "lg";
  className?: string;
}) {
  const style = STATUS_STYLE[status] ?? STATUS_STYLE.unknown;
  const Icon = ICONS[status] ?? HelpCircle;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full font-medium",
        size === "lg" ? "px-3 py-1.5 text-sm" : "px-2.5 py-1 text-xs",
        style.className,
        className,
      )}
    >
      <Icon className={size === "lg" ? "size-4" : "size-3.5"} aria-hidden="true" />
      {style.label}
    </span>
  );
}

/** Payout statuses come straight from Stripe and are a different vocabulary. */
export function PayoutStatusChip({ status }: { status: string }) {
  const map: Record<string, { label: string; className: string; Icon: typeof Check }> = {
    paid: {
      label: "Paid",
      className:
        "text-[var(--success)] bg-[color-mix(in_srgb,var(--success)_10%,transparent)]",
      Icon: Check,
    },
    in_transit: {
      label: "In transit",
      className: "text-primary bg-primary/10",
      Icon: ArrowRight,
    },
    pending: { label: "Pending", className: "text-amber-600 bg-amber-50", Icon: Clock },
    canceled: {
      label: "Canceled",
      className: "text-muted-foreground bg-muted",
      Icon: Ban,
    },
    failed: {
      label: "Failed",
      className: "text-destructive bg-destructive/10",
      Icon: XCircle,
    },
  };
  const s = map[status] ?? {
    label: status,
    className: "text-muted-foreground bg-muted",
    Icon: HelpCircle,
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium",
        s.className,
      )}
    >
      <s.Icon className="size-3.5" aria-hidden="true" />
      {s.label}
    </span>
  );
}
