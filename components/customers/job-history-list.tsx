"use client";

import { StatusPill } from "@/components/status-pill";
import { CalendarDays, User as UserIcon, Car, Wrench } from "lucide-react";
import { formatAbsoluteDate, formatCurrencyCents } from "./shared";

export interface JobHistoryItem {
  bookingId: string;
  scheduledMs: number;
  scheduledDate: string | null;
  scheduledTime: string | null;
  serviceNames: string[];
  mechanicName: string | null;
  status: string;
  totalCents: number;
  vehicleLabel?: string;
  customerName?: string;
}

export function JobHistoryList({
  jobs,
  showVehicle = false,
  showCustomer = false,
  emptyHint,
}: {
  jobs: JobHistoryItem[];
  showVehicle?: boolean;
  showCustomer?: boolean;
  emptyHint: string;
}) {
  if (jobs.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50/50 p-6 text-center text-xs text-gray-500">
        {emptyHint}
      </div>
    );
  }

  return (
    <ul className="space-y-2">
      {jobs.map((job) => (
        <li
          key={job.bookingId}
          className="rounded-xl border border-gray-100 bg-white p-3 transition-colors hover:border-gray-200 hover:bg-gray-50/50"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-500">
                <span className="inline-flex items-center gap-1">
                  <CalendarDays className="h-3.5 w-3.5 text-gray-400" />
                  {formatAbsoluteDate(job.scheduledMs)}
                  {job.scheduledTime ? (
                    <span className="text-gray-400">· {job.scheduledTime}</span>
                  ) : null}
                </span>
                <StatusPill status={job.status} />
              </div>
              <div className="mt-1.5 flex items-start gap-1.5 text-sm font-medium text-gray-900">
                <Wrench className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gray-400" />
                <span className="leading-snug">
                  {job.serviceNames.length > 0
                    ? job.serviceNames.join(", ")
                    : "No services listed"}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-gray-500">
                {job.mechanicName ? (
                  <span className="inline-flex items-center gap-1">
                    <UserIcon className="h-3 w-3 text-gray-400" />
                    {job.mechanicName}
                  </span>
                ) : null}
                {showVehicle && job.vehicleLabel ? (
                  <span className="inline-flex items-center gap-1">
                    <Car className="h-3 w-3 text-gray-400" />
                    {job.vehicleLabel}
                  </span>
                ) : null}
                {showCustomer && job.customerName ? (
                  <span className="inline-flex items-center gap-1">
                    <UserIcon className="h-3 w-3 text-gray-400" />
                    {job.customerName}
                  </span>
                ) : null}
              </div>
            </div>
            <span className="shrink-0 text-sm font-semibold tabular-nums text-gray-900">
              {formatCurrencyCents(job.totalCents)}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}
