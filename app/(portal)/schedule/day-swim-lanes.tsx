"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Ban, Car, CheckCircle2, Users } from "lucide-react";
import {
  statusColors,
  dateToString,
  getPendingApprovalLabel,
} from "./schedule-constants";
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
  dateChanged: boolean;
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
  nowTimestamp: number;
  selectedEventId?: string | null;
  onSelectEvent: (event: CalendarEvent) => void;
  onProposeReschedule?: (proposal: RescheduleProposal) => void;
  onDragError?: (message: string) => void;
  onContextMenuCell?: (info: ContextMenuCellInfo) => void;
  onSelectEmptyCell?: (info: {
    mechanicId: string;
    mechanicName: string;
    date: string;
    startTime: string;
    endTime: string;
  }) => void;
  onContextMenuBlocked?: (info: ContextMenuBlockedInfo) => void;
  onSelectBlocked?: (info: { slotId: string; date: string; startTime: string; endTime: string; mechanicId: string | null; blockTitle: string | null; note: string | null }) => void;
  onBlockDayClick?: (mechanicId: string, mechanicName: string) => void;
  currentDate?: Date;
  draftBooking?: {
    date: string;
    time: string;
    mechanicId: string;
    durationMinutes: number;
  } | null;
  /** When set, the lane belonging to this mechanic is highlighted and edits on
   *  other lanes are locked: drag-to-reschedule, empty-cell create, and
   *  right-click block all become no-ops on lanes the viewer doesn't own.
   *  Pass `null`/omit for shop owners and front-desk who can edit any lane. */
  viewerMechanicId?: string | null;
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

function formatCompactTime(h: number, m: number): string {
  const ampm = h >= 12 ? "p" : "a";
  const hour = h % 12 || 12;
  return m === 0 ? `${hour}${ampm}` : `${hour}:${String(m).padStart(2, "0")}${ampm}`;
}

/* ------------------------------------------------------------------ */
/*  Component                                                           */
/* ------------------------------------------------------------------ */

export default function DaySwimLanes({
  mechanics,
  events,
  minTime,
  maxTime,
  nowTimestamp,
  selectedEventId,
  onSelectEvent,
  onProposeReschedule,
  onDragError,
  onContextMenuCell,
  onSelectEmptyCell,
  onContextMenuBlocked,
  onSelectBlocked,
  onBlockDayClick,
  currentDate,
  draftBooking,
  viewerMechanicId,
}: DaySwimLanesProps) {
  const viewerKey = viewerMechanicId ? String(viewerMechanicId) : null;
  const isMechanicViewer = viewerKey !== null;
  const canEditColumn = useCallback(
    (colId: string) => {
      if (!isMechanicViewer) return true;
      if (colId === "__unassigned__") return false;
      return String(colId) === viewerKey;
    },
    [isMechanicViewer, viewerKey],
  );
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
  const now = new Date(nowTimestamp);
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
  const slotsRef = useRef(slots);
  const mechanicsRef = useRef(mechanics);
  const onSelectEventRef = useRef(onSelectEvent);
  const onProposeRescheduleRef = useRef(onProposeReschedule);
  const currentDateRef = useRef(currentDate);
  const onDragErrorRef = useRef(onDragError);
  const eventsRef = useRef(events);
  const canEditColumnRef = useRef(canEditColumn);

  useEffect(() => {
    columnsRef.current = columns;
    slotsRef.current = slots;
    mechanicsRef.current = mechanics;
    onSelectEventRef.current = onSelectEvent;
    onProposeRescheduleRef.current = onProposeReschedule;
    currentDateRef.current = currentDate;
    onDragErrorRef.current = onDragError;
    eventsRef.current = events;
    canEditColumnRef.current = canEditColumn;
  }, [
    columns,
    slots,
    mechanics,
    onSelectEvent,
    onProposeReschedule,
    currentDate,
    onDragError,
    events,
    canEditColumn,
  ]);

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

    const targetColId = cols[colIndex].id;
    // Mechanic viewers can't drop into another mechanic's lane.
    if (!canEditColumnRef.current(targetColId)) return null;

    return { colId: targetColId, slotIndex };
  }, []);

  /** Pointer-based drag: creates a floating DOM element that follows the cursor. */
  const handlePointerDown = useCallback((e: React.PointerEvent, ev: CalendarEvent, colId: string) => {
    if (!DRAGGABLE_STATUSES.has(ev.status ?? "")) return;
    if (e.button !== 0) return;
    // Mechanic viewers can't drag bookings out of someone else's lane.
    if (!canEditColumnRef.current(colId)) {
      onDragErrorRef.current?.("You can only adjust bookings in your own lane.");
      return;
    }
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
        const pendingLabel = getPendingApprovalLabel(ev);

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
        awaitP.textContent = pendingLabel;
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
              !be.isDraft &&
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
              dateChanged: false,
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

  if (mechanics.length === 0 && !hasUnassigned) {
    return (
      <div className="flex flex-col items-center justify-center h-[400px] gap-2">
        <Users className="w-8 h-8 text-muted-foreground opacity-40" />
        <p className="text-sm font-medium text-muted-foreground">No mechanics configured</p>
        <p className="text-xs text-muted-foreground">Add team members in the Team page to see their schedules here.</p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="overflow-auto"
      style={{ height: "calc(100vh - 180px)", minHeight: 500 }}
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
          const isOwnLane = isMechanicViewer && String(col.id) === viewerKey;
          const isReadOnlyLane = isMechanicViewer && !isOwnLane;
          return (
            <div
              key={col.id}
              className={`flex-1 min-w-[150px] ${colIdx < columns.length - 1 ? "border-r border-border" : ""}`}
            >
              {/* Column header */}
              <div
                className={`relative flex flex-col items-center justify-center border-b sticky top-0 z-30 group/header gap-1.5 px-2 py-3 ${
                  isOwnLane
                    ? "bg-primary/10 border-primary/30"
                    : "border-border bg-card"
                }`}
                style={{ height: HEADER_HEIGHT }}
              >
                {/* Avatar */}
                <div
                  className={`shrink-0 w-10 h-10 rounded-full flex items-center justify-center p-0.5 ${
                    isOwnLane ? "bg-primary/25 ring-2 ring-primary/40" : "bg-primary/15"
                  }`}
                >
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
                  <span
                    className={`text-xs font-medium truncate ${
                      isOwnLane ? "text-primary" : "text-muted-foreground"
                    }`}
                  >
                    {col.label}
                    {isOwnLane ? " · You" : ""}
                  </span>
                  {colBookings.length > 0 && (
                    <span className="text-[10px] text-muted-foreground">
                      {colBookings.length} job{colBookings.length !== 1 ? "s" : ""}
                    </span>
                  )}
                </div>
                {col.id !== "__unassigned__" && onBlockDayClick && !isReadOnlyLane && (
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
                className={`relative ${
                  isOwnLane
                    ? "bg-primary/[0.04]"
                    : isReadOnlyLane
                      ? "bg-muted/50"
                      : "bg-muted/30"
                } ${isReadOnlyLane ? "cursor-not-allowed" : ""}`}
                style={{ height: totalHeight }}
                onClick={(e) => {
                  if (!onSelectEmptyCell || col.id === "__unassigned__") return;
                  if (isReadOnlyLane) return;
                  if (
                    (e.target as HTMLElement).closest("[data-event-block]") ||
                    (e.target as HTMLElement).closest(".blocked-slot-pattern")
                  )
                    return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  const relY = e.clientY - rect.top;
                  const slotIndex = Math.min(
                    Math.max(Math.floor(relY / ROW_HEIGHT), 0),
                    slots.length - 1,
                  );
                  const slot = slots[slotIndex];
                  const nextSlot = slots[Math.min(slotIndex + 1, slots.length - 1)];
                  const startTime = formatHHMM(slot.hour, slot.minute);
                  const endTime =
                    slotIndex === slots.length - 1
                      ? formatHHMM(slot.hour, slot.minute + STEP_MINUTES)
                      : formatHHMM(nextSlot.hour, nextSlot.minute);
                  const date = currentDate
                    ? dateToString(currentDate)
                    : dateToString(new Date());
                  const mech = mechanics.find((m) => m._id === col.id);
                  onSelectEmptyCell({
                    mechanicId: col.id,
                    mechanicName: mech?.name ?? col.label,
                    date,
                    startTime,
                    endTime,
                  });
                }}
                onContextMenu={(e) => {
                  // Only fire for empty cell clicks — ignore if target is an event block or blocked overlay
                  if ((e.target as HTMLElement).closest("[data-event-block]") || (e.target as HTMLElement).closest(".blocked-slot-pattern")) return;
                  if (!onContextMenuCell || col.id === "__unassigned__") return;
                  if (isReadOnlyLane) {
                    e.preventDefault();
                    return;
                  }
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
                {colBookings.length === 0 && colBlocked.length === 0 && (
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <span className="text-xs text-muted-foreground/50">No bookings</span>
                  </div>
                )}
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

                {/* Draft booking ghost — shows where a draft booking is about to land */}
                {draftBooking &&
                  (draftBooking.mechanicId || "__unassigned__") === col.id &&
                  currentDate &&
                  draftBooking.date === dateToString(currentDate) &&
                  (() => {
                    const [dh, dm] = draftBooking.time.split(":").map(Number);
                    const draftStartMin = minutesFromBase(startHour, startMinute, dh, dm);
                    if (draftStartMin < 0 || draftStartMin >= totalMinutes) return null;
                    const draftTop = (draftStartMin / totalMinutes) * totalHeight;
                    const draftHeight = Math.max(
                      ROW_HEIGHT,
                      (draftBooking.durationMinutes / totalMinutes) * totalHeight
                    );
                    return (
                      <div
                        className="absolute left-1 right-1 z-[6] rounded-lg border-2 border-dashed border-primary bg-primary/15 pointer-events-none flex items-center justify-center px-2"
                        style={{ top: draftTop, height: draftHeight }}
                      >
                        <span className="text-[11px] font-semibold text-primary uppercase tracking-wide">
                          Draft — new booking
                        </span>
                      </div>
                    );
                  })()}

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
                      className={`absolute left-0 right-0 z-[5] blocked-slot-pattern group overflow-hidden ${
                        bl.isDraft
                          ? "pointer-events-none opacity-70 ring-2 ring-dashed ring-red-400 outline outline-2 outline-dashed outline-red-400 -outline-offset-2 animate-pulse"
                          : "cursor-pointer"
                      }`}
                      style={{
                        top: Math.max(0, blTop),
                        height: Math.max(ROW_HEIGHT * 0.5, blHeight),
                      }}
                      title={bl.note ?? undefined}
                      onClick={() => {
                        if (bl.isDraft) return;
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
                        if (bl.isDraft) return;
                        if (!bl.slotId || !onContextMenuBlocked) return;
                        e.preventDefault();
                        onContextMenuBlocked({ slotId: bl.slotId, clientX: e.clientX, clientY: e.clientY });
                      }}
                    >
                      <span className="absolute inset-0 flex flex-col items-center justify-center overflow-hidden px-1 pointer-events-none select-none gap-0.5">
                        {bl.isDraft && (
                          <span className="text-[9px] font-semibold uppercase tracking-wide text-red-500">
                            Draft preview
                          </span>
                        )}
                        <span
                          className="overflow-hidden text-center text-[11px] font-medium leading-tight text-red-400 whitespace-normal break-words"
                          style={{
                            display: "-webkit-box",
                            WebkitBoxOrient: "vertical",
                            WebkitLineClamp: Math.max(1, Math.floor(blHeight / 14)),
                          }}
                        >
                          {bl.blockTitle ?? "Blocked"}
                        </span>
                        {bl.isDraft && blHeight > 36 && (
                          <span className="text-[10px] text-red-400/80">
                            {`${formatCompactTime(bl.start.getHours(), bl.start.getMinutes())} – ${formatCompactTime(bl.end.getHours(), bl.end.getMinutes())}`}
                          </span>
                        )}
                        {bl.isDraft && bl.note && blHeight > 56 && (
                          <span className="text-[10px] text-red-400/70 line-clamp-2 text-center px-1">
                            {bl.note}
                          </span>
                        )}
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
                  const isTentativeQuote = ev.status === "tentative_quote";
                  const isAwaitingRecResponse =
                    ev.recommendationState === "pending_customer";
                  const isAwaitingInfo =
                    ev.diagnosticFollowupState === "awaiting_info";
                  const diagnosticBadge = isAwaitingRecResponse
                    ? "Waiting for customer response"
                    : isAwaitingInfo
                      ? "Awaiting info"
                      : null;
                  const pendingLabel = getPendingApprovalLabel(ev);

                  // Placeholder at original position while dragging
                  if (isBeingDragged) {
                    return (
                      <div
                        key={ev.id}
                        className="absolute left-0 right-0 text-xs px-2 py-1 overflow-hidden z-10"
                        style={{
                          top: slotTop,
                          height: Math.max(ROW_HEIGHT * 0.5, slotHeight - 2),
                          backgroundColor: "transparent",
                          color: colors.text,
                          border: `2px dashed ${colors.border}`,
                          opacity: 0.4,
                        }}
                      >
                        <div className="flex items-center gap-1.5 min-w-0">
                          <p className="font-medium truncate flex-1 min-w-0">
                            {ev.customerName}
                          </p>
                          <span className="shrink-0 rounded border border-current/30 bg-white/70 px-1 py-px font-mono text-[10px] font-bold leading-none tracking-tight">
                            {(ev as any).invoiceNumber
                              ? String((ev as any).invoiceNumber).startsWith("#")
                                ? (ev as any).invoiceNumber
                                : `#${(ev as any).invoiceNumber}`
                              : `#${String(ev.id).slice(-6).toUpperCase()}`}
                          </span>
                        </div>
                        <p className="truncate opacity-80">
                          {ev.serviceNames?.join(", ")}
                        </p>
                      </div>
                    );
                  }

                  const isSelected = selectedEventId === ev.id;

                  return (
                    <div
                      key={ev.id}
                      data-event-block
                      className={`absolute left-0 right-0 text-xs px-2 py-1 overflow-hidden z-10 select-none transition-shadow duration-150 ${
                        isDraggable
                          ? "cursor-grab active:cursor-grabbing"
                          : "cursor-pointer"
                      } ${isSelected ? "ring-2 ring-primary ring-offset-1 shadow-md z-20" : ""}`}
                      style={{
                        top: slotTop,
                        height: Math.max(ROW_HEIGHT * 0.5, slotHeight - 2),
                        backgroundColor: colors.bg,
                        color: colors.text,
                        borderLeft:
                          isPendingCustomer || isTentativeQuote
                            ? `3px dashed ${colors.border}`
                            : `3px solid ${colors.border}`,
                        borderTop: isTentativeQuote
                          ? `1px dashed ${colors.border}`
                          : undefined,
                        borderRight: isTentativeQuote
                          ? `1px dashed ${colors.border}`
                          : undefined,
                        borderBottom: isTentativeQuote
                          ? `1px dashed ${colors.border}`
                          : `2px solid ${colors.border}`,
                        opacity: isTentativeQuote ? 0.75 : undefined,
                      }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.boxShadow = "0 1px 3px rgba(0,0,0,0.08)"; }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.boxShadow = ""; }}
                      onPointerDown={
                        isDraggable
                          ? (e) => handlePointerDown(e, ev, col.id)
                          : undefined
                      }
                      onClick={
                        !isDraggable ? () => onSelectEvent(ev) : undefined
                      }
                    >
                      {slotHeight > ROW_HEIGHT * 1.5 && (
                        <span className="absolute bottom-0.5 right-1 text-[10px] opacity-50 font-medium">
                          {formatCompactTime(ev.start.getHours(), ev.start.getMinutes())}
                        </span>
                      )}
                      {isTentativeQuote && (
                        <span className="absolute top-0.5 right-1 rounded bg-white/80 px-1 text-[9px] font-semibold uppercase tracking-wide">
                          Pending quote
                        </span>
                      )}
                      {slotHeight <= ROW_HEIGHT * 2 && (ev.vehicleDisplay || ev.licensePlate) ? (
                        <>
                          <div className="flex items-center gap-1.5 min-w-0">
                            <p className="font-medium truncate flex-1 min-w-0">
                              {ev.customerName}
                              {(ev.vehicleDisplay || ev.licensePlate) && (
                                <span className="font-normal opacity-70">
                                  {" · "}
                                  {ev.vehicleDisplay ?? ev.licensePlate}
                                </span>
                              )}
                            </p>
                            <span
                              className="shrink-0 rounded border border-current/30 bg-white/70 px-1 py-px font-mono text-[10px] font-bold leading-none tracking-tight"
                              title={String(ev.id)}
                            >
                              {(ev as any).invoiceNumber
                              ? String((ev as any).invoiceNumber).startsWith("#")
                                ? (ev as any).invoiceNumber
                                : `#${(ev as any).invoiceNumber}`
                              : `#${String(ev.id).slice(-6).toUpperCase()}`}
                            </span>
                          </div>
                          <p className="truncate opacity-80">
                            {ev.serviceNames?.join(", ")}
                          </p>
                        </>
                      ) : (
                        <>
                          <div className="flex items-center gap-1.5 min-w-0">
                            <p className="font-medium truncate flex-1 min-w-0">
                              {ev.customerName}
                            </p>
                            <span
                              className="shrink-0 rounded border border-current/30 bg-white/70 px-1 py-px font-mono text-[10px] font-bold leading-none tracking-tight"
                              title={String(ev.id)}
                            >
                              {(ev as any).invoiceNumber
                              ? String((ev as any).invoiceNumber).startsWith("#")
                                ? (ev as any).invoiceNumber
                                : `#${(ev as any).invoiceNumber}`
                              : `#${String(ev.id).slice(-6).toUpperCase()}`}
                            </span>
                          </div>
                          <p className="truncate opacity-80">
                            {ev.serviceNames?.join(", ")}
                          </p>
                          {(ev.vehicleDisplay || ev.licensePlate) && (
                            <p className="mt-0.5 flex items-center gap-1 truncate opacity-75 text-[10px]">
                              <Car className="w-2.5 h-2.5 shrink-0" />
                              <span className="truncate">
                                {ev.vehicleDisplay}
                                {ev.licensePlate ? ` · ${ev.licensePlate}` : ""}
                              </span>
                            </p>
                          )}
                        </>
                      )}
                      {ev.customerNote && slotHeight > ROW_HEIGHT * 2 && (
                        <p
                          className="mt-0.5 truncate italic opacity-80 text-[10px]"
                          title={ev.customerNote}
                        >
                          “{ev.customerNote}”
                        </p>
                      )}
                      {ev.status === "completed" && (
                        <p className="mt-0.5 inline-flex items-center gap-1 truncate rounded-sm bg-green-100 px-1 text-[10px] font-semibold text-green-800">
                          <CheckCircle2 className="w-2.5 h-2.5 shrink-0" />
                          <span>
                            {(ev as any).backfilledAtMs ? "Backfilled" : "Completed"}
                          </span>
                          {typeof ev.capturedAmount === "number" &&
                            ev.capturedAmount > 0 && (
                              <span className="ml-1 tabular-nums">
                                · ${ev.capturedAmount.toFixed(2)}
                              </span>
                            )}
                        </p>
                      )}
                      {isPendingCustomer && (
                        <p className="truncate opacity-70 text-[10px]">
                          {pendingLabel}
                        </p>
                      )}
                      {diagnosticBadge && (
                        <p className="mt-0.5 inline-flex items-center gap-1 truncate rounded-sm bg-amber-100 px-1 text-[10px] font-semibold text-amber-900">
                          <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                          {diagnosticBadge}
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
