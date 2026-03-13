"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { ChevronDown, X } from "lucide-react";

type JobStatusFilter =
  | "all"
  | "pending_shop_acceptance"
  | "confirmed"
  | "in_progress"
  | "completed"
  | "cancelled";

const STATUS_TABS: { key: JobStatusFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "pending_shop_acceptance", label: "Pending" },
  { key: "confirmed", label: "Confirmed" },
  { key: "in_progress", label: "In Progress" },
  { key: "completed", label: "Completed" },
  { key: "cancelled", label: "Cancelled" },
];

const statusBadgeClass: Record<string, string> = {
  pending_shop_acceptance: "bg-amber-100 text-amber-700",
  pending: "bg-amber-100 text-amber-700",
  confirmed: "bg-blue-100 text-blue-700",
  in_progress: "bg-emerald-100 text-emerald-700",
  completed: "bg-gray-100 text-gray-700",
  cancelled: "bg-red-100 text-red-700",
  declined: "bg-red-100 text-red-700",
};

const statusLabel: Record<string, string> = {
  pending_shop_acceptance: "Pending",
  pending: "Pending",
  confirmed: "Confirmed",
  in_progress: "In Progress",
  completed: "Completed",
  cancelled: "Cancelled",
  declined: "Declined",
};

export default function JobsPage() {
  const [statusFilter, setStatusFilter] = useState<JobStatusFilter>("all");
  const [selectedJobId, setSelectedJobId] = useState<Id<"bookings"> | null>(null);
  const [assigningMechanicId, setAssigningMechanicId] = useState("");
  const [actionError, setActionError] = useState<string>("");

  const context = useQuery(api.bookings.getMyShopJobContext);
  const allJobs = useQuery(api.bookings.listForMyShop, {});
  const selectedJob = useQuery(
    api.bookings.getJobDetail,
    selectedJobId ? { bookingId: selectedJobId } : "skip"
  );

  const acceptJob = useMutation(api.bookings.accept);
  const completeJob = useMutation(api.bookings.complete);
  const cancelJob = useMutation(api.bookings.cancel);
  const updateJob = useMutation(api.bookings.update);

  const hasContext = !!context?.shopId;
  const mechanics = useMemo(() => context?.mechanics ?? [], [context?.mechanics]);
  const selectedMechanicId = useMemo(
    () => mechanics.find((m) => String(m._id) === assigningMechanicId)?._id,
    [assigningMechanicId, mechanics]
  );

  // Compute counts per status from all jobs
  const statusCounts = useMemo(() => {
    if (!allJobs) return {};
    const counts: Record<string, number> = { all: allJobs.length };
    for (const job of allJobs) {
      counts[job.status] = (counts[job.status] ?? 0) + 1;
    }
    return counts;
  }, [allJobs]);

  // Filter jobs client-side
  const filteredJobs = useMemo(() => {
    if (!allJobs) return undefined;
    if (statusFilter === "all") return allJobs;
    return allJobs.filter((j) => j.status === statusFilter);
  }, [allJobs, statusFilter]);

  useEffect(() => {
    if (!selectedJob) return;
    setAssigningMechanicId(selectedJob.mechanicId ? String(selectedJob.mechanicId) : "");
  }, [selectedJob]);

  async function handleStatusAction(action: "accept" | "complete" | "cancel") {
    if (!selectedJob?._id) return;
    setActionError("");
    try {
      if (action === "accept") await acceptJob({ bookingId: selectedJob._id });
      if (action === "complete") await completeJob({ bookingId: selectedJob._id });
      if (action === "cancel")
        await cancelJob({ bookingId: selectedJob._id, reason: "cancelled_from_jobs_page" });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Could not update status.";
      setActionError(message);
    }
  }

  async function handleAssignMechanic() {
    if (!selectedJob?._id || !selectedMechanicId) return;
    setActionError("");
    try {
      await updateJob({ bookingId: selectedJob._id, mechanicId: selectedMechanicId });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Could not assign mechanic.";
      setActionError(message);
    }
  }

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground">All Jobs</h1>
        <p className="text-sm text-muted-foreground mt-1">
          View, assign, and manage jobs through their lifecycle.
        </p>
      </div>

      {context === undefined ? (
        <div className="bg-card rounded-xl border border-border p-8 text-center text-muted-foreground">
          Loading…
        </div>
      ) : !hasContext ? (
        <div className="bg-card rounded-xl border border-border p-8 text-center text-muted-foreground">
          You must be an active shop staff member to manage jobs.
        </div>
      ) : (
        <>
          {/* Status summary tabs */}
          <div className="flex gap-0 border border-border rounded-xl overflow-hidden bg-card">
            {STATUS_TABS.map((tab, i) => {
              const count = statusCounts[tab.key] ?? 0;
              const isActive = statusFilter === tab.key;
              return (
                <button
                  key={tab.key}
                  onClick={() => setStatusFilter(tab.key)}
                  className={`flex-1 py-3 px-4 text-left transition-colors relative ${
                    i > 0 ? "border-l border-border" : ""
                  } ${isActive ? "bg-primary/5" : "hover:bg-muted/50"}`}
                >
                  {isActive && (
                    <div className="absolute top-0 left-0 right-0 h-0.5 bg-primary" />
                  )}
                  <p className={`text-xs font-medium ${isActive ? "text-primary" : "text-muted-foreground"}`}>
                    {tab.label}
                  </p>
                  <p className={`text-lg font-semibold mt-0.5 ${isActive ? "text-primary" : "text-foreground"}`}>
                    {allJobs === undefined ? "–" : count}
                  </p>
                </button>
              );
            })}
          </div>

          {/* Table card */}
          <div className="bg-card rounded-xl border border-border overflow-hidden">
            {/* Filter row */}
            <div className="flex items-center justify-between px-5 py-3 border-b border-border">
              <div className="flex items-center gap-2">
                <FilterPill label="Status" value={statusFilter !== "all" ? statusLabel[statusFilter] ?? statusFilter : undefined} onClear={() => setStatusFilter("all")} />
              </div>
              <p className="text-xs text-muted-foreground">
                {filteredJobs ? `${filteredJobs.length} result${filteredJobs.length !== 1 ? "s" : ""}` : ""}
              </p>
            </div>

            {/* Table */}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground font-medium">
                    <th className="pl-5 pr-3 py-3">Customer</th>
                    <th className="px-3 py-3">Vehicle</th>
                    <th className="px-3 py-3">Service</th>
                    <th className="px-3 py-3">Status</th>
                    <th className="px-3 py-3">Mechanic</th>
                    <th className="px-3 py-3">Date</th>
                    <th className="px-3 py-3 text-right pr-5">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredJobs === undefined ? (
                    <tr>
                      <td colSpan={7} className="px-5 py-8 text-center text-muted-foreground">
                        Loading jobs…
                      </td>
                    </tr>
                  ) : filteredJobs.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-5 py-8 text-center text-muted-foreground">
                        No jobs match this filter.
                      </td>
                    </tr>
                  ) : (
                    filteredJobs.map((job) => {
                      const isSelected = selectedJobId === job._id;
                      return (
                        <tr
                          key={String(job._id)}
                          onClick={() => setSelectedJobId(isSelected ? null : job._id)}
                          className={`border-b border-border last:border-b-0 cursor-pointer transition-colors ${
                            isSelected
                              ? "bg-primary/5"
                              : "hover:bg-muted/50"
                          }`}
                        >
                          <td className="pl-5 pr-3 py-3">
                            <p className="font-medium text-foreground">{job.customerName}</p>
                            <p className="text-xs text-muted-foreground">{job.customerEmail}</p>
                          </td>
                          <td className="px-3 py-3 text-foreground">{job.vehicle}</td>
                          <td className="px-3 py-3 text-foreground max-w-48 truncate">
                            {job.serviceNames.join(", ")}
                          </td>
                          <td className="px-3 py-3">
                            <span
                              className={`inline-flex text-[11px] px-2.5 py-1 rounded-full font-medium ${
                                statusBadgeClass[job.status] ?? "bg-gray-100 text-gray-700"
                              }`}
                            >
                              {statusLabel[job.status] ?? job.status}
                            </span>
                          </td>
                          <td className="px-3 py-3 text-foreground">
                            {job.mechanicName ?? <span className="text-muted-foreground">—</span>}
                          </td>
                          <td className="px-3 py-3 text-muted-foreground whitespace-nowrap">
                            {job.scheduledDate}, {job.scheduledTime}
                          </td>
                          <td className="px-3 py-3 text-right pr-5 font-medium text-foreground whitespace-nowrap">
                            ${job.totalCost.toFixed(2)}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Job detail panel */}
          {selectedJobId && (
            <div className="bg-card rounded-xl border border-border p-5">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold text-foreground">Job Detail</h2>
                <button
                  onClick={() => setSelectedJobId(null)}
                  className="p-1 rounded-md hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              {selectedJob === undefined ? (
                <p className="text-sm text-muted-foreground">Loading details…</p>
              ) : !selectedJob ? (
                <p className="text-sm text-muted-foreground">Job not found.</p>
              ) : (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
                    <div>
                      <p className="text-muted-foreground text-xs mb-1">Customer</p>
                      <p className="font-medium text-foreground">{selectedJob.customerName}</p>
                      <p className="text-muted-foreground text-xs">{selectedJob.customerEmail || "No email on file"}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground text-xs mb-1">Vehicle</p>
                      <p className="font-medium text-foreground">{selectedJob.vehicle}</p>
                      <p className="text-muted-foreground text-xs">{selectedJob.vin}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground text-xs mb-1">Schedule</p>
                      <p className="font-medium text-foreground">
                        {selectedJob.scheduledDate} at {selectedJob.scheduledTime}
                      </p>
                    </div>
                    <div>
                      <p className="text-muted-foreground text-xs mb-1">Services</p>
                      <p className="font-medium text-foreground">{selectedJob.serviceNames.join(", ")}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground text-xs mb-1">Costs</p>
                      <p className="font-medium text-foreground">${selectedJob.totalCost.toFixed(2)} total</p>
                      <p className="text-muted-foreground text-xs">
                        Labor ${selectedJob.laborCost.toFixed(2)} · Parts ${selectedJob.partsCost.toFixed(2)}
                      </p>
                    </div>
                    <div>
                      <p className="text-muted-foreground text-xs mb-1">Status</p>
                      <span
                        className={`inline-flex text-[11px] px-2.5 py-1 rounded-full font-medium ${
                          statusBadgeClass[selectedJob.status] ?? "bg-gray-100 text-gray-700"
                        }`}
                      >
                        {statusLabel[selectedJob.status] ?? selectedJob.status}
                      </span>
                    </div>
                  </div>

                  <div className="border-t border-border pt-4">
                    <p className="text-xs font-medium text-foreground mb-2">Assign mechanic</p>
                    <div className="flex flex-wrap gap-2">
                      <select
                        className="border border-border rounded-lg px-3 py-2 text-sm bg-card text-foreground min-w-48"
                        value={assigningMechanicId}
                        onChange={(e) => setAssigningMechanicId(e.target.value)}
                      >
                        <option value="">Unassigned</option>
                        {mechanics.map((m) => (
                          <option key={String(m._id)} value={String(m._id)}>
                            {m.name}
                          </option>
                        ))}
                      </select>
                      <button
                        onClick={handleAssignMechanic}
                        disabled={!assigningMechanicId}
                        className="px-3 py-2 text-sm rounded-lg border border-border hover:bg-muted transition-colors disabled:opacity-50"
                      >
                        Save assignment
                      </button>
                    </div>
                  </div>

                  <div className="border-t border-border pt-4">
                    <p className="text-xs font-medium text-foreground mb-2">Status transitions</p>
                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={() => handleStatusAction("accept")}
                        disabled={!["pending", "pending_shop_acceptance"].includes(selectedJob.status)}
                        className="px-3 py-2 text-sm rounded-lg bg-primary text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50"
                      >
                        Accept
                      </button>
                      <button
                        onClick={() => handleStatusAction("complete")}
                        disabled={!["confirmed", "in_progress"].includes(selectedJob.status)}
                        className="px-3 py-2 text-sm rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 transition-colors disabled:opacity-50"
                      >
                        Mark completed
                      </button>
                      <button
                        onClick={() => handleStatusAction("cancel")}
                        disabled={["completed", "cancelled"].includes(selectedJob.status)}
                        className="px-3 py-2 text-sm rounded-lg border border-red-300 text-red-600 hover:bg-red-50 transition-colors disabled:opacity-50"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>

                  <div className="border-t border-border pt-4">
                    <p className="text-xs font-medium text-foreground mb-2">Status history</p>
                    <div className="space-y-1 max-h-28 overflow-y-auto">
                      {selectedJob.history.length === 0 ? (
                        <p className="text-xs text-muted-foreground">No history entries yet.</p>
                      ) : (
                        selectedJob.history.map((h) => (
                          <p key={String(h._id)} className="text-xs text-muted-foreground">
                            {new Date(h.changed_at).toLocaleString()}:{" "}
                            <span className="font-medium text-foreground">{h.old_status ?? "none"}</span>
                            {" → "}
                            <span className="font-medium text-foreground">{h.new_status}</span>
                            {h.reason ? ` (${h.reason})` : ""}
                          </p>
                        ))
                      )}
                    </div>
                  </div>

                  {actionError && (
                    <p className="text-xs text-red-600">{actionError}</p>
                  )}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Small filter pill component */
function FilterPill({
  label,
  value,
  onClear,
}: {
  label: string;
  value?: string;
  onClear: () => void;
}) {
  if (!value) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground px-3 py-1.5 rounded-full border border-border bg-card">
        <ChevronDown className="w-3 h-3" />
        {label}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-primary px-3 py-1.5 rounded-full border border-primary/30 bg-primary/5">
      {label}: {value}
      <button onClick={onClear} className="ml-0.5 hover:text-primary/70 transition-colors">
        <X className="w-3 h-3" />
      </button>
    </span>
  );
}
