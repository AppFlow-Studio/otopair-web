"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Loader2, Clock } from "lucide-react";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

type HoursRow = {
  dayOfWeek: number;
  dayName: string;
  isClosed: boolean;
  openTime: string;
  closeTime: string;
};

function defaultHours(): HoursRow[] {
  return DAY_NAMES.map((dayName, dayOfWeek) => ({
    dayOfWeek,
    dayName,
    isClosed: dayOfWeek === 0,
    openTime: "09:00",
    closeTime: "17:00",
  }));
}

export default function HoursEditor() {
  const data = useQuery(api.shops.getMyOnboardingData);
  const updateHours = useMutation(api.shops.updateShopHours);

  const [rows, setRows] = useState<HoursRow[]>(defaultHours());
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const serverHours = useMemo(() => {
    if (!data?.hours) return null;
    const byDay = new Map(data.hours.map((h) => [h.dayOfWeek, h]));
    return DAY_NAMES.map((dayName, dayOfWeek) => {
      const existing = byDay.get(dayOfWeek);
      return existing
        ? {
            dayOfWeek,
            dayName: existing.dayName || dayName,
            isClosed: existing.isClosed,
            openTime: existing.openTime,
            closeTime: existing.closeTime,
          }
        : { dayOfWeek, dayName, isClosed: dayOfWeek === 0, openTime: "09:00", closeTime: "17:00" };
    });
  }, [data]);

  useEffect(() => {
    if (serverHours) setRows(serverHours);
  }, [serverHours]);

  async function handleSave() {
    setError(null);
    setMessage(null);
    const invalid = rows.find(
      (r) => !r.isClosed && (!r.openTime || !r.closeTime || r.openTime >= r.closeTime)
    );
    if (invalid) {
      setError(`Set a valid opening range for ${invalid.dayName}.`);
      return;
    }
    setSaving(true);
    try {
      await updateHours({ hours: rows });
      setMessage("Hours saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save your hours. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  if (data === undefined) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-500">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading hours…
      </div>
    );
  }

  if (!data?.shop) return null;

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide flex items-center gap-2">
          <Clock className="w-4 h-4" /> Operating Hours
        </h2>
      </div>

      <div className="space-y-3">
        {rows.map((row, index) => (
          <div
            key={row.dayOfWeek}
            className="grid gap-3 rounded-lg border border-gray-200 p-3 md:grid-cols-[140px_1fr_1fr_120px] items-end"
          >
            <div>
              <p className="text-sm font-semibold text-gray-900">{row.dayName}</p>
              <p className="mt-0.5 text-xs text-gray-500">
                {row.isClosed ? "Closed" : "Open"}
              </p>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Open</label>
              <input
                type="time"
                value={row.openTime}
                disabled={row.isClosed}
                onChange={(e) =>
                  setRows((prev) =>
                    prev.map((r, i) => (i === index ? { ...r, openTime: e.target.value } : r))
                  )
                }
                className="w-full rounded-md border border-gray-300 px-2.5 py-1.5 text-sm disabled:bg-gray-100 disabled:text-gray-400"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Close</label>
              <input
                type="time"
                value={row.closeTime}
                disabled={row.isClosed}
                onChange={(e) =>
                  setRows((prev) =>
                    prev.map((r, i) => (i === index ? { ...r, closeTime: e.target.value } : r))
                  )
                }
                className="w-full rounded-md border border-gray-300 px-2.5 py-1.5 text-sm disabled:bg-gray-100 disabled:text-gray-400"
              />
            </div>
            <label className="flex items-center justify-between gap-2 rounded-md border border-gray-200 px-3 py-2 text-sm">
              Closed
              <input
                type="checkbox"
                checked={row.isClosed}
                onChange={(e) =>
                  setRows((prev) =>
                    prev.map((r, i) => (i === index ? { ...r, isClosed: e.target.checked } : r))
                  )
                }
                className="h-4 w-4 rounded text-blue-600"
              />
            </label>
          </div>
        ))}
      </div>

      <div className="mt-5 flex items-center justify-between gap-3">
        <div className="text-xs">
          {error && <span className="text-red-600">{error}</span>}
          {message && <span className="text-green-600">{message}</span>}
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition-colors disabled:opacity-50"
        >
          {saving && <Loader2 className="w-4 h-4 animate-spin" />}
          Save Hours
        </button>
      </div>
    </div>
  );
}
