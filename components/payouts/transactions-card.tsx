"use client";

import { useMemo, type ReactNode } from "react";
import { AlertTriangle, Search, SearchX } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { TransactionCardMobile, TransactionRow } from "./transaction-row";
import {
  Card,
  Skeleton,
  formatCount,
  useDebouncedValue,
} from "./shared";
import type { ShopTxnListItem, ShopTxnListResult, StatusPill } from "./types";

const STATUS_OPTIONS: { value: StatusPill; label: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "captured", label: "Succeeded" },
  { value: "authorized", label: "Pending capture" },
  { value: "partially_refunded", label: "Partially refunded" },
  { value: "refunded", label: "Refunded" },
  { value: "disputed", label: "Disputed" },
  { value: "failed", label: "Failed" },
  { value: "cancelled", label: "Cancelled" },
];

const COLUMNS = [
  { key: "date", label: "Date", numeric: false },
  { key: "customer", label: "Customer", numeric: false },
  { key: "service", label: "Service", numeric: false },
  { key: "mechanic", label: "Mechanic", numeric: false },
  { key: "gross", label: "Captured", numeric: true },
  { key: "fee", label: "Otopair fee", numeric: true },
  { key: "net", label: "Your net", numeric: true },
  { key: "status", label: "Status", numeric: false },
];

function FilterMenu({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  const current = options.find((o) => o.value === value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-lg border border-border bg-card px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {current?.label ?? label}
          <svg
            className="size-4 text-muted-foreground"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[200px]">
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {options.map((o) => (
            <DropdownMenuRadioItem key={o.value} value={o.value}>
              {o.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function TransactionsCard({
  result,
  loading,
  mechanics,
  selectedId,
  onSelect,
  search,
  onSearchChange,
  status,
  onStatusChange,
  mechanicId,
  onMechanicChange,
  onClearFilters,
  exportSlot,
}: {
  result: ShopTxnListResult | undefined;
  loading: boolean;
  mechanics: { id: string; name: string }[];
  selectedId: string | null;
  onSelect: (txn: ShopTxnListItem) => void;
  search: string;
  onSearchChange: (v: string) => void;
  status: StatusPill;
  onStatusChange: (v: StatusPill) => void;
  mechanicId: string;
  onMechanicChange: (v: string) => void;
  /** Single callback rather than three setters: the filters live in the URL,
   *  and three sequential patches would each rebuild from the same stale
   *  query string, so only the last would survive. */
  onClearFilters: () => void;
  /** The export control is injected rather than built here — it needs the
   *  window, insights and Stripe overview, none of which this card knows. */
  exportSlot?: ReactNode;
}) {
  const rows = result?.page ?? [];

  const mechanicOptions = useMemo(
    () => [
      { value: "all", label: "All mechanics" },
      ...mechanics.map((m) => ({ value: String(m.id), label: m.name })),
    ],
    [mechanics],
  );

  const hasFilters =
    search.trim() !== "" || status !== "all" || mechanicId !== "all";

  return (
    <Card className="p-0">
      {/* Header */}
      <div className="flex flex-col gap-4 border-b border-border/50 p-6 xl:flex-row xl:items-start xl:justify-between">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Transactions
          </p>
          <div className="mt-1 flex items-baseline gap-2">
            <h2 className="text-xl font-semibold text-foreground">All activity</h2>
            <span
              className="text-sm text-muted-foreground"
              aria-live="polite"
            >
              {loading ? "" : `${formatCount(rows.length)} shown`}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <input
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="Name, last 4, invoice, or pi_…"
              aria-label="Search transactions"
              className="h-9 w-full rounded-lg border border-border bg-card pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/30 sm:w-[260px]"
            />
          </div>
          <FilterMenu
            label="Status"
            value={status}
            options={STATUS_OPTIONS}
            onChange={(v) => onStatusChange(v as StatusPill)}
          />
          <FilterMenu
            label="Mechanic"
            value={mechanicId}
            options={mechanicOptions}
            onChange={onMechanicChange}
          />
          {exportSlot}
        </div>
      </div>

      {/* A capped scan is not the whole set, and the page must not imply it is. */}
      {result?.truncated ? (
        <div
          role="status"
          className="flex items-start gap-2 border-b border-border/50 bg-amber-50 px-6 py-2.5 text-xs text-amber-900"
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          Showing the first {formatCount(result.scanned)} matches. Narrow the date
          range or add a filter to see the rest.
        </div>
      ) : null}

      {result && result.undatedExcluded > 0 ? (
        <div className="border-b border-border/50 px-6 py-2.5 text-xs text-muted-foreground">
          {formatCount(result.undatedExcluded)} older payment
          {result.undatedExcluded === 1 ? "" : "s"} have no recorded date and
          aren&apos;t included in this range.
        </div>
      ) : null}

      {/* Body */}
      {loading ? (
        <div className="space-y-3 p-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4">
              <Skeleton className="size-7 rounded-full" />
              <Skeleton className="h-3 w-32" />
              <Skeleton className="hidden h-3 w-40 sm:block" />
              <Skeleton className="ml-auto h-3 w-16" />
              <Skeleton className="h-6 w-24 rounded-full" />
            </div>
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
          <span className="flex size-12 items-center justify-center rounded-full bg-muted">
            <SearchX className="size-6 text-muted-foreground" aria-hidden="true" />
          </span>
          <p className="text-sm font-medium text-foreground">
            {hasFilters
              ? "No transactions match these filters"
              : "No payments yet"}
          </p>
          {hasFilters ? (
            <button
              type="button"
              onClick={onClearFilters}
              className="text-sm font-medium text-primary hover:underline"
            >
              Clear filters
            </button>
          ) : null}
        </div>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full border-collapse">
              <caption className="sr-only">
                Payments for this shop, newest first. Select a row to open its
                detail.
              </caption>
              <thead>
                <tr>
                  {COLUMNS.map((c) => (
                    <th
                      key={c.key}
                      scope="col"
                      className={cn(
                        "px-4 pb-2 pt-4 text-xs font-medium uppercase tracking-wide text-muted-foreground",
                        c.numeric ? "text-right" : "text-left",
                      )}
                    >
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((txn) => (
                  <TransactionRow
                    key={String(txn.id)}
                    txn={txn}
                    selected={selectedId === String(txn.id)}
                    onSelect={onSelect}
                  />
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="flex flex-col gap-3 p-4 md:hidden">
            {rows.map((txn) => (
              <TransactionCardMobile
                key={String(txn.id)}
                txn={txn}
                onSelect={onSelect}
              />
            ))}
          </div>
        </>
      )}
    </Card>
  );
}

export { useDebouncedValue };
