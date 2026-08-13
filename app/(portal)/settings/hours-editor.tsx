"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Loader2, Clock } from "lucide-react";
import TimePicker from "@/components/ui/time-picker";
import { useRegisterSaveable } from "@/components/settings/save-manager";

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

  const dirty = !!serverHours && JSON.stringify(rows) !== JSON.stringify(serverHours);

  const save = useCallback(async () => {
    const invalid = rows.find(
      (r) => !r.isClosed && (!r.openTime || !r.closeTime || r.openTime >= r.closeTime),
    );
    if (invalid) {
      throw new Error(`Set a valid opening range for ${invalid.dayName}.`);
    }
    await updateHours({ hours: rows });
  }, [rows, updateHours]);

  const reset = useCallback(() => {
    setRows(serverHours ?? defaultHours());
  }, [serverHours]);

  useRegisterSaveable("hours", "Hours", dirty, save, reset);

  if (data === undefined) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading hours…
      </div>
    );
  }

  if (!data?.shop) return null;

  return (
    <div className="rounded-xl border border-border bg-card p-6 shadow-sm sm:p-8">
      <div className="mb-2">
        <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
          <Clock className="w-4 h-4" /> Operating Hours
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Set open and close times for each day, or mark a day closed.
        </p>
      </div>

      <div className="mt-4 divide-y divide-border border-t border-border">
        {rows.map((row, index) => (
          <div
            key={row.dayOfWeek}
            className="grid items-end gap-3 py-4 md:grid-cols-[140px_1fr_1fr_120px]"
          >
            <div className="md:pb-2.5">
              <p className="text-sm font-semibold text-foreground">{row.dayName}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {row.isClosed ? "Closed" : "Open"}
              </p>
            </div>
            <div className={row.isClosed ? "opacity-50 transition-opacity" : "transition-opacity"}>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Open</label>
              <TimePicker
                value={row.openTime}
                disabled={row.isClosed}
                ariaLabel={`${row.dayName} opening time`}
                onChange={(next) =>
                  setRows((prev) =>
                    prev.map((r, i) => (i === index ? { ...r, openTime: next } : r))
                  )
                }
              />
            </div>
            <div className={row.isClosed ? "opacity-50 transition-opacity" : "transition-opacity"}>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Close</label>
              <TimePicker
                value={row.closeTime}
                disabled={row.isClosed}
                ariaLabel={`${row.dayName} closing time`}
                onChange={(next) =>
                  setRows((prev) =>
                    prev.map((r, i) => (i === index ? { ...r, closeTime: next } : r))
                  )
                }
              />
            </div>
            <label className="flex items-center gap-2 text-sm text-foreground md:justify-end md:pb-2.5">
              <input
                type="checkbox"
                checked={row.isClosed}
                onChange={(e) =>
                  setRows((prev) =>
                    prev.map((r, i) => (i === index ? { ...r, isClosed: e.target.checked } : r))
                  )
                }
                className="h-4 w-4 rounded border-input text-primary focus:ring-ring"
              />
              Closed
            </label>
          </div>
        ))}
      </div>
    </div>
  );
}
