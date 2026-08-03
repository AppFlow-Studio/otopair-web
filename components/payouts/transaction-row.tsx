"use client";

import { AlertTriangle, Wrench } from "lucide-react";
import { CustomerAvatar } from "@/components/customers/shared";
import { cn } from "@/lib/utils";
import { StatusChip } from "./status-chip";
import { formatDateTime, formatMoneyCents, formatRelative } from "./shared";
import type { ShopTxnListItem } from "./types";

/** Money that hasn't been captured has no revenue to report. Render an em dash
 *  rather than substituting the estimate. */
function money(cents: number | null): string {
  return cents == null ? "—" : formatMoneyCents(cents);
}

export function TransactionRow({
  txn,
  selected,
  onSelect,
}: {
  txn: ShopTxnListItem;
  selected: boolean;
  onSelect: (txn: ShopTxnListItem) => void;
}) {
  return (
    <tr
      // Keyboard-operable: v0's clickable <tr> was mouse-only, as is the
      // customers table this pattern comes from.
      tabIndex={0}
      role="button"
      aria-label={`Payment from ${txn.customerName}, ${money(txn.capturedCents)}`}
      aria-pressed={selected}
      onClick={() => onSelect(txn)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(txn);
        }
      }}
      className={cn(
        "cursor-pointer border-t border-border/50 transition-colors hover:bg-muted focus:outline-none focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        selected && "bg-muted",
      )}
    >
      <td
        className="whitespace-nowrap px-4 py-3.5 text-sm text-foreground/75"
        title={formatDateTime(txn.createdAtMs)}
      >
        {txn.createdAtMs ? formatRelative(txn.createdAtMs) : "No date"}
      </td>

      <td className="px-4 py-3.5">
        <div className="flex items-center gap-2.5">
          <CustomerAvatar name={txn.customerName} size="sm" />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">
              {txn.customerName}
            </p>
            <p className="text-xs tabular-nums text-muted-foreground">
              {txn.cardBrand ? `${txn.cardBrand} ` : ""}
              {txn.cardLast4 ? `···· ${txn.cardLast4}` : "—"}
            </p>
          </div>
        </div>
      </td>

      <td className="px-4 py-3.5">
        <p className="text-sm font-medium text-foreground">
          {txn.serviceSummary ?? "—"}
        </p>
        <p className="text-xs text-muted-foreground">{txn.vehicleYmm ?? "—"}</p>
      </td>

      <td className="px-4 py-3.5">
        <span className="inline-flex items-center gap-1.5 text-sm text-foreground/75">
          <Wrench className="size-3.5 text-muted-foreground" aria-hidden="true" />
          {txn.mechanicName ?? "Unassigned"}
        </span>
      </td>

      <td className="px-4 py-3.5 text-right text-sm font-medium tabular-nums text-foreground">
        {money(txn.capturedCents)}
      </td>

      <td className="px-4 py-3.5 text-right text-sm tabular-nums text-muted-foreground">
        {txn.platformFeeCents == null ? "—" : `-${formatMoneyCents(txn.platformFeeCents)}`}
      </td>

      <td className="px-4 py-3.5 text-right text-sm font-semibold tabular-nums text-foreground">
        {money(txn.netToShopCents)}
      </td>

      <td className="px-4 py-3.5">
        <div className="flex items-center gap-1.5">
          <StatusChip status={txn.displayStatus} />
          {txn.hasOpenDispute && txn.displayStatus !== "disputed" ? (
            <AlertTriangle
              className="size-3.5 text-destructive"
              aria-label="Open dispute"
            />
          ) : null}
        </div>
      </td>
    </tr>
  );
}

export function TransactionCardMobile({
  txn,
  onSelect,
}: {
  txn: ShopTxnListItem;
  onSelect: (txn: ShopTxnListItem) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(txn)}
      className="flex w-full flex-col gap-2 rounded-xl border border-border bg-card p-4 text-left transition-colors active:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-semibold text-foreground">{txn.customerName}</p>
        <p className="text-sm font-semibold tabular-nums text-foreground">
          {money(txn.netToShopCents)}
        </p>
      </div>
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 truncate text-xs text-muted-foreground">
          {txn.serviceSummary ?? "—"}
          {txn.vehicleYmm ? ` · ${txn.vehicleYmm}` : ""}
        </p>
        <p className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
          {money(txn.capturedCents)}
        </p>
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="inline-flex items-center gap-1.5 text-xs text-foreground/75">
          <Wrench className="size-3.5 text-muted-foreground" aria-hidden="true" />
          {txn.mechanicName ?? "Unassigned"}
        </span>
        <StatusChip status={txn.displayStatus} />
      </div>
    </button>
  );
}
