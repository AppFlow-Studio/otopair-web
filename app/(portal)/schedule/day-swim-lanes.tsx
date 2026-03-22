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
  minTime: Date;
  maxTime: Date;
  onSelectEvent: (event: CalendarEvent) => void;
  onProposeReschedule?: (proposal: RescheduleProposal) => void;
  onDragError?: (message: string) => void;
  currentDate?: Date;
}

/* ------------------------------------------------------------------ */
/*  Status colors                                                       */
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

const GUTTER_WIDTH = 70;
const ROW_HEIGHT = 48;
const STEP_MINUTES = 30;
const HEADER_HEIGHT = 36;
const DRAG_THRESHOLD = 5;

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

function formatGutterLabel(hour: number, minute: number): string {
  const ampm = hour >= 12 ? "PM" : "AM";
  const h = hour % 12 || 12;
  if (minute === 0) return `${h} ${ampm}`;
  return `${h}:${String(minute).padStart(2, "0")} ${ampm}`;
}

function minutesFromBase(baseH: number, baseM: number, h: number, m: number): number {
  return (h - baseH) * 60 + (m - baseM);
}

function formatHHMM(h: number, m: number): string {
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function dateToString(d: Date): string {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${day}`;
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
  currentDate,
}: DaySwimLanesProps) {
  const startHour = minTime.getHours();
  const startMinute = minTime.getMinutes();
  const endHour = maxTime.getHours();
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

  const hasUnassigned = events.some((e) => !e.resourceId);

  const columns: Array<{ id: string; label: string }> = useMemo(() => {
    const cols = mechanics.map((m) => ({ id: m._id, label: m.name }));
    if (hasUnassigned) cols.push({ id: "__unassigned__", label: "Unassigned" });
    return cols;
  }, [mechanics, hasUnassigned]);

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
          <div className="h-9 border-b border-border" />
          <div className="relative" style={{ height: totalHeight }}>
            {slots.map((s, i) => (
              <div
                key={i}
                className="absolute right-0 pr-2 text-xs text-muted-foreground"
                style={{
                  top: i * ROW_HEIGHT - 7,
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

                {/* Gridlines */}
                {slots.map((s, i) => (
                  <div
                    key={i}
                    className={`absolute left-0 right-0 pointer-events-none ${
                      s.minute === 0
                        ? "border-b border-border"
                        : "border-b border-border/40"
                    }`}
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
                    startHour,
                    startMinute,
                    ev.start.getHours(),
                    ev.start.getMinutes(),
                  );
                  const evDuration =
                    (ev.end.getTime() - ev.start.getTime()) / 60000;
                  const top = (evStartMin / totalMinutes) * totalHeight;
                  const height = (evDuration / totalMinutes) * totalHeight;
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
                        className="absolute left-1 right-1 rounded-md text-xs px-2 py-1 overflow-hidden z-10"
                        style={{
                          top: Math.max(0, top),
                          height: Math.max(ROW_HEIGHT * 0.8, height),
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
                      className={`absolute left-1 right-1 rounded-md text-xs px-2 py-1 overflow-hidden z-10 select-none ${
                        isDraggable
                          ? "cursor-grab active:cursor-grabbing"
                          : "cursor-pointer"
                      }`}
                      style={{
                        top: Math.max(0, top),
                        height: Math.max(ROW_HEIGHT * 0.8, height),
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
