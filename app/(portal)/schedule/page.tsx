"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  CalendarOff,
  CalendarPlus,
  Car,
  ChevronLeft,
  ChevronRight,
  Clock,
  Copy,
  Info,
  Loader2,
  MessageCircle,
  Pen,
  Tag,
  Trash2,
  Utensils,
  Wrench,
  X,
} from "lucide-react";
import {
  BOOKING_STATUS_LEGEND_KEYS,
  getBookingStatusLabel,
} from "@/lib/booking-status";
import { usePortalSidebar } from "../portal-context";
import { statusColors, dateToString } from "./schedule-constants";
import type { CalendarEvent } from "./schedule-constants";
import { Calendar, dateFnsLocalizer, Views } from "react-big-calendar";
import {
  Select,
  SelectItem,
  SelectListBox,
  SelectPopover,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { format, parse, startOfWeek, getDay, addDays, subDays, startOfMonth, endOfMonth, addMonths, subMonths } from "date-fns";
import { enUS } from "date-fns/locale/en-US";
import "react-big-calendar/lib/css/react-big-calendar.css";
import "./schedule.css";
import DaySwimLanes from "./day-swim-lanes";
import type { RescheduleProposal, ContextMenuCellInfo, ContextMenuBlockedInfo } from "./day-swim-lanes";
import WeekSwimLanes from "./week-swim-lanes";
import JobDetailPanel, { type JobDetailPanelHandle } from "@/components/job-detail-panel";
import CreateBookingDrawer from "./create-booking-drawer";

/* ------------------------------------------------------------------ */
/*  Localizer setup                                                     */
/* ------------------------------------------------------------------ */

const locales = { "en-US": enUS };
const localizer = dateFnsLocalizer({ format, parse, startOfWeek, getDay, locales });

/* ------------------------------------------------------------------ */
/*  Types                                                               */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

function formatDateRange(date: Date): string {
  return format(date, "MMMM yyyy");
}

function getWeekRange(date: Date) {
  const start = startOfWeek(date, { weekStartsOn: 0 });
  return {
    from: dateToString(start),
    to: dateToString(addDays(start, 6)),
  };
}

function getMonthRange(date: Date) {
  return {
    from: dateToString(startOfMonth(date)),
    to: dateToString(endOfMonth(date)),
  };
}

function getDayRange(date: Date) {
  return {
    from: dateToString(date),
    to: dateToString(date),
  };
}

function formatTimeLabel(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const hour = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, "0")} ${ampm}`;
}

function formatTimeLabelCompact(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const ampm = h >= 12 ? "pm" : "am";
  const hour = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, "0")}${ampm}`;
}

/** Returns true if the [startTime, endTime) window overlaps an existing manually-blocked slot for the given mechanic/date.
 *  Pass excludeSlotId to skip the slot currently being edited. */
function overlapsBlockedSlot(
  mechanicId: string,
  date: string,
  startTime: string,
  endTime: string,
  blockedSlots: Array<{ _id: string; date: string; startTime: string; endTime: string; mechanicId: string | null }>,
  excludeSlotId?: string
): boolean {
  const toMins = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
  const newStart = toMins(startTime);
  const newEnd = toMins(endTime);
  return blockedSlots.some((s) => {
    if (excludeSlotId && s._id === excludeSlotId) return false;
    if (s.date !== date) return false;
    if (s.mechanicId !== mechanicId) return false;
    return toMins(s.startTime) < newEnd && toMins(s.endTime) > newStart;
  });
}

/** Returns true if the [startTime, endTime) window overlaps any active booking for the given mechanic/date. */
function overlapsMechanicBooking(
  mechanicId: string,
  date: string,
  startTime: string,
  endTime: string,
  bookings: Array<{ scheduledDate: string; scheduledTime: string; estimatedMinutes: number; status: string; mechanicId: string | null }>
): boolean {
  const toMins = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
  const blockStart = toMins(startTime);
  const blockEnd = toMins(endTime);
  return bookings.some((b) => {
    if (b.scheduledDate !== date) return false;
    if (b.status === "cancelled" || b.status === "declined") return false;
    if (b.mechanicId !== mechanicId) return false;
    const bStart = toMins(b.scheduledTime);
    const bEnd = bStart + (b.estimatedMinutes ?? 60);
    return bStart < blockEnd && bEnd > blockStart;
  });
}

function generateTimeOptions(): Array<{ value: string; label: string }> {
  const options: Array<{ value: string; label: string }> = [];
  for (let h = 0; h < 24; h++) {
    for (const m of [0, 15, 30, 45]) {
      const value = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
      const ampm = h >= 12 ? "pm" : "am";
      const hour = h % 12 || 12;
      const label = `${hour}:${String(m).padStart(2, "0")}${ampm}`;
      options.push({ value, label });
    }
  }
  return options;
}

/* ------------------------------------------------------------------ */
/*  Block time type defaults                                            */
/* ------------------------------------------------------------------ */

const BUILT_IN_TYPES = [
  { id: "break", label: "Break", Icon: Clock },
  { id: "lunch", label: "Lunch", Icon: Utensils },
  { id: "meeting", label: "Meeting", Icon: MessageCircle },
  { id: "maintenance", label: "Maintenance", Icon: Wrench },
  { id: "pickup", label: "Pickup", Icon: Car },
  { id: "personal", label: "Personal", Icon: CalendarOff },
];

/* ------------------------------------------------------------------ */
/*  Main component                                                      */
/* ------------------------------------------------------------------ */

export default function SchedulePage() {
  const [currentDate, setCurrentDate] = useState(new Date());
  const [currentView, setCurrentView] = useState<"month" | "week" | "day">("week");
  const [mechanicFilter, setMechanicFilter] = useState<string>("all");
  const [selectedBookingId, setSelectedBookingId] = useState<Id<"bookings"> | null>(null);
  const [toast, setToast] = useState<{ msg: string; key: number } | null>(null);
  const [rescheduleProposal, setRescheduleProposal] = useState<RescheduleProposal | null>(null);
  const [rescheduleError, setRescheduleError] = useState("");
  const [isRescheduling, setIsRescheduling] = useState(false);
  const [contextMenu, setContextMenu] = useState<
    | { type: "block"; info: ContextMenuCellInfo }
    | { type: "unblock"; slotId: string; clientX: number; clientY: number }
    | { type: "deleteBlockType"; typeId: string; title: string; clientX: number; clientY: number }
    | null
  >(null);

  // Create booking drawer
  const [createBookingDrawer, setCreateBookingDrawer] = useState<{
    date: string;
    time: string;
    mechanicId: string;
  } | null>(null);

  // Block-full-day confirmation dialog
  const [blockDayConfirm, setBlockDayConfirm] = useState<{
    mechanicId: string;
    mechanicName: string;
    date: string;
    bookingCount: number;
  } | null>(null);

  // Blocked time drawer state
  const [blockTimeDrawer, setBlockTimeDrawer] = useState<{
    mechanicId: string;
    mechanicName: string;
    date: string;
    startTime: string;
    endTime: string;
    editingSlotId?: string;
    initialTitle?: string;
    initialDescription?: string;
  } | null>(null);
  const [btTitle, setBtTitle] = useState("");
  const [btDate, setBtDate] = useState("");
  const [btFrom, setBtFrom] = useState("");
  const [btTo, setBtTo] = useState("");
  const [btMechanicId, setBtMechanicId] = useState("");
  const [btDescription, setBtDescription] = useState("");
  const [btType, setBtType] = useState("custom");
  const [saveAsType, setSaveAsType] = useState(false);
  const savedBlockTypesQuery = useQuery(api.schedule.getBlockTimeTypes);
  const [btSaving, setBtSaving] = useState(false);

  const jobDetailRef = useRef<JobDetailPanelHandle>(null);

  const savedBlockTypes = savedBlockTypesQuery ?? [];
  const saveBlockTimeType = useMutation(api.schedule.saveBlockTimeType);
  const deleteBlockTimeType = useMutation(api.schedule.deleteBlockTimeType);

  const proposeReschedule = useMutation(api.bookings.proposeReschedule);
  const blockSlot = useMutation(api.schedule.blockSlot);
  const updateBlockedSlot = useMutation(api.schedule.updateBlockedSlot);
  const unblockSlot = useMutation(api.schedule.unblockSlot);
  const blockMechanicDay = useMutation(api.schedule.blockMechanicDay);
  const copyBlockedToNextWeek = useMutation(api.schedule.copyBlockedSlotsToNextWeek);
  const [isCopyingBlocks, setIsCopyingBlocks] = useState(false);
  const [legendOpen, setLegendOpen] = useState(false);
  const legendRef = useRef<HTMLDivElement>(null);
  const context = useQuery(api.schedule.getScheduleContext);

  const selectedJobDetail = useQuery(
    api.bookings.getJobDetail,
    selectedBookingId ? { bookingId: selectedBookingId } : "skip"
  );

  // Sidebar compresses when either drawer is open (same pattern as jobs page)
  const drawerOpen = !!blockTimeDrawer;
  const { setSidebarCompact } = usePortalSidebar();
  useEffect(() => {
    setSidebarCompact(drawerOpen || !!selectedBookingId);
    return () => setSidebarCompact(false);
  }, [drawerOpen, selectedBookingId, setSidebarCompact]);

  // Pre-fill drawer form fields when drawer opens
  useEffect(() => {
    if (blockTimeDrawer) {
      const initialTitle = blockTimeDrawer.initialTitle ?? "";
      setBtTitle(initialTitle);
      setBtDate(blockTimeDrawer.date);
      setBtFrom(blockTimeDrawer.startTime);
      setBtTo(blockTimeDrawer.endTime);
      setBtMechanicId(blockTimeDrawer.mechanicId);
      setBtDescription(blockTimeDrawer.initialDescription ?? "");
      // Detect type from title
      const builtIn = BUILT_IN_TYPES.find((t) => t.label.toLowerCase() === initialTitle.toLowerCase());
      if (builtIn) {
        setBtType(builtIn.id);
      } else {
        const matched = savedBlockTypes.find((t) => t.title === initialTitle);
        setBtType(matched ? matched._id : "custom");
      }
      setSaveAsType(false);
    }
  }, [blockTimeDrawer]); // eslint-disable-line react-hooks/exhaustive-deps

  // Close drawer on Escape
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setBlockTimeDrawer(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  // Auto-clear toast after 3s; key changes on every trigger so the timer always resets
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  // Dismiss legend popover on click-outside
  useEffect(() => {
    if (!legendOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (legendRef.current?.contains(e.target as Node)) return;
      setLegendOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [legendOpen]);

  // Keyboard shortcuts for the job detail modal
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!selectedBookingId) return;

      if (e.key === "Escape") {
        if ((e.target as HTMLElement).closest("[data-assign-dropdown]")) return;
        if (jobDetailRef.current?.handleEscape()) return;
        setSelectedBookingId(null);
        return;
      }

      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if ((e.target as HTMLElement).closest("[data-assign-dropdown]")) return;

      // Delegate modal-specific keys (decline/complete/cancel confirmation)
      if (jobDetailRef.current?.handleKeyDown(e)) {
        e.preventDefault();
        return;
      }

      // Action hotkeys — only when no sub-modal is open
      if (selectedJobDetail && !jobDetailRef.current?.hasOpenModal()) {
        const s = selectedJobDetail.status;
        const isPending = s === "pending" || s === "pending_shop_acceptance";
        const isActive = s === "confirmed" || s === "in_progress";
        if (e.key === "a" && isPending) { e.preventDefault(); jobDetailRef.current?.accept(); return; }
        if (e.key === "d" && isPending) { e.preventDefault(); jobDetailRef.current?.showDecline(); return; }
        if (e.key === "r" && isActive) { e.preventDefault(); jobDetailRef.current?.showMarkCompleted(); return; }
        if (e.key === "c" && isActive) { e.preventDefault(); jobDetailRef.current?.showCancelJob(); return; }
        if (e.key === "a" && !isPending) { e.preventDefault(); jobDetailRef.current?.openAssignDropdown(); return; }
        if (e.key === "t" && s === "confirmed" && selectedJobDetail.mechanicId) { e.preventDefault(); jobDetailRef.current?.startJob(); return; }
        if (e.key === "s" && !isPending) { e.preventDefault(); jobDetailRef.current?.assignMechanic(); return; }
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [selectedBookingId, selectedJobDetail]);

  // Dismiss context menu on click-outside or Escape
  const contextMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!contextMenu) return;
    const dismiss = (e: PointerEvent) => {
      // Don't dismiss if click is inside the context menu itself
      if (contextMenuRef.current?.contains(e.target as Node)) return;
      setContextMenu(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setContextMenu(null); };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", onKey);
    };
  }, [contextMenu]);

  // Context menu action handlers
  const handleBlockSlot = useCallback(async (info: ContextMenuCellInfo) => {
    setContextMenu(null);
    try {
      await blockSlot({
        mechanicId: info.mechanicId as Id<"mechanics">,
        date: info.date,
        startTime: info.startTime,
        endTime: info.endTime,
      });
      setToast({ msg: `Blocked ${formatTimeLabel(info.startTime)}–${formatTimeLabel(info.endTime)} for ${info.mechanicName}`, key: Date.now() });
    } catch (err: unknown) {
      setToast({ msg: err instanceof Error ? err.message : "Failed to block slot", key: Date.now() });
    }
  }, [blockSlot]);

  const bookingsRef = useRef<typeof bookings>(undefined);
  const handleBlockFullDay = useCallback(async (mechanicId: string, mechanicName: string, date: string, force = false) => {
    setContextMenu(null);

    // Check existing bookings for this mechanic on this date before calling the mutation
    if (!force) {
      const current = bookingsRef.current;
      if (current) {
        const count = current.filter(
          (b) => b.mechanicId === mechanicId && b.scheduledDate === date &&
                 b.status !== "cancelled" && b.status !== "declined"
        ).length;
        if (count > 0) {
          setBlockDayConfirm({ mechanicId, mechanicName, date, bookingCount: count });
          return;
        }
      }
    }

    try {
      await blockMechanicDay({
        mechanicId: mechanicId as Id<"mechanics">,
        date,
        ...(force ? { force: true } : {}),
      });
      setToast({ msg: `Blocked full day for ${mechanicName}`, key: Date.now() });
      setBlockDayConfirm(null);
    } catch (err: unknown) {
      setToast({ msg: err instanceof Error ? err.message : "Failed to block day", key: Date.now() });
    }
  }, [blockMechanicDay]);

  const handleUnblockSlot = useCallback(async (slotId: string) => {
    setContextMenu(null);
    try {
      await unblockSlot({ slotId: slotId as Id<"time_slots"> });
      setToast({ msg: "Slot unblocked", key: Date.now() });
    } catch (err: unknown) {
      setToast({ msg: err instanceof Error ? err.message : "Failed to unblock slot", key: Date.now() });
    }
  }, [unblockSlot]);

  // Reschedule handlers
  const handleProposeReschedule = useCallback((proposal: RescheduleProposal) => {
    setRescheduleProposal(proposal);
    setRescheduleError("");
  }, []);

  async function handleConfirmReschedule() {
    if (!rescheduleProposal) return;
    setIsRescheduling(true);
    setRescheduleError("");
    try {
      await proposeReschedule({
        bookingId: rescheduleProposal.eventId as Id<"bookings">,
        newScheduledDate: rescheduleProposal.newDate,
        newScheduledTime: rescheduleProposal.newTime,
        newMechanicId: rescheduleProposal.newMechanicId
          ? (rescheduleProposal.newMechanicId as Id<"mechanics">)
          : undefined,
      });
      setRescheduleProposal(null);
      setToast({ msg: "Reschedule proposed — awaiting customer approval", key: Date.now() });
    } catch (err: unknown) {
      setRescheduleError(
        err instanceof Error ? err.message : "Could not propose reschedule.",
      );
    } finally {
      setIsRescheduling(false);
    }
  }

  // Compute date range based on current view
  const dateRange = useMemo(() => {
    if (currentView === "month") return getMonthRange(currentDate);
    if (currentView === "day") return getDayRange(currentDate);
    return getWeekRange(currentDate);
  }, [currentDate, currentView]);

  const bookings = useQuery(api.schedule.getBookingsForRange, {
    dateFrom: dateRange.from,
    dateTo: dateRange.to,
  });
  bookingsRef.current = bookings;

  const blockedSlots = useQuery(api.schedule.getBlockedSlots, {
    dateFrom: dateRange.from,
    dateTo: dateRange.to,
  });

  // Map bookings to calendar events
  const events: CalendarEvent[] = useMemo(() => {
    if (!bookings) return [];
    const bookingEvents: CalendarEvent[] = bookings
      .filter((b) => mechanicFilter === "all" || b.mechanicId === mechanicFilter)
      .map((b) => {
        const [h, m] = b.scheduledTime.split(":").map(Number);
        const start = new Date(b.scheduledDate + "T00:00:00");
        start.setHours(h, m, 0, 0);
        const end = new Date(start.getTime() + (b.estimatedMinutes ?? 60) * 60 * 1000);

        return {
          id: b._id,
          title: `${b.customerName} — ${b.serviceNames.join(", ")}`,
          start,
          end,
          resourceId: b.mechanicId ?? undefined,
          type: "booking" as const,
          status: b.status,
          customerName: b.customerName,
          mechanicName: b.mechanicName,
          serviceNames: b.serviceNames,
          totalCost: b.totalCost,
        };
      });

    // Merge blocked slots as "blocked" events
    const blockedEvents: CalendarEvent[] = (blockedSlots ?? [])
      .filter((s) => mechanicFilter === "all" || s.mechanicId === mechanicFilter)
      .map((s) => {
        const [sh, sm] = s.startTime.split(":").map(Number);
        const [eh, em] = s.endTime.split(":").map(Number);
        const start = new Date(s.date + "T00:00:00");
        start.setHours(sh, sm, 0, 0);
        const end = new Date(s.date + "T00:00:00");
        end.setHours(eh, em, 0, 0);
        return {
          id: `blocked-${s._id}`,
          slotId: s._id,
          title: "Blocked",
          start,
          end,
          resourceId: s.mechanicId ?? undefined,
          type: "blocked" as const,
          status: "blocked",
          blockTitle: s.title ?? null,
          note: s.note ?? null,
        };
      });

    return [...bookingEvents, ...blockedEvents];
  }, [bookings, blockedSlots, mechanicFilter]);

  // Day view: determine which mechanics to show as columns
  const dayViewMechanics = useMemo(() => {
    if (!context?.mechanics) return [];
    if (mechanicFilter !== "all") {
      return context.mechanics.filter((m) => m._id === mechanicFilter);
    }
    return context.mechanics;
  }, [context?.mechanics, mechanicFilter]);

  // Always use swim lanes for the day view
  const useDaySwimLanes = currentView === "day";

  // Constrain time grid to operating hours
  const { minTime, maxTime } = useMemo(() => {
    let earliest = 24;
    let latest = 0;
    if (context?.hours) {
      for (const h of context.hours) {
        if (h.isClosed) continue;
        const [oh] = h.openTime.split(":").map(Number);
        const [ch] = h.closeTime.split(":").map(Number);
        if (oh < earliest) earliest = oh;
        if (ch > latest) latest = ch;
      }
    }
    if (earliest >= latest) { earliest = 0; latest = 24; }
    return {
      minTime: new Date(0, 0, 0, earliest, 0),
      // hour=24 rolls over via Date constructor: use next-day midnight (day=1, hour=0) as sentinel
      maxTime: latest === 24 ? new Date(0, 0, 1, 0, 0) : new Date(0, 0, 0, latest, 0),
    };
  }, [context?.hours]);

  // Navigation handlers
  const handleNavigate = useCallback((date: Date) => {
    setCurrentDate(date);
  }, []);

  const handleViewChange = useCallback((view: string) => {
    setCurrentView(view as "month" | "week" | "day");
  }, []);

  const goToday = useCallback(() => setCurrentDate(new Date()), []);

  const goBack = useCallback(() => {
    if (currentView === "month") setCurrentDate((d) => subMonths(d, 1));
    else if (currentView === "week") setCurrentDate((d) => subDays(d, 7));
    else setCurrentDate((d) => subDays(d, 1));
  }, [currentView]);

  const goForward = useCallback(() => {
    if (currentView === "month") setCurrentDate((d) => addMonths(d, 1));
    else if (currentView === "week") setCurrentDate((d) => addDays(d, 7));
    else setCurrentDate((d) => addDays(d, 1));
  }, [currentView]);

  // Custom event component — abbreviated in week view
  const EventComponent = useCallback(({ event }: { event: CalendarEvent }) => {
    const colors = statusColors[event.status ?? "confirmed"] ?? statusColors.confirmed;
    const customerDisplay = currentView === "week"
      ? (event.customerName?.split(" ")[0] ?? "")
      : (event.customerName ?? "");
    const isPendingCustomer = event.status === "pending_customer_acceptance";
    return (
      <div
        className="px-1.5 py-0.5 rounded text-[11px] leading-tight overflow-hidden h-full"
        style={{
          backgroundColor: colors.bg,
          color: colors.text,
          borderLeft: isPendingCustomer
            ? `3px dashed ${colors.border}`
            : `3px solid ${colors.border}`,
        }}
      >
        <p className="font-medium truncate">{customerDisplay}</p>
        <p className="truncate opacity-80">{event.serviceNames?.join(", ")}</p>
        {isPendingCustomer && (
          <p className="truncate opacity-70 text-[10px]">Awaiting approval</p>
        )}
      </div>
    );
  }, [currentView]);

  // Custom toolbar — we render our own
  const CustomToolbar = useCallback(() => null, []);

  const mechanics = context?.mechanics ?? [];

  if (context === undefined) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="w-8 h-8 text-primary animate-spin" />
      </div>
    );
  }

  if (context === null) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold text-foreground">Schedule</h1>
        <div className="bg-card rounded-xl border border-border p-8 text-center text-muted-foreground">
          This page is for shop team members. If you need access, reach out to your shop owner.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-foreground">Schedule</h1>
      </div>

      {/* Flex row: main content + drawer */}
      <div className="flex items-start">
      {/* Main content */}
      <div className="flex-1 min-w-0 space-y-6">

      {/* Toolbar: nav + view switcher + mechanic filter */}
      <div className="bg-card border border-border rounded-xl p-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          {/* Left: navigation */}
          <div className="flex items-center gap-2">
            <button
              onClick={goToday}
              className="px-3 py-1.5 text-sm font-medium rounded-lg border border-border hover:bg-muted transition-colors"
            >
              Today
            </button>
            <button
              onClick={goBack}
              className="p-1.5 rounded-lg hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
            <button
              onClick={goForward}
              className="p-1.5 rounded-lg hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
            <h2 className="text-base font-semibold text-foreground ml-2">
              {currentView === "day"
                ? format(currentDate, "EEEE, MMMM d, yyyy")
                : currentView === "week"
                ? `${format(startOfWeek(currentDate, { weekStartsOn: 0 }), "MMM d")} – ${format(addDays(startOfWeek(currentDate, { weekStartsOn: 0 }), 6), "MMM d, yyyy")}`
                : formatDateRange(currentDate)}
            </h2>
          </div>

          {/* Right: filters + view switcher */}
          <div className="flex items-center gap-3">
            {/* Mechanic filter */}
            {context.mechanics.length > 0 && (
              <Select
                selectedKey={mechanicFilter}
                onSelectionChange={(key) => setMechanicFilter(String(key))}
              >
                <SelectTrigger className="h-9 rounded-lg border-border bg-card text-sm px-3 min-w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopover placement="bottom end">
                  <SelectListBox shouldFocusWrap>
                    <SelectItem id="all" textValue="All Mechanics">All Mechanics</SelectItem>
                    {context.mechanics.map((m) => (
                      <SelectItem key={m._id} id={m._id} textValue={m.name}>
                        {m.name}
                      </SelectItem>
                    ))}
                  </SelectListBox>
                </SelectPopover>
              </Select>
            )}

            {/* Legend popover */}
            <div className="relative" ref={legendRef}>
              <button
                onClick={() => setLegendOpen((o) => !o)}
                className="p-1.5 rounded-lg hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
                title="Status legend"
              >
                <Info className="w-5 h-5" />
              </button>
              {legendOpen && (
                <div className="absolute top-full right-0 mt-1 z-50 bg-card border border-border rounded-lg shadow-lg p-3 min-w-[200px]">
                  <p className="text-xs font-medium text-muted-foreground mb-2">Status Legend</p>
                  <div className="flex flex-col gap-1.5">
                    {BOOKING_STATUS_LEGEND_KEYS.map((key) => {
                        const colors = statusColors[key];
                        if (!colors) return null;
                        return (
                          <div key={key} className="flex items-center gap-1.5">
                            <div
                              className="w-3 h-3 rounded-sm shrink-0"
                              style={{ backgroundColor: colors.border }}
                            />
                            <span className="text-xs text-foreground">{getBookingStatusLabel(key)}</span>
                          </div>
                        );
                      })}
                    <div className="flex items-center gap-1.5">
                      <div className="w-3 h-3 rounded-sm blocked-slot-pattern shrink-0" />
                      <span className="text-xs text-foreground">Blocked</span>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Copy blocks to next week — week view only */}
            {currentView === "week" && (
              <button
                disabled={isCopyingBlocks}
                onClick={async () => {
                  setIsCopyingBlocks(true);
                  try {
                    const weekStartDate = dateToString(startOfWeek(currentDate, { weekStartsOn: 0 }));
                    const result = await copyBlockedToNextWeek({ weekStartDate });
                    setToast({ msg: `Copied ${result.copied} blocked slot(s) to next week`, key: Date.now() });
                  } catch (err: unknown) {
                    setToast({ msg: err instanceof Error ? err.message : "Failed to copy blocks", key: Date.now() });
                  } finally {
                    setIsCopyingBlocks(false);
                  }
                }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg border border-border hover:bg-muted transition-colors disabled:opacity-50"
              >
                {isCopyingBlocks ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
                Copy blocks to next week
              </button>
            )}

            {/* View switcher */}
            <div className="flex border border-border rounded-lg overflow-hidden">
              {(["day", "week", "month"] as const).map((view) => (
                <button
                  key={view}
                  onClick={() => handleViewChange(view)}
                  className={`px-3 py-1.5 text-sm font-medium transition-colors ${
                    currentView === view
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  }`}
                >
                  {view.charAt(0).toUpperCase() + view.slice(1)}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>


      {/* Calendar */}
      <div className="bg-card border border-border rounded-xl overflow-hidden schedule-calendar relative">
        {bookings === undefined ? (
          <div className="flex items-center justify-center h-[600px]">
            <Loader2 className="w-6 h-6 text-primary animate-spin" />
          </div>
        ) : null}
        {bookings !== undefined && currentView === "day" && useDaySwimLanes && (
          <DaySwimLanes
            mechanics={dayViewMechanics}
            events={events}
            minTime={minTime}
            maxTime={maxTime}
            currentDate={currentDate}
            onSelectEvent={(ev) => setSelectedBookingId(ev.id as Id<"bookings">)}
            onProposeReschedule={handleProposeReschedule}
            onDragError={(msg) => setToast({ msg, key: Date.now() })}
            onContextMenuCell={(info) => {
              if (
                bookings &&
                overlapsMechanicBooking(info.mechanicId, info.date, info.startTime, info.endTime, bookings)
              ) return;
              setContextMenu({ type: "block", info });
            }}
            onContextMenuBlocked={(info) => setContextMenu({ type: "unblock", slotId: info.slotId, clientX: info.clientX, clientY: info.clientY })}
            onSelectBlocked={(info) => {
              const mech = context?.mechanics.find((m) => m._id === info.mechanicId);
              setBlockTimeDrawer({
                mechanicId: info.mechanicId ?? "",
                mechanicName: mech ? mech.name : "",
                date: info.date,
                startTime: info.startTime,
                endTime: info.endTime,
                editingSlotId: info.slotId,
                initialTitle: info.blockTitle ?? undefined,
                initialDescription: info.note ?? undefined,
              });
            }}
            onBlockDayClick={(mechanicId, mechanicName) => handleBlockFullDay(mechanicId, mechanicName, dateToString(currentDate))}
          />
        )}
        {bookings !== undefined && currentView === "week" && (
          <WeekSwimLanes
            mechanics={context.mechanics}
            events={events}
            weekStart={startOfWeek(currentDate, { weekStartsOn: 0 })}
            shopHours={context.hours}
            onNavigateToDay={(date, mechanicId) => {
              setCurrentDate(date);
              setCurrentView("day");
              if (mechanicId) setMechanicFilter(mechanicId);
            }}
            onBlockDay={(mechanicId, mechanicName, date) => handleBlockFullDay(mechanicId, mechanicName, date)}
          />
        )}
        {bookings !== undefined && !(currentView === "day" && useDaySwimLanes) && currentView !== "week" && (
          <Calendar
            localizer={localizer}
            events={events.filter((e) => e.type !== "blocked")}
            startAccessor="start"
            endAccessor="end"
            date={currentDate}
            view={currentView}
            onNavigate={handleNavigate}
            onView={handleViewChange as any}
            min={minTime}
            max={maxTime}
            getNow={() => new Date()}
            step={30}
            timeslots={2}
            style={{ height: "calc(100vh - 320px)", minHeight: 500 }}
            onSelectEvent={(event) => setSelectedBookingId((event as CalendarEvent).id as Id<"bookings">)}
            formats={{
              dayFormat: (date: Date) => format(date, "EEE d"),
              weekdayFormat: (date: Date) => format(date, "EEE"),
            }}
            components={{
              event: EventComponent as any,
              toolbar: CustomToolbar as any,
            }}
            eventPropGetter={() => ({
              style: {
                backgroundColor: "transparent",
                border: "none",
                padding: 0,
              },
            })}
            dayPropGetter={(date) => {
              const today = new Date();
              const isToday =
                date.getDate() === today.getDate() &&
                date.getMonth() === today.getMonth() &&
                date.getFullYear() === today.getFullYear();
              return {
                /* --primary rgb(82,153,254) at 3% opacity */
                style: isToday ? { backgroundColor: "rgba(82, 153, 254, 0.03)" } : {},
              };
            }}
          />
        )}
      </div>


      </div>{/* end main content */}

      {/* Blocked time drawer */}
      <div
        className={`flex-shrink-0 overflow-hidden transition-[width] duration-200 ease-out ${
          drawerOpen ? "w-[420px]" : "w-0"
        }`}
      >
        <div className="w-[396px] ml-6 flex flex-col border border-border bg-card rounded-xl overflow-hidden">
          {blockTimeDrawer && (
            <div className="flex flex-col h-full">
              {/* Header */}
              <div className="flex items-center justify-between px-5 py-4 border-b border-border">
                <h2 className="text-base font-semibold text-foreground">{blockTimeDrawer.editingSlotId ? "Edit blocked time" : "Add blocked time"}</h2>
                <button
                  onClick={() => setBlockTimeDrawer(null)}
                  className="p-1 rounded-lg hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Body */}
              <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">
                {/* Block time type */}
                <div>
                  <label className="text-sm font-medium text-foreground mb-2 block">Block time type</label>
                  <div className="flex gap-3 overflow-x-auto pb-1 scrollbar-none">
                    <div
                      onClick={() => setBtType("custom")}
                      className={`flex flex-col items-center gap-1.5 px-5 py-3 border-2 rounded-xl cursor-pointer transition-colors shrink-0 ${
                        btType === "custom" ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50"
                      }`}
                    >
                      <Pen className="w-5 h-5 text-foreground" />
                      <span className="text-xs font-medium text-foreground">Custom</span>
                    </div>
                    {BUILT_IN_TYPES.map(({ id, label, Icon }) => (
                      <div
                        key={id}
                        onClick={() => { setBtType(id); setBtTitle(label); }}
                        className={`flex flex-col items-center gap-1.5 px-5 py-3 border-2 rounded-xl cursor-pointer transition-colors shrink-0 ${
                          btType === id ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50"
                        }`}
                      >
                        <Icon className="w-5 h-5 text-foreground" />
                        <span className="text-xs font-medium text-foreground">{label}</span>
                      </div>
                    ))}
                    {savedBlockTypes.map((t) => (
                      <div
                        key={t._id}
                        onClick={() => { setBtType(t._id); setBtTitle(t.title); }}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setContextMenu({ type: "deleteBlockType", typeId: t._id, title: t.title, clientX: e.clientX, clientY: e.clientY });
                        }}
                        className={`flex flex-col items-center gap-1.5 px-5 py-3 border-2 rounded-xl cursor-pointer transition-colors shrink-0 ${
                          btType === t._id ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50"
                        }`}
                      >
                        <Tag className="w-5 h-5 text-foreground" />
                        <span className="text-xs font-medium text-foreground">{t.title}</span>
                      </div>
                    ))}
                  </div>

                  {/* "Save as new block time type?" toggle — only for custom type with a title */}
                  {btType === "custom" && btTitle.trim() && (
                    <div className="flex items-center justify-between mt-3">
                      <span className="text-sm text-muted-foreground">Save as new block time type?</span>
                      <button
                        role="switch"
                        aria-checked={saveAsType}
                        onClick={() => setSaveAsType(!saveAsType)}
                        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-200 ease-in-out focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-1 ${
                          saveAsType ? "bg-primary" : "bg-muted-foreground/25"
                        }`}
                      >
                        <span
                          className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform duration-200 ease-in-out ${
                            saveAsType ? "translate-x-[18px]" : "translate-x-[3px]"
                          }`}
                        />
                      </button>
                    </div>
                  )}
                </div>

                {/* Title — only shown for custom type */}
                {btType === "custom" && (
                  <div>
                    <label className="text-sm font-medium text-foreground mb-1.5 block">Title</label>
                    <input
                      type="text"
                      placeholder="e.g. lunch meeting (optional)"
                      value={btTitle}
                      onChange={(e) => setBtTitle(e.target.value)}
                      className="w-full px-3 py-2.5 text-sm border border-border rounded-lg bg-card text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors"
                    />
                  </div>
                )}

                {/* Date */}
                <div>
                  <label className="text-sm font-medium text-foreground mb-1.5 block">Date</label>
                  <input
                    type="date"
                    value={btDate}
                    onChange={(e) => setBtDate(e.target.value)}
                    className="w-full px-3 py-2.5 text-sm border border-border rounded-lg bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors"
                  />
                </div>

                {/* From / To */}
                <div className="flex gap-3">
                  <div className="flex-1">
                    <label className="text-sm font-medium text-foreground mb-1.5 block">From</label>
                    <select
                      value={btFrom}
                      onChange={(e) => setBtFrom(e.target.value)}
                      className="w-full px-3 py-2.5 text-sm border border-border rounded-lg bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors"
                    >
                      {generateTimeOptions().map((t) => (
                        <option key={t.value} value={t.value}>{t.label}</option>
                      ))}
                    </select>
                  </div>
                  <div className="flex-1">
                    <label className="text-sm font-medium text-foreground mb-1.5 block">To</label>
                    <select
                      value={btTo}
                      onChange={(e) => setBtTo(e.target.value)}
                      className="w-full px-3 py-2.5 text-sm border border-border rounded-lg bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors"
                    >
                      {generateTimeOptions().map((t) => (
                        <option key={t.value} value={t.value}>{t.label}</option>
                      ))}
                    </select>
                  </div>
                </div>
                {btFrom && btTo && btMechanicId && btDate && bookings &&
                  overlapsMechanicBooking(btMechanicId, btDate, btFrom, btTo, bookings) && (
                  <p className="text-xs text-destructive">
                    This time overlaps an existing booking and cannot be blocked.
                  </p>
                )}
                {btFrom && btTo && btMechanicId && btDate && blockedSlots &&
                  !overlapsMechanicBooking(btMechanicId, btDate, btFrom, btTo, bookings ?? []) &&
                  overlapsBlockedSlot(btMechanicId, btDate, btFrom, btTo, blockedSlots, blockTimeDrawer?.editingSlotId) && (
                  <p className="text-xs text-destructive">
                    Cannot add blocked time onto a time already blocked.
                  </p>
                )}

                {/* Team member */}
                <div>
                  <label className="text-sm font-medium text-foreground mb-1.5 block">Team member</label>
                  <select
                    value={btMechanicId}
                    onChange={(e) => setBtMechanicId(e.target.value)}
                    className="w-full px-3 py-2.5 text-sm border border-border rounded-lg bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors"
                  >
                    <option value="">Select team member</option>
                    {mechanics.map((m) => (
                      <option key={m._id} value={m._id}>{m.name}</option>
                    ))}
                  </select>
                </div>

                {/* Frequency */}
                <div>
                  <label className="text-sm font-medium text-foreground mb-1.5 block">Frequency</label>
                  <select
                    disabled
                    className="w-full px-3 py-2.5 text-sm border border-border rounded-lg bg-muted text-foreground cursor-not-allowed"
                  >
                    <option>Doesn&apos;t repeat</option>
                  </select>
                </div>

                {/* Description */}
                <div>
                  <label className="text-sm font-medium text-foreground mb-1.5 block">
                    Description <span className="font-normal text-muted-foreground">(Optional)</span>
                  </label>
                  <div className="relative">
                    <textarea
                      placeholder="Add description or note"
                      value={btDescription}
                      onChange={(e) => {
                        if (e.target.value.length <= 255) setBtDescription(e.target.value);
                      }}
                      rows={3}
                      className="w-full px-3 py-2.5 text-sm border border-border rounded-lg bg-card text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors resize-none"
                    />
                    <span className="absolute bottom-2 right-3 text-[10px] text-muted-foreground">
                      {btDescription.length}/255
                    </span>
                  </div>
                </div>
              </div>

              {/* Footer */}
              <div className="px-5 py-4 border-t border-border">
                <button
                  disabled={
                    btSaving || !btDate || !btFrom || !btTo || !btMechanicId ||
                    !!(bookings && overlapsMechanicBooking(btMechanicId, btDate, btFrom, btTo, bookings)) ||
                    !!(blockedSlots && overlapsBlockedSlot(btMechanicId, btDate, btFrom, btTo, blockedSlots, blockTimeDrawer?.editingSlotId))
                  }
                  onClick={async () => {
                    setBtSaving(true);
                    try {
                      if (blockTimeDrawer.editingSlotId) {
                        await updateBlockedSlot({
                          slotId: blockTimeDrawer.editingSlotId as Id<"time_slots">,
                          mechanicId: btMechanicId as Id<"mechanics">,
                          date: btDate,
                          startTime: btFrom,
                          endTime: btTo,
                          ...(btTitle.trim() ? { title: btTitle.trim() } : {}),
                          ...(btDescription.trim() ? { note: btDescription.trim() } : {}),
                        });
                        setToast({ msg: "Blocked time updated", key: Date.now() });
                      } else {
                        await blockSlot({
                          mechanicId: btMechanicId as Id<"mechanics">,
                          date: btDate,
                          startTime: btFrom,
                          endTime: btTo,
                          ...(btTitle.trim() ? { title: btTitle.trim() } : {}),
                          ...(btDescription.trim() ? { note: btDescription.trim() } : {}),
                        });
                        setToast({ msg: `Blocked ${formatTimeLabel(btFrom)}–${formatTimeLabel(btTo)} for ${blockTimeDrawer.mechanicName}`, key: Date.now() });
                      }
                      // Persist as a new saved type if the toggle is on and the title isn't already a known type
                      if (saveAsType && btTitle.trim() && btType === "custom") {
                        const trimmed = btTitle.trim().toLowerCase();
                        const alreadyExists =
                          BUILT_IN_TYPES.some((t) => t.label.toLowerCase() === trimmed) ||
                          savedBlockTypes.some((t) => t.title.toLowerCase() === trimmed);
                        if (!alreadyExists) {
                          await saveBlockTimeType({ title: btTitle.trim() });
                        }
                      }
                      setBlockTimeDrawer(null);
                    } catch (err: unknown) {
                      setToast({ msg: err instanceof Error ? err.message : "Failed to save blocked time", key: Date.now() });
                    } finally {
                      setBtSaving(false);
                    }
                  }}
                  className="w-full py-2.5 text-sm font-medium rounded-lg bg-primary text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-40 inline-flex items-center justify-center gap-2"
                >
                  {btSaving && <Loader2 className="w-4 h-4 animate-spin" />}
                  {blockTimeDrawer.editingSlotId ? "Update" : "Save"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Job detail drawer */}
      <div className={`flex-shrink-0 overflow-hidden transition-[width] duration-200 ease-out ${selectedBookingId ? "w-[504px]" : "w-0"}`}>
        <div className="w-[480px] ml-6 flex flex-col border border-border bg-card rounded-xl overflow-hidden sticky top-6 h-[calc(100vh-3rem)]">
          {selectedBookingId && (
            <JobDetailPanel
              ref={jobDetailRef}
              job={selectedJobDetail}
              mechanics={mechanics}
              onClose={() => setSelectedBookingId(null)}
              onSuccess={(msg) => setToast({ msg, key: Date.now() })}
              showJobsLink
            />
          )}
        </div>
      </div>

      {/* Create booking drawer */}
      {createBookingDrawer && (
        <div className="flex-shrink-0 self-stretch w-[420px]">
          <div className="w-[396px] ml-6 flex flex-col border border-border bg-card rounded-xl overflow-hidden h-full">
            <CreateBookingDrawer
              initialDate={createBookingDrawer.date}
              initialTime={createBookingDrawer.time}
              initialMechanicId={createBookingDrawer.mechanicId}
              mechanics={mechanics}
              bookings={bookings ?? []}
              onClose={() => setCreateBookingDrawer(null)}
              onToast={(msg) => setToast({ msg, key: Date.now() })}
            />
          </div>
        </div>
      )}

      </div>{/* end flex row */}

      {/* Reschedule confirmation dialog */}
      {rescheduleProposal && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/20 backdrop-blur-sm"
            onClick={() => setRescheduleProposal(null)}
          />
          <div className="relative bg-card rounded-xl border border-border shadow-xl p-5 w-full max-w-sm">
            <h3 className="text-base font-semibold text-foreground mb-2">
              Reschedule this booking?
            </h3>
            <div className="text-sm text-muted-foreground mb-4 space-y-1">
              {rescheduleProposal.timeChanged && rescheduleProposal.mechanicChanged ? (
                <p>
                  Move from{" "}
                  <span className="font-medium text-foreground">
                    {rescheduleProposal.originalMechanicName ?? "Unassigned"}
                  </span>{" "}
                  at{" "}
                  <span className="font-medium text-foreground">
                    {formatTimeLabel(rescheduleProposal.originalTime)}
                  </span>{" "}
                  to{" "}
                  <span className="font-medium text-foreground">
                    {rescheduleProposal.newMechanicName ?? "Unassigned"}
                  </span>{" "}
                  at{" "}
                  <span className="font-medium text-foreground">
                    {formatTimeLabel(rescheduleProposal.newTime)}
                  </span>
                  ?
                </p>
              ) : rescheduleProposal.timeChanged ? (
                <p>
                  Move from{" "}
                  <span className="font-medium text-foreground">
                    {formatTimeLabel(rescheduleProposal.originalTime)}
                  </span>{" "}
                  to{" "}
                  <span className="font-medium text-foreground">
                    {formatTimeLabel(rescheduleProposal.newTime)}
                  </span>
                  ? The customer will be asked to approve the new time.
                </p>
              ) : (
                <p>
                  Reassign from{" "}
                  <span className="font-medium text-foreground">
                    {rescheduleProposal.originalMechanicName ?? "Unassigned"}
                  </span>{" "}
                  to{" "}
                  <span className="font-medium text-foreground">
                    {rescheduleProposal.newMechanicName ?? "Unassigned"}
                  </span>
                  ? The customer will be asked to approve the change.
                </p>
              )}
              <p className="text-xs text-muted-foreground mt-2">
                The booking will be set to Pending Customer until the customer responds. If they
                don&apos;t respond within 24 hours, the original time will be restored automatically.
              </p>
            </div>
            {rescheduleError && (
              <p className="text-xs text-destructive mb-3">{rescheduleError}</p>
            )}
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setRescheduleProposal(null)}
                disabled={isRescheduling}
                className="px-3 py-2 text-sm rounded-lg border border-border hover:bg-muted transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmReschedule}
                disabled={isRescheduling}
                className="px-3 py-2 text-sm rounded-lg bg-primary text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50 inline-flex items-center gap-1.5"
              >
                {isRescheduling && (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                )}
                {isRescheduling ? "Confirming…" : "Confirm reschedule"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Right-click context menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-[80] bg-card border border-border rounded-xl shadow-2xl overflow-hidden min-w-[220px]"
          style={
            contextMenu.type === "deleteBlockType"
              ? { right: window.innerWidth - contextMenu.clientX - 6, top: contextMenu.clientY }
              : {
                  left: contextMenu.type === "block" ? contextMenu.info.clientX : contextMenu.clientX,
                  top: contextMenu.type === "block" ? contextMenu.info.clientY : contextMenu.clientY,
                }
          }
          onPointerDown={(e) => e.stopPropagation()}
        >
          {contextMenu.type === "block" && (
            <>
              {/* Time header */}
              <div className="px-4 py-3 border-b border-border">
                <span className="text-sm font-semibold text-foreground">
                  {formatTimeLabelCompact(contextMenu.info.startTime)}
                </span>
              </div>
              {/* Menu items */}
              <div className="py-1">
                <button
                  className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-foreground hover:bg-muted transition-colors"
                  onClick={() => {
                    setCreateBookingDrawer({
                      date: contextMenu.info.date,
                      time: contextMenu.info.startTime,
                      mechanicId: contextMenu.info.mechanicId,
                    });
                    setContextMenu(null);
                  }}
                >
                  <CalendarPlus className="w-4 h-4 text-muted-foreground shrink-0" />
                  Create new booking
                </button>
                <button
                  className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-foreground hover:bg-muted transition-colors"
                  onClick={() => {
                    setBlockTimeDrawer({
                      mechanicId: contextMenu.info.mechanicId,
                      mechanicName: contextMenu.info.mechanicName,
                      date: contextMenu.info.date,
                      startTime: contextMenu.info.startTime,
                      endTime: contextMenu.info.endTime,
                    });
                    setContextMenu(null);
                  }}
                >
                  <CalendarOff className="w-4 h-4 text-muted-foreground shrink-0" />
                  Add blocked time
                </button>
              </div>
            </>
          )}
          {contextMenu.type === "unblock" && (
            <div className="py-1">
              <button
                className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-foreground hover:bg-muted transition-colors"
                onClick={() => handleUnblockSlot(contextMenu.slotId)}
              >
                <CalendarOff className="w-4 h-4 text-muted-foreground shrink-0" />
                Unblock this slot
              </button>
            </div>
          )}
          {contextMenu.type === "deleteBlockType" && (
            <>
              <div className="py-1">
                <button
                  className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-destructive hover:bg-muted transition-colors"
                  onClick={async () => {
                    setContextMenu(null);
                    if (btType === contextMenu.typeId) { setBtType("custom"); setBtTitle(""); }
                    try {
                      await deleteBlockTimeType({ typeId: contextMenu.typeId as Id<"block_time_types"> });
                    } catch (err: unknown) {
                      setToast({ msg: err instanceof Error ? err.message : "Failed to delete type", key: Date.now() });
                    }
                  }}
                >
                  <Trash2 className="w-4 h-4 shrink-0" />
                  Delete block time type
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Success toast — shown outside modals when neither is open */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-[70] bg-card border border-border rounded-lg shadow-lg px-4 py-3 text-sm text-foreground select-none pointer-events-none">
          {toast.msg}
        </div>
      )}

      {/* Block-full-day confirmation dialog */}
      {blockDayConfirm && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center"
        >
          <div className="absolute inset-0 bg-black/20 backdrop-blur-sm" onClick={() => setBlockDayConfirm(null)} />
          <div className="relative bg-card border border-border rounded-xl shadow-xl p-6 w-full max-w-sm mx-4">
            <h3 className="text-base font-semibold text-foreground mb-2">Block remaining time?</h3>
            <p className="text-sm text-muted-foreground mb-5">
              <span className="font-medium text-foreground">{blockDayConfirm.mechanicName}</span> has{" "}
              {blockDayConfirm.bookingCount} existing booking{blockDayConfirm.bookingCount !== 1 ? "s" : ""} on this day.
              Confirming will block all open time around those bookings and clear any existing manual blocks.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setBlockDayConfirm(null)}
                className="flex-1 px-4 py-2 text-sm font-medium border border-border rounded-lg hover:bg-muted transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => handleBlockFullDay(blockDayConfirm.mechanicId, blockDayConfirm.mechanicName, blockDayConfirm.date, true)}
                className="flex-1 px-4 py-2 text-sm font-semibold bg-primary text-primary-foreground rounded-lg hover:opacity-90 transition-opacity"
              >
                Block remaining time
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
