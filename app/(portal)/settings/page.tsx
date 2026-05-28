"use client";

import { useClerk, useUser } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { LogOut, MapPin, Phone, Globe, Mail, ExternalLink, Loader2, Save, DollarSign, AlertTriangle, X } from "lucide-react";
import {
  DEFAULT_NO_SHOW_THRESHOLD_MINUTES,
  DEFAULT_OVERRUN_EXTENSION_FLOOR_MINUTES,
  DEFAULT_OVERRUN_EXTENSION_PERCENT,
} from "@/lib/scheduling-overhaul";
import HoursEditor from "./hours-editor";
import ServicesEditor from "./services-editor";
import DevTestTools from "./dev-test-tools";

export default function SettingsPage() {
  const { signOut } = useClerk();
  const { user } = useUser();
  const router = useRouter();
  const shops = useQuery(api.shops.getMyShops);
  const updateSchedulingSettings = useMutation(api.shops.updateMySchedulingSettings);
  const updateLaborRate = useMutation(api.shops.updateMyLaborRate);
  const shop = shops?.[0] ?? null;
  const currentLaborRate = shop?.labor_rate ?? null;
  const [laborRateInput, setLaborRateInput] = useState("");
  const [laborRateMessage, setLaborRateMessage] = useState("");
  const [isLaborConfirmOpen, setIsLaborConfirmOpen] = useState(false);
  const [isSavingLaborRate, setIsSavingLaborRate] = useState(false);
  const [noShowThreshold, setNoShowThreshold] = useState(DEFAULT_NO_SHOW_THRESHOLD_MINUTES);
  const [overrunPercent, setOverrunPercent] = useState(DEFAULT_OVERRUN_EXTENSION_PERCENT);
  const [overrunFloor, setOverrunFloor] = useState(DEFAULT_OVERRUN_EXTENSION_FLOOR_MINUTES);
  const [bufferMinutes, setBufferMinutes] = useState(10);
  const [maxPerMechanic, setMaxPerMechanic] = useState(2);
  const [entityLabelMode, setEntityLabelMode] = useState<"mechanic" | "bay">("mechanic");
  const [reminderLeadMinutes, setReminderLeadMinutes] = useState(0);
  const [settingsMessage, setSettingsMessage] = useState("");
  const [isSavingSettings, setIsSavingSettings] = useState(false);

  useEffect(() => {
    if (!shop) return;
    setNoShowThreshold(shop.no_show_threshold_minutes ?? DEFAULT_NO_SHOW_THRESHOLD_MINUTES);
    setOverrunPercent(shop.overrun_default_extension_percent ?? DEFAULT_OVERRUN_EXTENSION_PERCENT);
    setOverrunFloor(shop.overrun_extension_floor_minutes ?? DEFAULT_OVERRUN_EXTENSION_FLOOR_MINUTES);
    setBufferMinutes(shop.buffer_minutes ?? 10);
    setMaxPerMechanic(shop.max_bookings_per_mechanic_rolling_hour ?? 2);
    setEntityLabelMode(shop.entity_label_mode === "bay" ? "bay" : "mechanic");
    setReminderLeadMinutes(
      Number(shop.appointment_reminder_lead_minutes ?? 0),
    );
    setLaborRateInput(String(shop.labor_rate ?? 150));
  }, [shop]);

  const parsedNewLaborRate = Number(laborRateInput);
  const isLaborRateValid =
    Number.isFinite(parsedNewLaborRate) &&
    parsedNewLaborRate > 0 &&
    parsedNewLaborRate <= 1000;
  const isLaborRateChanged =
    isLaborRateValid &&
    currentLaborRate != null &&
    Math.abs(parsedNewLaborRate - currentLaborRate) > 0.001;

  async function handleConfirmLaborRate() {
    if (!isLaborRateValid) return;
    setIsSavingLaborRate(true);
    setLaborRateMessage("");
    try {
      await updateLaborRate({ laborRate: parsedNewLaborRate });
      setLaborRateMessage(`Labor rate updated to $${parsedNewLaborRate.toFixed(2)}/hr.`);
      setIsLaborConfirmOpen(false);
    } catch (error: unknown) {
      setLaborRateMessage(
        error instanceof Error ? error.message : "Could not update labor rate.",
      );
    } finally {
      setIsSavingLaborRate(false);
    }
  }

  async function handleSignOut() {
    await signOut();
    router.push("/");
  }

  async function handleSaveSchedulingSettings() {
    setIsSavingSettings(true);
    setSettingsMessage("");
    try {
      await updateSchedulingSettings({
        noShowThresholdMinutes: noShowThreshold,
        overrunDefaultExtensionPercent: overrunPercent,
        overrunExtensionFloorMinutes: overrunFloor,
        bufferMinutes,
        maxBookingsPerMechanicRollingHour: maxPerMechanic,
        entityLabelMode,
        appointmentReminderLeadMinutes: reminderLeadMinutes,
      });
      setSettingsMessage("Scheduling settings saved.");
    } catch (error: unknown) {
      setSettingsMessage(
        error instanceof Error ? error.message : "Could not save scheduling settings.",
      );
    } finally {
      setIsSavingSettings(false);
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 mb-2">Settings</h1>
      <p className="text-gray-600 mb-8">
        Manage your account and shop settings.
      </p>

      <div className="space-y-6">
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="text-sm font-semibold text-gray-900 mb-4 uppercase tracking-wide">
            Shop Info
          </h2>

          {shops === undefined ? (
            <p className="text-gray-400 text-sm">Loading...</p>
          ) : !shop ? (
            <div>
              <h3 className="text-lg font-semibold text-gray-900 mb-2">
                No shop configured yet
              </h3>
              <p className="text-gray-500 mb-6 text-sm">
                Set up your shop to start accepting bookings and managing your team.
              </p>
              <Link
                href="/shop/setup"
                className="inline-flex items-center px-5 py-2.5 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition-colors"
              >
                Set Up Shop
              </Link>
            </div>
          ) : (
            <div className="space-y-6">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="text-xl font-bold text-gray-900 mb-1">{shop.name}</h3>
                  <p className="text-gray-500 text-sm">/{shop.slug}</p>
                </div>
                <span
                  className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ${
                    shop.is_active
                      ? "bg-green-100 text-green-700"
                      : "bg-gray-100 text-gray-500"
                  }`}
                >
                  {shop.is_active ? "Active" : "Inactive"}
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="bg-gray-50 rounded-lg border border-gray-200 p-5">
                  <h4 className="text-sm font-semibold text-gray-900 mb-4 uppercase tracking-wide">
                    Location &amp; Contact
                  </h4>
                  <ul className="space-y-3">
                    <li className="flex items-start gap-3 text-sm text-gray-700">
                      <MapPin className="w-4 h-4 text-gray-400 mt-0.5 shrink-0" />
                      <span>
                        {shop.address}
                        <br />
                        {shop.city}, {shop.state} {shop.zip}
                      </span>
                    </li>
                    <li className="flex items-center gap-3 text-sm text-gray-700">
                      <Phone className="w-4 h-4 text-gray-400 shrink-0" />
                      <span>{shop.phone}</span>
                    </li>
                    {shop.email && (
                      <li className="flex items-center gap-3 text-sm text-gray-700">
                        <Mail className="w-4 h-4 text-gray-400 shrink-0" />
                        <span>{shop.email}</span>
                      </li>
                    )}
                    {shop.website && (
                      <li className="flex items-center gap-3 text-sm">
                        <Globe className="w-4 h-4 text-gray-400 shrink-0" />
                        <a
                          href={shop.website}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-600 hover:underline flex items-center gap-1"
                        >
                          {shop.website}
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      </li>
                    )}
                  </ul>
                </div>

                {shop.description && (
                  <div className="bg-gray-50 rounded-lg border border-gray-200 p-5">
                    <h4 className="text-sm font-semibold text-gray-900 mb-4 uppercase tracking-wide">
                      About
                    </h4>
                    <p className="text-sm text-gray-700 leading-relaxed">
                      {shop.description}
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {shop && <HoursEditor />}
        {shop && <ServicesEditor />}
        {shop ? (
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-sm font-semibold text-gray-900 mb-4 uppercase tracking-wide">
              Labor Rate
            </h2>
            <p className="text-sm text-gray-500 mb-5">
              Hourly rate billed to customers for technician work. Applied to
              every new booking and to the labor portion of invoices.
            </p>
            <div className="flex flex-wrap items-end gap-4">
              <div>
                <span className="text-xs font-medium uppercase tracking-wide text-gray-500">
                  Current
                </span>
                <p className="mt-1 text-2xl font-bold text-gray-900">
                  {currentLaborRate != null
                    ? `$${currentLaborRate.toFixed(2)}/hr`
                    : "Not set"}
                </p>
              </div>
              <label className="block">
                <span className="text-sm font-medium text-gray-700">New rate ($/hr)</span>
                <div className="mt-2 flex items-center gap-2">
                  <div className="relative">
                    <DollarSign className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                    <input
                      type="number"
                      min={1}
                      max={1000}
                      step="0.01"
                      value={laborRateInput}
                      onChange={(event) => setLaborRateInput(event.target.value)}
                      className="w-40 rounded-lg border border-gray-200 bg-white py-2 pl-8 pr-3 text-sm text-gray-900 outline-none transition-colors focus:border-blue-500"
                    />
                  </div>
                </div>
              </label>
              <button
                type="button"
                onClick={() => {
                  setLaborRateMessage("");
                  setIsLaborConfirmOpen(true);
                }}
                disabled={!isLaborRateChanged || isSavingLaborRate}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Save className="h-4 w-4" />
                Update rate
              </button>
              {laborRateMessage ? (
                <p className="w-full text-sm text-gray-600">{laborRateMessage}</p>
              ) : null}
            </div>
          </div>
        ) : null}
        {shop ? (
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-sm font-semibold text-gray-900 mb-4 uppercase tracking-wide">
              Scheduling Automation
            </h2>
            <div className="grid grid-cols-1 gap-5 md:grid-cols-4">
              <label className="block">
                <span className="text-sm font-medium text-gray-700">Buffer after job</span>
                <select
                  value={bufferMinutes}
                  onChange={(event) => setBufferMinutes(Number(event.target.value))}
                  className="mt-2 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none transition-colors focus:border-blue-500"
                >
                  {[10, 15, 20, 30].map((value) => (
                    <option key={value} value={value}>
                      {value} minutes
                    </option>
                  ))}
                </select>
                <span className="mt-1 block text-xs text-gray-500">
                  Time reserved between jobs; next slot rounds up to the 15-minute grid.
                </span>
              </label>
              <label className="block">
                <span className="text-sm font-medium text-gray-700">No-show threshold</span>
                <select
                  value={noShowThreshold}
                  onChange={(event) => setNoShowThreshold(Number(event.target.value))}
                  className="mt-2 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none transition-colors focus:border-blue-500"
                >
                  {[15, 30, 45, 60].map((value) => (
                    <option key={value} value={value}>
                      {value} minutes
                    </option>
                  ))}
                </select>
              </label>

              <label className="block">
                <span className="text-sm font-medium text-gray-700">Default extension</span>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={overrunPercent}
                  onChange={(event) => setOverrunPercent(Number(event.target.value))}
                  className="mt-2 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none transition-colors focus:border-blue-500"
                />
                <span className="mt-1 block text-xs text-gray-500">Percent of estimated job duration</span>
              </label>

              <label className="block">
                <span className="text-sm font-medium text-gray-700">Extension floor</span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={overrunFloor}
                  onChange={(event) => setOverrunFloor(Number(event.target.value))}
                  className="mt-2 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none transition-colors focus:border-blue-500"
                />
                <span className="mt-1 block text-xs text-gray-500">Minimum minutes applied by system default</span>
              </label>

              <label className="block">
                <span className="text-sm font-medium text-gray-700">Max bookings per mechanic / hour</span>
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={maxPerMechanic}
                  onChange={(event) => setMaxPerMechanic(Number(event.target.value))}
                  className="mt-2 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none transition-colors focus:border-blue-500"
                />
                <span className="mt-1 block text-xs text-gray-500">
                  Soft cap on jobs per mechanic in any rolling 60-minute window.
                </span>
              </label>

              <label className="block">
                <span className="text-sm font-medium text-gray-700">Booking entity label</span>
                <select
                  value={entityLabelMode}
                  onChange={(event) =>
                    setEntityLabelMode(event.target.value as "mechanic" | "bay")
                  }
                  className="mt-2 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none transition-colors focus:border-blue-500"
                >
                  <option value="mechanic">Mechanic (John, Mike, Sarah)</option>
                  <option value="bay">Bay (Bay 1, Bay 2, Bay 3)</option>
                </select>
                <span className="mt-1 block text-xs text-gray-500">
                  How customer-visible UI refers to bookable slots.
                </span>
              </label>

              <label className="block">
                <span className="text-sm font-medium text-gray-700">Appointment reminder</span>
                <select
                  value={reminderLeadMinutes}
                  onChange={(event) =>
                    setReminderLeadMinutes(Number(event.target.value))
                  }
                  className="mt-2 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none transition-colors focus:border-blue-500"
                >
                  <option value={0}>Off</option>
                  <option value={60}>1 hour before</option>
                  <option value={120}>2 hours before</option>
                  <option value={1440}>1 day before</option>
                  <option value={2880}>2 days before</option>
                </select>
                <span className="mt-1 block text-xs text-gray-500">
                  Customers receive an SMS + email reminder at this lead time. Sends silently skip if no contact info is on file.
                </span>
              </label>
            </div>
            <div className="mt-5 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => void handleSaveSchedulingSettings()}
                disabled={isSavingSettings}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-60"
              >
                {isSavingSettings ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                Save scheduling
              </button>
              {settingsMessage ? (
                <p className="text-sm text-gray-600">{settingsMessage}</p>
              ) : null}
            </div>
          </div>
        ) : null}

        {shop && process.env.NODE_ENV === "development" && (
          <DevTestTools shopId={shop._id} />
        )}

        <div className="bg-white rounded-xl border border-gray-200">
          <div className="px-6 pt-5 pb-2">
            <p className="text-sm font-medium text-gray-500 mb-1">Signed in as</p>
            <p className="text-sm font-semibold text-gray-900">
              {user?.fullName ?? user?.primaryEmailAddress?.emailAddress ?? "-"}
            </p>
            {user?.primaryEmailAddress && user.fullName && (
              <p className="text-xs text-gray-500 mt-0.5">
                {user.primaryEmailAddress.emailAddress}
              </p>
            )}
          </div>
          <div className="px-6 pt-2 pb-5">
            <button
              onClick={handleSignOut}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg border border-red-200 text-red-600 text-sm font-medium hover:bg-red-50 transition-colors"
            >
              <LogOut className="w-4 h-4" />
              Sign out
            </button>
            <p className="text-xs text-gray-400 mt-2">
              You will be redirected to the home page.
            </p>
          </div>
        </div>

      </div>

      {isLaborConfirmOpen && shop ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="labor-rate-confirm-title"
          className="fixed inset-0 z-[90] flex items-center justify-center px-4 py-6"
        >
          <div
            className="absolute inset-0 bg-black/40"
            onClick={
              isSavingLaborRate ? undefined : () => setIsLaborConfirmOpen(false)
            }
          />
          <div className="relative z-[91] w-full max-w-md overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl">
            <div className="flex items-start justify-between gap-4 border-b border-gray-200 px-6 py-5">
              <div>
                <div className="flex items-center gap-2 text-amber-600">
                  <AlertTriangle className="h-4 w-4" />
                  <span className="text-xs font-semibold uppercase tracking-[0.2em]">
                    Confirm change
                  </span>
                </div>
                <h2
                  id="labor-rate-confirm-title"
                  className="mt-2 text-lg font-semibold text-gray-900"
                >
                  Update your hourly labor rate?
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setIsLaborConfirmOpen(false)}
                disabled={isSavingLaborRate}
                className="rounded-lg p-2 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 disabled:opacity-60"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="px-6 py-5">
              <div className="flex items-center justify-between rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-sm">
                <div>
                  <p className="text-xs uppercase tracking-wide text-gray-500">
                    Current
                  </p>
                  <p className="mt-1 text-lg font-semibold text-gray-900">
                    {currentLaborRate != null
                      ? `$${currentLaborRate.toFixed(2)}/hr`
                      : "Not set"}
                  </p>
                </div>
                <span className="text-gray-400">→</span>
                <div className="text-right">
                  <p className="text-xs uppercase tracking-wide text-gray-500">
                    New
                  </p>
                  <p className="mt-1 text-lg font-semibold text-blue-600">
                    ${parsedNewLaborRate.toFixed(2)}/hr
                  </p>
                </div>
              </div>
              <p className="mt-4 text-sm text-gray-600">
                The new rate applies immediately to <strong>all new bookings</strong>
                {" "}and to the labor calculation on future invoices. Already-confirmed
                bookings keep the rate that was disclosed to the customer.
              </p>
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-gray-200 bg-gray-50 px-6 py-4">
              <button
                type="button"
                onClick={() => setIsLaborConfirmOpen(false)}
                disabled={isSavingLaborRate}
                className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleConfirmLaborRate()}
                disabled={isSavingLaborRate || !isLaborRateValid}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isSavingLaborRate ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                Confirm
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
