"use client";

import { VolumeBars, type VolumePoint } from "./charts";
import {
  Card,
  CardEyebrow,
  ChartTableView,
  EmptyHint,
  Skeleton,
  formatDayLabel,
} from "./shared";
import type { BookingSeriesPoint } from "./types";

/** Booking volume from Convex, split completed vs everything else. */
export function OrderVolumeChart({
  series,
  loading,
}: {
  series: BookingSeriesPoint[] | undefined;
  loading: boolean;
}) {
  const data: VolumePoint[] = (series ?? []).map((p) => ({
    date: p.date,
    completed: p.completed,
    other: Math.max(0, p.total - p.completed),
  }));
  const completedTotal = data.reduce((s, p) => s + p.completed, 0);

  return (
    <Card className="flex flex-col">
      <CardEyebrow>Order volume</CardEyebrow>
      {loading ? (
        <>
          <Skeleton className="mt-2 h-8 w-20" />
          <Skeleton className="mt-6 h-[180px] w-full rounded-xl" />
        </>
      ) : data.length === 0 ? (
        <EmptyHint>No bookings in this range.</EmptyHint>
      ) : (
        <>
          <p className="mt-1 text-3xl font-semibold tracking-tight text-foreground">
            {completedTotal}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">Jobs completed</p>
          <div className="mt-6">
            <VolumeBars data={data} />
          </div>
          <ChartTableView
            caption="Bookings per day, completed versus other"
            columns={["Day", "Completed", "Other"]}
            rows={data.map((p) => [formatDayLabel(p.date), p.completed, p.other])}
          />
        </>
      )}
    </Card>
  );
}
