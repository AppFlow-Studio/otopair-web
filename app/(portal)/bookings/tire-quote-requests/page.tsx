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
import { formatHoursValue } from "@/lib/labor-units";
import { shouldShowShopQuoteRequest } from "@/lib/quoteRequestVisibility";
import {
  OTHER_QUOTE_BRAND,
  customQuoteBrandInputValue,
  isCustomQuoteBrand,
  isQuoteBrandReady,
  nextQuoteBrandValue,
} from "@/lib/quote-brand-selection";
import {
  Select,
  SelectItem,
  SelectListBox,
  SelectPopover,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { QuoteVehiclePanel, type QuoteSpecItem } from "@/components/quote/quote-vehicle-panel";
import ConfirmationDialog from "@/components/confirmation-dialog";

// Customer-facing tier vocabulary (from the tire-spec picker) is
// premium / plus / standard, but the tire_brands catalog is keyed
// elite / select / standard. Bridge the two here. Tolerant of a value that
// is already a catalog tier so this keeps working if the vocab is ever unified.
type CatalogTier = "elite" | "select" | "standard";
const TIER_TO_CATALOG: Record<string, CatalogTier> = {
  premium: "elite",
  plus: "select",
  standard: "standard",
  elite: "elite",
  select: "select",
};
const CATALOG_TIER_LABEL: Record<CatalogTier, string> = {
  elite: "Elite",
  select: "Select",
  standard: "Standard",
};

function toCatalogTier(tier: string | null | undefined): CatalogTier | null {
  if (!tier) return null;
  return TIER_TO_CATALOG[tier.trim().toLowerCase()] ?? null;
}

type BrandOption = { value: string; label: string };

function TireBrandSelect({
  value,
  onChange,
  options,
  loading = false,
}: {
  value: string;
  onChange: (v: string) => void;
  options: BrandOption[];
  loading?: boolean;
}) {
  const matched = options.find((b) => b.value === value);
  const isOther = isCustomQuoteBrand(value, options.map((option) => option.value));
  const selectedKey = matched ? matched.value : isOther ? OTHER_QUOTE_BRAND : "none";
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const filtered = normalizedQuery
    ? options.filter((b) => b.label.toLowerCase().includes(normalizedQuery))
    : options;

  return (
    <div className="space-y-2">
      <Select
        selectedKey={selectedKey}
        onSelectionChange={(key) => {
          onChange(nextQuoteBrandValue(String(key)));
          setQuery("");
        }}
      >
        <SelectTrigger className="w-full h-9 rounded-md border border-border bg-background px-3 text-sm text-foreground justify-between">
          <SelectValue>
            {matched
              ? matched.label
              : isOther
                ? "Other…"
                : loading
                  ? "Loading brands…"
                  : "Select brand…"}
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
              <SelectItem id={OTHER_QUOTE_BRAND} textValue="Other…" className="min-h-0 rounded-sm px-2.5 py-1.5 text-xs">
                Other…
              </SelectItem>
            ) : null}
          </SelectListBox>
        </SelectPopover>
      </Select>
      {isOther && (
        <input
          type="text"
          value={customQuoteBrandInputValue(value)}
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
  tire_specs?: {
    size: string;
    type: string;
    tier: string;
    quantity: number;
  };
  vin: string;
  submitted_at: number;
  vehicle: {
    year: number | null;
    make: string | null;
    model: string | null;
    trim?: string | null;
    spec_label?: string | null;
    image_url?: string | null;
  } | null;
  quote_status: "open" | "pending" | "expired" | "cancelled";
  quote_response: null | {
    _id: Id<"tire_quote_responses">;
    mechanic_id?: Id<"mechanics">;
    tire_brand: string;
    tire_model?: string;
    per_tire_price: number;
    quantity: number;
    labor_cost: number;
    total: number;
    availability: { date: string; time: string };
    estimated_duration_minutes?: number;
    created_at: number;
    expires_at?: number;
    cancelled_at?: number;
  };
  checkout_held: boolean;
  checkout_hold_expires_at: number | null;
};

function formatVehicle(v: OpenRequest["vehicle"]): string {
  if (!v) return "Unknown vehicle";
  const parts = [v.year, v.make, v.model].filter(Boolean);
  return parts.length ? parts.join(" ") : "Unknown vehicle";
}

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
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

function QuoteStatusBadge({ status }: { status: OpenRequest["quote_status"] }) {
  const label =
    status === "pending"
      ? "Pending Quote"
      : status === "expired"
        ? "Expired"
        : status === "cancelled"
          ? "Cancelled"
          : "Open";
  const tone =
    status === "pending"
      ? "bg-amber-50 text-amber-700"
      : status === "expired"
        ? "bg-muted text-muted-foreground"
        : status === "cancelled"
          ? "bg-destructive/10 text-destructive"
          : "bg-primary/10 text-primary";
  return <span className={`rounded-full px-2 py-1 text-xs font-medium ${tone}`}>{label}</span>;
}

function liveQuoteState(request: OpenRequest, now: number) {
  const checkoutHeld =
    request.checkout_held &&
    request.checkout_hold_expires_at != null &&
    request.checkout_hold_expires_at > now;
  const expiresAt = request.quote_response
    ? request.quote_response.expires_at ?? request.quote_response.created_at + 10 * 60_000
    : null;
  const status =
    request.quote_status === "pending" && !checkoutHeld && expiresAt != null && expiresAt <= now
      ? "expired"
      : request.quote_status;
  return { checkoutHeld, status };
}

/**
 * Body of the Tire Quote Requests page — exported separately so the
 * unified "Quotes" page at /bookings/quote-requests can render it as one
 * of its tabs. The default export below is the backward-compat shell at
 * /bookings/tire-quote-requests in case anything still deep-links there.
 */
export function TireQuoteRequestsContent({ hideHeader = false }: { hideHeader?: boolean } = {}) {
  const context = useQuery(api.bookings.getMyShopJobContext);
  const shopId = context?.shopId as Id<"shops"> | undefined;

  const requests = useQuery(
    api.bookings.listOpenTireQuoteRequestsForShop,
    shopId ? { shopId } : "skip",
  ) as OpenRequest[] | undefined;

  const [activeRequest, setActiveRequest] = useState<OpenRequest | null>(null);
  const [pendingRejectId, setPendingRejectId] = useState<string | null>(null);
  const [cancelRequest, setCancelRequest] = useState<OpenRequest | null>(null);
  const [holdNoticeOpen, setHoldNoticeOpen] = useState(false);
  const [quoteClock, setQuoteClock] = useState(() => Date.now());
  const dismissQuoteRequest = useMutation(api.quote_request_dismissals.dismiss);
  const cancelQuote = useMutation(api.tire_quote_responses.cancel);

  useEffect(() => {
    const nextBoundary = (requests ?? [])
      .flatMap((request) => [
        request.quote_response?.expires_at ??
          (request.quote_response ? request.quote_response.created_at + 10 * 60_000 : null),
        request.checkout_hold_expires_at,
      ])
      .filter((value): value is number => value != null && value > quoteClock)
      .sort((a, b) => a - b)[0];
    if (nextBoundary == null) return;
    const timer = window.setTimeout(() => setQuoteClock(Date.now()), nextBoundary - Date.now() + 50);
    return () => window.clearTimeout(timer);
  }, [quoteClock, requests]);

  const visibleRequests = useMemo(
    () =>
      (requests ?? []).filter((request) =>
        shouldShowShopQuoteRequest(liveQuoteState(request, quoteClock).status),
      ),
    [quoteClock, requests],
  );

  const handleReject = async (id: Id<"bookings">) => {
    if (!shopId) return;
    setPendingRejectId(String(id));
    try {
      await dismissQuoteRequest({ booking_id: id, shop_id: shopId });
    } finally {
      setPendingRejectId(null);
    }
  };

  const handleCancelQuote = async () => {
    if (!cancelRequest?.quote_response) return;
    try {
      await cancelQuote({ response_id: cancelRequest.quote_response._id });
      setCancelRequest(null);
    } catch (error) {
      const data = (error as { data?: { code?: string } })?.data;
      if (data?.code === "QUOTE_HELD") {
        setCancelRequest(null);
        setHoldNoticeOpen(true);
      }
    }
  };

  return (
    <div className="space-y-6">
      {hideHeader ? null : (
        <div>
          <h1 className="text-2xl font-bold text-foreground">Tire Quote Requests</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Review open requests and track pending or cancelled quotes.
          </p>
        </div>
      )}

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
      ) : visibleRequests.length === 0 ? (
        <div className="bg-card rounded-xl border border-border p-12 text-center">
          <Wrench className="mx-auto h-10 w-10 text-muted-foreground/40" strokeWidth={1.5} />
          <p className="mt-3 text-sm font-medium text-foreground">No open tire quote requests</p>
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
                <th className="px-5 py-3 text-left font-medium text-muted-foreground">Size</th>
                <th className="px-5 py-3 text-left font-medium text-muted-foreground">Type</th>
                <th className="px-5 py-3 text-left font-medium text-muted-foreground">Tier</th>
                <th className="px-5 py-3 text-left font-medium text-muted-foreground">Qty</th>
                <th className="px-5 py-3 text-left font-medium text-muted-foreground">Submitted</th>
                <th className="px-5 py-3 text-left font-medium text-muted-foreground">Status</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody>
              {visibleRequests.map((r) => {
                const live = liveQuoteState(r, quoteClock);
                return (
                <tr key={r._id} className="border-b border-border last:border-b-0 hover:bg-muted/20">
                  <td className="px-5 py-4 text-foreground">{formatVehicle(r.vehicle)}</td>
                  <td className="px-5 py-4 text-foreground">{r.tire_specs?.size ?? "—"}</td>
                  <td className="px-5 py-4 text-foreground capitalize">
                    {r.tire_specs?.type ?? "—"}
                  </td>
                  <td className="px-5 py-4 text-foreground capitalize">
                    {r.tire_specs?.tier ?? "—"}
                  </td>
                  <td className="px-5 py-4 text-foreground">{r.tire_specs?.quantity ?? "—"}</td>
                  <td className="px-5 py-4 text-muted-foreground">
                    {formatRelative(r.submitted_at)}
                  </td>
                  <td className="px-5 py-4"><QuoteStatusBadge status={live.status} /></td>
                  <td className="px-5 py-4 text-right">
                    <div className="inline-flex items-center gap-2">
                      {live.status === "open" ? (
                        <>
                          <button onClick={() => setActiveRequest(r)} className="inline-flex items-center rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90">Make Quote</button>
                          <button onClick={() => handleReject(r._id)} disabled={pendingRejectId === String(r._id)} className="inline-flex items-center rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-50">{pendingRejectId === String(r._id) ? "Rejecting…" : "Reject"}</button>
                        </>
                      ) : live.status === "pending" ? (
                        <>
                          <button onClick={() => setActiveRequest(r)} disabled={live.checkoutHeld} title={live.checkoutHeld ? "The customer has this quote held. Changes are unavailable." : undefined} className="inline-flex items-center rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40">Requote</button>
                          <button onClick={() => setCancelRequest(r)} disabled={live.checkoutHeld} title={live.checkoutHeld ? "The customer has this quote held. Changes are unavailable." : undefined} className="inline-flex items-center rounded-md border border-destructive/40 bg-background px-3 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/5 disabled:cursor-not-allowed disabled:opacity-40">Cancel Quote</button>
                        </>
                      ) : null}
                    </div>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {activeRequest && shopId && (
        <TireQuoteSubmissionDialog
          request={activeRequest}
          shopId={shopId}
          shopMechanics={context?.mechanics ?? []}
          shopHours={context?.hours ?? []}
          onClose={() => setActiveRequest(null)}
          onHeld={() => {
            setActiveRequest(null);
            setHoldNoticeOpen(true);
          }}
        />
      )}
      <ConfirmationDialog
        open={cancelRequest != null}
        title="Cancel this quote?"
        description="The customer will no longer be able to accept this shop's quote."
        onClose={() => setCancelRequest(null)}
        secondaryAction={{ label: "Keep quote", onAction: () => setCancelRequest(null) }}
        primaryAction={{ label: "Cancel quote", onAction: () => void handleCancelQuote(), variant: "destructive" }}
      />
      <ConfirmationDialog
        open={holdNoticeOpen}
        title="Quote changes unavailable"
        description="The customer now has this slot and quote held."
        onClose={() => setHoldNoticeOpen(false)}
        primaryAction={{ label: "Got it", onAction: () => setHoldNoticeOpen(false) }}
      />
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

export function TireQuoteSubmissionDialog({
  request,
  shopId,
  shopMechanics,
  shopHours,
  onClose,
  onHeld,
}: {
  request: OpenRequest;
  shopId: Id<"shops">;
  shopMechanics: Array<{ _id: Id<"mechanics">; name: string; imageUrl?: string | null }>;
  shopHours: Array<{ dayOfWeek: number; openTime: string; closeTime: string; isClosed: boolean }>;
  onClose: () => void;
  onHeld?: () => void;
}) {
  const submit = useMutation(api.tire_quote_responses.create);
  const requote = useMutation(api.tire_quote_responses.requote);
  const existing = request.quote_response;
  const liveDetail = useQuery(
    api.tire_quote_responses.getShopDetail,
    existing ? { response_id: existing._id } : "skip",
  );
  useEffect(() => {
    if (existing && liveDetail?.checkout_held) onHeld?.();
  }, [existing, liveDetail?.checkout_held, onHeld]);

  // Curated, tier-filtered brand list: the mechanic only chooses from brands
  // that qualify for the tier the customer requested. "Other…" stays available
  // as the off-list escape hatch (doc Rule 2).
  const requestedTier = request.tire_specs?.tier ?? null;
  const catalogTier = toCatalogTier(requestedTier);
  const tierBrands = useQuery(
    api.tireBrands.getByTier,
    catalogTier ? { tier: catalogTier } : "skip",
  );
  const brandOptions: BrandOption[] = useMemo(() => {
    const rows = (tierBrands ?? []) as Array<{ brand: string }>;
    return rows
      .map((r) => ({ value: r.brand, label: r.brand }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [tierBrands]);
  const brandsLoading = catalogTier != null && tierBrands === undefined;

  const [durationMinutes, setDurationMinutes] = useState(existing?.estimated_duration_minutes ?? 30);

  const [tireBrand, setTireBrand] = useState(existing?.tire_brand ?? "");
  const [tireModel, setTireModel] = useState(existing?.tire_model ?? "");
  const [perTirePrice, setPerTirePrice] = useState(existing ? String(existing.per_tire_price) : "");
  const [laborCost, setLaborCost] = useState(existing ? String(existing.labor_cost) : "");
  const [availabilityDate, setAvailabilityDate] = useState(existing?.availability.date ?? todayIso());
  const [availabilityTime, setAvailabilityTime] = useState(existing?.availability.time ?? "");
  const [mechanicId, setMechanicId] = useState<string>(existing?.mechanic_id ? String(existing.mechanic_id) : "");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Schedule lane state
  const [laneDate, setLaneDate] = useState<Date | null>(existing ? dateStringToDate(existing.availability.date) : null);
  const [nowTimestamp, setNowTimestamp] = useState(() => Date.now());
  const initialLaneDateSelectedRef = useRef(Boolean(existing));

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
    const nextExpiry = (scheduleBookings ?? [])
      .map((event) => event.expiresAt)
      .filter((expiresAt: unknown): expiresAt is number =>
        typeof expiresAt === "number" && expiresAt > nowTimestamp,
      )
      .sort((a: number, b: number) => a - b)[0];
    if (nextExpiry == null) return;
    const timeoutId = window.setTimeout(
      () => setNowTimestamp(Date.now()),
      Math.max(0, nextExpiry - Date.now()) + 50,
    );
    return () => window.clearTimeout(timeoutId);
  }, [scheduleBookings, nowTimestamp]);

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
    const bookingEvents: CalendarEvent[] = (scheduleBookings ?? [])
      .filter(
        (b) =>
          b.status !== "tentative_quote" ||
          b.expiresAt == null ||
          b.expiresAt > nowTimestamp,
      )
      .map((b: any) => {
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
  }, [scheduleBookings, blockedSlots, nowTimestamp]);

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

  const quantity = request.tire_specs?.quantity ?? 0;

  // Pinned reference the mechanic quotes against — tire size is the key they
  // paste into their supplier lookup, so it's copyable.
  const tireSpecItems: QuoteSpecItem[] = useMemo(() => {
    const specs = request.tire_specs;
    const items: QuoteSpecItem[] = [];
    if (specs?.size) items.push({ label: "Tire size", value: specs.size, copyable: true });
    items.push({ label: "Quantity", value: String(quantity) });
    if (specs?.type) items.push({ label: "Type", value: capitalize(specs.type) });
    if (specs?.tier) items.push({ label: "Tier", value: capitalize(specs.tier) });
    return items;
  }, [request.tire_specs, quantity]);

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
    const ppt = Number(perTirePrice);
    const labor = Number(laborCost);
    if (!Number.isFinite(ppt) || !Number.isFinite(labor)) return null;
    return ppt * quantity + labor;
  }, [perTirePrice, laborCost, quantity]);

  const canSubmit =
    isQuoteBrandReady(tireBrand) &&
    perTirePrice !== "" &&
    Number(perTirePrice) > 0 &&
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
      const quote = {
        tire_brand: tireBrand.trim(),
        tire_model: tireModel.trim() ? tireModel.trim() : undefined,
        per_tire_price: Number(perTirePrice),
        quantity,
        labor_cost: Number(laborCost),
        total,
        availability: { date: availabilityDate, time: availabilityTime },
        estimated_duration_minutes: durationMinutes,
        mechanic_id: mechanicId as Id<"mechanics">,
      };
      if (existing) {
        await requote({ response_id: existing._id, ...quote });
      } else {
        await submit({ booking_id: request._id, shop_id: shopId, ...quote });
      }
      onClose();
    } catch (e) {
      const data = (e as { data?: { code?: string } })?.data;
      if (data?.code === "QUOTE_HELD") {
        onHeld?.();
        return;
      }
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
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
          <div>
            <h3 className="text-base font-semibold text-foreground">
              {existing ? "Requote tire quote" : "Submit tire quote"}
            </h3>
            <p className="text-sm text-muted-foreground mt-0.5">
              {formatVehicle(request.vehicle)} · {request.tire_specs?.size ?? "—"} · qty {quantity}
            </p>
          </div>
          <button onClick={onClose} className="rounded-md p-1.5 hover:bg-muted text-muted-foreground">
            ✕
          </button>
        </div>

        {/* Body: swim lanes + form */}
        <div className="flex flex-1 min-h-0">
          {/* Left: schedule swim lanes */}
          <div className="flex-1 flex flex-col min-w-0 border-r border-border">
            {/* Date nav */}
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
                  nowTimestamp={nowTimestamp}
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

          {/* Right: quote form */}
          <div className="w-80 shrink-0 flex flex-col min-h-0">
            <QuoteVehiclePanel
              vehicle={request.vehicle}
              vin={request.vin}
              specItems={tireSpecItems}
            />
            <div className="p-5 space-y-4 flex-1 overflow-y-auto">
              <Field label="Tire brand" required>
                {catalogTier ? (
                  <p className="mb-1.5 text-[11px] text-muted-foreground">
                    Customer selected{" "}
                    <span className="font-medium capitalize text-foreground">
                      {requestedTier}
                    </span>
                    {" — "}showing{" "}
                    <span className="font-medium text-foreground">
                      {CATALOG_TIER_LABEL[catalogTier]}
                    </span>{" "}
                    tier brands only.
                  </p>
                ) : null}
                <TireBrandSelect
                  value={tireBrand}
                  onChange={setTireBrand}
                  options={brandOptions}
                  loading={brandsLoading}
                />
                {catalogTier && !brandsLoading && brandOptions.length === 0 ? (
                  <p className="mt-1.5 text-[11px] text-amber-600">
                    No brands are catalogued for this tier yet — use “Other…” to
                    enter the brand you’re quoting.
                  </p>
                ) : null}
              </Field>

              <Field label="Tire model (optional)">
                <input
                  type="text"
                  value={tireModel}
                  onChange={(e) => setTireModel(e.target.value)}
                  placeholder="e.g. Pilot Sport 4S"
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                />
              </Field>

              <div className="grid grid-cols-2 gap-3">
                <Field label="Per-tire price ($)" required>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={perTirePrice}
                    onChange={(e) => setPerTirePrice(e.target.value)}
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
                  {[15, 30, 45].map((mins) => (
                    <button
                      key={mins}
                      onClick={() => setDurationMinutes(mins)}
                      className={`flex-1 rounded-md border py-1.5 text-xs font-medium transition-colors ${
                        durationMinutes === mins
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border bg-background text-foreground hover:bg-muted"
                      }`}
                    >
                      {formatHoursValue(mins)} hr
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

            {/* Footer */}
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
                {submitting
                  ? existing ? "Saving…" : "Submitting…"
                  : existing ? "Save quote" : "Submit quote"}
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

// Backward-compat default export so direct deep-links to
// /bookings/tire-quote-requests still resolve. The sidebar now points at
// the unified /bookings/quote-requests page.
export default function TireQuoteRequestsPage() {
  return <TireQuoteRequestsContent />;
}
