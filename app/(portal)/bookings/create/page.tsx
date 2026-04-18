"use client";

import { FormEvent, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  X,
  User,
  Car,
  Calendar,
  Wrench,
  DollarSign,
  Clock,
  UserCheck,
} from "lucide-react";

function toNumber(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export default function CreateBookingPage() {
  const router = useRouter();
  const context = useQuery(api.bookings.getMyShopJobContext);
  const createBooking = useMutation(api.bookings.create);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [actionError, setActionError] = useState("");
  const [assigningMechanicId, setAssigningMechanicId] = useState("");
  const [selectedServices, setSelectedServices] = useState<Record<string, boolean>>({});
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
  const selectedMechanic = mechanics.find((m) => String(m._id) === assigningMechanicId);
  const selectedServiceNames = services
    .filter((s) => selectedServices[String(s._id)])
    .map((s) => s.name);
  const totalCost = toNumber(formState.laborCost) + toNumber(formState.partsCost);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!context?.shopId) return;

    setActionError("");
    if (selectedServiceIds.length === 0) {
      setActionError("Select at least one service.");
      return;
    }
    if (
      !formState.customerEmail ||
      !formState.vin ||
      !formState.scheduledDate ||
      !formState.scheduledTime
    ) {
      setActionError("Customer email, VIN, date, and time are required.");
      return;
    }

    try {
      setIsSubmitting(true);
      await createBooking({
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
      router.push("/bookings");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to create booking.";
      setActionError(message);
      setIsSubmitting(false);
    }
  }

  return (
    /* Pull out of the portal's p-6 padding so we can go edge-to-edge */
    <div className="min-h-screen bg-gray-50 -m-6">
      {/* ── Top bar ─────────────────────────────────────────────────── */}
      <div className="sticky top-0 z-20 flex items-center justify-between px-6 py-3 bg-white border-b border-gray-200">
        <Link
          href="/bookings"
          className="flex items-center justify-center w-8 h-8 rounded-full hover:bg-gray-100 transition-colors"
        >
          <X className="w-5 h-5 text-gray-600" />
        </Link>
        <h1 className="text-base font-semibold text-gray-900">New Booking</h1>
        <button
          form="create-job-form"
          type="submit"
          disabled={isSubmitting || !context}
          className="px-4 py-1.5 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-700 disabled:opacity-60 transition-colors"
        >
          {isSubmitting ? "Creating…" : "Create"}
        </button>
      </div>

      {/* ── Body ────────────────────────────────────────────────────── */}
      <form id="create-job-form" onSubmit={handleSubmit}>
        <div className="flex min-h-[calc(100vh-53px)]">

          {/* Main content */}
          <div className="flex-1 px-8 py-6 space-y-5 max-w-3xl">

            {/* Customer */}
            <section className="bg-white rounded-xl border border-gray-200 p-6">
              <div className="flex items-center gap-2 mb-4">
                <User className="w-4 h-4 text-gray-400" />
                <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Customer</h2>
              </div>
              <div className="space-y-3">
                <input
                  placeholder="Customer email *"
                  type="email"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  value={formState.customerEmail}
                  onChange={(e) => setFormState((s) => ({ ...s, customerEmail: e.target.value }))}
                />
                <div className="grid grid-cols-2 gap-3">
                  <input
                    placeholder="First name"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    value={formState.customerFirstName}
                    onChange={(e) => setFormState((s) => ({ ...s, customerFirstName: e.target.value }))}
                  />
                  <input
                    placeholder="Last name"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    value={formState.customerLastName}
                    onChange={(e) => setFormState((s) => ({ ...s, customerLastName: e.target.value }))}
                  />
                </div>
              </div>
            </section>

            {/* Vehicle */}
            <section className="bg-white rounded-xl border border-gray-200 p-6">
              <div className="flex items-center gap-2 mb-4">
                <Car className="w-4 h-4 text-gray-400" />
                <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Vehicle</h2>
              </div>
              <div className="space-y-3">
                <input
                  placeholder="VIN *"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  value={formState.vin}
                  onChange={(e) => setFormState((s) => ({ ...s, vin: e.target.value }))}
                />
                <div className="grid grid-cols-3 gap-3">
                  <input
                    placeholder="Year"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    value={formState.vehicleYear}
                    onChange={(e) => setFormState((s) => ({ ...s, vehicleYear: e.target.value }))}
                  />
                  <input
                    placeholder="Make"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    value={formState.vehicleMake}
                    onChange={(e) => setFormState((s) => ({ ...s, vehicleMake: e.target.value }))}
                  />
                  <input
                    placeholder="Model"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    value={formState.vehicleModel}
                    onChange={(e) => setFormState((s) => ({ ...s, vehicleModel: e.target.value }))}
                  />
                </div>
              </div>
            </section>

            {/* Schedule */}
            <section className="bg-white rounded-xl border border-gray-200 p-6">
              <div className="flex items-center gap-2 mb-4">
                <Calendar className="w-4 h-4 text-gray-400" />
                <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Schedule</h2>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-gray-500 mb-1.5">Service date *</label>
                  <input
                    type="date"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    value={formState.scheduledDate}
                    onChange={(e) => setFormState((s) => ({ ...s, scheduledDate: e.target.value }))}
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1.5">Time *</label>
                  <input
                    type="time"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    value={formState.scheduledTime}
                    onChange={(e) => setFormState((s) => ({ ...s, scheduledTime: e.target.value }))}
                  />
                </div>
              </div>
            </section>

            {/* Services — like Square's "Line items" */}
            <section className="bg-white rounded-xl border border-gray-200 p-6">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <Wrench className="w-4 h-4 text-gray-400" />
                  <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Services</h2>
                </div>
                {selectedServiceNames.length > 0 && (
                  <span className="text-xs font-medium text-blue-600">
                    {selectedServiceNames.length} selected
                  </span>
                )}
              </div>
              {context === undefined ? (
                <p className="text-sm text-gray-400">Loading services…</p>
              ) : services.length === 0 ? (
                <p className="text-sm text-gray-500">No services configured for this shop.</p>
              ) : (
                <div className="divide-y divide-gray-100">
                  {services.map((service) => {
                    const id = String(service._id);
                    const checked = !!selectedServices[id];
                    return (
                      <label
                        key={id}
                        className="flex items-center gap-3 py-3 cursor-pointer group"
                      >
                        <div
                          className={`w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
                            checked
                              ? "bg-blue-600 border-blue-600"
                              : "border-gray-300 group-hover:border-gray-400"
                          }`}
                        >
                          {checked && (
                            <svg className="w-3 h-3 text-white" viewBox="0 0 12 12" fill="none">
                              <path
                                d="M2 6l3 3 5-5"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                          )}
                        </div>
                        <span className={`text-sm font-medium ${checked ? "text-blue-700" : "text-gray-700"}`}>
                          {service.name}
                        </span>
                        <input
                          type="checkbox"
                          className="sr-only"
                          checked={checked}
                          onChange={(e) =>
                            setSelectedServices((prev) => ({ ...prev, [id]: e.target.checked }))
                          }
                        />
                      </label>
                    );
                  })}
                </div>
              )}
            </section>

            {actionError && (
              <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3">
                <p className="text-sm text-red-600">{actionError}</p>
              </div>
            )}
          </div>

          {/* ── Right panel — "Booking at a glance" ─────────────────────── */}
          <div className="w-72 shrink-0 border-l border-gray-200 bg-white px-6 py-6 space-y-6">
            <h3 className="text-base font-semibold text-gray-900">Booking at a glance</h3>

            {/* Mechanic */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <UserCheck className="w-4 h-4 text-gray-400" />
                <span className="text-sm font-medium text-gray-700">Assigned mechanic</span>
              </div>
              <select
                className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white"
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
              {selectedMechanic && (
                <p className="text-xs text-blue-600">{selectedMechanic.name} will be assigned</p>
              )}
            </div>

            {/* Costs */}
            <div className="border-t border-gray-100 pt-5 space-y-3">
              <div className="flex items-center gap-2">
                <DollarSign className="w-4 h-4 text-gray-400" />
                <span className="text-sm font-medium text-gray-700">Costs</span>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Labor ($)</label>
                <input
                  placeholder="0.00"
                  type="number"
                  min="0"
                  step="0.01"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  value={formState.laborCost}
                  onChange={(e) => setFormState((s) => ({ ...s, laborCost: e.target.value }))}
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Parts ($)</label>
                <input
                  placeholder="0.00"
                  type="number"
                  min="0"
                  step="0.01"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  value={formState.partsCost}
                  onChange={(e) => setFormState((s) => ({ ...s, partsCost: e.target.value }))}
                />
              </div>
              {totalCost > 0 && (
                <div className="flex items-center justify-between pt-2 border-t border-gray-100">
                  <span className="text-sm text-gray-600">Total</span>
                  <span className="text-sm font-semibold text-gray-900">${totalCost.toFixed(2)}</span>
                </div>
              )}
            </div>

            {/* Estimated time */}
            <div className="border-t border-gray-100 pt-5 space-y-2">
              <div className="flex items-center gap-2">
                <Clock className="w-4 h-4 text-gray-400" />
                <span className="text-sm font-medium text-gray-700">Estimated time</span>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Labor (minutes)</label>
                <input
                  placeholder="e.g. 90"
                  type="number"
                  min="0"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  value={formState.estimatedLaborMinutes}
                  onChange={(e) =>
                    setFormState((s) => ({ ...s, estimatedLaborMinutes: e.target.value }))
                  }
                />
              </div>
            </div>

            {/* Live summary */}
            {(selectedServiceNames.length > 0 || formState.scheduledDate) && (
              <div className="border-t border-gray-100 pt-5 space-y-3">
                <span className="text-sm font-medium text-gray-700">Summary</span>
                {formState.scheduledDate && (
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-500">Date</span>
                    <span className="text-gray-900">{formState.scheduledDate}</span>
                  </div>
                )}
                {formState.scheduledTime && (
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-500">Time</span>
                    <span className="text-gray-900">{formState.scheduledTime}</span>
                  </div>
                )}
                {selectedServiceNames.length > 0 && (
                  <div className="flex justify-between gap-2 text-sm">
                    <span className="text-gray-500 shrink-0">Services</span>
                    <span className="text-gray-900 text-right">{selectedServiceNames.join(", ")}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </form>
    </div>
  );
}
