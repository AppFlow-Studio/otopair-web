"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

type JobStatusFilter =
  | "all"
  | "pending_shop_acceptance"
  | "confirmed"
  | "in_progress"
  | "completed"
  | "cancelled";

const statusBadgeClass: Record<string, string> = {
  pending_shop_acceptance: "bg-amber-100 text-amber-700",
  pending: "bg-amber-100 text-amber-700",
  confirmed: "bg-blue-100 text-blue-700",
  in_progress: "bg-emerald-100 text-emerald-700",
  completed: "bg-gray-100 text-gray-700",
  cancelled: "bg-red-100 text-red-700",
  declined: "bg-red-100 text-red-700",
};

export default function JobsPage() {
  const [statusFilter, setStatusFilter] = useState<JobStatusFilter>("all");
  const [selectedJobId, setSelectedJobId] = useState<Id<"bookings"> | null>(null);
  const [assigningMechanicId, setAssigningMechanicId] = useState("");
  const [actionError, setActionError] = useState<string>("");

  const context = useQuery(api.bookings.getMyShopJobContext);
  const jobs = useQuery(
    api.bookings.listForMyShop,
    statusFilter === "all" ? {} : { status: statusFilter }
  );
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
      <div>
        <h1 className="text-2xl font-bold text-gray-900 mb-2">All Jobs</h1>
        <p className="text-gray-600">
          View, assign, and transition jobs through their lifecycle.
        </p>
      </div>

      {context === undefined ? (
        <div className="bg-white rounded-xl border border-gray-200 p-8 text-center text-gray-500">
          Loading…
        </div>
      ) : !hasContext ? (
        <div className="bg-white rounded-xl border border-gray-200 p-8 text-center text-gray-500">
          You must be an active shop staff member to manage jobs.
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          {/* Jobs list */}
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-gray-900">Jobs</h2>
              <select
                className="border border-gray-300 rounded-md px-3 py-1.5 text-sm"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as JobStatusFilter)}
              >
                <option value="all">All</option>
                <option value="pending_shop_acceptance">Pending acceptance</option>
                <option value="confirmed">Confirmed</option>
                <option value="in_progress">In progress</option>
                <option value="completed">Completed</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </div>

            <div className="space-y-2">
              {jobs === undefined ? (
                <p className="text-sm text-gray-500">Loading jobs…</p>
              ) : jobs.length === 0 ? (
                <p className="text-sm text-gray-500">No jobs match this filter.</p>
              ) : (
                jobs.map((job) => (
                  <button
                    key={String(job._id)}
                    onClick={() => setSelectedJobId(job._id)}
                    className={`w-full text-left border rounded-lg px-3 py-2.5 transition-colors ${
                      selectedJobId === job._id
                        ? "border-blue-500 bg-blue-50"
                        : "border-gray-200 hover:bg-gray-50"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-medium text-gray-900">
                        {job.customerName} — {job.vehicle}
                      </p>
                      <span
                        className={`text-[11px] px-2 py-0.5 rounded-full ${
                          statusBadgeClass[job.status] ?? "bg-gray-100 text-gray-700"
                        }`}
                      >
                        {job.status}
                      </span>
                    </div>
                    <p className="text-xs text-gray-600 mt-1">
                      {job.scheduledDate} at {job.scheduledTime} · {job.serviceNames.join(", ")}
                    </p>
                  </button>
                ))
              )}
            </div>
          </div>

          {/* Job detail */}
          <div className="bg-white rounded-xl border border-gray-200 p-5 min-h-56">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Job Detail</h2>
            {!selectedJobId ? (
              <p className="text-sm text-gray-500">Select a job to view details and actions.</p>
            ) : selectedJob === undefined ? (
              <p className="text-sm text-gray-500">Loading details…</p>
            ) : !selectedJob ? (
              <p className="text-sm text-gray-500">Job not found.</p>
            ) : (
              <div className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                  <div>
                    <p className="text-gray-500">Customer</p>
                    <p className="font-medium text-gray-900">{selectedJob.customerName}</p>
                    <p className="text-gray-600">{selectedJob.customerEmail || "No email on file"}</p>
                  </div>
                  <div>
                    <p className="text-gray-500">Vehicle</p>
                    <p className="font-medium text-gray-900">{selectedJob.vehicle}</p>
                    <p className="text-gray-600">{selectedJob.vin}</p>
                  </div>
                  <div>
                    <p className="text-gray-500">Schedule</p>
                    <p className="font-medium text-gray-900">
                      {selectedJob.scheduledDate} at {selectedJob.scheduledTime}
                    </p>
                  </div>
                  <div>
                    <p className="text-gray-500">Costs</p>
                    <p className="font-medium text-gray-900">
                      ${selectedJob.totalCost.toFixed(2)} total
                    </p>
                    <p className="text-gray-600">
                      Labor ${selectedJob.laborCost.toFixed(2)} / Parts ${selectedJob.partsCost.toFixed(2)}
                    </p>
                  </div>
                  <div>
                    <p className="text-gray-500">Services</p>
                    <p className="font-medium text-gray-900">{selectedJob.serviceNames.join(", ")}</p>
                  </div>
                  <div>
                    <p className="text-gray-500">Status</p>
                    <p className="font-medium text-gray-900">{selectedJob.status}</p>
                  </div>
                </div>

                <div className="border-t border-gray-200 pt-3">
                  <p className="text-sm font-medium text-gray-800 mb-2">Assign mechanic</p>
                  <div className="flex flex-wrap gap-2">
                    <select
                      className="border border-gray-300 rounded-md px-3 py-2 text-sm min-w-48"
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
                      className="px-3 py-2 text-sm rounded-md border border-gray-300 hover:bg-gray-50 disabled:opacity-60"
                    >
                      Save assignment
                    </button>
                  </div>
                </div>

                <div className="border-t border-gray-200 pt-3">
                  <p className="text-sm font-medium text-gray-800 mb-2">Status transitions</p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => handleStatusAction("accept")}
                      disabled={!["pending", "pending_shop_acceptance"].includes(selectedJob.status)}
                      className="px-3 py-2 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-60"
                    >
                      Accept
                    </button>
                    <button
                      onClick={() => handleStatusAction("complete")}
                      disabled={!["confirmed", "in_progress"].includes(selectedJob.status)}
                      className="px-3 py-2 text-sm rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-60"
                    >
                      Mark completed
                    </button>
                    <button
                      onClick={() => handleStatusAction("cancel")}
                      disabled={["completed", "cancelled"].includes(selectedJob.status)}
                      className="px-3 py-2 text-sm rounded-md border border-red-300 text-red-600 hover:bg-red-50 disabled:opacity-60"
                    >
                      Cancel
                    </button>
                  </div>
                </div>

                <div className="border-t border-gray-200 pt-3">
                  <p className="text-sm font-medium text-gray-800 mb-2">Status history</p>
                  <div className="space-y-1 max-h-28 overflow-y-auto">
                    {selectedJob.history.length === 0 ? (
                      <p className="text-xs text-gray-500">No history entries yet.</p>
                    ) : (
                      selectedJob.history.map((h) => (
                        <p key={String(h._id)} className="text-xs text-gray-600">
                          {new Date(h.changed_at).toLocaleString()}:{" "}
                          <span className="font-medium">{h.old_status ?? "none"}</span>
                          {" → "}
                          <span className="font-medium">{h.new_status}</span>
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
        </div>
      )}
    </div>
  );
}
