"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Loader2, User as UserIcon, X } from "lucide-react";
import { motion } from "framer-motion";
import {
  VehicleThumb,
  VinCopyPill,
  formatCurrencyCents,
  formatMileage,
  formatRelativeLastVisit,
} from "./shared";
import { JobHistoryList, type JobHistoryItem } from "./job-history-list";

interface VehicleDetailPanelProps {
  vehicleId: Id<"vehicles">;
  onClose: () => void;
}

export function VehicleDetailPanel({
  vehicleId,
  onClose,
}: VehicleDetailPanelProps) {
  const detail = useQuery(api.shopCustomers.getShopVehicleDetail, {
    vehicleId,
  });

  return (
    <motion.div
      initial={{ x: 24, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 24, opacity: 0 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
      className="flex h-full w-full flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm"
    >
      <div className="flex items-start justify-between border-b border-gray-100 bg-gradient-to-b from-gray-50 to-white px-6 pt-6 pb-5">
        {detail === undefined ? (
          <div className="flex items-center gap-3 text-sm text-gray-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading vehicle…
          </div>
        ) : detail === null ? (
          <div className="text-sm text-gray-500">Vehicle not found.</div>
        ) : (
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <VehicleThumb
              imageUrl={detail.imageUrl}
              alt={`${detail.year ?? ""} ${detail.make} ${detail.model}`.trim() || detail.vin}
            />
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-lg font-semibold text-gray-900">
                {[detail.year, detail.make, detail.model]
                  .filter(Boolean)
                  .join(" ") || detail.vin}
              </h2>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500">
                {detail.trim ? (
                  <span className="rounded-md bg-gray-100 px-1.5 py-0.5 text-[11px] font-medium text-gray-700">
                    {detail.trim}
                  </span>
                ) : null}
                <VinCopyPill vin={detail.vin} />
                {detail.nickname ? (
                  <span className="text-[11px] italic text-gray-500">
                    “{detail.nickname}”
                  </span>
                ) : null}
              </div>
            </div>
          </div>
        )}
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
          aria-label="Close panel"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {detail && (
        <div className="flex-1 overflow-y-auto px-6 py-5">
          <div className="grid grid-cols-3 gap-3">
            <StatTile label="Mileage" value={formatMileage(detail.mileage)} />
            <StatTile label="Jobs" value={String(detail.jobsCount)} />
            <StatTile
              label="Lifetime"
              value={formatCurrencyCents(detail.lifetimeSpendCents)}
            />
          </div>
          <div className="mt-2 grid grid-cols-1 gap-3">
            <StatTile
              label="Last serviced"
              value={formatRelativeLastVisit(detail.lastServicedMs)}
            />
          </div>

          {detail.ownerName ? (
            <section className="mt-6">
              <h3 className="text-xs font-semibold uppercase tracking-[0.18em] text-gray-500">
                Owner
              </h3>
              <div className="mt-2 flex items-center gap-2 rounded-lg border border-gray-100 bg-gray-50/50 px-3 py-2 text-sm">
                <UserIcon className="h-3.5 w-3.5 text-gray-400" />
                <span className="text-gray-700">{detail.ownerName}</span>
              </div>
            </section>
          ) : null}

          <section className="mt-6">
            <h3 className="text-xs font-semibold uppercase tracking-[0.18em] text-gray-500">
              Service history at your shop
            </h3>
            <div className="mt-3">
              <JobHistoryList
                jobs={detail.jobs as JobHistoryItem[]}
                showCustomer
                emptyHint="No jobs at your shop yet."
              />
            </div>
          </section>
        </div>
      )}
    </motion.div>
  );
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-gray-50 px-3 py-2.5">
      <div className="text-[11px] uppercase tracking-wider text-gray-500">
        {label}
      </div>
      <div className="mt-0.5 truncate text-base font-semibold tabular-nums text-gray-900">
        {value}
      </div>
    </div>
  );
}
