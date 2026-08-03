"use client";

import { useState } from "react";
import { useConvex } from "convex/react";
import { Check, Download, Loader2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  buildInsightsCsv,
  buildPayoutsCsv,
  buildTransactionsCsv,
  csvFilename,
  downloadCsv,
  fetchAllTransactions,
} from "./export";
import type {
  DateWindow,
  PaymentFilters,
  PayoutsOverview,
  ShopPaymentInsights,
} from "./types";

type Kind = "transactions" | "summary" | "payouts";

export function ExportMenu({
  shopName,
  window,
  filters,
  insights,
  overview,
  disabled,
}: {
  shopName: string;
  window: DateWindow;
  filters: PaymentFilters;
  insights: ShopPaymentInsights | null | undefined;
  overview: PayoutsOverview | null;
  disabled?: boolean;
}) {
  const convex = useConvex();
  const [busy, setBusy] = useState<Kind | null>(null);
  const [progress, setProgress] = useState(0);
  const [done, setDone] = useState<Kind | null>(null);
  const [error, setError] = useState<string | null>(null);

  function finish(kind: Kind) {
    setDone(kind);
    setTimeout(() => setDone(null), 2500);
  }

  async function run(kind: Kind) {
    setBusy(kind);
    setError(null);
    setProgress(0);
    try {
      if (kind === "transactions") {
        // Pages the query to the end rather than serializing the 50 rows on
        // screen — a file that looks like the filtered set has to be it.
        const result = await fetchAllTransactions(
          convex,
          window,
          filters,
          setProgress,
        );
        downloadCsv(
          csvFilename("payments", window),
          buildTransactionsCsv(result, shopName, window, filters),
        );
      } else if (kind === "summary") {
        if (!insights) throw new Error("Summary isn't loaded yet.");
        downloadCsv(
          csvFilename("revenue-summary", window),
          buildInsightsCsv(insights, shopName, window),
        );
      } else {
        if (!overview) throw new Error("Payout data isn't loaded yet.");
        downloadCsv(
          csvFilename("payouts", window),
          buildPayoutsCsv(overview, shopName, window),
        );
      }
      finish(kind);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed.");
    } finally {
      setBusy(null);
      setProgress(0);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={disabled || busy !== null}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {busy ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : done ? (
              <Check className="size-4 text-[var(--success)]" aria-hidden="true" />
            ) : (
              <Download className="size-4" aria-hidden="true" />
            )}
            {busy
              ? progress > 0
                ? `${progress} rows…`
                : "Preparing…"
              : done
                ? "Downloaded"
                : "Export"}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[260px]">
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
            CSV for the selected date range
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => void run("transactions")}>
            <div>
              <p className="text-sm">Transactions</p>
              <p className="text-xs text-muted-foreground">
                Every payment matching your filters
              </p>
            </div>
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!insights}
            onSelect={() => void run("summary")}
          >
            <div>
              <p className="text-sm">Revenue summary</p>
              <p className="text-xs text-muted-foreground">
                Totals, methods, services, mechanics, daily
              </p>
            </div>
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!overview}
            onSelect={() => void run("payouts")}
          >
            <div>
              <p className="text-sm">Payouts</p>
              <p className="text-xs text-muted-foreground">
                Transfers Stripe has sent to your bank
              </p>
            </div>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
