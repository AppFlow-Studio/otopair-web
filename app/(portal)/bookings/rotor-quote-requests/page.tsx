// @ts-nocheck - Convex `api` type is too deep for tsc with this schema (TS2589).
// Suppress this file; runtime types are validated by the Convex deployment.
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { ChevronLeft, ChevronRight, Wrench } from "lucide-react";
import { format, addDays, subDays } from "date-fns";
import DaySwimLanes from "@/app/(portal)/schedule/day-swim-lanes";
import type { CalendarEvent } from "@/app/(portal)/schedule/day-swim-lanes";
import { getBookingEndTime } from "@/lib/schedule-overlap";
import { findNextAvailableSlot } from "@/lib/findNextAvailableSlot";
import {
  Select,
  SelectItem,
  SelectListBox,
  SelectPopover,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// Rotor brands the shop can pick from. "Other…" lets them type free text.
// Curated against the common OEM + aftermarket suppliers; the customer's
// tier filter (Premium/Plus/Standard) doesn't constrain the brand list —
// the shop sources whichever fits the price they can offer.
const ROTOR_BRANDS = [
  { value: "brembo", label: "Brembo" },
  { value: "akebono", label: "Akebono" },
  { value: "bosch", label: "Bosch" },
  { value: "ate", label: "ATE" },
  { value: "zimmermann", label: "Zimmermann" },
  { value: "ebc", label: "EBC" },
  { value: "powerstop", label: "PowerStop" },
  { value: "centric", label: "Centric" },
  { value: "raybestos", label: "Raybestos" },
  { value: "wagner", label: "Wagner" },
  { value: "acdelco", label: "AC Delco" },
  { value: "stoptech", label: "StopTech" },
  { value: "duragon", label: "DuraGo" },
  { value: "detroit_axle", label: "Detroit Axle" },
  { value: "hawk", label: "Hawk" },
];

const OTHER_BRAND = "__other__";

function RotorBrandSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const matched = ROTOR_BRANDS.find((b) => b.value === value);
  const isOther = !!value && !matched;
  const selectedKey = matched ? matched.value : isOther ? OTHER_BRAND : "none";
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const filtered = normalizedQuery
    ? ROTOR_BRANDS.filter((b) => b.label.toLowerCase().includes(normalizedQuery))
    : ROTOR_BRANDS;

  return (
    <div className="space-y-2">
      <Select
        selectedKey={selectedKey}
        onSelectionChange={(key) => {
          const k = String(key);
          if (k === "none") onChange("");
          else if (k === OTHER_BRAND) { if (matched) onChange(""); }
          else onChange(k);
          setQuery("");
        }}
      >
        <SelectTrigger className="w-full h-9 rounded-md border border-border bg-background px-3 text-sm text-foreground justify-between">
          <SelectValue>
            {matched ? matched.label : isOther ? "Other…" : "Select brand…"}
          </SelectValue>
        </SelectTrigger>
        <SelectPopover className="rounded-md">
          <div
            className="border-b border-border p-1.5"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (!["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(e.key))
                  e.stopPropagation();
              }}
              placeholder="Search…"
              className="w-full rounded-sm border border-border bg-background px-2 py-1 text-xs"
            />
          </div>
          <SelectListBox shouldFocusWrap className="p-1 max-h-56 overflow-y-auto text-sm">
            <SelectItem id="none" textValue="Select brand…" className="min-h-0 rounded-sm px-2.5 py-1.5 text-xs text-muted-foreground">
              Select brand…
            </SelectItem>
            {filtered.map((b) => (
              <SelectItem key={b.value} id={b.value} textValue={b.label} className="min-h-0 rounded-sm px-2.5 py-1.5 text-xs">
                {b.label}
              </SelectItem>
            ))}
            {"other".includes(normalizedQuery) || !normalizedQuery ? (
              <SelectItem id={OTHER_BRAND} textValue="Other…" className="min-h-0 rounded-sm px-2.5 py-1.5 text-xs">
                Other…
              </SelectItem>
            ) : null}
          </SelectListBox>
        </SelectPopover>
      </Select>
      {isOther && (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Brand name"
          autoFocus
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
        />
      )}
    </div>
  );
}

const todayIso = () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

type OpenRequest = {
  _id: Id<"bookings">;
  _creationTime: number;
  status: string;
  rotor_specs?: {
    axle: string; // "front" | "rear" | "both"
    tier: string;
    quantity: number;
  };
  vin: string;
  submitted_at: number;
  vehicle: { year: number | null; make: string | null; model: string | null } | null;
};

function formatVehicle(v: OpenRequest["vehicle"]): string {
  if (!v) return "Unknown vehicle";
  const parts = [v.year, v.make, v.model].filter(Boolean);
  return parts.length ? parts.join(" ") : "Unknown vehicle";
}

function formatAxle(axle: string | undefined): string {
  if (axle === "front") return "Front pair";
  if (axle === "rear") return "Rear pair";
  if (axle === "both") return "All four";
  return "—";
}

function formatRelative(ts: number): string {
  const diffMs = Date.now() - ts;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export default function RotorQuoteRequestsPage() {
  const context = useQuery(api.bookings.getMyShopJobContext);
  const shopId = context?.shopId as Id<"shops"> | undefined;

  const allRequests = useQuery(
    api.bookings.listOpenRotorQuoteRequestsForShop,
    shopId ? { shopId } : "skip",
  ) as OpenRequest[] | undefined;

  const [activeRequest, setActiveRequest] = useState<OpenRequest | null>(null);
  const [rejectedIds, setRejectedIds] = useState<Set<string>>(new Set());

  const requests = useMemo(
    () => allRequests?.filter((r) => !rejectedIds.has(String(r._id))),
    [allRequests, rejectedIds],
  );

  const handleReject = (id: Id<"bookings">) => {
    setRejectedIds((prev) => {
      const next = new Set(prev);
      next.add(String(id));
      return next;
    });
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Rotor Quote Requests</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Open rotor quotes from customers shopping the bid path. Source the
          lowest OEM price you can offer, submit a quote, and the row leaves
          once the customer accepts.
        </p>
      </div>

      {context === undefined ? (
        <div className="bg-card rounded-xl border border-border p-8 text-center text-muted-foreground">
          Loading…
        </div>
      ) : !shopId ? (
        <div className="bg-card rounded-xl border border-border p-8 text-center text-muted-foreground">
          This page is for shop team members. If you need access, reach out to your shop owner.
        </div>
      ) : requests === undefined ? (
        <div className="bg-card rounded-xl border border-border p-8 text-center text-muted-foreground">
          Loading requests…
        </div>
      ) : requests.length === 0 ? (
        <div className="bg-card rounded-xl border border-border p-12 text-center">
          <Wrench className="mx-auto h-10 w-10 text-muted-foreground/40" strokeWidth={1.5} />
          <p className="mt-3 text-sm font-medium text-foreground">No open rotor quote requests</p>
          <p className="mt-1 text-xs text-muted-foreground">
            New customer requests will appear here.
          </p>
        </div>
      ) : (
        <div className="bg-card rounded-xl border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                <th className="px-5 py-3 text-left font-medium text-muted-foreground">Vehicle</th>
                <th className="px-5 py-3 text-left font-medium text-muted-foreground">Axle</th>
                <th className="px-5 py-3 text-left font-medium text-muted-foreground">Tier</th>
                <th className="px-5 py-3 text-left font-medium text-muted-foreground">Qty</th>
                <th className="px-5 py-3 text-left font-medium text-muted-foreground">Submitted</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r._id} className="border-b border-border last:border-b-0 hover:bg-muted/20">
                  <td className="px-5 py-4 text-foreground">{formatVehicle(r.vehicle)}</td>
                  <td className="px-5 py-4 text-foreground">{formatAxle(r.rotor_specs?.axle)}</td>
                  <td className="px-5 py-4 text-foreground capitalize">{r.rotor_specs?.tier ?? "—"}</td>
                  <td className="px-5 py-4 text-foreground">{r.rotor_specs?.quantity ?? "—"}</td>
                  <td className="px-5 py-4 text-muted-foreground">
                    {formatRelative(r.submitted_at)}
                  </td>
                  <td className="px-5 py-4 text-right">
                    <div className="inline-flex items-center gap-2">
                      <button
                        onClick={() => setActiveRequest(r)}
                        className="inline-flex items-center rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90"
                      >
                        Make Quote
                      </button>
                      <button
                        onClick={() => handleReject(r._id)}
                        className="inline-flex items-center rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
                      >
                        Reject
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {activeRequest && shopId && (
        <QuoteSubmissionDialog
          request={activeRequest}
          shopId={shopId}
          shopMechanics={context?.mechanics ?? []}
          shopHours={context?.hours ?? []}
          onClose={() => setActiveRequest(null)}
        />
      )}
    </div>
  );
}

function dateStringToDate(s: string): Date {
  const [y, mo, d] = s.split("-").map(Number);
  return new Date(y, mo - 1, d);
}

function dateToString(d: Date): string {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${day}`;
}

function formatDayHeading(d: Date): string {
  return format(d, "EEEE, MMM d");
}

function formatTimeLabel(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const hour = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, "0")} ${ampm}`;
}

function QuoteSubmissionDialog({
  request,
  shopId,
  shopMechanics,
  shopHours,
  onClose,
}: {
  request: OpenRequest;
  shopId: Id<"shops">;
  shopMechanics: Array<{ _id: Id<"mechanics">; name: string; imageUrl?: string | null }>;
  shopHours: Array<{ dayOfWeek: number; openTime: string; closeTime: string; isClosed: boolean }>;
  onClose: () => void;
}) {
  const submit = useMutation(api.rotor_quote_responses.create);

  // Rotor jobs are heavier than tire swaps — default to 60 min, give 45/60/90
  // presets (both axles can easily run 90 min).
  const [durationMinutes, setDurationMinutes] = useState(60);

  const [rotorBrand, setRotorBrand] = useState("");
  const [rotorModel, setRotorModel] = useState("");
  const [perRotorPrice, setPerRotorPrice] = useState("");
  const [laborCost, setLaborCost] = useState("");
  const [availabilityDate, setAvailabilityDate] = useState(todayIso());
  const [availabilityTime, setAvailabilityTime] = useState("");
  const [mechanicId, setMechanicId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [laneDate, setLaneDate] = useState<Date | null>(null);
  const initialLaneDateSelectedRef = useRef(false);

  const laneDateStr = laneDate ? dateToString(laneDate) : todayIso();
  const initialLookaheadRange = useMemo(() => {
    const start = new Date();
    const end = new Date(start);
    end.setDate(start.getDate() + 13);
    return { dateFrom: dateToString(start), dateTo: dateToString(end) };
  }, []);

  const scheduleBookings = useQuery(
    api.schedule.getBookingsForRange,
    laneDate ? { dateFrom: laneDateStr, dateTo: laneDateStr } : "skip",
  );
  const blockedSlots = useQuery(
    api.schedule.getBlockedSlots,
    laneDate ? { dateFrom: laneDateStr, dateTo: laneDateStr } : "skip",
  );
  const initialLookaheadBookings = useQuery(api.schedule.getBookingsForRange, {
    dateFrom: initialLookaheadRange.dateFrom,
    dateTo: initialLookaheadRange.dateTo,
  });
  const initialLookaheadBlockedSlots = useQuery(api.schedule.getBlockedSlots, {
    dateFrom: initialLookaheadRange.dateFrom,
    dateTo: initialLookaheadRange.dateTo,
  });

  useEffect(() => {
    if (initialLaneDateSelectedRef.current) return;
    if (initialLookaheadBookings === undefined || initialLookaheadBlockedSlots === undefined) return;

    initialLaneDateSelectedRef.current = true;
    if (shopHours.length === 0 || shopMechanics.length === 0) {
      setLaneDate(dateStringToDate(todayIso()));
      return;
    }

    const slot = findNextAvailableSlot({
      now: new Date(),
      shopHours,
      mechanics: shopMechanics.map((m) => ({ _id: String(m._id) })),
      bookings: initialLookaheadBookings,
      blockedSlots: initialLookaheadBlockedSlots,
      durationMinutes,
    });

    setLaneDate(dateStringToDate(slot?.date ?? todayIso()));
  }, [
    durationMinutes,
    initialLookaheadBlockedSlots,
    initialLookaheadBookings,
    shopHours,
    shopMechanics,
  ]);

  const laneEvents: CalendarEvent[] = useMemo(() => {
    const bookingEvents: CalendarEvent[] = (scheduleBookings ?? []).map((b: any) => {
      const [h, m] = b.scheduledTime.split(":").map(Number);
      const endTime = getBookingEndTime(b.scheduledTime, b.estimatedMinutes);
      const [eh, em] = endTime.split(":").map(Number);
      const start = new Date(b.scheduledDate + "T00:00:00");
      start.setHours(h, m, 0, 0);
      const end = new Date(b.scheduledDate + "T00:00:00");
      end.setHours(eh, em, 0, 0);
      return {
        id: b._id,
        title: `${b.customerName} — ${(b.serviceNames ?? []).join(", ")}`,
        start,
        end,
        resourceId: b.mechanicId ?? undefined,
        type: "booking" as const,
        status: b.status,
        customerName: b.customerName,
        mechanicName: b.mechanicName,
        serviceNames: b.serviceNames,
      };
    });

    const blockedEvents: CalendarEvent[] = (blockedSlots ?? []).map((s: any) => {
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
  }, [scheduleBookings, blockedSlots]);

  const laneDayHours = useMemo(() => {
    if (!laneDate) return null;
    const dow = laneDate.getDay();
    return shopHours.find((h) => h.dayOfWeek === dow) ?? null;
  }, [laneDate, shopHours]);

  const laneMinTime = useMemo(() => {
    if (!laneDate) return new Date();
    const d = new Date(laneDate);
    if (laneDayHours && !laneDayHours.isClosed && laneDayHours.openTime) {
      const [h, m] = laneDayHours.openTime.split(":").map(Number);
      d.setHours(h, m, 0, 0);
    } else {
      d.setHours(7, 0, 0, 0);
    }
    return d;
  }, [laneDate, laneDayHours]);

  const laneMaxTime = useMemo(() => {
    if (!laneDate) return new Date();
    const d = new Date(laneDate);
    if (laneDayHours && !laneDayHours.isClosed && laneDayHours.closeTime) {
      const [h, m] = laneDayHours.closeTime.split(":").map(Number);
      d.setHours(h, m, 0, 0);
    } else {
      d.setHours(20, 0, 0, 0);
    }
    return d;
  }, [laneDate, laneDayHours]);

  const quantity = request.rotor_specs?.quantity ?? 0;

  const availabilityDateTime = useMemo(() => {
    if (!availabilityDate || !availabilityTime) return null;
    const dt = new Date(`${availabilityDate}T${availabilityTime}`);
    return Number.isNaN(dt.getTime()) ? null : dt;
  }, [availabilityDate, availabilityTime]);

  const availabilityFormatted = useMemo(() => {
    if (!availabilityDateTime) return "";
    return format(availabilityDateTime, "MMM d, yyyy 'at' h:mm a");
  }, [availabilityDateTime]);

  const availabilityIsFuture =
    availabilityDateTime !== null && availabilityDateTime.getTime() > Date.now();

  const total = useMemo(() => {
    const ppt = Number(perRotorPrice);
    const labor = Number(laborCost);
    if (!Number.isFinite(ppt) || !Number.isFinite(labor)) return null;
    return ppt * quantity + labor;
  }, [perRotorPrice, laborCost, quantity]);

  const canSubmit =
    rotorBrand.trim().length > 0 &&
    perRotorPrice !== "" &&
    Number(perRotorPrice) > 0 &&
    laborCost !== "" &&
    Number(laborCost) >= 0 &&
    availabilityIsFuture &&
    mechanicId !== "" &&
    total !== null &&
    !submitting;

  const handleSubmit = async () => {
    if (!canSubmit || total === null) return;
    setSubmitting(true);
    setError(null);
    try {
      await submit({
        booking_id: request._id,
        shop_id: shopId,
        rotor_brand: (ROTOR_BRANDS.find((b) => b.value === rotorBrand)?.label ?? rotorBrand).trim(),
        rotor_model: rotorModel.trim() ? rotorModel.trim() : undefined,
        per_rotor_price: Number(perRotorPrice),
        quantity,
        labor_cost: Number(laborCost),
        total,
        availability: { date: availabilityDate, time: availabilityTime },
        estimated_duration_minutes: durationMinutes,
        mechanic_id: mechanicId ? (mechanicId as Id<"mechanics">) : undefined,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't submit your quote. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/20 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-6xl h-[85vh] rounded-xl border border-border bg-card shadow-xl flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <div>
            <h3 className="text-base font-semibold text-foreground">Submit rotor quote</h3>
            <p className="text-sm text-muted-foreground mt-0.5">
              {formatVehicle(request.vehicle)} · {formatAxle(request.rotor_specs?.axle)} · qty {quantity}
            </p>
          </div>
          <button onClick={onClose} className="rounded-md p-1.5 hover:bg-muted text-muted-foreground">
            ✕
          </button>
        </div>

        <div className="flex flex-1 min-h-0">
          <div className="flex-1 flex flex-col min-w-0 border-r border-border">
            <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border shrink-0">
              <button
                onClick={() => setLaneDate((d) => subDays(d ?? new Date(), 1))}
                disabled={!laneDate}
                className="rounded-md p-1 hover:bg-muted text-muted-foreground disabled:opacity-50"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="text-sm font-medium text-foreground">
                {laneDate ? formatDayHeading(laneDate) : "Loading schedule..."}
              </span>
              <button
                onClick={() => setLaneDate((d) => addDays(d ?? new Date(), 1))}
                disabled={!laneDate}
                className="rounded-md p-1 hover:bg-muted text-muted-foreground disabled:opacity-50"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
              {availabilityDate && availabilityTime && mechanicId && (
                <span className="ml-auto text-xs text-muted-foreground">
                  Selected:{" "}
                  <span className="font-medium text-foreground">
                    {formatTimeLabel(availabilityTime)} on {format(dateStringToDate(availabilityDate), "MMM d")}
                    {" · "}
                    {shopMechanics.find((m) => String(m._id) === mechanicId)?.name ?? ""}
                  </span>
                </span>
              )}
            </div>
            {laneDayHours?.isClosed && (
              <div className="px-4 py-2.5 bg-muted/50 border-b border-border text-xs text-muted-foreground text-center">
                Shop is closed on this day — pick another date.
              </div>
            )}
            <div className="flex-1 overflow-auto">
              {laneDate ? (
                <DaySwimLanes
                  mechanics={shopMechanics.map((m) => ({
                    _id: String(m._id),
                    name: m.name,
                    imageUrl: (m as any).imageUrl ?? null,
                  }))}
                  events={laneEvents}
                  minTime={laneMinTime}
                  maxTime={laneMaxTime}
                  nowTimestamp={Date.now()}
                  onSelectEvent={() => {}}
                  currentDate={laneDate}
                  draftBooking={
                    availabilityDate && availabilityTime && mechanicId
                      ? {
                          date: availabilityDate,
                          time: availabilityTime,
                          mechanicId,
                          durationMinutes,
                        }
                      : null
                  }
                  onSelectEmptyCell={laneDayHours?.isClosed ? undefined : (info) => {
                    setLaneDate(dateStringToDate(info.date));
                    setAvailabilityDate(info.date);
                    setAvailabilityTime(info.startTime);
                    setMechanicId(info.mechanicId);
                  }}
                />
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  Finding the next available day...
                </div>
              )}
            </div>
            <p className="px-4 py-2 text-xs text-muted-foreground border-t border-border shrink-0">
              Click an empty slot to set the "Ready by" time and assign a mechanic.
            </p>
          </div>

          <div className="w-80 shrink-0 flex flex-col overflow-y-auto">
            <div className="p-5 space-y-4 flex-1">
              <Field label="Rotor brand" required>
                <RotorBrandSelect value={rotorBrand} onChange={setRotorBrand} />
              </Field>

              <Field label="Rotor model (optional)">
                <input
                  type="text"
                  value={rotorModel}
                  onChange={(e) => setRotorModel(e.target.value)}
                  placeholder="e.g. OE Replacement Disc"
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                />
              </Field>

              <div className="grid grid-cols-2 gap-3">
                <Field label="Per-rotor price ($)" required>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={perRotorPrice}
                    onChange={(e) => setPerRotorPrice(e.target.value)}
                    placeholder="0.00"
                    className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  />
                </Field>
                <Field label="Quantity">
                  <input
                    type="number"
                    value={quantity}
                    readOnly
                    className="w-full rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
                  />
                </Field>
              </div>

              <Field label="Labor cost ($)" required>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={laborCost}
                  onChange={(e) => setLaborCost(e.target.value)}
                  placeholder="0.00"
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                />
              </Field>

              <Field label="Total ($)">
                <input
                  type="text"
                  value={total !== null ? total.toFixed(2) : "—"}
                  readOnly
                  className="w-full rounded-md border border-border bg-muted/40 px-3 py-2 text-sm font-medium text-foreground"
                />
              </Field>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Estimated duration</label>
                <div className="flex gap-1.5">
                  {[45, 60, 90].map((mins) => (
                    <button
                      key={mins}
                      onClick={() => setDurationMinutes(mins)}
                      className={`flex-1 rounded-md border py-1.5 text-xs font-medium transition-colors ${
                        durationMinutes === mins
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border bg-background text-foreground hover:bg-muted"
                      }`}
                    >
                      {mins} min
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">
                  Ready by<span className="ml-0.5 text-destructive">*</span>
                </label>
                {availabilityDate && availabilityTime && mechanicId ? (
                  <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
                    <p className="font-medium text-foreground">{availabilityFormatted}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {shopMechanics.find((m) => String(m._id) === mechanicId)?.name ?? ""}
                    </p>
                    <button
                      onClick={() => { setAvailabilityDate(""); setAvailabilityTime(""); setMechanicId(""); }}
                      className="mt-1.5 text-xs text-muted-foreground hover:text-foreground underline"
                    >
                      Clear
                    </button>
                  </div>
                ) : (
                  <div className="rounded-md border border-dashed border-border bg-muted/20 px-3 py-3 text-xs text-muted-foreground text-center">
                    Click a slot on the schedule to set the ready-by time
                  </div>
                )}
                {availabilityDateTime && !availabilityIsFuture && (
                  <p className="text-xs text-destructive">Pick a date and time in the future.</p>
                )}
              </div>

              {error && (
                <div className="rounded-md bg-destructive/10 border border-destructive/30 px-3 py-2 text-sm text-destructive">
                  {error}
                </div>
              )}
            </div>

            <div className="px-5 py-4 border-t border-border flex gap-2 justify-end shrink-0">
              <button
                onClick={onClose}
                disabled={submitting}
                className="px-3 py-2 text-sm rounded-lg border border-border hover:bg-muted disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleSubmit}
                disabled={!canSubmit}
                className="px-3 py-2 text-sm rounded-lg bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                {submitting ? "Submitting…" : "Submit quote"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium text-muted-foreground">
        {label}
        {required && <span className="ml-0.5 text-destructive">*</span>}
      </label>
      {children}
    </div>
  );
}
