"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { findNextAvailableSlot } from "@/lib/findNextAvailableSlot";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Calendar as CalendarIcon,
  CalendarOff,
  CalendarPlus,
  Car,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Clock,
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
  BOOKING_STATUS_VISUALS,
  getBookingStatusLabel,
  type BookingStatus,
} from "@/lib/booking-status";
import { usePortalSidebar } from "../portal-context";
import {
  statusColors,
  dateToString,
  getPendingApprovalLabel,
} from "./schedule-constants";
import type { CalendarEvent } from "./schedule-constants";
import {
  getBookingEndTime,
  overlapsBlockedSlot,
  overlapsMechanicBooking,
} from "@/lib/schedule-overlap";
import { Calendar, dateFnsLocalizer } from "react-big-calendar";
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
import type { RescheduleProposal, ContextMenuCellInfo } from "./day-swim-lanes";
import WeekSwimLanes from "./week-swim-lanes";
import WeekSingleMechanicLanes from "./week-single-mechanic-lanes";
import BookingDetailPanel, { type JobDetailPanelHandle } from "@/components/booking-detail-panel";
import ConfirmationDialog, { ShortcutLabel } from "@/components/confirmation-dialog";
import {
  drawerInputClassName,
  drawerPrimaryButtonClassName,
  drawerSelectTriggerClassName,
  drawerTextareaClassName,
  DrawerFieldLabel,
  DrawerSectionHeader,
} from "@/components/drawer-panel-styles";
import RescheduleConfirmationDialog from "@/components/reschedule-confirmation-dialog";
import LateStartReviewDialog, {
  type LateStartReviewView,
} from "@/components/late-start-review-dialog";
import CreateBookingDrawer from "./create-booking-drawer";
import DatePicker from "@/components/ui/date-picker";

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

function formatDecisionDueTime(timestampMs: number): string {
  return new Date(timestampMs).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

function hhmmToMinutes(hhmm: string): number {
  const [hours, minutes] = hhmm.split(":").map(Number);
  return hours * 60 + minutes;
}

function roundUpToQuarter(minutes: number): number {
  return Math.min(24 * 60, Math.ceil(minutes / 15) * 15);
}

function minutesToCalendarDate(totalMinutes: number): Date {
  if (totalMinutes >= 24 * 60) {
    return new Date(0, 0, 1, 0, 0);
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return new Date(0, 0, 0, hours, minutes);
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

function getDayOfWeekFromDateString(date: string) {
  return new Date(`${date}T00:00:00`).getDay();
}

function bookingFallsOutsideShopHours(
  shopHours: Array<{
    dayOfWeek: number;
    openTime: string;
    closeTime: string;
    isClosed: boolean;
  }>,
  {
    date,
    startTime,
    estimatedMinutes,
  }: {
    date: string;
    startTime: string;
    estimatedMinutes: number;
  }
) {
  const hours = shopHours.find((entry) => entry.dayOfWeek === getDayOfWeekFromDateString(date));
  if (!hours || hours.isClosed) return true;

  const startMinutes = hhmmToMinutes(startTime);
  const endMinutes = hhmmToMinutes(getBookingEndTime(startTime, estimatedMinutes));
  const openMinutes = hhmmToMinutes(hours.openTime);
  const closeMinutes = hhmmToMinutes(hours.closeTime);

  return startMinutes < openMinutes || startMinutes >= closeMinutes || endMinutes > closeMinutes;
}

const MONTH_STATUS_ORDER = [
  "pending_shop_acceptance",
  "pending_customer_acceptance",
  "confirmed",
  "vehicle_at_shop",
  "in_progress",
  "completed",
  "cancelled",
  "declined",
  "no_show",
];

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
  const [nowTimestamp, setNowTimestamp] = useState(() => Date.now());
  const [currentView, setCurrentView] = useState<"month" | "week" | "day">("day");
  const [mechanicFilter, setMechanicFilter] = useState<string>("all");
  const [selectedBookingId, setSelectedBookingId] = useState<Id<"bookings"> | null>(null);
  const [toast, setToast] = useState<{ msg: string; key: number } | null>(null);
  const [rescheduleProposal, setRescheduleProposal] = useState<RescheduleProposal | null>(null);
  const [rescheduleError, setRescheduleError] = useState("");
  const [isRescheduling, setIsRescheduling] = useState(false);
  const [noShowReschedule, setNoShowReschedule] = useState<{
    bookingId: string;
    customerName: string;
    date: string;
    time: string;
    mechanicId: string;
  } | null>(null);
  const [noShowRescheduleError, setNoShowRescheduleError] = useState("");
  const [isSubmittingNoShowReschedule, setIsSubmittingNoShowReschedule] = useState(false);
  const [selectedLateStartReviewId, setSelectedLateStartReviewId] = useState<string | null>(null);
  const [lateStartReviewError, setLateStartReviewError] = useState("");
  const [isSubmittingLateStartReview, setIsSubmittingLateStartReview] = useState(false);
  const [contextMenu, setContextMenu] = useState<
    | { type: "block"; info: ContextMenuCellInfo }
    | { type: "unblock"; slotId: string; clientX: number; clientY: number }
    | { type: "deleteBlockType"; typeId: string; title: string; clientX: number; clientY: number }
    | { type: "blockDay"; mechanicId: string; mechanicName: string; date: string; isBlocked: boolean; slotId?: string; clientX: number; clientY: number }
    | null
  >(null);
  const [contextMenuStyle, setContextMenuStyle] = useState<CSSProperties | null>(null);

  // Create booking drawer (lifted draft state — drives drawer + ghost block on calendar)
  const [createBookingDrawer, setCreateBookingDrawer] = useState<{
    date: string;
    time: string;
    mechanicId: string;
    durationMinutes: number;
  } | null>(null);

  const router = useRouter();
  const searchParams = useSearchParams();
  const autoOpenedRef = useRef(false);

  // Block-full-day confirmation dialog
  const [blockDayConfirm, setBlockDayConfirm] = useState<{
    mechanicId: string;
    mechanicName: string;
    date: string;
    bookingCount: number;
  } | null>(null);
  const [lateStartOutsideHoursConfirm, setLateStartOutsideHoursConfirm] = useState<{
    reviewId: string;
    targets: Array<{
      bookingId: string;
      newScheduledDate: string;
      newScheduledTime: string;
      newMechanicId?: string;
    }>;
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
  const [btFrequency, setBtFrequency] = useState<"none" | "daily" | "weekly" | "biweekly" | "monthly">("none");
  const [btUntil, setBtUntil] = useState("");
  const [saveAsType, setSaveAsType] = useState(false);
  const savedBlockTypesQuery = useQuery(api.schedule.getBlockTimeTypes);
  const [btSaving, setBtSaving] = useState(false);

  const jobDetailRef = useRef<JobDetailPanelHandle>(null);
  const seenLateStartReviewIdsRef = useRef<Set<string>>(new Set());

  const savedBlockTypes = savedBlockTypesQuery ?? [];
  const saveBlockTimeType = useMutation(api.schedule.saveBlockTimeType);
  const deleteBlockTimeType = useMutation(api.schedule.deleteBlockTimeType);

  const proposeReschedule = useMutation(api.bookings.proposeReschedule);
  const markVehicleAtShop = useMutation(api.bookings.markVehicleAtShop);
  const markPostThresholdNoShow = useMutation(api.bookings.markPostThresholdNoShow);
  const rescheduleFromNoShowAlert = useMutation(api.bookings.rescheduleFromNoShowAlert);
  const answerOverrunExtension = useMutation(api.bookings.answerOverrunExtension);
  const acceptLateStartReview = useMutation(api.bookings.acceptLateStartReview);
  const denyLateStartReview = useMutation(api.bookings.denyLateStartReview);
  const applyManualLateStartReview = useMutation(api.bookings.applyManualLateStartReview);
  const blockSlot = useMutation(api.schedule.blockSlot);
  const updateBlockedSlot = useMutation(api.schedule.updateBlockedSlot);
  const unblockSlot = useMutation(api.schedule.unblockSlot);
  const blockMechanicDay = useMutation(api.schedule.blockMechanicDay);

  const [legendOpen, setLegendOpen] = useState(false);
  const legendRef = useRef<HTMLDivElement>(null);
  const context = useQuery(api.schedule.getScheduleContext);
  const portalAccess = useQuery(api.shops.getMyPortalAccess);
  const viewerMechanicId =
    portalAccess && portalAccess.status === "active"
      ? (portalAccess.mechanicId ?? null)
      : null;
  const isMechanicViewer =
    portalAccess?.status === "active" &&
    (portalAccess.role === "shop_mechanic" || portalAccess.role === "mechanic");

  useEffect(() => {
    if (isMechanicViewer && viewerMechanicId && mechanicFilter !== viewerMechanicId) {
      setMechanicFilter(viewerMechanicId);
    }
  }, [isMechanicViewer, viewerMechanicId, mechanicFilter]);
  const lateStartReviews = useQuery(api.bookings.getOpenLateStartReviews);
  const customerLateAlerts = useQuery(api.bookings.getOpenCustomerLateAlerts);
  const frontDeskOverrunAlerts = useQuery(api.bookings.getOpenFrontDeskOverrunAlerts);
  const manualSchedulingAlerts = useQuery(api.bookings.getOpenManualSchedulingAlerts);

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
      setBtFrequency("none");
      setBtUntil("");
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

  // Close create booking drawer on Escape
  useEffect(() => {
    if (!createBookingDrawer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCreateBookingDrawer(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [createBookingDrawer]);

  // Two-way sync: when user navigates the schedule (Today/Back/Forward) while drawer is open,
  // update draft.date so the form follows. The draft → currentDate direction is handled below
  // in the drawer's onDraftChange handler.
  useEffect(() => {
    if (!createBookingDrawer) return;
    const dateStr = dateToString(currentDate);
    if (createBookingDrawer.date === dateStr) return;
    setCreateBookingDrawer((prev) => (prev ? { ...prev, date: dateStr } : prev));
  }, [currentDate, createBookingDrawer]);

  // Force day view while a draft is active so the ghost block is visible
  useEffect(() => {
    if (createBookingDrawer && currentView !== "day") {
      setCurrentView("day");
    }
  }, [createBookingDrawer, currentView]);

  // Auto-clear toast after 3s; key changes on every trigger so the timer always resets
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    const updateNow = () => setNowTimestamp(Date.now());
    updateNow();
    const intervalId = window.setInterval(updateNow, 30_000);
    return () => window.clearInterval(intervalId);
  }, []);

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
        const isActive =
          s === "confirmed" || s === "vehicle_at_shop" || s === "in_progress";
        if (e.key === "a" && isPending) { e.preventDefault(); jobDetailRef.current?.accept(); return; }
        if (e.key === "d" && isPending) { e.preventDefault(); jobDetailRef.current?.showDecline(); return; }
        if (e.key === "r" && isActive) { e.preventDefault(); jobDetailRef.current?.showMarkCompleted(); return; }
        if (e.key === "c" && isActive) { e.preventDefault(); jobDetailRef.current?.showCancelJob(); return; }
        if (e.key === "a" && !isPending) { e.preventDefault(); jobDetailRef.current?.openAssignDropdown(); return; }
        if (e.key === "t" && s === "vehicle_at_shop" && selectedJobDetail.mechanicId) { e.preventDefault(); jobDetailRef.current?.startJob(); return; }
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

  useEffect(() => {
    if (!contextMenu) {
      setContextMenuStyle(null);
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      const menu = contextMenuRef.current;
      if (!menu) return;

      const rect = menu.getBoundingClientRect();
      const margin = 8;
      const anchor =
        contextMenu.type === "block"
          ? {
              x: contextMenu.info.clientX,
              y: contextMenu.info.clientY,
            }
          : {
              x: contextMenu.clientX,
              y: contextMenu.clientY,
            };

      const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
      const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);
      const left = Math.min(Math.max(anchor.x, margin), maxLeft);
      const top =
        anchor.y + rect.height + margin > window.innerHeight
          ? Math.max(margin, anchor.y - rect.height)
          : Math.min(Math.max(anchor.y, margin), maxTop);

      setContextMenuStyle({
        left,
        top,
        visibility: "visible",
      });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [contextMenu]);

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

  async function handleMarkVehicleHereFromAlert(bookingId: string) {
    try {
      await markVehicleAtShop({ bookingId: bookingId as Id<"bookings"> });
      setToast({ msg: "Vehicle marked here", key: Date.now() });
    } catch (err: unknown) {
      setToast({ msg: err instanceof Error ? err.message : "Could not mark vehicle here", key: Date.now() });
    }
  }

  async function handleMarkNoShowFromAlert(bookingId: string) {
    try {
      await markPostThresholdNoShow({ bookingId: bookingId as Id<"bookings"> });
      setToast({ msg: "Booking marked no-show", key: Date.now() });
    } catch (err: unknown) {
      setToast({ msg: err instanceof Error ? err.message : "Could not mark no-show", key: Date.now() });
    }
  }

  async function handleSubmitNoShowReschedule() {
    if (!noShowReschedule) return;
    setIsSubmittingNoShowReschedule(true);
    setNoShowRescheduleError("");
    try {
      await rescheduleFromNoShowAlert({
        bookingId: noShowReschedule.bookingId as Id<"bookings">,
        newScheduledDate: noShowReschedule.date,
        newScheduledTime: noShowReschedule.time,
        newMechanicId: noShowReschedule.mechanicId
          ? (noShowReschedule.mechanicId as Id<"mechanics">)
          : undefined,
        assignmentPreference: noShowReschedule.mechanicId
          ? "specific_mechanic"
          : "any",
      });
      setNoShowReschedule(null);
      setToast({ msg: "Booking rescheduled", key: Date.now() });
    } catch (err: unknown) {
      setNoShowRescheduleError(
        err instanceof Error ? err.message : "Could not reschedule booking.",
      );
    } finally {
      setIsSubmittingNoShowReschedule(false);
    }
  }

  async function handleOverrunExtension(bookingId: string, extensionMinutes: number) {
    try {
      await answerOverrunExtension({
        bookingId: bookingId as Id<"bookings">,
        extensionMinutes,
      });
      setToast({ msg: `Overrun extended ${extensionMinutes} minutes`, key: Date.now() });
    } catch (err: unknown) {
      setToast({ msg: err instanceof Error ? err.message : "Could not save overrun response", key: Date.now() });
    }
  }

  async function handleAcceptLateStartReview(reviewId: string) {
    setLateStartReviewError("");
    setIsSubmittingLateStartReview(true);
    try {
      await acceptLateStartReview({ reviewId: reviewId as Id<"late_start_reviews"> });
      setSelectedLateStartReviewId(null);
      setToast({ msg: "Late-start delay applied", key: Date.now() });
    } catch (err: unknown) {
      setLateStartReviewError(
        err instanceof Error ? err.message : "Could not apply the late-start delay.",
      );
    } finally {
      setIsSubmittingLateStartReview(false);
    }
  }

  async function handleDenyLateStartReview(reviewId: string) {
    setLateStartReviewError("");
    setIsSubmittingLateStartReview(true);
    try {
      await denyLateStartReview({ reviewId: reviewId as Id<"late_start_reviews"> });
      setSelectedLateStartReviewId(null);
      setToast({ msg: "Late-start delay snoozed until the next checkpoint", key: Date.now() });
    } catch (err: unknown) {
      setLateStartReviewError(
        err instanceof Error ? err.message : "Could not snooze the late-start delay.",
      );
    } finally {
      setIsSubmittingLateStartReview(false);
    }
  }

  async function handleApplyManualLateStartReview(
    reviewId: string,
    targets: Array<{
      bookingId: string;
      newScheduledDate: string;
      newScheduledTime: string;
      newMechanicId?: string;
    }>,
    allowOutsideShopHours = false
  ) {
    setLateStartReviewError("");
    setIsSubmittingLateStartReview(true);
    try {
      const reviewForAction =
        lateStartReviews?.find((review) => review._id === reviewId) ?? null;
      if (
        !allowOutsideShopHours &&
        context?.hours &&
        reviewForAction?.proposals.some((proposal) => {
          const target = targets.find((item) => item.bookingId === proposal.bookingId);
          if (!target) return false;
          return bookingFallsOutsideShopHours(context.hours, {
            date: target.newScheduledDate,
            startTime: target.newScheduledTime,
            estimatedMinutes: proposal.estimatedMinutes,
          });
        })
      ) {
        setLateStartOutsideHoursConfirm({ reviewId, targets });
        setLateStartReviewError("");
        return;
      }

      await applyManualLateStartReview({
        reviewId: reviewId as Id<"late_start_reviews">,
        manualTargets: targets.map((target) => ({
          bookingId: target.bookingId as Id<"bookings">,
          newScheduledDate: target.newScheduledDate,
          newScheduledTime: target.newScheduledTime,
          newMechanicId: target.newMechanicId
            ? (target.newMechanicId as Id<"mechanics">)
            : undefined,
          allowOutsideShopHours: allowOutsideShopHours || undefined,
        })),
      });
      setSelectedLateStartReviewId(null);
      setLateStartOutsideHoursConfirm(null);
      setToast({ msg: "Manual late-start delay applied", key: Date.now() });
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Could not apply the manual late-start delay.";
      if (
        !allowOutsideShopHours &&
        (
          message.includes("This booking would end after the shop closes.") ||
          message.includes("The requested start time is outside the shop's operating hours.")
        )
      ) {
        setLateStartOutsideHoursConfirm({ reviewId, targets });
        setLateStartReviewError("");
        return;
      }
      setLateStartReviewError(
        message,
      );
    } finally {
      setIsSubmittingLateStartReview(false);
    }
  }

  const openLateStartReview = useCallback((reviewId: string) => {
    setLateStartReviewError("");
    setSelectedLateStartReviewId(reviewId);
  }, []);

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

  // Wider lookahead used only when auto-opening the create-booking drawer to find the
  // next available slot across the next 14 days.
  const wantsAutoOpen = searchParams.get("action") === "newBooking";
  const lookaheadRange = useMemo(() => {
    const start = new Date();
    const end = new Date();
    end.setDate(start.getDate() + 13);
    return { dateFrom: dateToString(start), dateTo: dateToString(end) };
  }, []);
  const lookaheadBookings = useQuery(
    api.schedule.getBookingsForRange,
    wantsAutoOpen && !autoOpenedRef.current ? lookaheadRange : "skip"
  );

  const blockedSlots = useQuery(api.schedule.getBlockedSlots, {
    dateFrom: dateRange.from,
    dateTo: dateRange.to,
  });

  // Auto-open create-booking drawer with next available slot when ?action=newBooking is set.
  useEffect(() => {
    if (autoOpenedRef.current) return;
    if (!wantsAutoOpen) return;
    if (!context?.hours || !context?.mechanics || lookaheadBookings === undefined) return;

    autoOpenedRef.current = true;

    const slot = findNextAvailableSlot({
      now: new Date(),
      shopHours: context.hours,
      mechanics: context.mechanics,
      bookings: lookaheadBookings,
      durationMinutes: 60,
    });

    if (slot) {
      const [y, mo, d] = slot.date.split("-").map(Number);
      setCurrentDate(new Date(y, mo - 1, d));
      setCurrentView("day");
      setCreateBookingDrawer({
        date: slot.date,
        time: slot.time,
        mechanicId: slot.mechanicId,
        durationMinutes: slot.durationMinutes,
      });
    } else {
      // Fallback: open with the soonest possible time today
      const todayStr = dateToString(new Date());
      const fallbackMechanic = context.mechanics[0]?._id ?? "";
      setCreateBookingDrawer({
        date: todayStr,
        time: "09:00",
        mechanicId: fallbackMechanic,
        durationMinutes: 60,
      });
      setToast({ msg: "No open slot found in the next 14 days", key: Date.now() });
    }

    router.replace("/schedule", { scroll: false });
  }, [wantsAutoOpen, context?.hours, context?.mechanics, lookaheadBookings, router]);

  const selectedLateStartReview = useMemo<LateStartReviewView | null>(() => {
    if (!lateStartReviews || !selectedLateStartReviewId) return null;
    return (
      lateStartReviews.find((review) => review._id === selectedLateStartReviewId) ??
      null
    );
  }, [lateStartReviews, selectedLateStartReviewId]);

  useEffect(() => {
    if (!selectedLateStartReviewId || selectedLateStartReview) return;
    setSelectedLateStartReviewId(null);
    setLateStartReviewError("");
  }, [selectedLateStartReviewId, selectedLateStartReview]);

  useEffect(() => {
    if (!lateStartReviews) return;

    const seenIds = seenLateStartReviewIdsRef.current;
    const nextIds = new Set(lateStartReviews.map((review) => review._id));
    const newReview = lateStartReviews.find((review) => !seenIds.has(review._id)) ?? null;

    seenLateStartReviewIdsRef.current = nextIds;

    if (!newReview || selectedLateStartReviewId) {
      return;
    }

    setLateStartReviewError("");
    setSelectedLateStartReviewId(newReview._id);
    setToast({ msg: "Late-start decision needed", key: Date.now() });
  }, [lateStartReviews, selectedLateStartReviewId]);

  // Map bookings to calendar events
  const events: CalendarEvent[] = useMemo(() => {
    if (!bookings) return [];
    const bookingEvents: CalendarEvent[] = bookings
      .filter((b) => mechanicFilter === "all" || b.mechanicId === mechanicFilter)
      .map((b) => {
        const [h, m] = b.scheduledTime.split(":").map(Number);
        const endTime = getBookingEndTime(
          b.scheduledTime,
          b.estimatedMinutes
        );
        const [eh, em] = endTime.split(":").map(Number);
        const start = new Date(b.scheduledDate + "T00:00:00");
        start.setHours(h, m, 0, 0);
        const end = new Date(b.scheduledDate + "T00:00:00");
        end.setHours(eh, em, 0, 0);

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
          scheduleChangeMode: b.scheduleChangeMode,
          customerCanRestoreOriginal: b.customerCanRestoreOriginal,
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

    // Draft preview while the Add blocked time drawer is open
    const draftEvents: CalendarEvent[] = [];
    const draftValid =
      blockTimeDrawer &&
      !blockTimeDrawer.editingSlotId &&
      btDate &&
      btFrom &&
      btTo &&
      btTo > btFrom &&
      btMechanicId &&
      (mechanicFilter === "all" || mechanicFilter === btMechanicId);
    if (draftValid) {
      const draftDates: string[] = [btDate];
      if (btFrequency !== "none" && btUntil && btUntil >= btDate) {
        const [sy, sm, sd] = btDate.split("-").map(Number);
        const [uy, um, ud] = btUntil.split("-").map(Number);
        if (sy && sm && sd && uy && um && ud) {
          const endUtc = Date.UTC(uy, um - 1, ud);
          let y = sy, m = sm - 1, d = sd;
          let count = 0;
          while (count < 366) {
            const cur = Date.UTC(y, m, d);
            if (cur > endUtc) break;
            const iso = new Date(cur);
            const ds = `${iso.getUTCFullYear()}-${String(iso.getUTCMonth() + 1).padStart(2, "0")}-${String(iso.getUTCDate()).padStart(2, "0")}`;
            if (ds !== btDate) draftDates.push(ds);
            if (btFrequency === "daily") d += 1;
            else if (btFrequency === "weekly") d += 7;
            else if (btFrequency === "biweekly") d += 14;
            else m += 1;
            const norm = new Date(Date.UTC(y, m, d));
            y = norm.getUTCFullYear();
            m = norm.getUTCMonth();
            d = norm.getUTCDate();
            count++;
          }
        }
      }
      const [sh, sm] = btFrom.split(":").map(Number);
      const [eh, em] = btTo.split(":").map(Number);
      const fallbackTitle =
        btTitle.trim() ||
        BUILT_IN_TYPES.find((t) => t.id === btType)?.label ||
        savedBlockTypes.find((t) => t._id === btType)?.title ||
        "Blocked";
      for (const ds of draftDates) {
        const start = new Date(`${ds}T00:00:00`);
        start.setHours(sh, sm, 0, 0);
        const end = new Date(`${ds}T00:00:00`);
        end.setHours(eh, em, 0, 0);
        draftEvents.push({
          id: `blocked-draft-${ds}`,
          title: fallbackTitle,
          start,
          end,
          resourceId: btMechanicId,
          type: "blocked",
          status: "blocked",
          blockTitle: fallbackTitle,
          note: btDescription.trim() || null,
          isDraft: true,
        });
      }
    }

    return [...bookingEvents, ...blockedEvents, ...draftEvents];
  }, [
    bookings,
    blockedSlots,
    mechanicFilter,
    blockTimeDrawer,
    btDate,
    btFrom,
    btTo,
    btMechanicId,
    btFrequency,
    btUntil,
    btTitle,
    btDescription,
    btType,
    savedBlockTypes,
  ]);

  // For month view: collapse individual bookings into one chip per status per day
  const calendarEvents = useMemo(() => {
    const base = events.filter((e) => e.type !== "blocked");
    if (currentView !== "month") return base;

    const groups = new Map<string, { date: Date; status: string; count: number }>();
    for (const ev of base) {
      const dateStr = dateToString(ev.start);
      const status = ev.status ?? "confirmed";
      const key = `${dateStr}:${status}`;
      if (!groups.has(key)) {
        groups.set(key, { date: ev.start, status, count: 0 });
      }
      groups.get(key)!.count++;
    }

    return Array.from(groups.entries()).map(([key, { date, status, count }]) => {
      const orderIdx = MONTH_STATUS_ORDER.indexOf(status);
      const start = new Date(date);
      start.setHours(orderIdx === -1 ? 23 : orderIdx, 0, 0, 0);
      const end = new Date(start);
      end.setMinutes(30);
      return {
        id: `month-summary-${key}`,
        title: String(count),
        start,
        end,
        type: "booking" as const,
        status,
      } satisfies CalendarEvent;
    });
  }, [events, currentView]);

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

  // Constrain time grid to operating hours, but extend it in the UI if visible events run later.
  const { minTime, maxTime } = useMemo(() => {
    let earliestMinutes = 24 * 60;
    let latestMinutes = 0;
    if (context?.hours) {
      for (const h of context.hours) {
        if (h.isClosed) continue;
        earliestMinutes = Math.min(earliestMinutes, hhmmToMinutes(h.openTime));
        latestMinutes = Math.max(latestMinutes, hhmmToMinutes(h.closeTime));
      }
    }

    for (const event of events) {
      const startMinutes = event.start.getHours() * 60 + event.start.getMinutes();
      const endMinutes = event.end.getHours() * 60 + event.end.getMinutes();
      earliestMinutes = Math.min(earliestMinutes, startMinutes);
      latestMinutes = Math.max(latestMinutes, endMinutes);
    }

    if (earliestMinutes >= latestMinutes) {
      earliestMinutes = 0;
      latestMinutes = 24 * 60;
    }

    const roundedLatestMinutes = roundUpToQuarter(latestMinutes);

    return {
      minTime: minutesToCalendarDate(earliestMinutes),
      maxTime: minutesToCalendarDate(roundedLatestMinutes),
    };
  }, [context?.hours, events]);

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
    // Month view — summary chip
    if (event.id.startsWith("month-summary-")) {
      const visuals = BOOKING_STATUS_VISUALS[event.status as BookingStatus];
      if (!visuals) return null;
      return (
        <span
          className="text-[10px] font-semibold px-2 py-0.5 rounded-full inline-flex items-center gap-1 cursor-pointer w-full"
          style={{
            backgroundColor: visuals.calendarColors.border,
            color: "#fff",
          }}
        >
          <span className="font-bold">{event.title}</span>
          <span>{getBookingStatusLabel(event.status as BookingStatus)}</span>
        </span>
      );
    }

    const colors = statusColors[event.status ?? "confirmed"] ?? statusColors.confirmed;
    const customerDisplay = currentView === "week"
      ? (event.customerName?.split(" ")[0] ?? "")
      : currentView === "month"
      ? (() => {
          const parts = event.customerName?.split(" ") ?? [];
          return parts.length > 1 ? `${parts[0]} ${parts[1][0]}.` : parts[0] ?? "";
        })()
      : (event.customerName ?? "");
    const isPendingCustomer = event.status === "pending_customer_acceptance";
    const pendingLabel = getPendingApprovalLabel(event);
    return (
      <div
        className="px-1.5 py-0.5 rounded text-[11px] leading-tight overflow-hidden h-full cursor-pointer"
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
          <p className="truncate opacity-70 text-[10px]">{pendingLabel}</p>
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
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-foreground">Schedule</h1>
          {context.lateStartTestMode ? (
            <span className="inline-flex items-center rounded-full border border-amber-300 bg-amber-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-amber-800">
              Late-start test mode active
              {` (${context.lateStartTiming.warningLeadMinutes}/${context.lateStartTiming.initialCycleMinutes} min)`}
            </span>
          ) : null}
        </div>
      </div>

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
                isDisabled={isMechanicViewer}
              >
                <SelectTrigger className="h-9 rounded-lg border-border bg-card text-sm px-3 min-w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopover placement="bottom end">
                  <SelectListBox shouldFocusWrap>
                    {!isMechanicViewer && (
                      <SelectItem id="all" textValue="All Mechanics">All Mechanics</SelectItem>
                    )}
                    {context.mechanics.map((m) => (
                      <SelectItem key={m._id} id={m._id} textValue={m.name}>
                        {m.name}
                      </SelectItem>
                    ))}
                  </SelectListBox>
                </SelectPopover>
              </Select>
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
          </div>
        </div>
      </div>

      {customerLateAlerts && customerLateAlerts.length > 0 ? (
        <div className="rounded-2xl border border-orange-200 bg-orange-50 p-4 shadow-sm">
          <div className="flex items-center gap-2 text-orange-700">
            <AlertTriangle className="h-4 w-4" />
            <span className="text-xs font-semibold uppercase tracking-[0.2em]">
              No-show decisions
            </span>
          </div>
          <div className="mt-4 grid gap-3 xl:grid-cols-2">
            {customerLateAlerts.map((alert) => (
              <div
                key={String(alert._id)}
                className="rounded-2xl border border-orange-200 bg-white/90 p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-foreground">
                      {alert.customerName}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {alert.minutesLate}m late for {formatTimeLabel(alert.scheduledTime)}
                      {alert.mechanicName ? ` with ${alert.mechanicName}` : ""}
                    </p>
                    <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">
                      {[alert.vehicle, alert.serviceSummary].filter(Boolean).join(" · ")}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSelectedBookingId(alert.bookingId as Id<"bookings">)}
                    className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted"
                  >
                    Open
                  </button>
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void handleMarkVehicleHereFromAlert(String(alert.bookingId))}
                    className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
                  >
                    Vehicle here
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setNoShowReschedule({
                        bookingId: String(alert.bookingId),
                        customerName: alert.customerName,
                        date: alert.scheduledDate,
                        time: alert.scheduledTime,
                        mechanicId: alert.mechanicId ? String(alert.mechanicId) : "",
                      })
                    }
                    className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted"
                  >
                    Reschedule
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleMarkNoShowFromAlert(String(alert.bookingId))}
                    className="rounded-lg border border-orange-300 px-3 py-1.5 text-xs font-medium text-orange-800 transition-colors hover:bg-orange-100"
                  >
                    Mark no-show
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {frontDeskOverrunAlerts && frontDeskOverrunAlerts.length > 0 ? (
        <div className="rounded-2xl border border-cyan-200 bg-cyan-50 p-4 shadow-sm">
          <div className="flex items-center gap-2 text-cyan-700">
            <Clock className="h-4 w-4" />
            <span className="text-xs font-semibold uppercase tracking-[0.2em]">
              Overrun escalations
            </span>
          </div>
          <div className="mt-4 grid gap-3 xl:grid-cols-2">
            {frontDeskOverrunAlerts.map((alert) => (
              <div
                key={String(alert._id)}
                className="rounded-2xl border border-cyan-200 bg-white/90 p-4"
              >
                <p className="text-sm font-semibold text-foreground">
                  {alert.customerName}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {alert.serviceSummary}
                  {alert.mechanicName ? ` · ${alert.mechanicName}` : ""}
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  {[15, 30, 45, 60].map((minutes) => (
                    <button
                      key={minutes}
                      type="button"
                      onClick={() => void handleOverrunExtension(String(alert.bookingId), minutes)}
                      className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted"
                    >
                      +{minutes}m
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {manualSchedulingAlerts && manualSchedulingAlerts.length > 0 ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-4 shadow-sm">
          <div className="flex items-center gap-2 text-red-700">
            <AlertTriangle className="h-4 w-4" />
            <span className="text-xs font-semibold uppercase tracking-[0.2em]">
              Manual scheduling review
            </span>
          </div>
          <div className="mt-3 space-y-2">
            {manualSchedulingAlerts.map((alert) => (
              <div key={String(alert._id)} className="rounded-xl bg-white/90 px-4 py-3 text-sm text-red-900">
                {alert.reason}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {lateStartReviews && lateStartReviews.length > 0 ? (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 shadow-sm">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-amber-700">
                <AlertTriangle className="h-4 w-4" />
                <span className="text-xs font-semibold uppercase tracking-[0.2em]">
                  Late Start Decisions
                </span>
              </div>
              <h2 className="mt-2 text-lg font-semibold text-amber-950">
                {lateStartReviews.length === 1
                  ? "1 booking chain needs a delay decision"
                  : `${lateStartReviews.length} booking chains need delay decisions`}
              </h2>
              <p className="mt-1 text-sm text-amber-900/80">
                Review these before the next automatic delay applies.
              </p>
            </div>
            <button
              type="button"
              onClick={() => openLateStartReview(lateStartReviews[0]._id)}
              className="inline-flex shrink-0 items-center justify-center rounded-lg bg-amber-900 px-3.5 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
            >
              Review first alert
            </button>
          </div>

          <div className="mt-4 grid gap-3 xl:grid-cols-2">
            {lateStartReviews.map((review) => {
              const autoApplyLabel =
                review.status === "blocked_manual_review"
                  ? "Automatic delay could not be built safely."
                  : `Auto-applies at ${formatDecisionDueTime(review.decisionDueAtMs)} if nobody responds.`;
              return (
                <button
                  key={review._id}
                  type="button"
                  onClick={() => openLateStartReview(review._id)}
                  className="rounded-2xl border border-amber-200 bg-white/90 p-4 text-left transition-[border-color,box-shadow,background-color] hover:border-amber-300 hover:bg-white hover:shadow-sm"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-foreground">
                        {review.upstreamCustomerName}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Scheduled for{" "}
                        {review.upstreamScheduledTime
                          ? formatTimeLabel(review.upstreamScheduledTime)
                          : "an unscheduled time"}
                        {" "}with {review.upstreamMechanicName ?? "an assigned mechanic"}
                      </p>
                      {review.upstreamServiceSummary ? (
                        <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">
                          {review.upstreamServiceSummary}
                        </p>
                      ) : null}
                    </div>
                    <span className="rounded-full bg-amber-100 px-2.5 py-1 text-[11px] font-semibold text-amber-800">
                      +{review.cycleMinutes}m
                    </span>
                  </div>
                  <p className="mt-3 text-sm text-amber-900">{autoApplyLabel}</p>
                  <p className="mt-2 text-xs font-medium text-amber-800">
                    {review.proposals.length} affected booking
                    {review.proposals.length === 1 ? "" : "s"}
                  </p>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {/* Flex row: calendar + drawers */}
      <div className="flex items-start">
      {/* Main content */}
      <div className="flex-1 min-w-0">

      {/* Calendar */}
      <div className="bg-card border border-border rounded-xl overflow-hidden schedule-calendar relative">
        {bookings === undefined ? (
          <div className="flex items-center justify-center" style={{ height: "calc(100vh - 320px)", minHeight: 500 }}>
            <Loader2 className="w-6 h-6 text-primary animate-spin" />
          </div>
        ) : null}
        {bookings !== undefined && currentView === "day" && useDaySwimLanes && (
          <DaySwimLanes
            mechanics={dayViewMechanics}
            events={events}
            minTime={minTime}
            maxTime={maxTime}
            nowTimestamp={nowTimestamp}
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
            draftBooking={createBookingDrawer}
          />
        )}
        {bookings !== undefined && currentView === "week" && mechanicFilter === "all" && (
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
            onContextMenuBlockDay={(info) => setContextMenu({ type: "blockDay", ...info })}
          />
        )}
        {bookings !== undefined && currentView === "week" && mechanicFilter !== "all" && (() => {
          const selectedMechanic = context.mechanics.find((m) => m._id === mechanicFilter);
          if (!selectedMechanic) return null;
          return (
            <WeekSingleMechanicLanes
              mechanic={selectedMechanic}
              events={events}
              weekStart={startOfWeek(currentDate, { weekStartsOn: 0 })}
              minTime={minTime}
              maxTime={maxTime}
              nowTimestamp={nowTimestamp}
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
            />
          );
        })()}
        {bookings !== undefined && !(currentView === "day" && useDaySwimLanes) && currentView !== "week" && (
          <Calendar
            localizer={localizer}
            events={calendarEvents}
            startAccessor="start"
            endAccessor="end"
            date={currentDate}
            view={currentView}
            onNavigate={handleNavigate}
            onView={(view) =>
              handleViewChange(view as "month" | "week" | "day")
            }
            min={minTime}
            max={maxTime}
            getNow={() => new Date(nowTimestamp)}
            step={30}
            timeslots={2}
            style={{ height: "calc(100vh - 320px)", minHeight: 500 }}
            onSelectEvent={(event) => {
              const ev = event as CalendarEvent;
              if (ev.id.startsWith("month-summary-")) {
                setCurrentDate(ev.start);
                setCurrentView("day");
                return;
              }
              setSelectedBookingId(ev.id as Id<"bookings">);
            }}
            formats={{
              dayFormat: (date: Date) => format(date, "EEE d"),
              weekdayFormat: (date: Date) => format(date, "EEE"),
            }}
            components={{
              event: EventComponent,
              toolbar: CustomToolbar,
            }}
            eventPropGetter={() => ({
              style: {
                backgroundColor: "transparent",
                border: "none",
                padding: 0,
              },
            })}
            dayPropGetter={() => ({ style: {} })}
            selectable
            onSelectSlot={(slotInfo) => { setCurrentDate(slotInfo.start); setCurrentView("day"); }}
            onDrillDown={(date) => { setCurrentDate(date); setCurrentView("day"); }}
            drilldownView="day"
          />
        )}
      </div>


      </div>{/* end main content */}

      {/* Blocked time drawer */}
      <div
        className={`flex-shrink-0 overflow-hidden transition-[width] duration-200 ease-out ${
          drawerOpen ? "w-[552px]" : "w-0"
        }`}
      >
        <div className="w-[528px] ml-6 flex h-[calc(100vh-320px)] min-h-[500px] flex-col overflow-hidden rounded-2xl border border-border bg-card">
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
              <div className="flex-1 overflow-y-auto px-5 py-5 space-y-6">
                {/* Block time type */}
                <div>
                  <DrawerSectionHeader icon={CalendarOff} label="Block time type" />
                  <div className="flex gap-2.5 overflow-x-auto pb-1 scrollbar-none">
                    <div
                      onClick={() => setBtType("custom")}
                      className={`flex min-w-[106px] flex-col items-center gap-2 rounded-2xl border px-4 py-3 cursor-pointer transition-all shrink-0 ${
                        btType === "custom"
                          ? "border-primary bg-primary/5 shadow-sm"
                          : "border-transparent bg-muted/40 hover:border-primary/10 hover:bg-muted/70"
                      }`}
                    >
                      <Pen className="w-5 h-5 text-foreground" />
                      <span className="text-xs font-medium text-foreground">Custom</span>
                    </div>
                    {BUILT_IN_TYPES.map(({ id, label, Icon }) => (
                      <div
                        key={id}
                        onClick={() => { setBtType(id); setBtTitle(label); }}
                        className={`flex min-w-[106px] flex-col items-center gap-2 rounded-2xl border px-4 py-3 cursor-pointer transition-all shrink-0 ${
                          btType === id
                            ? "border-primary bg-primary/5 shadow-sm"
                            : "border-transparent bg-muted/40 hover:border-primary/10 hover:bg-muted/70"
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
                        className={`flex min-w-[106px] flex-col items-center gap-2 rounded-2xl border px-4 py-3 cursor-pointer transition-all shrink-0 ${
                          btType === t._id
                            ? "border-primary bg-primary/5 shadow-sm"
                            : "border-transparent bg-muted/40 hover:border-primary/10 hover:bg-muted/70"
                        }`}
                      >
                        <Tag className="w-5 h-5 text-foreground" />
                        <span className="text-xs font-medium text-foreground">{t.title}</span>
                      </div>
                    ))}
                  </div>

                  {/* "Save as new block time type?" toggle — only for custom type with a title */}
                  {btType === "custom" && btTitle.trim() && (
                    <div className="mt-3 flex items-center justify-between rounded-xl bg-muted/40 px-4 py-3">
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
                    <DrawerFieldLabel>Title</DrawerFieldLabel>
                    <input
                      type="text"
                      placeholder="e.g. lunch meeting (optional)"
                      value={btTitle}
                      onChange={(e) => setBtTitle(e.target.value)}
                      className={drawerInputClassName}
                    />
                  </div>
                )}

                {/* Date */}
                <div>
                  <DrawerFieldLabel>Date</DrawerFieldLabel>
                  <DatePicker value={btDate} onChange={setBtDate} />
                </div>

                {/* From / To */}
                <div className="flex gap-3">
                  <div className="flex-1">
                    <DrawerFieldLabel>From</DrawerFieldLabel>
                    <Select
                      selectedKey={btFrom}
                      onSelectionChange={(key) => {
                        const next = String(key);
                        setBtFrom(next);
                        if (btTo && btTo <= next) setBtTo("");
                      }}
                    >
                      <SelectTrigger className={drawerSelectTriggerClassName}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectPopover placement="bottom start">
                        <SelectListBox shouldFocusWrap>
                          {generateTimeOptions()
                            .filter((t) => t.value !== "23:45")
                            .map((t) => (
                              <SelectItem key={t.value} id={t.value} textValue={t.label}>{t.label}</SelectItem>
                            ))}
                        </SelectListBox>
                      </SelectPopover>
                    </Select>
                  </div>
                  <div className="flex-1">
                    <DrawerFieldLabel>To</DrawerFieldLabel>
                    <Select
                      isDisabled={!btFrom}
                      selectedKey={btTo}
                      onSelectionChange={(key) => setBtTo(String(key))}
                    >
                      <SelectTrigger className={drawerSelectTriggerClassName}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectPopover placement="bottom start">
                        <SelectListBox shouldFocusWrap>
                          {generateTimeOptions()
                            .filter((t) => !btFrom || t.value > btFrom)
                            .map((t) => (
                              <SelectItem key={t.value} id={t.value} textValue={t.label}>{t.label}</SelectItem>
                            ))}
                        </SelectListBox>
                      </SelectPopover>
                    </Select>
                  </div>
                </div>
                {btFrom && btTo && btTo <= btFrom && (
                  <p className="text-xs text-destructive">
                    End time must be after the start time.
                  </p>
                )}
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
                  <DrawerFieldLabel>Team member</DrawerFieldLabel>
                  <Select
                    selectedKey={btMechanicId || "none"}
                    onSelectionChange={(key) => setBtMechanicId(key === "none" ? "" : String(key))}
                  >
                    <SelectTrigger className={drawerSelectTriggerClassName}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopover placement="bottom start">
                      <SelectListBox shouldFocusWrap>
                        <SelectItem id="none" textValue="Select team member">
                          <span className="text-muted-foreground">Select team member</span>
                        </SelectItem>
                        {mechanics.map((m) => (
                          <SelectItem key={m._id} id={m._id} textValue={m.name}>{m.name}</SelectItem>
                        ))}
                      </SelectListBox>
                    </SelectPopover>
                  </Select>
                </div>

                {/* Frequency */}
                {!blockTimeDrawer.editingSlotId && (
                  <div>
                    <DrawerFieldLabel>Frequency</DrawerFieldLabel>
                    <Select
                      selectedKey={btFrequency}
                      onSelectionChange={(key) => {
                        const next = String(key) as typeof btFrequency;
                        setBtFrequency(next);
                        if (next !== "none" && !btUntil && btDate) {
                          const [y, m, d] = btDate.split("-").map(Number);
                          if (y && m && d) {
                            const dt = new Date(Date.UTC(y, m - 1, d + 30));
                            setBtUntil(
                              `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`,
                            );
                          }
                        }
                      }}
                    >
                      <SelectTrigger className={drawerSelectTriggerClassName}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectPopover placement="bottom start">
                        <SelectListBox>
                          <SelectItem id="none" textValue="Doesn't repeat">Doesn&apos;t repeat</SelectItem>
                          <SelectItem id="daily" textValue="Daily">Daily</SelectItem>
                          <SelectItem id="weekly" textValue="Weekly">Weekly</SelectItem>
                          <SelectItem id="biweekly" textValue="Every 2 weeks">Every 2 weeks</SelectItem>
                          <SelectItem id="monthly" textValue="Monthly">Monthly</SelectItem>
                        </SelectListBox>
                      </SelectPopover>
                    </Select>
                  </div>
                )}

                {/* Ends on */}
                {!blockTimeDrawer.editingSlotId && btFrequency !== "none" && (
                  <div>
                    <DrawerFieldLabel>Ends on</DrawerFieldLabel>
                    <DatePicker value={btUntil} onChange={setBtUntil} />
                    {btUntil && btDate && btUntil < btDate && (
                      <p className="mt-1 text-xs text-destructive">
                        End date must be on or after the start date.
                      </p>
                    )}
                  </div>
                )}

                {/* Description */}
                <div>
                  <DrawerFieldLabel>
                    Description <span className="font-normal text-muted-foreground">(Optional)</span>
                  </DrawerFieldLabel>
                  <div className="relative">
                    <textarea
                      placeholder="Add description or note"
                      value={btDescription}
                      onChange={(e) => {
                        if (e.target.value.length <= 255) setBtDescription(e.target.value);
                      }}
                      rows={3}
                      className={drawerTextareaClassName}
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
                    btTo <= btFrom ||
                    (btFrequency !== "none" && (!btUntil || btUntil < btDate)) ||
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
                        const recurring = btFrequency !== "none" && !!btUntil;
                        await blockSlot({
                          mechanicId: btMechanicId as Id<"mechanics">,
                          date: btDate,
                          startTime: btFrom,
                          endTime: btTo,
                          ...(btTitle.trim() ? { title: btTitle.trim() } : {}),
                          ...(btDescription.trim() ? { note: btDescription.trim() } : {}),
                          ...(recurring ? { frequency: btFrequency as "daily" | "weekly" | "biweekly" | "monthly", until: btUntil } : {}),
                        });
                        setToast({
                          msg: recurring
                            ? `Blocked time set to repeat ${btFrequency} until ${btUntil}`
                            : `Blocked ${formatTimeLabel(btFrom)}–${formatTimeLabel(btTo)} for ${blockTimeDrawer.mechanicName}`,
                          key: Date.now(),
                        });
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
                  className={`${drawerPrimaryButtonClassName} w-full py-3`}
                >
                  {btSaving && <Loader2 className="w-4 h-4 animate-spin" />}
                  {blockTimeDrawer.editingSlotId ? "Save changes" : "Save"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Job detail drawer */}
      <div className={`flex-shrink-0 overflow-hidden transition-[width] duration-200 ease-out ${selectedBookingId ? "w-[552px]" : "w-0"}`}>
        <div className="w-[528px] ml-6 flex flex-col border border-border bg-card rounded-2xl overflow-hidden h-[calc(100vh-320px)] min-h-[500px]">
          {selectedBookingId && (
            <BookingDetailPanel
              ref={jobDetailRef}
              job={selectedJobDetail}
              mechanics={mechanics}
              scheduleConflicts={{
                bookings: bookings ?? [],
                blockedSlots: blockedSlots ?? [],
              }}
              onRequestRescheduleConfirmation={handleProposeReschedule}
              onClose={() => setSelectedBookingId(null)}
              onSuccess={(msg) => setToast({ msg, key: Date.now() })}
              showBookingsLink
            />
          )}
        </div>
      </div>

      {/* Create booking drawer */}
      {createBookingDrawer && (
        <div className="flex-shrink-0 w-[552px] h-[calc(100vh-320px)] min-h-[500px]">
          <div className="w-[528px] ml-6 flex h-full flex-col overflow-hidden rounded-2xl border border-border bg-card">
            <CreateBookingDrawer
              date={createBookingDrawer.date}
              time={createBookingDrawer.time}
              mechanicId={createBookingDrawer.mechanicId}
              onDraftChange={(next) => {
                setCreateBookingDrawer((prev) =>
                  prev
                    ? { ...prev, date: next.date, time: next.time, mechanicId: next.mechanicId }
                    : prev
                );
                // Two-way sync: drawer date → schedule's viewed day
                const [y, mo, d] = next.date.split("-").map(Number);
                if (
                  Number.isFinite(y) &&
                  Number.isFinite(mo) &&
                  Number.isFinite(d) &&
                  next.date !== dateToString(currentDate)
                ) {
                  setCurrentDate(new Date(y, mo - 1, d));
                }
              }}
              mechanics={mechanics}
              bookings={bookings ?? []}
              shopHours={context?.hours ?? []}
              onClose={() => setCreateBookingDrawer(null)}
              onToast={(msg) => setToast({ msg, key: Date.now() })}
            />
          </div>
        </div>
      )}

      </div>{/* end flex row */}

      {noShowReschedule ? (
        <div className="fixed inset-0 z-[90] flex items-center justify-center px-4 py-6">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setNoShowReschedule(null)}
          />
          <div className="relative z-[91] w-full max-w-lg rounded-2xl border border-border bg-card p-6 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                  Reschedule late customer
                </p>
                <h2 className="mt-2 text-lg font-semibold text-foreground">
                  {noShowReschedule.customerName}
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setNoShowReschedule(null)}
                className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <div>
                <DrawerFieldLabel>Date</DrawerFieldLabel>
                <input
                  type="date"
                  value={noShowReschedule.date}
                  onChange={(event) =>
                    setNoShowReschedule((current) =>
                      current ? { ...current, date: event.target.value } : current,
                    )
                  }
                  className={drawerInputClassName}
                />
              </div>
              <div>
                <DrawerFieldLabel>Time</DrawerFieldLabel>
                <Select
                  selectedKey={noShowReschedule.time}
                  onSelectionChange={(key) =>
                    setNoShowReschedule((current) =>
                      current ? { ...current, time: String(key) } : current,
                    )
                  }
                >
                  <SelectTrigger className={drawerSelectTriggerClassName}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopover>
                    <SelectListBox shouldFocusWrap>
                      {generateTimeOptions().map((option) => (
                        <SelectItem key={option.value} id={option.value} textValue={option.label}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectListBox>
                  </SelectPopover>
                </Select>
              </div>
              <div className="sm:col-span-2">
                <DrawerFieldLabel>Assignment</DrawerFieldLabel>
                <Select
                  selectedKey={noShowReschedule.mechanicId || "any"}
                  onSelectionChange={(key) =>
                    setNoShowReschedule((current) =>
                      current
                        ? {
                            ...current,
                            mechanicId: key === "any" ? "" : String(key),
                          }
                        : current,
                    )
                  }
                >
                  <SelectTrigger className={drawerSelectTriggerClassName}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopover>
                    <SelectListBox shouldFocusWrap>
                      <SelectItem id="any" textValue="Any mechanic">
                        <span className="text-muted-foreground">Any mechanic</span>
                      </SelectItem>
                      {mechanics.map((mechanic) => (
                        <SelectItem key={mechanic._id} id={mechanic._id} textValue={mechanic.name}>
                          {mechanic.name}
                        </SelectItem>
                      ))}
                    </SelectListBox>
                  </SelectPopover>
                </Select>
              </div>
            </div>
            {noShowRescheduleError ? (
              <p className="mt-4 text-sm text-destructive">
                {noShowRescheduleError}
              </p>
            ) : null}
            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setNoShowReschedule(null)}
                className="rounded-lg border border-border px-3.5 py-2 text-sm font-medium transition-colors hover:bg-muted"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleSubmitNoShowReschedule()}
                disabled={isSubmittingNoShowReschedule}
                className="inline-flex items-center gap-2 rounded-lg bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
              >
                {isSubmittingNoShowReschedule ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : null}
                Reschedule
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <RescheduleConfirmationDialog
        proposal={rescheduleProposal}
        error={rescheduleError}
        isSubmitting={isRescheduling}
        onCancel={() => setRescheduleProposal(null)}
        onConfirm={() => void handleConfirmReschedule()}
        reserveOriginalSlotMessage="The booking will be set to Pending Customer until the customer responds. If they don't respond within 24 hours, the original time will be restored automatically."
      />

      <LateStartReviewDialog
        review={selectedLateStartReview}
        mechanics={mechanics}
        shopHours={context.hours}
        error={lateStartReviewError}
        isSubmitting={isSubmittingLateStartReview}
        onClose={() => {
          setLateStartReviewError("");
          setSelectedLateStartReviewId(null);
        }}
        onAccept={() =>
          selectedLateStartReview
            ? void handleAcceptLateStartReview(selectedLateStartReview._id)
            : undefined
        }
        onDeny={() =>
          selectedLateStartReview
            ? void handleDenyLateStartReview(selectedLateStartReview._id)
            : undefined
        }
        onApplyManual={(targets) =>
          selectedLateStartReview
            ? void handleApplyManualLateStartReview(selectedLateStartReview._id, targets)
            : undefined
        }
      />

      {/* Right-click context menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-[80] bg-card border border-border rounded-xl shadow-lg overflow-hidden min-w-[220px]"
          style={contextMenuStyle ?? { left: 0, top: 0, visibility: "hidden" }}
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
                      durationMinutes: 60,
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
          {contextMenu.type === "blockDay" && (
            <div className="py-1">
              {contextMenu.isBlocked && contextMenu.slotId ? (
                <button
                  className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-foreground hover:bg-muted transition-colors"
                  onClick={() => handleUnblockSlot(contextMenu.slotId!)}
                >
                  <CalendarIcon className="w-4 h-4 text-muted-foreground shrink-0" />
                  Unblock this slot
                </button>
              ) : (
                <button
                  className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-foreground hover:bg-muted transition-colors"
                  onClick={() => {
                    handleBlockFullDay(contextMenu.mechanicId, contextMenu.mechanicName, contextMenu.date);
                    setContextMenu(null);
                  }}
                >
                  <CalendarOff className="w-4 h-4 text-muted-foreground shrink-0" />
                  Block full day
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Success toast — shown only when blur-overlay confirmations are not open */}
      {toast && !rescheduleProposal && !noShowReschedule && !blockDayConfirm && (
        <div className="fixed bottom-6 right-6 z-[70] bg-card border border-border rounded-lg shadow-lg px-4 py-3 text-sm text-foreground select-none pointer-events-none">
          {toast.msg}
        </div>
      )}

      <ConfirmationDialog
        open={!!lateStartOutsideHoursConfirm}
        title="Delay outside shop hours?"
        description="This delayed booking falls outside the shop's operating hours. Would you like to apply the delay anyway?"
        onClose={() => setLateStartOutsideHoursConfirm(null)}
        zIndexClassName="z-[95]"
        secondaryAction={{
          label: <ShortcutLabel text="Cancel" shortcutKey="c" />,
          onAction: () => setLateStartOutsideHoursConfirm(null),
          shortcutKey: "c",
        }}
        primaryAction={{
          label: <ShortcutLabel text="Apply anyway" shortcutKey="a" />,
          onAction: () => {
            if (!lateStartOutsideHoursConfirm) return;
            void handleApplyManualLateStartReview(
              lateStartOutsideHoursConfirm.reviewId,
              lateStartOutsideHoursConfirm.targets,
              true
            );
          },
          shortcutKey: "a",
          variant: "primary",
        }}
      />

      <ConfirmationDialog
        open={!!blockDayConfirm}
        title="Block remaining time?"
        description={
          blockDayConfirm ? (
            <>
              <span className="font-medium text-foreground">{blockDayConfirm.mechanicName}</span> has{" "}
              {blockDayConfirm.bookingCount} existing booking{blockDayConfirm.bookingCount !== 1 ? "s" : ""} on this day.
              Confirming will block all open time around those bookings and clear any existing manual blocks.
            </>
          ) : undefined
        }
        onClose={() => setBlockDayConfirm(null)}
        zIndexClassName="z-[80]"
        secondaryAction={{
          label: <ShortcutLabel text="Cancel" shortcutKey="c" />,
          onAction: () => setBlockDayConfirm(null),
          shortcutKey: "c",
        }}
        primaryAction={{
          label: <ShortcutLabel text="Block remaining time" shortcutKey="b" />,
          onAction: () => {
            if (!blockDayConfirm) return;
            void handleBlockFullDay(
              blockDayConfirm.mechanicId,
              blockDayConfirm.mechanicName,
              blockDayConfirm.date,
              true
            );
          },
          shortcutKey: "b",
          variant: "primary",
        }}
      />
    </div>
  );
}
