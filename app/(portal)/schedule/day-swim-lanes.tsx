"use client";

import { useCallback, useMemo, useRef, useState } from "react";

/* ------------------------------------------------------------------ */
/*  Types                                                               */
/* ------------------------------------------------------------------ */

interface CalendarEvent {
  id: string;
  title: string;
  start: Date;
  end: Date;
  resourceId?: string;
  type: "booking" | "blocked";
  status?: string;
  customerName?: string;
  mechanicName?: string | null;
  serviceNames?: string[];
  totalCost?: number;
}

interface Mechanic {
  _id: string;
  name: string;
}

export interface RescheduleProposal {
  eventId: string;
  originalDate: string;
  originalTime: string;
  originalMechanicId: string | undefined;
  originalMechanicName: string | undefined;
  newDate: string;
  newTime: string;
  newMechanicId: string | undefined;
  newMechanicName: string | undefined;
  timeChanged: boolean;
  mechanicChanged: boolean;
}

interface DaySwimLanesProps {
  mechanics: Mechanic[];
  events: CalendarEvent[];
  minTime: Date; // Date with hours/minutes set for start of day
  maxTime: Date; // Date with hours/minutes set for end of day
  onSelectEvent: (event: CalendarEvent) => void;
  onProposeReschedule?: (proposal: RescheduleProposal) => void;
  currentDate?: Date;
}

/* ------------------------------------------------------------------ */
/*  Status colors (duplicated to keep component self-contained)         */
/* ------------------------------------------------------------------ */

const statusColors: Record<string, { bg: string; text: string; border: string }> = {
  pending_shop_acceptance:      { bg: "rgb(255 251 235)", text: "rgb(217 119 6)", border: "rgb(252 211 77)" },
  pending:                      { bg: "rgb(255 251 235)", text: "rgb(217 119 6)", border: "rgb(252 211 77)" },
  pending_customer_acceptance:  { bg: "rgb(243 232 255)", text: "rgb(147 51 234)", border: "rgb(192 132 252)" },
  confirmed:                    { bg: "rgb(224 231 255)", text: "rgb(99 102 241)", border: "rgb(165 180 252)" },
  in_progress:                  { bg: "rgb(236 253 245)", text: "rgb(5 150 105)", border: "rgb(110 231 183)" },
  completed:                    { bg: "rgb(243 244 246)", text: "rgb(107 114 128)", border: "rgb(209 213 219)" },
  blocked:                      { bg: "rgb(254 242 242)", text: "rgb(239 68 68)", border: "rgb(252 165 165)" },
};

const DRAGGABLE_STATUSES = new Set([
  "pending_shop_acceptance",
  "pending",
  "confirmed",
  "pending_customer_acceptance",
]);

/* ------------------------------------------------------------------ */
/*  Constants                                                           */
/* ------------------------------------------------------------------ */

const GUTTER_WIDTH = 70;        // px — left time-label gutter
const ROW_HEIGHT = 48;          // px per 30-minute slot
const STEP_MINUTES = 30;

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

function formatGutterLabel(hour: number, minute: number): string {
  const ampm = hour >= 12 ? "PM" : "AM";
  const h = hour % 12 || 12;
  if (minute === 0) return `${h} ${ampm}`;
  return `${h}:${String(minute).padStart(2, "0")} ${ampm}`;
}

/** Minutes elapsed from `base` hour/min to given hour/min. */
function minutesFromBase(baseH: number, baseM: number, h: number, m: number): number {
  return (h - baseH) * 60 + (m - baseM);
}

function formatHHMM(h: number, m: number): string {
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function formatTimeLabel(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const hour = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, "0")} ${ampm}`;
}

function dateToString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/* ------------------------------------------------------------------ */
/*  Component                                                           */
/* ------------------------------------------------------------------ */

export default function DaySwimLanes({
  mechanics,
  events,
  minTime,
  maxTime,
  onSelectEvent,
  onProposeReschedule,
  currentDate,
}: DaySwimLanesProps) {
  const startHour = minTime.getHours();
  const startMinute = minTime.getMinutes();
  const endHour = maxTime.getHours();
  const endMinute = maxTime.getMinutes();

  // Drag state
  const [dragEventId, setDragEventId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ colId: string; slotIndex: number } | null>(null);
  const dragDataRef = useRef<{
    eventId: string;
    originalColId: string;
    originalTime: string;
    originalDate: string;
    originalMechanicName: string | undefined;
  } | null>(null);

  // Build time slots (30-min increments)
  const slots = useMemo(() => {
    const result: Array<{ hour: number; minute: number }> = [];
    let h = startHour;
    let m = startMinute;
    while (h < endHour || (h === endHour && m < endMinute)) {
      result.push({ hour: h, minute: m });
      m += STEP_MINUTES;
      if (m >= 60) { h += 1; m -= 60; }
    }
    return result;
  }, [startHour, startMinute, endHour, endMinute]);

  const totalMinutes = minutesFromBase(startHour, startMinute, endHour, endMinute);
  const totalHeight = (totalMinutes / STEP_MINUTES) * ROW_HEIGHT;

  // Build columns: if mechanic filter already applied, just use what we get.
  // Determine if any events lack a mechanic → need "Unassigned" column.
  const hasUnassigned = events.some((e) => !e.resourceId);

  const columns: Array<{ id: string; label: string }> = useMemo(() => {
    const cols = mechanics.map((m) => ({
      id: m._id,
      label: m.name,
    }));
    if (hasUnassigned) {
      cols.push({ id: "__unassigned__", label: "Unassigned" });
    }
    return cols;
  }, [mechanics, hasUnassigned]);

  // Group events by column
  const eventsByColumn = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const col of columns) map.set(col.id, []);
    for (const ev of events) {
      const colId = ev.resourceId || "__unassigned__";
      const list = map.get(colId);
      if (list) list.push(ev);
    }
    return map;
  }, [columns, events]);

  // Current time indicator position
  const now = new Date();
  const nowMinutes = minutesFromBase(startHour, startMinute, now.getHours(), now.getMinutes());
  const showNowLine = nowMinutes >= 0 && nowMinutes <= totalMinutes;
  const nowTop = (nowMinutes / totalMinutes) * totalHeight;

  // Drag handlers
  const handleDragStart = useCallback((e: React.DragEvent, ev: CalendarEvent, colId: string) => {
    if (!DRAGGABLE_STATUSES.has(ev.status ?? "")) {
      e.preventDefault();
      return;
    }
    const time = formatHHMM(ev.start.getHours(), ev.start.getMinutes());
    const date = currentDate ? dateToString(currentDate) : dateToString(ev.start);
    const mechanic = mechanics.find((m) => m._id === (ev.resourceId || ""));

    dragDataRef.current = {
      eventId: ev.id,
      originalColId: colId,
      originalTime: time,
      originalDate: date,
      originalMechanicName: mechanic?.name,
    };
    setDragEventId(ev.id);

    // Set drag image to the element
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", ev.id);
  }, [currentDate, mechanics]);

  const handleDragOver = useCallback((e: React.DragEvent, colId: string, slotIndex: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropTarget({ colId, slotIndex });
  }, []);

  const handleDragLeave = useCallback(() => {
    // Only clear if we leave the grid entirely — handled by container onDragLeave
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, colId: string, slotIndex: number) => {
    e.preventDefault();
    setDragEventId(null);
    setDropTarget(null);

    const data = dragDataRef.current;
    if (!data || !onProposeReschedule) return;

    const slot = slots[slotIndex];
    if (!slot) return;

    const newTime = formatHHMM(slot.hour, slot.minute);
    const newMechanicId = colId === "__unassigned__" ? undefined : colId;
    const originalMechanicId = data.originalColId === "__unassigned__" ? undefined : data.originalColId;

    const timeChanged = newTime !== data.originalTime;
    const mechanicChanged = newMechanicId !== originalMechanicId;

    if (!timeChanged && !mechanicChanged) return;

    const newMechanic = mechanics.find((m) => m._id === newMechanicId);

    onProposeReschedule({
      eventId: data.eventId,
      originalDate: data.originalDate,
      originalTime: data.originalTime,
      originalMechanicId,
      originalMechanicName: data.originalMechanicName,
      newDate: data.originalDate, // same day — drag is within day view
      newTime,
      newMechanicId,
      newMechanicName: newMechanic?.name,
      timeChanged,
      mechanicChanged,
    });

    dragDataRef.current = null;
  }, [slots, mechanics, onProposeReschedule]);

  const handleDragEnd = useCallback(() => {
    setDragEventId(null);
    setDropTarget(null);
    dragDataRef.current = null;
  }, []);

  const handleContainerDragLeave = useCallback((e: React.DragEvent) => {
    // Only clear drop target if we leave the container
    const container = e.currentTarget as HTMLElement;
    const related = e.relatedTarget as HTMLElement | null;
    if (!related || !container.contains(related)) {
      setDropTarget(null);
    }
  }, []);

  return (
    <div
      className="overflow-auto"
      style={{ height: "calc(100vh - 320px)", minHeight: 500 }}
      onDragLeave={handleContainerDragLeave}
    >
      <div className="flex" style={{ minWidth: GUTTER_WIDTH + columns.length * 150 }}>
        {/* Time gutter */}
        <div className="shrink-0" style={{ width: GUTTER_WIDTH }}>
          {/* Spacer for header row */}
          <div className="h-9 border-b border-border" />
          {/* Time labels */}
          <div className="relative" style={{ height: totalHeight }}>
            {slots.map((s, i) => (
              <div
                key={i}
                className="absolute right-0 pr-2 text-xs text-muted-foreground"
                style={{
                  top: i * ROW_HEIGHT - 7, // offset to center label on the gridline
                  width: GUTTER_WIDTH,
                  textAlign: "right",
                }}
              >
                {s.minute === 0 ? formatGutterLabel(s.hour, s.minute) : ""}
              </div>
            ))}
          </div>
        </div>

        {/* Mechanic columns */}
        {columns.map((col, colIdx) => {
          const colEvents = eventsByColumn.get(col.id) ?? [];
          return (
            <div
              key={col.id}
              className={`flex-1 min-w-[150px] ${colIdx < columns.length - 1 ? "border-r border-border" : ""}`}
            >
              {/* Column header */}
              <div className="h-9 flex items-center justify-center border-b border-border bg-card sticky top-0 z-10">
                <span className="text-xs font-medium text-muted-foreground truncate px-2">
                  {col.label}
                </span>
              </div>

              {/* Time grid + events */}
              <div className="relative" style={{ height: totalHeight }}>
                {/* Drop zone slots — invisible but receive drag events */}
                {slots.map((s, i) => {
                  const isDropHere = dropTarget?.colId === col.id && dropTarget?.slotIndex === i;
                  return (
                    <div
                      key={`drop-${i}`}
                      className={`absolute left-0 right-0 ${isDropHere ? "bg-primary/5" : ""}`}
                      style={{ top: i * ROW_HEIGHT, height: ROW_HEIGHT }}
                      onDragOver={(e) => handleDragOver(e, col.id, i)}
                      onDrop={(e) => handleDrop(e, col.id, i)}
                    />
                  );
                })}

                {/* Gridlines */}
                {slots.map((s, i) => (
                  <div
                    key={i}
                    className={`absolute left-0 right-0 pointer-events-none ${s.minute === 0 ? "border-b border-border" : "border-b border-border/40"}`}
                    style={{ top: i * ROW_HEIGHT + ROW_HEIGHT - 1 }}
                  />
                ))}

                {/* Current time indicator */}
                {showNowLine && (
                  <div
                    className="absolute left-0 right-0 h-0.5 bg-destructive z-20 pointer-events-none"
                    style={{ top: nowTop }}
                  />
                )}

                {/* Event blocks */}
                {colEvents.map((ev) => {
                  const evStartMin = minutesFromBase(
                    startHour, startMinute,
                    ev.start.getHours(), ev.start.getMinutes()
                  );
                  const evDuration = (ev.end.getTime() - ev.start.getTime()) / 60000;
                  const top = (evStartMin / totalMinutes) * totalHeight;
                  const height = (evDuration / totalMinutes) * totalHeight;
                  const colors = statusColors[ev.status ?? "confirmed"] ?? statusColors.confirmed;
                  const isDraggable = DRAGGABLE_STATUSES.has(ev.status ?? "");
                  const isBeingDragged = dragEventId === ev.id;
                  const isPendingCustomer = ev.status === "pending_customer_acceptance";

                  return (
                    <div
                      key={ev.id}
                      className={`absolute left-1 right-1 rounded-md text-xs px-2 py-1 overflow-hidden z-10 ${
                        isDraggable ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"
                      } ${isBeingDragged ? "opacity-50" : ""}`}
                      style={{
                        top: Math.max(0, top),
                        height: Math.max(ROW_HEIGHT * 0.8, height),
                        backgroundColor: colors.bg,
                        color: colors.text,
                        borderLeft: isPendingCustomer
                          ? `3px dashed ${colors.border}`
                          : `3px solid ${colors.border}`,
                      }}
                      draggable={isDraggable}
                      onDragStart={(e) => handleDragStart(e, ev, col.id)}
                      onDragEnd={handleDragEnd}
                      onClick={() => onSelectEvent(ev)}
                    >
                      <p className="font-medium truncate">{ev.customerName}</p>
                      <p className="truncate opacity-80">{ev.serviceNames?.join(", ")}</p>
                      {isPendingCustomer && (
                        <p className="truncate opacity-70 text-[10px]">Awaiting approval</p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
