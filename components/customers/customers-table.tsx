"use client";

import { ChevronDown, ChevronUp, UsersRound } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  CustomerAvatar,
  TableSkeleton,
  formatCurrencyCents,
  formatRelativeLastVisit,
  highlightMatch,
} from "./shared";

export interface CustomerRow {
  id: string;
  name: string;
  email: string;
  phone: string;
  profilePhotoUrl: string | null;
  vehiclesCount: number;
  totalJobs: number;
  lastVisitMs: number | null;
  lifetimeSpendCents: number;
}

export type CustomersSortKey =
  | "name"
  | "vehiclesCount"
  | "totalJobs"
  | "lastVisitMs"
  | "lifetimeSpendCents";

export type CustomersSort = { key: CustomersSortKey; dir: "asc" | "desc" };

interface Column {
  key: CustomersSortKey | "phone" | "email";
  label: string;
  sortable: boolean;
  align?: "right";
  hideWhenCompact?: boolean;
  className?: string;
}

const COLUMNS: Column[] = [
  { key: "name", label: "Name", sortable: true },
  { key: "email", label: "Email", sortable: false },
  { key: "phone", label: "Phone", sortable: false, hideWhenCompact: true },
  {
    key: "vehiclesCount",
    label: "Vehicles",
    sortable: true,
    align: "right",
    className: "w-24",
  },
  {
    key: "totalJobs",
    label: "Jobs",
    sortable: true,
    align: "right",
    className: "w-20",
  },
  {
    key: "lastVisitMs",
    label: "Last visit",
    sortable: true,
    align: "right",
    className: "w-28",
  },
  {
    key: "lifetimeSpendCents",
    label: "Lifetime",
    sortable: true,
    align: "right",
    className: "w-28",
  },
];

export function CustomersTable({
  rows,
  search,
  selectedId,
  onSelect,
  sort,
  onSortChange,
  drawerCompact,
  onClearFilters,
  hasActiveFilters,
}: {
  rows: CustomerRow[] | undefined;
  search: string;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  sort: CustomersSort;
  onSortChange: (s: CustomersSort) => void;
  drawerCompact: boolean;
  onClearFilters: () => void;
  hasActiveFilters: boolean;
}) {
  const visibleCols = COLUMNS.filter(
    (c) => !drawerCompact || !c.hideWhenCompact,
  );

  const handleSort = (key: CustomersSortKey) => {
    if (sort.key === key) {
      onSortChange({ key, dir: sort.dir === "asc" ? "desc" : "asc" });
    } else {
      onSortChange({
        key,
        dir: key === "name" ? "asc" : "desc",
      });
    }
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-100 text-left text-xs font-medium uppercase tracking-wider text-gray-500">
            {visibleCols.map((col) => (
              <th
                key={col.key}
                className={cn(
                  "px-5 py-3 font-medium",
                  col.align === "right" ? "text-right" : "",
                  col.className,
                )}
              >
                {col.sortable ? (
                  <button
                    type="button"
                    onClick={() => handleSort(col.key as CustomersSortKey)}
                    className={cn(
                      "inline-flex items-center gap-1 transition-colors hover:text-gray-700",
                      sort.key === col.key ? "text-blue-600" : "",
                    )}
                  >
                    {col.label}
                    {sort.key === col.key ? (
                      sort.dir === "asc" ? (
                        <ChevronUp className="h-3 w-3" />
                      ) : (
                        <ChevronDown className="h-3 w-3" />
                      )
                    ) : null}
                  </button>
                ) : (
                  col.label
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows === undefined ? (
            <TableSkeleton rows={6} cols={visibleCols.length} />
          ) : rows.length === 0 ? (
            <tr>
              <td colSpan={visibleCols.length} className="px-5 py-16">
                <EmptyState
                  hasActiveFilters={hasActiveFilters}
                  onClear={onClearFilters}
                />
              </td>
            </tr>
          ) : (
            rows.map((row) => {
              const isSelected = selectedId === row.id;
              return (
                <tr
                  key={row.id}
                  onClick={() => onSelect(isSelected ? null : row.id)}
                  className={cn(
                    "cursor-pointer border-b border-gray-50 transition-colors last:border-0",
                    isSelected ? "bg-blue-50/60" : "hover:bg-gray-50/60",
                  )}
                >
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-3">
                      <CustomerAvatar name={row.name} />
                      <span className="font-medium text-gray-900">
                        {highlightMatch(row.name, search)}
                      </span>
                    </div>
                  </td>
                  <td className="px-5 py-3 text-gray-600">
                    {row.email ? highlightMatch(row.email, search) : "—"}
                  </td>
                  {!drawerCompact ? (
                    <td className="px-5 py-3 text-gray-600">
                      {row.phone ? highlightMatch(row.phone, search) : "—"}
                    </td>
                  ) : null}
                  <td className="px-5 py-3 text-right tabular-nums text-gray-700">
                    {row.vehiclesCount}
                  </td>
                  <td className="px-5 py-3 text-right tabular-nums text-gray-700">
                    {row.totalJobs}
                  </td>
                  <td className="px-5 py-3 text-right text-gray-600">
                    {formatRelativeLastVisit(row.lastVisitMs)}
                  </td>
                  <td className="px-5 py-3 text-right font-medium tabular-nums text-gray-900">
                    {formatCurrencyCents(row.lifetimeSpendCents)}
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

function EmptyState({
  hasActiveFilters,
  onClear,
}: {
  hasActiveFilters: boolean;
  onClear: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <UsersRound className="h-10 w-10 text-gray-300" />
      <p className="text-sm font-medium text-gray-700">
        {hasActiveFilters ? "No customers match your filters" : "No customers yet"}
      </p>
      <p className="max-w-xs text-xs text-gray-500">
        {hasActiveFilters
          ? "Try a different search term or clear filters to see everyone who's visited."
          : "Customers will appear here once they book service at your shop."}
      </p>
      {hasActiveFilters ? (
        <button
          type="button"
          onClick={onClear}
          className="mt-1 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50"
        >
          Clear filters
        </button>
      ) : null}
    </div>
  );
}
