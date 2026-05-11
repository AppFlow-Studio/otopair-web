"use client";

import { useClerk, useUser } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { LogOut, MapPin, Phone, Globe, Mail, ExternalLink } from "lucide-react";
import {
  DEFAULT_NO_SHOW_THRESHOLD_MINUTES,
  DEFAULT_OVERRUN_EXTENSION_FLOOR_MINUTES,
  DEFAULT_OVERRUN_EXTENSION_PERCENT,
} from "@/lib/scheduling-overhaul";
import HoursEditor from "./hours-editor";
import ServicesEditor from "./services-editor";

export default function SettingsPage() {
  const { signOut } = useClerk();
  const { user } = useUser();
  const router = useRouter();
  const shops = useQuery(api.shops.getMyShops);
  const updateSchedulingSettings = useMutation(api.shops.updateMySchedulingSettings);
  const shop = shops?.[0] ?? null;
  const [noShowThreshold, setNoShowThreshold] = useState(DEFAULT_NO_SHOW_THRESHOLD_MINUTES);
  const [overrunPercent, setOverrunPercent] = useState(DEFAULT_OVERRUN_EXTENSION_PERCENT);
  const [overrunFloor, setOverrunFloor] = useState(DEFAULT_OVERRUN_EXTENSION_FLOOR_MINUTES);
  const [settingsMessage, setSettingsMessage] = useState("");
  const [isSavingSettings, setIsSavingSettings] = useState(false);

  useEffect(() => {
    if (!shop) return;
    setNoShowThreshold(shop.no_show_threshold_minutes ?? DEFAULT_NO_SHOW_THRESHOLD_MINUTES);
    setOverrunPercent(shop.overrun_default_extension_percent ?? DEFAULT_OVERRUN_EXTENSION_PERCENT);
    setOverrunFloor(shop.overrun_extension_floor_minutes ?? DEFAULT_OVERRUN_EXTENSION_FLOOR_MINUTES);
  }, [shop]);

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

        {shop && (
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-sm font-semibold text-gray-900 mb-4 uppercase tracking-wide">
              Scheduling
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <label className="block">
                <span className="text-sm font-medium text-gray-700">No-show threshold</span>
                <input
                  type="number"
                  min={15}
                  max={60}
                  value={noShowThreshold}
                  onChange={(event) => setNoShowThreshold(Number(event.target.value))}
                  className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-blue-500"
                />
                <span className="mt-1 block text-xs text-gray-500">15-60 minutes</span>
              </label>
              <label className="block">
                <span className="text-sm font-medium text-gray-700">Default extension</span>
                <input
                  type="number"
                  min={0}
                  value={overrunPercent}
                  onChange={(event) => setOverrunPercent(Number(event.target.value))}
                  className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-blue-500"
                />
                <span className="mt-1 block text-xs text-gray-500">Percent of estimate</span>
              </label>
              <label className="block">
                <span className="text-sm font-medium text-gray-700">Extension floor</span>
                <input
                  type="number"
                  min={0}
                  value={overrunFloor}
                  onChange={(event) => setOverrunFloor(Number(event.target.value))}
                  className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-blue-500"
                />
                <span className="mt-1 block text-xs text-gray-500">Minutes</span>
              </label>
            </div>
            <div className="mt-5 flex items-center gap-3">
              <button
                onClick={handleSaveSchedulingSettings}
                disabled={isSavingSettings}
                className="inline-flex items-center px-4 py-2.5 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-60 transition-colors"
              >
                {isSavingSettings ? "Saving..." : "Save scheduling settings"}
              </button>
              {settingsMessage && (
                <p className="text-sm text-gray-600">{settingsMessage}</p>
              )}
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
