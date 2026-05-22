"use client";

import { Car, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  TableSkeleton,
  VehicleThumb,
  VinCopyPill,
  formatMileage,
  formatRelativeLastVisit,
  highlightMatch,
} from "./shared";

export interface VehicleRow {
  id: string;
  vehicleId: string | null;
  vin: string;
  year: number | null;
  make: string;
  model: string;
  trim: string | null;
  imageUrl: string | null;
  mileage: number | null;
  ownerId: string | null;
  ownerName: string;
  lastServicedMs: number | null;
  jobsCount: number;
}

export type VehiclesSortKey =
  | "year"
  | "make"
  | "lastServicedMs"
  | "jobsCount";

export type VehiclesSort = { key: VehiclesSortKey; dir: "asc" | "desc" };

interface Column {
  key: VehiclesSortKey | "trim" | "vin" | "mileage" | "ownerName" | "thumb" | "model";
  label: string;
  sortable: boolean;
  align?: "right";
  hideWhenCompact?: boolean;
  className?: string;
}

const COLUMNS: Column[] = [
  { key: "thumb", label: "", sortable: false, className: "w-16" },
  { key: "year", label: "Year", sortable: true, className: "w-16" },
  { key: "make", label: "Make", sortable: true },
  { key: "model", label: "Model", sortable: false },
  { key: "trim", label: "Trim", sortable: false, hideWhenCompact: true },
  { key: "vin", label: "VIN", sortable: false },
  {
    key: "mileage",
    label: "Mileage",
    sortable: false,
    align: "right",
    hideWhenCompact: true,
  },
  { key: "ownerName", label: "Owner", sortable: false },
  {
    key: "lastServicedMs",
    label: "Last serviced",
    sortable: true,
    align: "right",
    className: "w-32",
  },
  {
    key: "jobsCount",
    label: "Jobs",
    sortable: true,
    align: "right",
    className: "w-16",
  },
];

export function VehiclesTable({
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
  rows: VehicleRow[] | undefined;
  search: string;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  sort: VehiclesSort;
  onSortChange: (s: VehiclesSort) => void;
  drawerCompact: boolean;
  onClearFilters: () => void;
  hasActiveFilters: boolean;
}) {
  const visibleCols = COLUMNS.filter(
    (c) => !drawerCompact || !c.hideWhenCompact,
  );

  const handleSort = (key: VehiclesSortKey) => {
    if (sort.key === key) {
      onSortChange({ key, dir: sort.dir === "asc" ? "desc" : "asc" });
    } else {
      onSortChange({ key, dir: "desc" });
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
                    onClick={() => handleSort(col.key as VehiclesSortKey)}
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
                  onClick={() => {
                    if (!row.vehicleId) return;
                    onSelect(isSelected ? null : row.id);
                  }}
                  className={cn(
                    "border-b border-gray-50 transition-colors last:border-0",
                    row.vehicleId
                      ? "cursor-pointer"
                      : "cursor-default opacity-70",
                    isSelected ? "bg-blue-50/60" : "hover:bg-gray-50/60",
                  )}
                >
                  <td className="px-5 py-3">
                    <VehicleThumb
                      imageUrl={row.imageUrl}
                      alt={`${row.year ?? ""} ${row.make} ${row.model}`.trim() || row.vin}
                    />
                  </td>
                  <td className="px-5 py-3 tabular-nums text-gray-700">
                    {row.year ?? "—"}
                  </td>
                  <td className="px-5 py-3 font-medium text-gray-900">
                    {row.make ? highlightMatch(row.make, search) : "—"}
                  </td>
                  <td className="px-5 py-3 text-gray-700">
                    {row.model ? highlightMatch(row.model, search) : "—"}
                  </td>
                  {!drawerCompact ? (
                    <td className="px-5 py-3 text-gray-600">{row.trim ?? "—"}</td>
                  ) : null}
                  <td className="px-5 py-3">
                    <VinCopyPill vin={row.vin} />
                  </td>
                  {!drawerCompact ? (
                    <td className="px-5 py-3 text-right tabular-nums text-gray-600">
                      {formatMileage(row.mileage)}
                    </td>
                  ) : null}
                  <td className="px-5 py-3 text-gray-600">
                    {row.ownerName ? highlightMatch(row.ownerName, search) : "—"}
                  </td>
                  <td className="px-5 py-3 text-right text-gray-600">
                    {formatRelativeLastVisit(row.lastServicedMs)}
                  </td>
                  <td className="px-5 py-3 text-right tabular-nums text-gray-700">
                    {row.jobsCount}
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
      <Car className="h-10 w-10 text-gray-300" />
      <p className="text-sm font-medium text-gray-700">
        {hasActiveFilters ? "No vehicles match your filters" : "No vehicles yet"}
      </p>
      <p className="max-w-xs text-xs text-gray-500">
        {hasActiveFilters
          ? "Try a different search term or clear filters."
          : "Vehicles will appear here once a customer books service at your shop."}
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
