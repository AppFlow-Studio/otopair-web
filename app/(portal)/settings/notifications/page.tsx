"use client";

import Link from "next/link";
import { Bell, ArrowLeft } from "lucide-react";

export default function NotificationSettingsPage() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <Link
        href="/settings"
        className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to settings
      </Link>

      <h1 className="mt-4 text-2xl font-semibold text-gray-900">
        Notification preferences
      </h1>
      <p className="mt-1 text-sm text-gray-500">
        Choose which alerts appear in your notification bell.
      </p>

      <div className="mt-6 rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gray-100">
            <Bell className="h-5 w-5 text-gray-500" />
          </div>
          <div>
            <p className="text-sm font-medium text-gray-900">Coming soon</p>
            <p className="mt-1 text-sm text-gray-500">
              Per-channel toggles (in-app, email, push) and per-category
              controls will live here. For now, every shop staff member sees
              all booking confirmations and quote requests in the bell.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
