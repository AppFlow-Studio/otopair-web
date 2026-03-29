"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { Ban } from "lucide-react";
import { statusColors, dateToString } from "./schedule-constants";
import type { CalendarEvent } from "./schedule-constants";

interface Mechanic {
  _id: string;
  name: string;
  firstName?: string;
  lastName?: string;
  imageUrl?: string | null;
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

export interface ContextMenuCellInfo {
  mechanicId: string;
  mechanicName: string;
  date: string;
  startTime: string;
  endTime: string;
  clientX: number;
  clientY: number;
}

export interface ContextMenuBlockedInfo {
  slotId: string;
  clientX: number;
  clientY: number;
}

interface DaySwimLanesProps {
  mechanics: Mechanic[];
  events: CalendarEvent[];
  minTime: Date;
  maxTime: Date;
  onSelectEvent: (event: CalendarEvent) => void;
  onProposeReschedule?: (proposal: RescheduleProposal) => void;
  onDragError?: (message: string) => void;
  onContextMenuCell?: (info: ContextMenuCellInfo) => void;
  onContextMenuBlocked?: (info: ContextMenuBlockedInfo) => void;
  onSelectBlocked?: (info: { slotId: string; date: string; startTime: string; endTime: string; mechanicId: string | null; blockTitle: string | null; note: string | null }) => void;
  onBlockDayClick?: (mechanicId: string, mechanicName: string) => void;
  currentDate?: Date;
}

/* ------------------------------------------------------------------ */
/*  Re-export CalendarEvent for consumers that import types from here   */
/* ------------------------------------------------------------------ */

export type { CalendarEvent };

const DRAGGABLE_STATUSES = new Set([
  "pending_shop_acceptance",
  "pending",
  "confirmed",
  "pending_customer_acceptance",
]);

/* ------------------------------------------------------------------ */
/*  Constants                                                           */
/* ------------------------------------------------------------------ */

const GUTTER_WIDTH = 70;
const ROW_HEIGHT = 24;
const STEP_MINUTES = 15;
const HEADER_HEIGHT = 84;
const DRAG_THRESHOLD = 5;

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

function formatGutterTime(hour: number, minute: number): { time: string; period: string; isHalf: boolean } | null {
  if (minute === 0) {
    const ampm = hour >= 12 ? "pm" : "am";
    const h = hour % 12 || 12;
    return { time: `${h}:00`, period: ampm, isHalf: false };
  }
  if (minute === 30) {
    return { time: ":30", period: "", isHalf: true };
  }
  return null;
}

function minutesFromBase(baseH: number, baseM: number, h: number, m: number): number {
  return (h - baseH) * 60 + (m - baseM);
}

function formatHHMM(h: number, m: number): string {
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
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
  onDragError,
  onContextMenuCell,
  onContextMenuBlocked,
  onSelectBlocked,
  onBlockDayClick,
  currentDate,
}: DaySwimLanesProps) {
  const startHour = minTime.getHours();
  const startMinute = minTime.getMinutes();
  // maxTime of next-day midnight (e.g. new Date(0,0,1,0,0)) has getHours()===0 but is later than minTime;
  // treat that as hour 24 so the slot loop and height calculation don't collapse.
  const endHour = (maxTime.getHours() === 0 && maxTime > minTime) ? 24 : maxTime.getHours();
  const endMinute = maxTime.getMinutes();

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

  const hasUnassigned = events.some((e) => e.type !== "blocked" && !e.resourceId);

  const columns: Array<{ id: string; label: string; initials: string; imageUrl?: string | null }> = useMemo(() => {
    const cols = mechanics.map((m) => {
      const first = (m.firstName ?? m.name.split(" ")[0] ?? "").charAt(0).toUpperCase();
      const last = (m.lastName ?? m.name.split(" ").slice(-1)[0] ?? "").charAt(0).toUpperCase();
      return { id: m._id, label: m.name, initials: first + last, imageUrl: m.imageUrl };
    });
    if (hasUnassigned) cols.push({ id: "__unassigned__", label: "Unassigned", initials: "?", imageUrl: null });
    return cols;
  }, [mechanics, hasUnassigned]);

  const { bookingsByColumn, blockedByColumn } = useMemo(() => {
    const bkMap = new Map<string, CalendarEvent[]>();
    const blMap = new Map<string, CalendarEvent[]>();
    for (const col of columns) {
      bkMap.set(col.id, []);
      blMap.set(col.id, []);
    }
    for (const ev of events) {
      const colId = ev.resourceId || "__unassigned__";
      if (ev.type === "blocked") {
        blMap.get(colId)?.push(ev);
      } else {
        bkMap.get(colId)?.push(ev);
      }
    }
    return { bookingsByColumn: bkMap, blockedByColumn: blMap };
  }, [columns, events]);

  // Current time indicator
  const now = new Date();
  const nowMinutes = minutesFromBase(startHour, startMinute, now.getHours(), now.getMinutes());
  const showNowLine = nowMinutes >= 0 && nowMinutes <= totalMinutes;
  const nowTop = (nowMinutes / totalMinutes) * totalHeight;

  // ---- Drag state ----
  const [dragEventId, setDragEventId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ colId: string; slotIndex: number } | null>(null);
  const [dragSlotCount, setDragSlotCount] = useState(1);
  const floatingRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const dropTargetRef = useRef<{ colId: string; slotIndex: number } | null>(null);

  // Stable refs for values used inside pointer event closures
  const columnsRef = useRef(columns);
  columnsRef.current = columns;
  const slotsRef = useRef(slots);
  slotsRef.current = slots;
  const mechanicsRef = useRef(mechanics);
  mechanicsRef.current = mechanics;
  const onSelectEventRef = useRef(onSelectEvent);
  onSelectEventRef.current = onSelectEvent;
  const onProposeRescheduleRef = useRef(onProposeReschedule);
  onProposeRescheduleRef.current = onProposeReschedule;
  const currentDateRef = useRef(currentDate);
  currentDateRef.current = currentDate;
  const onDragErrorRef = useRef(onDragError);
  onDragErrorRef.current = onDragError;
  const eventsRef = useRef(events);
  eventsRef.current = events;

  /** Given a viewport coordinate, return which column + slot the pointer is over. */
  const getDropTarget = useCallback((clientX: number, clientY: number) => {
    const container = containerRef.current;
    if (!container) return null;

    const rect = container.getBoundingClientRect();
    const cx = clientX - rect.left;
    const cy = clientY - rect.top;

    if (cx < 0 || cy < HEADER_HEIGHT || cx > rect.width || cy > rect.height) return null;

    const cols = columnsRef.current;
    const sls = slotsRef.current;

    const gridX = cx + container.scrollLeft - GUTTER_WIDTH;
    if (gridX < 0) return null;

    const colWidth = (container.scrollWidth - GUTTER_WIDTH) / cols.length;
    const colIndex = Math.min(Math.max(Math.floor(gridX / colWidth), 0), cols.length - 1);

    const contentY = cy - HEADER_HEIGHT + container.scrollTop;
    const slotIndex = Math.min(Math.max(Math.round(contentY / ROW_HEIGHT), 0), sls.length - 1);

    return { colId: cols[colIndex].id, slotIndex };
  }, []);

  /** Pointer-based drag: creates a floating DOM element that follows the cursor. */
  const handlePointerDown = useCallback((e: React.PointerEvent, ev: CalendarEvent, colId: string) => {
    if (!DRAGGABLE_STATUSES.has(ev.status ?? "")) return;
    if (e.button !== 0) return;
    e.preventDefault();

    const el = e.currentTarget as HTMLElement;
    const elRect = el.getBoundingClientRect();
    const offX = e.clientX - elRect.left;
    const offY = e.clientY - elRect.top;
    const w = elRect.width;
    const h = elRect.height;
    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;

    function createFloating() {
      const colors = statusColors[ev.status ?? "confirmed"] ?? statusColors.confirmed;
      const isPendingCustomer = ev.status === "pending_customer_acceptance";

      const floating = document.createElement("div");
      Object.assign(floating.style, {
        position: "fixed",
        zIndex: "50",
        pointerEvents: "none",
        width: `${w}px`,
        height: `${h}px`,
        backgroundColor: colors.bg,
        color: colors.text,
        borderLeft: isPendingCustomer
          ? `3px dashed ${colors.border}`
          : `3px solid ${colors.border}`,
        borderRadius: "0.375rem",
        padding: "4px 8px",
        fontSize: "12px",
        lineHeight: "1.25",
        overflow: "hidden",
        boxShadow:
          "0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)",
        top: "0px",
        left: "0px",
        willChange: "transform",
        transform: `translate(${startX - offX}px, ${startY - offY}px)`,
      });

      const nameP = document.createElement("p");
      Object.assign(nameP.style, {
        fontWeight: "500",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      });
      nameP.textContent = ev.customerName ?? "";
      floating.appendChild(nameP);

      const svcP = document.createElement("p");
      Object.assign(svcP.style, {
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        opacity: "0.8",
      });
      svcP.textContent = ev.serviceNames?.join(", ") ?? "";
      floating.appendChild(svcP);

      if (isPendingCustomer) {
        const awaitP = document.createElement("p");
        Object.assign(awaitP.style, {
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          opacity: "0.7",
          fontSize: "10px",
        });
        awaitP.textContent = "Awaiting approval";
        floating.appendChild(awaitP);
      }

      document.body.appendChild(floating);
      floatingRef.current = floating;
    }

    function cleanup() {
      if (floatingRef.current) {
        floatingRef.current.remove();
        floatingRef.current = null;
      }
      setDragEventId(null);
      setDropTarget(null);
      setDragSlotCount(1);
      dropTargetRef.current = null;
      document.body.style.cursor = "";
      dragging = false;
    }

    /** Animate the floating clone back to the booking's original position, then clean up. */
    function animateBackAndCleanup(onDone: () => void) {
      // Hide the drop-zone highlight immediately
      setDropTarget(null);
      dropTargetRef.current = null;

      const floating = floatingRef.current;
      if (!floating) {
        setDragEventId(null);
        setDragSlotCount(1);
        document.body.style.cursor = "";
        dragging = false;
        onDone();
        return;
      }

      // Fire callback immediately so the toast appears as the animation begins
      onDone();

      floating.style.transition = "transform 0.28s cubic-bezier(0.2, 0, 0.2, 1)";
      floating.style.transform = `translate(${elRect.left}px, ${elRect.top}px)`;

      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        floating.remove();
        floatingRef.current = null;
        setDragEventId(null);
        setDragSlotCount(1);
        document.body.style.cursor = "";
        dragging = false;
      };

      floating.addEventListener("transitionend", finish, { once: true });
      setTimeout(finish, 400); // fallback in case transitionend doesn't fire
    }

    function onMove(me: PointerEvent) {
      if (!dragging) {
        const dx = me.clientX - startX;
        const dy = me.clientY - startY;
        if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD)
          return;

        dragging = true;
        createFloating();
        setDragEventId(ev.id);
        const evDurationMin = (ev.end.getTime() - ev.start.getTime()) / 60000;
        setDragSlotCount(Math.max(1, Math.ceil(evDurationMin / STEP_MINUTES)));
        document.body.style.cursor = "grabbing";
      }

      if (floatingRef.current) {
        floatingRef.current.style.transform = `translate(${me.clientX - offX}px, ${me.clientY - offY}px)`;
      }

      // Use the top-left of the floating booking block (not the raw cursor)
      // so the drop slot reflects where the booking visually sits.
      const target = getDropTarget(me.clientX - offX + w / 2, me.clientY - offY);
      dropTargetRef.current = target;
      setDropTarget((prev) => {
        if (!target && !prev) return prev;
        if (
          target &&
          prev &&
          target.colId === prev.colId &&
          target.slotIndex === prev.slotIndex
        )
          return prev;
        return target;
      });
    }

    function onUp() {
      removeListeners();

      if (!dragging) {
        // Below threshold — treat as click
        onSelectEventRef.current(ev);
        return;
      }

      const target = dropTargetRef.current;

      // Forbidden drop: cannot reschedule to the Unassigned column
      if (target?.colId === "__unassigned__") {
        animateBackAndCleanup(() => {
          onDragErrorRef.current?.("Cannot reschedule to an unassigned mechanic");
        });
        return;
      }

      // Forbidden drop: cannot reschedule onto a blocked time slot
      if (target) {
        const sls = slotsRef.current;
        const slot = sls[target.slotIndex];
        if (slot) {
          const dropTime = formatHHMM(slot.hour, slot.minute);
          const evDurationMin = (ev.end.getTime() - ev.start.getTime()) / 60000;
          const dropEndTotalMin = slot.hour * 60 + slot.minute + evDurationMin;
          const deh = Math.floor(Math.min(1439, dropEndTotalMin) / 60);
          const dem = Math.min(1439, dropEndTotalMin) % 60;
          const dropEndTime = formatHHMM(deh, dem);

          const blocked = eventsRef.current.filter(
            (be) =>
              be.type === "blocked" &&
              (be.resourceId === target.colId || !be.resourceId),
          );
          const overlapsBlocked = blocked.some((bl) => {
            const blStart = formatHHMM(bl.start.getHours(), bl.start.getMinutes());
            const blEnd = formatHHMM(bl.end.getHours(), bl.end.getMinutes());
            return blStart < dropEndTime && blEnd > dropTime;
          });
          if (overlapsBlocked) {
            animateBackAndCleanup(() => {
              onDragErrorRef.current?.("Cannot reschedule onto a blocked time slot");
            });
            return;
          }

          // Forbidden drop: cannot reschedule onto a time occupied by another booking
          const otherBookings = eventsRef.current.filter(
            (be) => be.type === "booking" && be.id !== ev.id && be.resourceId === target.colId,
          );
          const overlapsBooking = otherBookings.some((bk) => {
            const bkStart = formatHHMM(bk.start.getHours(), bk.start.getMinutes());
            const bkEnd = formatHHMM(bk.end.getHours(), bk.end.getMinutes());
            return bkStart < dropEndTime && bkEnd > dropTime;
          });
          if (overlapsBooking) {
            animateBackAndCleanup(() => {
              onDragErrorRef.current?.("Cannot reschedule onto a time already booked");
            });
            return;
          }
        }
      }

      // Check if the drop target differs from the original position
      if (target && onProposeRescheduleRef.current) {
        const sls = slotsRef.current;
        const slot = sls[target.slotIndex];
        if (slot) {
          const newTime = formatHHMM(slot.hour, slot.minute);
          const originalTime = formatHHMM(
            ev.start.getHours(),
            ev.start.getMinutes(),
          );
          const newMechanicId =
            target.colId === "__unassigned__" ? undefined : target.colId;
          const originalMechanicId =
            colId === "__unassigned__" ? undefined : colId;

          const timeChanged = newTime !== originalTime;
          const mechanicChanged = newMechanicId !== originalMechanicId;

          if (timeChanged || mechanicChanged) {
            const date = currentDateRef.current
              ? dateToString(currentDateRef.current)
              : dateToString(ev.start);
            const mechs = mechanicsRef.current;
            const origMech = mechs.find((m) => m._id === originalMechanicId);
            const newMech = mechs.find((m) => m._id === newMechanicId);

            onProposeRescheduleRef.current({
              eventId: ev.id,
              originalDate: date,
              originalTime,
              originalMechanicId,
              originalMechanicName: origMech?.name,
              newDate: date,
              newTime,
              newMechanicId,
              newMechanicName: newMech?.name,
              timeChanged,
              mechanicChanged,
            });
          }
        }
      }

      cleanup();
    }

    function onEscape(ke: KeyboardEvent) {
      if (ke.key === "Escape" && dragging) {
        removeListeners();
        cleanup();
      }
    }

    function removeListeners() {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      document.removeEventListener("keydown", onEscape);
      window.removeEventListener("blur", onUp);
    }

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
    document.addEventListener("keydown", onEscape);
    window.addEventListener("blur", onUp);
  }, [getDropTarget]);

  /* ---- Render ---- */

  return (
    <div
      ref={containerRef}
      className="overflow-auto"
      style={{ height: "calc(100vh - 320px)", minHeight: 500 }}
    >
      <div
        className="flex"
        style={{ minWidth: GUTTER_WIDTH + columns.length * 150 }}
      >
        {/* Time gutter */}
        <div className="shrink-0" style={{ width: GUTTER_WIDTH }}>
          <div className="bg-card sticky top-0 z-30 border-b border-border" style={{ height: HEADER_HEIGHT }} />
          <div className="relative" style={{ height: totalHeight }}>
            {/* Time labels */}
            {slots.map((s, i) => {
              const label = formatGutterTime(s.hour, s.minute);
              if (!label) return null;
              return (
                <div
                  key={i}
                  className="absolute right-0 pr-2 flex flex-col items-end leading-none text-muted-foreground"
                  style={{
                    top: i * ROW_HEIGHT + 2,
                    width: GUTTER_WIDTH,
                    opacity: label.isHalf ? 0.45 : 1,
                  }}
                >
                  <span className={label.isHalf ? "text-[9px]" : "text-[11px] font-medium"}>{label.time}</span>
                  {!label.isHalf && <span className="text-[10px]">{label.period}</span>}
                </div>
              );
            })}
            {/* Current time pill in gutter */}
            {showNowLine && (
              <div
                className="absolute left-0 right-0 z-30 pointer-events-none flex items-center justify-end pr-1.5"
                style={{ top: nowTop - 9, width: GUTTER_WIDTH }}
              >
                <span className="text-[10px] font-semibold text-destructive bg-card border-2 border-destructive rounded-full px-1.5 py-[3px] leading-none">
                  {`${now.getHours() % 12 || 12}:${String(now.getMinutes()).padStart(2, "0")}`}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Mechanic columns */}
        {columns.map((col, colIdx) => {
          const colBookings = bookingsByColumn.get(col.id) ?? [];
          const colBlocked = blockedByColumn.get(col.id) ?? [];
          return (
            <div
              key={col.id}
              className={`flex-1 min-w-[150px] ${colIdx < columns.length - 1 ? "border-r border-border" : ""}`}
            >
              {/* Column header */}
              <div className="relative flex flex-col items-center justify-center border-b border-border bg-card sticky top-0 z-30 group/header gap-1.5 px-2 py-3" style={{ height: HEADER_HEIGHT }}>
                {/* Avatar */}
                <div className="shrink-0" style={{ width: 40, height: 40, borderRadius: 9999, padding: 2, background: 'rgba(99,102,241,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {col.imageUrl ? (
                    <img
                      src={col.imageUrl}
                      alt={col.label}
                      style={{ width: 36, height: 36, borderRadius: 9999, objectFit: 'cover' }}
                    />
                  ) : (
                    <div
                      className="bg-white text-primary font-semibold flex items-center justify-center"
                      style={{ width: 36, height: 36, borderRadius: 9999, fontSize: 13 }}
                    >
                      {col.initials}
                    </div>
                  )}
                </div>
                <div className="flex flex-col items-center min-w-0">
                  <span className="text-xs font-medium text-muted-foreground truncate">
                    {col.label}
                  </span>
                  {colBookings.length > 0 && (
                    <span className="text-[10px] text-muted-foreground">
                      {colBookings.length} job{colBookings.length !== 1 ? "s" : ""}
                    </span>
                  )}
                </div>
                {col.id !== "__unassigned__" && onBlockDayClick && (
                  <button
                    className="absolute top-1 right-1 opacity-0 group-hover/header:opacity-100 transition-opacity p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-destructive"
                    title={`Block full day for ${col.label}`}
                    onClick={() => onBlockDayClick(col.id, col.label)}
                  >
                    <Ban className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

              {/* Time grid + events */}
              <div
                className="relative bg-muted/30"
                style={{ height: totalHeight }}
                onContextMenu={(e) => {
                  // Only fire for empty cell clicks — ignore if target is an event block or blocked overlay
                  if ((e.target as HTMLElement).closest("[data-event-block]") || (e.target as HTMLElement).closest(".blocked-slot-pattern")) return;
                  if (!onContextMenuCell || col.id === "__unassigned__") return;
                  e.preventDefault();
                  const rect = e.currentTarget.getBoundingClientRect();
                  const relY = e.clientY - rect.top;
                  const slotIndex = Math.min(Math.max(Math.floor(relY / ROW_HEIGHT), 0), slots.length - 1);
                  const slot = slots[slotIndex];
                  const nextSlotIndex = Math.min(slotIndex + 1, slots.length - 1);
                  const nextSlot = slots[nextSlotIndex];
                  const startTime = formatHHMM(slot.hour, slot.minute);
                  const endTime = slotIndex === nextSlotIndex
                    ? formatHHMM(slot.hour, slot.minute + STEP_MINUTES)
                    : formatHHMM(nextSlot.hour, nextSlot.minute);
                  const date = currentDate ? dateToString(currentDate) : dateToString(new Date());
                  const mech = mechanics.find((m) => m._id === col.id);
                  onContextMenuCell({
                    mechanicId: col.id,
                    mechanicName: mech?.name ?? col.label,
                    date,
                    startTime,
                    endTime,
                    clientX: e.clientX,
                    clientY: e.clientY,
                  });
                }}
              >
                {/* Drop zone highlight — spans the full booking duration */}
                {dropTarget?.colId === col.id && (
                  <div
                    className="absolute left-0 right-0 bg-primary/10 border border-primary/20 rounded"
                    style={{
                      top: dropTarget.slotIndex * ROW_HEIGHT,
                      height: dragSlotCount * ROW_HEIGHT,
                    }}
                  />
                )}

                {/* Gridlines — drawn at the top of each slot so hour marks land exactly on the hour */}
                {slots.map((s, i) => (
                  <div
                    key={i}
                    className={`absolute left-0 right-0 pointer-events-none ${
                      s.minute === 0
                        ? "border-t border-border"
                        : "border-t border-border/40"
                    }`}
                    style={{ top: i * ROW_HEIGHT }}
                  />
                ))}

                {/* Blocked slot overlays */}
                {colBlocked.map((bl) => {
                  const blStartMin = minutesFromBase(startHour, startMinute, bl.start.getHours(), bl.start.getMinutes());
                  const blDuration = (bl.end.getTime() - bl.start.getTime()) / 60000;
                  const blTop = (blStartMin / totalMinutes) * totalHeight;
                  const blHeight = (blDuration / totalMinutes) * totalHeight;
                  return (
                    <div
                      key={bl.id}
                      className="absolute left-0 right-0 z-[5] blocked-slot-pattern group cursor-pointer"
                      style={{
                        top: Math.max(0, blTop),
                        height: Math.max(ROW_HEIGHT * 0.5, blHeight),
                      }}
                      title={bl.note ?? undefined}
                      onClick={() => {
                        if (!bl.slotId || !onSelectBlocked) return;
                        onSelectBlocked({
                          slotId: bl.slotId,
                          date: `${bl.start.getFullYear()}-${String(bl.start.getMonth() + 1).padStart(2, "0")}-${String(bl.start.getDate()).padStart(2, "0")}`,
                          startTime: `${String(bl.start.getHours()).padStart(2, "0")}:${String(bl.start.getMinutes()).padStart(2, "0")}`,
                          endTime: `${String(bl.end.getHours()).padStart(2, "0")}:${String(bl.end.getMinutes()).padStart(2, "0")}`,
                          mechanicId: bl.resourceId ?? null,
                          blockTitle: bl.blockTitle ?? null,
                          note: bl.note ?? null,
                        });
                      }}
                      onContextMenu={(e) => {
                        if (!bl.slotId || !onContextMenuBlocked) return;
                        e.preventDefault();
                        onContextMenuBlocked({ slotId: bl.slotId, clientX: e.clientX, clientY: e.clientY });
                      }}
                    >
                      <span className="absolute inset-0 flex items-center justify-center text-[11px] font-medium text-red-400 select-none pointer-events-none px-1 truncate">
                        {bl.blockTitle ?? "Blocked"}
                      </span>
                    </div>
                  );
                })}

                {/* Current time indicator */}
                {showNowLine && (
                  <div
                    className="absolute left-0 right-0 z-20 pointer-events-none"
                    style={{ top: nowTop }}
                  >
                    <div className="absolute left-0 right-0 top-1/2 -translate-y-1/2 h-[1.5px] bg-destructive" />
                    {colIdx === 0 && (
                      <div className="absolute -left-[5px] top-1/2 -translate-y-1/2 w-[10px] h-[10px] rounded-full bg-destructive" />
                    )}
                  </div>
                )}

                {/* Event blocks */}
                {colBookings.map((ev: CalendarEvent) => {
                  const evStartMin = minutesFromBase(
                    startHour,
                    startMinute,
                    ev.start.getHours(),
                    ev.start.getMinutes(),
                  );
                  const evDuration =
                    (ev.end.getTime() - ev.start.getTime()) / 60000;
                  const slotTop = (evStartMin / totalMinutes) * totalHeight;
                  const slotHeight = Math.max(ROW_HEIGHT * 0.5, (evDuration / totalMinutes) * totalHeight);
                  const colors =
                    statusColors[ev.status ?? "confirmed"] ??
                    statusColors.confirmed;
                  const isDraggable = DRAGGABLE_STATUSES.has(ev.status ?? "");
                  const isBeingDragged = dragEventId === ev.id;
                  const isPendingCustomer =
                    ev.status === "pending_customer_acceptance";

                  // Placeholder at original position while dragging
                  if (isBeingDragged) {
                    return (
                      <div
                        key={ev.id}
                        className="absolute left-0 right-0 text-xs px-2 py-1 overflow-hidden z-10"
                        style={{
                          top: slotTop,
                          height: slotHeight,
                          backgroundColor: "transparent",
                          color: colors.text,
                          border: `2px dashed ${colors.border}`,
                          opacity: 0.4,
                        }}
                      >
                        <p className="font-medium truncate">
                          {ev.customerName}
                        </p>
                        <p className="truncate opacity-80">
                          {ev.serviceNames?.join(", ")}
                        </p>
                      </div>
                    );
                  }

                  return (
                    <div
                      key={ev.id}
                      data-event-block
                      className={`absolute left-0 right-0 text-xs px-2 py-1 overflow-hidden z-10 select-none ${
                        isDraggable
                          ? "cursor-grab active:cursor-grabbing"
                          : "cursor-pointer"
                      }`}
                      style={{
                        top: slotTop,
                        height: slotHeight,
                        backgroundColor: colors.bg,
                        color: colors.text,
                        borderLeft: isPendingCustomer
                          ? `3px dashed ${colors.border}`
                          : `3px solid ${colors.border}`,
                      }}
                      onPointerDown={
                        isDraggable
                          ? (e) => handlePointerDown(e, ev, col.id)
                          : undefined
                      }
                      onClick={
                        !isDraggable ? () => onSelectEvent(ev) : undefined
                      }
                    >
                      <p className="font-medium truncate">
                        {ev.customerName}
                      </p>
                      <p className="truncate opacity-80">
                        {ev.serviceNames?.join(", ")}
                      </p>
                      {isPendingCustomer && (
                        <p className="truncate opacity-70 text-[10px]">
                          Awaiting approval
                        </p>
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
