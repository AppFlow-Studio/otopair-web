"use client";

import { useClerk, useUser } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Clock, LogOut, MapPin, Phone, Globe, Mail, ExternalLink, Loader2, Save, Zap } from "lucide-react";
import {
  DEFAULT_NO_SHOW_THRESHOLD_MINUTES,
  DEFAULT_OVERRUN_AUTO_APPLY_MINUTES,
  DEFAULT_OVERRUN_ESCALATION_MINUTES,
  DEFAULT_OVERRUN_EXTENSION_FLOOR_MINUTES,
  DEFAULT_OVERRUN_EXTENSION_PERCENT,
} from "@/lib/scheduling-overhaul";
import { detectTimezoneFromState, US_TIMEZONES } from "@/lib/shopTimezone";
import HoursEditor from "./hours-editor";
import ShopLogoUploader from "./logo-uploader";
import ServicesEditor from "./services-editor";
import LaborRateCard from "./labor-rate-card";
import DevTestTools from "./dev-test-tools";

export default function SettingsPage() {
  const { signOut } = useClerk();
  const { user } = useUser();
  const router = useRouter();
  const shops = useQuery(api.shops.getMyShops);
  const updateSchedulingSettings = useMutation(api.shops.updateMySchedulingSettings);
  const setShopTimezone = useMutation(api.shops.setShopTimezone);
  const shop = shops?.[0] ?? null;
  const [noShowThreshold, setNoShowThreshold] = useState(DEFAULT_NO_SHOW_THRESHOLD_MINUTES);
  const [overrunPercent, setOverrunPercent] = useState(DEFAULT_OVERRUN_EXTENSION_PERCENT);
  const [overrunFloor, setOverrunFloor] = useState(DEFAULT_OVERRUN_EXTENSION_FLOOR_MINUTES);
  const [overrunEscalationMinutes, setOverrunEscalationMinutes] = useState(DEFAULT_OVERRUN_ESCALATION_MINUTES);
  const [overrunAutoApplyMinutes, setOverrunAutoApplyMinutes] = useState(DEFAULT_OVERRUN_AUTO_APPLY_MINUTES);
  const [bufferMinutes, setBufferMinutes] = useState(10);
  const [maxPerMechanic, setMaxPerMechanic] = useState(2);
  const [entityLabelMode, setEntityLabelMode] = useState<"mechanic" | "bay">("mechanic");
  const [reminderLeadMinutes, setReminderLeadMinutes] = useState(0);
  const [settingsMessage, setSettingsMessage] = useState("");
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [timezone, setTimezone] = useState("");
  const [isSavingTimezone, setIsSavingTimezone] = useState(false);
  const [timezoneMessage, setTimezoneMessage] = useState("");

  useEffect(() => {
    if (!shop) return;
    setTimezone((shop as any).timezone ?? "");
    setNoShowThreshold(shop.no_show_threshold_minutes ?? DEFAULT_NO_SHOW_THRESHOLD_MINUTES);
    setOverrunPercent(shop.overrun_default_extension_percent ?? DEFAULT_OVERRUN_EXTENSION_PERCENT);
    setOverrunFloor(shop.overrun_extension_floor_minutes ?? DEFAULT_OVERRUN_EXTENSION_FLOOR_MINUTES);
    setOverrunEscalationMinutes(shop.overrun_escalation_minutes ?? DEFAULT_OVERRUN_ESCALATION_MINUTES);
    setOverrunAutoApplyMinutes(shop.overrun_auto_apply_minutes ?? DEFAULT_OVERRUN_AUTO_APPLY_MINUTES);
    setBufferMinutes(shop.buffer_minutes ?? 10);
    setMaxPerMechanic(shop.max_bookings_per_mechanic_rolling_hour ?? 2);
    setEntityLabelMode(shop.entity_label_mode === "bay" ? "bay" : "mechanic");
    setReminderLeadMinutes(
      Number(shop.appointment_reminder_lead_minutes ?? 0),
    );
  }, [shop]);

  async function handleSignOut() {
    await signOut();
    router.push("/");
  }

  function handleAutoDetectTimezone() {
    const detected = detectTimezoneFromState((shop as any)?.state);
    if (detected) {
      setTimezone(detected);
      setTimezoneMessage(`Auto-detected from state (${(shop as any)?.state}). Save to apply.`);
    } else {
      setTimezoneMessage("Couldn't auto-detect — please select a timezone manually.");
    }
  }

  async function handleSaveTimezone() {
    if (!timezone) return;
    setIsSavingTimezone(true);
    setTimezoneMessage("");
    try {
      await setShopTimezone({ timezone });
      setTimezoneMessage("Timezone saved.");
    } catch (error: unknown) {
      setTimezoneMessage(error instanceof Error ? error.message : "Could not save timezone.");
    } finally {
      setIsSavingTimezone(false);
    }
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
        overrunEscalationMinutes,
        overrunAutoApplyMinutes,
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
                <div className="flex items-start gap-4">
                  <ShopLogoUploader
                    shopId={(shop as any)._id}
                    logoUrl={(shop as any).logoUrl ?? null}
                    memberRole={(shop as any).memberRole}
                  />
                  <div>
                    <h3 className="text-xl font-bold text-gray-900 mb-1">{shop.name}</h3>
                    <p className="text-gray-500 text-sm">/{shop.slug}</p>
                  </div>
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

        {shop && process.env.NODE_ENV === "development" && (
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <div className="flex items-center gap-2 mb-4">
              <Clock className="h-4 w-4 text-gray-500" />
              <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">
                Shop Timezone
              </h2>
            </div>
            <p className="text-sm text-gray-500 mb-4">
              Used to determine today&apos;s schedule and compute appointment
              times correctly. Should match the physical location of the shop.
            </p>
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-[280px]">
                <label className="block text-sm font-medium text-gray-700 mb-1.5">
                  Timezone
                </label>
                <select
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                  className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none transition-colors focus:border-blue-500"
                >
                  <option value="">— Select timezone —</option>
                  {US_TIMEZONES.map((tz) => (
                    <option key={tz.value} value={tz.value}>
                      {tz.label}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                onClick={handleAutoDetectTimezone}
                className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-3.5 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50"
              >
                <Zap className="h-3.5 w-3.5 text-amber-500" />
                Auto-detect from state
              </button>
              <button
                type="button"
                onClick={() => void handleSaveTimezone()}
                disabled={isSavingTimezone || !timezone}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-60"
              >
                {isSavingTimezone ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
                Save timezone
              </button>
            </div>
            {timezoneMessage && (
              <p className="mt-2 text-sm text-gray-600">{timezoneMessage}</p>
            )}
          </div>
        )}

        {shop && <HoursEditor />}
        {shop && <ServicesEditor />}
        {shop ? <LaborRateCard shopId={shop._id} /> : null}
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
                <span className="text-sm font-medium text-gray-700">Front desk escalation</span>
                <input
                  type="number"
                  min={1}
                  max={30}
                  step={1}
                  value={overrunEscalationMinutes}
                  onChange={(event) => setOverrunEscalationMinutes(Number(event.target.value))}
                  className="mt-2 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none transition-colors focus:border-blue-500"
                />
                <span className="mt-1 block text-xs text-gray-500">
                  Minutes after an overrun before the front desk is alerted.
                </span>
              </label>

              <label className="block">
                <span className="text-sm font-medium text-gray-700">Auto-apply extension</span>
                <input
                  type="number"
                  min={1}
                  max={60}
                  step={1}
                  value={overrunAutoApplyMinutes}
                  onChange={(event) => setOverrunAutoApplyMinutes(Number(event.target.value))}
                  className="mt-2 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none transition-colors focus:border-blue-500"
                />
                <span className="mt-1 block text-xs text-gray-500">
                  Minutes after an overrun before the system auto-applies the default extension. Must be at or after front desk escalation.
                </span>
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
    </div>
  );
}
