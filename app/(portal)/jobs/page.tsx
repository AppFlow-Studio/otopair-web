"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

type JobStatusFilter = "all" | "pending_shop_acceptance" | "confirmed" | "in_progress" | "completed" | "cancelled";

const statusBadgeClass: Record<string, string> = {
  pending_shop_acceptance: "bg-amber-100 text-amber-700",
  pending: "bg-amber-100 text-amber-700",
  confirmed: "bg-blue-100 text-blue-700",
  in_progress: "bg-emerald-100 text-emerald-700",
  completed: "bg-gray-100 text-gray-700",
  cancelled: "bg-red-100 text-red-700",
  declined: "bg-red-100 text-red-700",
};

const defaultServiceSelection: Record<string, boolean> = {};

function toNumber(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export default function JobsPage() {
  const [statusFilter, setStatusFilter] = useState<JobStatusFilter>("all");
  const [selectedJobId, setSelectedJobId] = useState<Id<"bookings"> | null>(null);
  const [assigningMechanicId, setAssigningMechanicId] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string>("");

  const [formState, setFormState] = useState({
    customerEmail: "",
    customerFirstName: "",
    customerLastName: "",
    vin: "",
    vehicleYear: "",
    vehicleMake: "",
    vehicleModel: "",
    scheduledDate: "",
    scheduledTime: "",
    laborCost: "",
    partsCost: "",
    estimatedLaborMinutes: "",
  });
  const [selectedServices, setSelectedServices] =
    useState<Record<string, boolean>>(defaultServiceSelection);

  const context = useQuery(api.bookings.getMyShopJobContext);
  const jobs = useQuery(
    api.bookings.listForMyShop,
    statusFilter === "all" ? {} : { status: statusFilter }
  );
  const selectedJob = useQuery(
    api.bookings.getJobDetail,
    selectedJobId ? { bookingId: selectedJobId } : "skip"
  );

  const createJob = useMutation(api.bookings.create);
  const acceptJob = useMutation(api.bookings.accept);
  const completeJob = useMutation(api.bookings.complete);
  const cancelJob = useMutation(api.bookings.cancel);
  const updateJob = useMutation(api.bookings.update);

  const hasContext = !!context?.shopId;
  const mechanics = useMemo(() => context?.mechanics ?? [], [context?.mechanics]);
  const services = useMemo(() => context?.services ?? [], [context?.services]);

  const selectedServiceIds = useMemo(
    () => services.filter((s) => selectedServices[String(s._id)]).map((s) => s._id),
    [services, selectedServices]
  );
  const selectedMechanicId = useMemo(
    () => mechanics.find((m) => String(m._id) === assigningMechanicId)?._id,
    [assigningMechanicId, mechanics]
  );

  useEffect(() => {
    if (!selectedJob) return;
    setAssigningMechanicId(selectedJob.mechanicId ? String(selectedJob.mechanicId) : "");
  }, [selectedJob]);

  async function handleCreateJob(e: FormEvent) {
    e.preventDefault();
    if (!context?.shopId) return;

    setActionError("");
    if (selectedServiceIds.length === 0) {
      setActionError("Select at least one service.");
      return;
    }
    if (!formState.customerEmail || !formState.vin || !formState.scheduledDate || !formState.scheduledTime) {
      setActionError("Customer email, VIN, date, and time are required.");
      return;
    }

    try {
      setIsSubmitting(true);
      const createdId = await createJob({
        shopId: context.shopId,
        customerEmail: formState.customerEmail.trim(),
        customerFirstName: formState.customerFirstName.trim() || undefined,
        customerLastName: formState.customerLastName.trim() || undefined,
        vin: formState.vin.trim(),
        vehicleYear: formState.vehicleYear ? toNumber(formState.vehicleYear) : undefined,
        vehicleMake: formState.vehicleMake.trim() || undefined,
        vehicleModel: formState.vehicleModel.trim() || undefined,
        scheduledDate: formState.scheduledDate,
        scheduledTime: formState.scheduledTime,
        serviceIds: selectedServiceIds,
        mechanicId: selectedMechanicId,
        laborCost: toNumber(formState.laborCost),
        partsCost: toNumber(formState.partsCost),
        estimatedLaborMinutes: formState.estimatedLaborMinutes
          ? toNumber(formState.estimatedLaborMinutes)
          : undefined,
        status: "confirmed",
      });

      setSelectedJobId(createdId);
      setFormState({
        customerEmail: "",
        customerFirstName: "",
        customerLastName: "",
        vin: "",
        vehicleYear: "",
        vehicleMake: "",
        vehicleModel: "",
        scheduledDate: "",
        scheduledTime: "",
        laborCost: "",
        partsCost: "",
        estimatedLaborMinutes: "",
      });
      setSelectedServices({});
      setAssigningMechanicId("");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to create job.";
      setActionError(message);
    } finally {
      setIsSubmitting(false);
    }
  }

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
      await updateJob({
        bookingId: selectedJob._id,
        mechanicId: selectedMechanicId,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Could not assign mechanic.";
      setActionError(message);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Job Management</h1>
        <p className="text-gray-600">
          Create, assign, and transition jobs through pending, confirmed, in-progress, and completed.
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
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
          <div className="xl:col-span-1 bg-white rounded-xl border border-gray-200 p-5">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Create Job</h2>
            <form className="space-y-3" onSubmit={handleCreateJob}>
              <input
                placeholder="Customer email"
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                value={formState.customerEmail}
                onChange={(e) => setFormState((s) => ({ ...s, customerEmail: e.target.value }))}
              />
              <div className="grid grid-cols-2 gap-2">
                <input
                  placeholder="First name"
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                  value={formState.customerFirstName}
                  onChange={(e) => setFormState((s) => ({ ...s, customerFirstName: e.target.value }))}
                />
                <input
                  placeholder="Last name"
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                  value={formState.customerLastName}
                  onChange={(e) => setFormState((s) => ({ ...s, customerLastName: e.target.value }))}
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <input
                  placeholder="VIN"
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                  value={formState.vin}
                  onChange={(e) => setFormState((s) => ({ ...s, vin: e.target.value }))}
                />
                <input
                  placeholder="Year"
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                  value={formState.vehicleYear}
                  onChange={(e) => setFormState((s) => ({ ...s, vehicleYear: e.target.value }))}
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <input
                  placeholder="Make"
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                  value={formState.vehicleMake}
                  onChange={(e) => setFormState((s) => ({ ...s, vehicleMake: e.target.value }))}
                />
                <input
                  placeholder="Model"
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                  value={formState.vehicleModel}
                  onChange={(e) => setFormState((s) => ({ ...s, vehicleModel: e.target.value }))}
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <input
                  type="date"
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                  value={formState.scheduledDate}
                  onChange={(e) => setFormState((s) => ({ ...s, scheduledDate: e.target.value }))}
                />
                <input
                  type="time"
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                  value={formState.scheduledTime}
                  onChange={(e) => setFormState((s) => ({ ...s, scheduledTime: e.target.value }))}
                />
              </div>

              <div className="grid grid-cols-3 gap-2">
                <input
                  placeholder="Labor $"
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                  value={formState.laborCost}
                  onChange={(e) => setFormState((s) => ({ ...s, laborCost: e.target.value }))}
                />
                <input
                  placeholder="Parts $"
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                  value={formState.partsCost}
                  onChange={(e) => setFormState((s) => ({ ...s, partsCost: e.target.value }))}
                />
                <input
                  placeholder="Labor min"
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                  value={formState.estimatedLaborMinutes}
                  onChange={(e) =>
                    setFormState((s) => ({ ...s, estimatedLaborMinutes: e.target.value }))
                  }
                />
              </div>

              <div>
                <p className="text-xs font-medium text-gray-600 mb-1">Assign mechanic (optional)</p>
                <select
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
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
              </div>

              <div>
                <p className="text-xs font-medium text-gray-600 mb-1">Services</p>
                <div className="max-h-32 overflow-y-auto border border-gray-200 rounded-md p-2 space-y-1">
                  {services.length === 0 ? (
                    <p className="text-xs text-gray-500">No offered services configured for this shop.</p>
                  ) : (
                    services.map((service) => {
                      const id = String(service._id);
                      return (
                        <label key={id} className="flex items-center gap-2 text-sm text-gray-700">
                          <input
                            type="checkbox"
                            checked={!!selectedServices[id]}
                            onChange={(e) =>
                              setSelectedServices((prev) => ({ ...prev, [id]: e.target.checked }))
                            }
                          />
                          <span>{service.name}</span>
                        </label>
                      );
                    })
                  )}
                </div>
              </div>

              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full bg-blue-600 text-white rounded-md py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-60"
              >
                {isSubmitting ? "Creating..." : "Create Job"}
              </button>
              {actionError && <p className="text-xs text-red-600">{actionError}</p>}
            </form>
          </div>

          <div className="xl:col-span-2 space-y-4">
            <div className="bg-white rounded-xl border border-gray-200 p-4">
              <div className="flex items-center justify-between mb-3">
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

              <div className="space-y-2 max-h-80 overflow-y-auto">
                {jobs === undefined ? (
                  <p className="text-sm text-gray-500">Loading jobs...</p>
                ) : jobs.length === 0 ? (
                  <p className="text-sm text-gray-500">No jobs match this filter.</p>
                ) : (
                  jobs.map((job) => (
                    <button
                      key={String(job._id)}
                      onClick={() => setSelectedJobId(job._id)}
                      className={`w-full text-left border rounded-lg px-3 py-2 transition-colors ${
                        selectedJobId === job._id
                          ? "border-blue-500 bg-blue-50"
                          : "border-gray-200 hover:bg-gray-50"
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <p className="text-sm font-medium text-gray-900">
                          {job.customerName} - {job.vehicle}
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
                        {job.scheduledDate} at {job.scheduledTime} - {job.serviceNames.join(", ")}
                      </p>
                    </button>
                  ))
                )}
              </div>
            </div>

            <div className="bg-white rounded-xl border border-gray-200 p-4 min-h-56">
              <h2 className="text-lg font-semibold text-gray-900 mb-3">Job Detail</h2>
              {!selectedJobId ? (
                <p className="text-sm text-gray-500">Select a job to view details and actions.</p>
              ) : selectedJob === undefined ? (
                <p className="text-sm text-gray-500">Loading details...</p>
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
                        className="border border-gray-300 rounded-md px-3 py-2 text-sm min-w-56"
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
                            {" -> "}
                            <span className="font-medium">{h.new_status}</span>
                            {h.reason ? ` (${h.reason})` : ""}
                          </p>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
