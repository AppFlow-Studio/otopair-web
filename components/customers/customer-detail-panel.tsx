"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Car, Loader2, Mail, Phone, X } from "lucide-react";
import { motion } from "framer-motion";
import {
  CustomerAvatar,
  formatAbsoluteDate,
  formatCurrencyCents,
} from "./shared";
import { JobHistoryList, type JobHistoryItem } from "./job-history-list";

interface CustomerDetailPanelProps {
  customerId: Id<"users">;
  onClose: () => void;
}

export function CustomerDetailPanel({
  customerId,
  onClose,
}: CustomerDetailPanelProps) {
  const detail = useQuery(api.shopCustomers.getShopCustomerDetail, {
    customerId,
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
            Loading customer…
          </div>
        ) : detail === null ? (
          <div className="text-sm text-gray-500">Customer not found.</div>
        ) : (
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <CustomerAvatar name={detail.name} />
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-lg font-semibold text-gray-900">
                {detail.name}
              </h2>
              <div className="mt-1 flex flex-col gap-1 text-xs text-gray-500">
                {detail.email ? (
                  <span className="inline-flex items-center gap-1.5">
                    <Mail className="h-3.5 w-3.5 text-gray-400" />
                    <a
                      href={`mailto:${detail.email}`}
                      className="truncate hover:text-blue-600"
                    >
                      {detail.email}
                    </a>
                  </span>
                ) : null}
                {detail.phone ? (
                  <span className="inline-flex items-center gap-1.5">
                    <Phone className="h-3.5 w-3.5 text-gray-400" />
                    <a
                      href={`tel:${detail.phone}`}
                      className="hover:text-blue-600"
                    >
                      {detail.phone}
                    </a>
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
            <StatTile label="Vehicles" value={String(detail.vehiclesCount)} />
            <StatTile label="Jobs" value={String(detail.totalJobs)} />
            <StatTile
              label="Lifetime"
              value={formatCurrencyCents(detail.lifetimeSpendCents)}
            />
          </div>
          <div className="mt-2 grid grid-cols-2 gap-3">
            <StatTile
              label="Avg ticket"
              value={formatCurrencyCents(detail.avgTicketCents)}
            />
            <StatTile
              label="First visit"
              value={formatAbsoluteDate(detail.firstVisitMs)}
            />
          </div>

          {detail.vehicles.length > 0 ? (
            <section className="mt-6">
              <h3 className="text-xs font-semibold uppercase tracking-[0.18em] text-gray-500">
                Vehicles
              </h3>
              <ul className="mt-2 space-y-1.5">
                {detail.vehicles.map((v) => (
                  <li
                    key={v.vin}
                    className="flex items-center gap-2 rounded-lg border border-gray-100 bg-gray-50/50 px-3 py-2 text-sm"
                  >
                    <Car className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                    <span className="min-w-0 flex-1 truncate text-gray-700">
                      {[v.year, v.make, v.model].filter(Boolean).join(" ") ||
                        v.vin}
                      {v.trim ? (
                        <span className="text-gray-400"> · {v.trim}</span>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className="mt-6">
            <h3 className="text-xs font-semibold uppercase tracking-[0.18em] text-gray-500">
              Service history at your shop
            </h3>
            <div className="mt-3">
              <JobHistoryList
                jobs={detail.jobs as JobHistoryItem[]}
                showVehicle
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
