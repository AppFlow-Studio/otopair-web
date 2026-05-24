"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { formatPhoneInput, isValidUsPhone, normalizePhoneToE164 } from "@/lib/phone";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useEntityLabel } from "@/lib/use-entity-label";
import { ArrowRight, Calendar, Car, ChevronDown, Clock, Loader2, MessageSquare, Plus, Search, Stethoscope, User, Wrench, X } from "lucide-react";
import {
  Select,
  SelectItem,
  SelectListBox,
  SelectPopover,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  drawerInputClassName,
  drawerSelectTriggerClassName,
  DrawerFieldLabel,
} from "@/components/drawer-panel-styles";
import ConfirmationDialog, { ShortcutLabel } from "@/components/confirmation-dialog";
import ServiceOptionsPicker, { type SelectedServiceOption } from "@/components/booking/service-options-picker";
import TireSpecPicker, { type TireSpecs } from "@/components/booking/tire-spec-picker";
import DatePicker from "@/components/ui/date-picker";
import { getBookingEndTime } from "@/lib/schedule-overlap";
import VehicleYMMTPicker from "./vehicle-ymmt-picker";

/* ------------------------------------------------------------------ */
/*  Types                                                               */
/* ------------------------------------------------------------------ */

interface Mechanic {
  _id: string;
  name: string;
}

interface Booking {
  scheduledDate: string;
  scheduledTime: string;
  estimatedMinutes: number;
  status: string;
  mechanicId: string | null;
}

interface ShopHour {
  dayOfWeek: number;
  openTime: string;
  closeTime: string;
  isClosed: boolean;
}

interface CreateBookingDrawerProps {
  date: string;
  time: string;
  mechanicId: string;
  onDraftChange: (next: { date: string; time: string; mechanicId: string }) => void;
  mechanics: Mechanic[];
  bookings: Booking[];
  shopHours: ShopHour[];
  onClose: () => void;
  onToast: (msg: string) => void;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

function buildTimeOptions(): Array<{ value: string; label: string }> {
  const opts: Array<{ value: string; label: string }> = [];
  for (let h = 0; h < 24; h++) {
    for (const m of [0, 15, 30, 45]) {
      const value = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
      const ampm = h >= 12 ? "pm" : "am";
      const hour = h % 12 || 12;
      const label = `${hour}:${String(m).padStart(2, "0")} ${ampm}`;
      opts.push({ value, label });
    }
  }
  return opts;
}

const TIME_OPTIONS = buildTimeOptions();

const ESTIMATE_MINUTE_OPTIONS: number[] = Array.from({ length: 32 }, (_, i) => (i + 1) * 15);

function formatMinutesLabel(mins: number): string {
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
}

function toMins(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function getShopHoursForDate(shopHours: ShopHour[], date: string) {
  const dayOfWeek = new Date(`${date}T00:00:00`).getDay();
  return shopHours.find((hour) => hour.dayOfWeek === dayOfWeek) ?? null;
}

function getUserFacingErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) return "Failed to create booking";

  const message = err.message.trim();
  const uncaughtMatch = message.match(/Uncaught Error:\s*(.+?)(?:\.\s*Called by client)?$/);
  if (uncaughtMatch?.[1]) {
    return uncaughtMatch[1].trim();
  }

  const calledByClientMatch = message.match(/]\s*(.+?)\.\s*Called by client$/);
  if (calledByClientMatch?.[1]) {
    return calledByClientMatch[1].trim();
  }

  return message || "Failed to create booking";
}

function CollapsibleSection({
  sectionKey,
  icon: Icon,
  label,
  open,
  onToggle,
  required,
  children,
}: {
  sectionKey: string;
  icon: React.ElementType<{ className?: string }>;
  label: string;
  open: boolean;
  onToggle: (key: string) => void;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section>
      <button
        type="button"
        onClick={() => onToggle(sectionKey)}
        aria-expanded={open}
        className="mb-4 flex w-full items-center justify-between gap-2 text-left"
      >
        <span className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-primary" />
          <h3 className="text-[11px] font-bold tracking-wider text-muted-foreground">
            {label}
            {required ? (
              <span className="ml-1 text-destructive normal-case tracking-normal font-normal">
                *
              </span>
            ) : null}
          </h3>
        </span>
        <ChevronDown
          className={`h-4 w-4 text-muted-foreground transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open ? children : null}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Component                                                           */
/* ------------------------------------------------------------------ */

export default function CreateBookingDrawer({
  date,
  time,
  mechanicId,
  onDraftChange,
  mechanics,
  bookings,
  shopHours,
  onClose,
  onToast,
}: CreateBookingDrawerProps) {
  const entityLabel = useEntityLabel();

  /* ---- Customer ---- */
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");

  /* ---- Vehicle ---- */
  const [vin, setVin] = useState("");
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [make, setMake] = useState("");
  const [model, setModel] = useState("");
  const [trim, setTrim] = useState("");

  /* ---- VIN decode ---- */
  const VIN_REGEX = /^[A-HJ-NPR-Z0-9]{17}$/i;
  const [validVin, setValidVin] = useState("");
  const [vinLookupState, setVinLookupState] = useState<"idle" | "loading" | "error">("idle");
  const [vinSource, setVinSource] = useState<"convex" | "nhtsa" | null>(null);
  const [vinSuggestion, setVinSuggestion] = useState<{
    vin: string;
    year?: string;
    make?: string;
    model?: string;
    trim?: string;
  } | null>(null);
  const [vinImageUrl, setVinImageUrl] = useState<string | null>(null);
  const [vinImageLoading, setVinImageLoading] = useState(false);
  const [vinConfirmOpen, setVinConfirmOpen] = useState(false);
  const lastDecodedVinRef = useRef<string>("");

  type OwnerInfo = { userId: string; firstName: string | null; lastName: string | null; email: string | null; phone: string | null };
  const [pendingOwners, setPendingOwners] = useState<OwnerInfo[]>([]);
  const [ownerPickerOpen, setOwnerPickerOpen] = useState(false);

  // Convex lookup — skipped until a valid 17-char VIN is entered
  const convexVehicleInfo = useQuery(
    api.vehicles.getVehicleBookingInfo,
    validVin ? { vin: validVin } : "skip"
  );

  // Sync validVin from raw vin input
  useEffect(() => {
    const trimmed = vin.trim().toUpperCase();
    if (trimmed.length === 17 && VIN_REGEX.test(trimmed)) {
      setValidVin(trimmed);
    } else {
      setValidVin("");
      setVinLookupState("idle");
      setVinSource(null);
    }
  }, [vin]);

  // React to Convex result — prefill from DB or fall back to NHTSA
  useEffect(() => {
    if (!validVin) return;
    if (validVin === lastDecodedVinRef.current) return;

    if (convexVehicleInfo === undefined) {
      setVinLookupState("loading");
      return;
    }

    if (convexVehicleInfo !== null) {
      lastDecodedVinRef.current = validVin;
      setVinLookupState("idle");
      setVinSource("convex");
      setVinSuggestion({
        vin: validVin,
        year: convexVehicleInfo.year != null ? String(convexVehicleInfo.year) : undefined,
        make: convexVehicleInfo.make ?? undefined,
        model: convexVehicleInfo.model ?? undefined,
        trim: convexVehicleInfo.trim ?? undefined,
      });
      setVinImageUrl(null);
      setVinImageLoading(true);
      setVinConfirmOpen(true);
      setPendingOwners((convexVehicleInfo.owners ?? []) as OwnerInfo[]);

      const imgParams = new URLSearchParams({ vin: validVin });
      if (convexVehicleInfo.year) imgParams.set("year", String(convexVehicleInfo.year));
      if (convexVehicleInfo.make) imgParams.set("make", convexVehicleInfo.make);
      if (convexVehicleInfo.model) imgParams.set("model", convexVehicleInfo.model);
      if (convexVehicleInfo.trim) imgParams.set("trim", convexVehicleInfo.trim);
      fetch(`/api/vehicle-image?${imgParams.toString()}`)
        .then((r) => (r.ok ? r.json() : Promise.resolve({ imageUrl: null })))
        .then((d) => setVinImageUrl(d?.imageUrl ?? null))
        .catch(() => setVinImageUrl(null))
        .finally(() => setVinImageLoading(false));
      return;
    }

    // Not in Convex — fall back to NHTSA
    setVinLookupState("loading");
    let cancelled = false;
    const handle = window.setTimeout(async () => {
      try {
        const res = await fetch(
          `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValuesExtended/${encodeURIComponent(validVin)}?format=json`
        );
        if (!res.ok) throw new Error("NHTSA request failed");
        const data = await res.json();
        const row = data?.Results?.[0];
        if (cancelled) return;
        if (!row || row.ErrorCode === "11" || (!row.Make && !row.Model && !row.ModelYear)) {
          setVinLookupState("error");
          return;
        }
        lastDecodedVinRef.current = validVin;
        setVinSource("nhtsa");
        setVinSuggestion({
          vin: validVin,
          year: row.ModelYear || undefined,
          make: row.Make || undefined,
          model: row.Model || undefined,
          trim: row.Trim || undefined,
        });
        setVinImageUrl(null);
        setVinImageLoading(true);
        setVinConfirmOpen(true);
        setVinLookupState("idle");
        setPendingOwners([]);

        const imgParams = new URLSearchParams({ vin: validVin });
        if (row.ModelYear) imgParams.set("year", String(row.ModelYear));
        if (row.Make) imgParams.set("make", String(row.Make));
        if (row.Model) imgParams.set("model", String(row.Model));
        if (row.Trim) imgParams.set("trim", String(row.Trim));
        fetch(`/api/vehicle-image?${imgParams.toString()}`)
          .then((r) => (r.ok ? r.json() : Promise.resolve({ imageUrl: null })))
          .then((d) => { if (!cancelled) setVinImageUrl(d?.imageUrl ?? null); })
          .catch(() => { if (!cancelled) setVinImageUrl(null); })
          .finally(() => { if (!cancelled) setVinImageLoading(false); });
      } catch {
        if (!cancelled) setVinLookupState("error");
      }
    }, 400);

    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [validVin, convexVehicleInfo]);

  function applyOwner(owner: OwnerInfo) {
    if (owner.firstName) setFirstName(owner.firstName);
    if (owner.lastName) setLastName(owner.lastName);
    if (owner.email) setEmail(owner.email);
    if (owner.phone) {
      const digits = owner.phone.replace(/\D/g, "").slice(-10);
      if (digits.length === 10) setPhone(formatPhoneInput(digits));
    }
    setOwnerPickerOpen(false);
  }

  function applyVehicleOnly() {
    if (!vinSuggestion) return;
    if (vinSuggestion.year) setYear(vinSuggestion.year);
    if (vinSuggestion.make) setMake(vinSuggestion.make);
    if (vinSuggestion.model) setModel(vinSuggestion.model);
    if (vinSuggestion.trim) setTrim(vinSuggestion.trim);
    setVinConfirmOpen(false);
  }

  function applyVinSuggestion() {
    applyVehicleOnly();
    if (pendingOwners.length === 1) {
      applyOwner(pendingOwners[0]);
    } else if (pendingOwners.length > 1) {
      setOwnerPickerOpen(true);
    }
  }

  /* ---- Services ---- */
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [expandedCats, setExpandedCats] = useState<Set<string>>(new Set());
  const [customServices, setCustomServices] = useState<
    Array<{ name: string; durationMinutes?: number }>
  >([]);
  const [showCustomForm, setShowCustomForm] = useState(false);
  const [customDraftName, setCustomDraftName] = useState("");
  const [customDraftMinutes, setCustomDraftMinutes] = useState("");

  /* ---- Customer states / notes ---- */
  const [customerNotes, setCustomerNotes] = useState("");

  /* ---- Collapsible sections ---- */
  const SECTION_KEYS = [
    "customer",
    "vehicle",
    "services",
    "mechanic_estimate",
    "diagnostic",
    "notes",
    "scheduling",
  ] as const;
  type SectionKey = (typeof SECTION_KEYS)[number];
  const [openSections, setOpenSections] = useState<Set<SectionKey>>(
    () => new Set(SECTION_KEYS),
  );
  const toggleSection = (key: string) =>
    setOpenSections((current) => {
      const next = new Set(current);
      const k = key as SectionKey;
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  const openSection = (key: SectionKey) =>
    setOpenSections((current) => {
      if (current.has(key)) return current;
      const next = new Set(current);
      next.add(key);
      return next;
    });

  /* ---- Mechanic estimate (walk-in data capture) ---- */
  // Free-form mechanic overrides for time + price. Both `null` means "use the
  // catalog sum". Captured even when matching catalog so analytics can build
  // mechanic-quote vs. catalog vs. actual price/time distributions per
  // (shop, service, engine, chassis).
  const [mechanicEstimateMinutes, setMechanicEstimateMinutes] = useState<number | null>(null);
  const [mechanicQuotedPrice, setMechanicQuotedPrice] = useState<number | null>(null);

  /* ---- Diagnostic system ---- */
  type DiagnosticSystem =
    | "brakes"
    | "tires_wheels"
    | "engine"
    | "battery_electrical"
    | "not_sure";
  const [diagnosticSystem, setDiagnosticSystem] = useState<DiagnosticSystem | null>(null);

  /* ---- Scheduling (controlled by parent) ---- */
  const setDate = (next: string) => onDraftChange({ date: next, time, mechanicId });
  const setTime = (next: string) => onDraftChange({ date, time: next, mechanicId });
  const setMechanicId = (next: string) => onDraftChange({ date, time, mechanicId: next });

  const [assignmentPreference, setAssignmentPreference] = useState<
    "any" | "specific_mechanic"
  >(mechanicId ? "specific_mechanic" : "any");

  /* ---- Now-forward bounds ---- */
  const todayISO = useMemo(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }, []);
  const minTimeToday = useMemo(() => {
    const d = new Date();
    const totalMins = d.getHours() * 60 + d.getMinutes();
    const rounded = totalMins % 15 === 0 ? totalMins : totalMins + (15 - (totalMins % 15));
    const h = Math.min(23, Math.floor(rounded / 60));
    const m = rounded >= 24 * 60 ? 45 : rounded % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }, []);
  const isToday = date === todayISO;
  const filteredTimeOptions = useMemo(() => {
    const dayHours = getShopHoursForDate(shopHours, date);
    // Backfill (past date OR earlier-today) should be allowed without
    // narrowing the time picker — the mechanic is logging history, not
    // scheduling work, so shop-hours / now-floor filtering doesn't apply.
    const pastDay = date < todayISO;
    return TIME_OPTIONS.filter((o) => {
      if (!pastDay) {
        if (isToday && o.value < minTimeToday) {
          // Allow earlier-today selections for backfill but flag visually via banner.
          // (Skipping filter — `isBackfill` derived from date+time gates the flow.)
        }
        if (dayHours && !dayHours.isClosed) {
          const m = toMins(o.value);
          if (m < toMins(dayHours.openTime) || m >= toMins(dayHours.closeTime)) return false;
        }
      }
      return true;
    });
  }, [isToday, minTimeToday, shopHours, date, todayISO]);

  const [isSaving, setIsSaving] = useState(false);
  const [outsideHoursConfirmOpen, setOutsideHoursConfirmOpen] = useState(false);
  const [selectedServiceOptions, setSelectedServiceOptions] = useState<SelectedServiceOption[]>([]);
  const [tireSpecs, setTireSpecs] = useState<TireSpecs | null>(null);
  const [showOptionsPicker, setShowOptionsPicker] = useState(false);
  const [showTirePicker, setShowTirePicker] = useState(false);
  const [pendingSubmitOutsideHours, setPendingSubmitOutsideHours] = useState<boolean | null>(null);

  const shopData = useQuery(api.schedule.getShopServicesWithCategories);
  const createBooking = useMutation(api.bookings.createByShop);
  const backfillBooking = useMutation((api as any).bookings.backfillCompletedBooking);

  /* ---- Backfill mode: scheduled start is in the past. ---- */
  // Mechanics use the same drawer to retroactively log finished jobs so the
  // schedule stays in sync. When `isBackfill` is true the form skips capacity
  // / overlap / hours validation, swaps "estimate" labels to "actual",
  // requires completion mileage, and submits via backfillCompletedBooking.
  const [backfillCompletionMileage, setBackfillCompletionMileage] = useState<number | null>(null);
  const [backfillTechNotes, setBackfillTechNotes] = useState("");
  type BackfillPart = {
    part_name: string;
    oem_number: string;
    cost: string;
    quantity: string;
    // Which booking service this row belongs to. Drives per-service render
    // blocks and lets the server stamp service_id on each parts_used entry
    // so multi-service jobs get accurate downstream attribution.
    service_id: string;
  };
  const [backfillParts, setBackfillParts] = useState<BackfillPart[]>([]);
  const [backfillSendReceipt, setBackfillSendReceipt] = useState(false);
  const [backfillDuplicateAcknowledged, setBackfillDuplicateAcknowledged] = useState(false);
  const [backfillDuplicateConfirmOpen, setBackfillDuplicateConfirmOpen] = useState(false);

  const isBackfill = useMemo(() => {
    if (!date || !time) return false;
    const ms = new Date(`${date}T${time}:00`).getTime();
    return Number.isFinite(ms) && ms < Date.now();
  }, [date, time]);

  const isRecentBackfill = useMemo(() => {
    if (!isBackfill || !date || !time) return false;
    const ms = new Date(`${date}T${time}:00`).getTime();
    return Date.now() - ms < 24 * 60 * 60 * 1000;
  }, [isBackfill, date, time]);

  const isStaleBackfill = useMemo(() => {
    if (!isBackfill || !date || !time) return false;
    const ms = new Date(`${date}T${time}:00`).getTime();
    return Date.now() - ms > 30 * 24 * 60 * 60 * 1000;
  }, [isBackfill, date, time]);

  // Reset receipt toggle when we leave the recent window so it can't be
  // sent for a job logged a week later (UX from review).
  useEffect(() => {
    if (!isRecentBackfill && backfillSendReceipt) setBackfillSendReceipt(false);
  }, [isRecentBackfill, backfillSendReceipt]);

  // Any time the past-time inputs change, drop a previous duplicate ack so the
  // server check runs fresh against the new slot.
  useEffect(() => {
    setBackfillDuplicateAcknowledged(false);
  }, [date, time, vin]);

  // Sentinel prefix for the auto-generated tire-replacement parts row.
  // Used by the prefill effect (declared after `tireService` is in scope)
  // and by the per-service prune effect to keep tire rows alive.
  const TIRE_PART_PREFIX = "Tires — ";

  const categories = useMemo(() => shopData?.categories ?? [], [shopData?.categories]);

  const isDiagnostic = useMemo(() => {
    const matchesDiagnostic = (text: string | undefined | null) =>
      typeof text === "string" && /diagnost/i.test(text);
    for (const cat of categories as any[]) {
      const catLooksDiagnostic = matchesDiagnostic(cat.name);
      for (const s of cat.services) {
        if (!selectedIds.has(s._id)) continue;
        if (
          catLooksDiagnostic ||
          matchesDiagnostic(s.slug) ||
          matchesDiagnostic(s.name)
        ) {
          return true;
        }
      }
    }
    return false;
  }, [categories, selectedIds]);

  useEffect(() => {
    if (!isDiagnostic && diagnosticSystem !== null) setDiagnosticSystem(null);
  }, [isDiagnostic, diagnosticSystem]);

  /* ---- Option-bearing services ---- */
  const isTireReplacementService = (s: { slug?: string | null; name?: string | null }) => {
    const slug = (s.slug ?? "").toLowerCase();
    const name = (s.name ?? "").toLowerCase();
    return (
      slug === "tire-replacement" ||
      slug === "tire_replacement" ||
      slug === "tires" ||
      /tire.*(replac|change)/.test(slug) ||
      /tire.*(replac|change)/.test(name)
    );
  };
  const { optionServices, tireService } = useMemo(() => {
    const all = categories.flatMap((c: any) => c.services as any[]);
    const selected = all.filter((s) => selectedIds.has(s._id));
    return {
      optionServices: selected.filter(
        (s) => s.hasOptions && !isTireReplacementService(s),
      ),
      tireService: selected.find((s) => isTireReplacementService(s)) ?? null,
    };
  }, [categories, selectedIds]);

  // Drop stale picks when a service is deselected.
  useEffect(() => {
    setSelectedServiceOptions((current) =>
      current.filter((p) =>
        optionServices.some((s: any) => String(s._id) === String(p.service_id)),
      ),
    );
    if (!tireService && tireSpecs) setTireSpecs(null);
  }, [optionServices, tireService, tireSpecs]);

  // For tire-replacement backfills, prefill (or refresh) a parts row built
  // from the tire spec the mechanic picked. Walk-in/backfill tire jobs don't
  // have a tire_quote_responses row, so brand/per-tire price stay blank for
  // the mechanic to fill. The sentinel TIRE_PART_PREFIX keeps the row from
  // duplicating when specs are re-edited.
  useEffect(() => {
    if (!isBackfill) return;
    if (!tireSpecs || !tireService) return;
    const label = `${TIRE_PART_PREFIX}${tireSpecs.tier} ${tireSpecs.type}`.trim();
    const oem = `TIRE-${tireSpecs.size}`;
    const tireServiceId = String(tireService._id);
    setBackfillParts((rows) => {
      const existingIdx = rows.findIndex((r) =>
        r.part_name.startsWith(TIRE_PART_PREFIX),
      );
      const next: BackfillPart = {
        part_name: label,
        oem_number: oem,
        cost: existingIdx >= 0 ? rows[existingIdx].cost : "",
        quantity: String(tireSpecs.quantity),
        service_id: tireServiceId,
      };
      if (existingIdx >= 0) {
        const copy = [...rows];
        copy[existingIdx] = next;
        return copy;
      }
      return [next, ...rows];
    });
  }, [isBackfill, tireSpecs, tireService]);

  // Selected services that mandate parts entry. Surfaced in backfill mode
  // as one parts block per service so each is attributable downstream.
  // Tire-replacement is always included when selected — it always uses
  // parts (the tires themselves) even if the catalog row doesn't flag
  // requires_parts.
  const partsRequiredServicesForBackfill = useMemo(() => {
    if (!isBackfill) return [] as Array<{ _id: string; name: string }>;
    const all = categories.flatMap((c: any) => c.services as any[]);
    return all
      .filter(
        (s: any) =>
          selectedIds.has(s._id) &&
          (Boolean(s.requiresParts) || isTireReplacementService(s)),
      )
      .map((s: any) => ({ _id: String(s._id), name: String(s.name) }));
  }, [isBackfill, categories, selectedIds]);
  const requiresPartsForBackfill = partsRequiredServicesForBackfill.length > 0;

  // Drop any backfill part rows whose owning service has been deselected
  // (so the per-service blocks accurately reflect what's selected). Tire
  // sentinel rows are pruned via tireSpecs=null when the tire service is
  // removed, handled in the picker cleanup effect above.
  useEffect(() => {
    if (!isBackfill) return;
    const validIds = new Set(partsRequiredServicesForBackfill.map((s) => s._id));
    setBackfillParts((rows) => {
      const next = rows.filter(
        (r) =>
          r.part_name.startsWith(TIRE_PART_PREFIX) || validIds.has(r.service_id),
      );
      return next.length === rows.length ? rows : next;
    });
  }, [isBackfill, partsRequiredServicesForBackfill]);

  const missingOptionServices = useMemo(
    () =>
      optionServices.filter(
        (s: any) =>
          !selectedServiceOptions.some(
            (p) => String(p.service_id) === String(s._id),
          ),
      ),
    [optionServices, selectedServiceOptions],
  );
  const needsTireSpecs = tireService != null && tireSpecs == null;

  /* ---- Catalog-derived estimate (used as fallback + comparison baseline) ---- */
  const catalogEstimateMinutes = useMemo(() => {
    const allServices = categories.flatMap((c: any) => c.services as any[]);
    const selected = allServices.filter((s: any) => selectedIds.has(s._id));
    const customMins = customServices.reduce(
      (sum: number, c) => sum + (c.durationMinutes ?? 0),
      0,
    );
    return (
      selected.reduce(
        (sum: number, s: any) => sum + (s.defaultLaborHours ?? 0) * 60,
        0,
      ) + customMins
    );
  }, [categories, selectedIds, customServices]);

  // Mechanic override wins when present; otherwise fall back to catalog sum.
  const effectiveEstimateMinutes = useMemo(
    () => mechanicEstimateMinutes ?? catalogEstimateMinutes,
    [mechanicEstimateMinutes, catalogEstimateMinutes],
  );

  /* ---- Overlap check ---- */
  const overlapError = useMemo(() => {
    if (isBackfill) return null;
    if (!mechanicId || !date || !time) return null;
    const estMins = effectiveEstimateMinutes || 60;
    const endTime = getBookingEndTime(time, estMins);
    const startMins = toMins(time);
    const endMins = toMins(endTime);
    const conflict = bookings.find((b) => {
      if (b.scheduledDate !== date) return false;
      if (b.status === "cancelled" || b.status === "declined") return false;
      if (b.mechanicId !== mechanicId) return false;
      const bStart = toMins(b.scheduledTime);
      const bEnd = toMins(
        getBookingEndTime(b.scheduledTime, b.estimatedMinutes)
      );
      return bStart < endMins && bEnd > startMins;
    });
    return conflict ? "This time slot overlaps an existing booking for this mechanic." : null;
  }, [mechanicId, date, time, effectiveEstimateMinutes, bookings]);

  /* ---- Per-mechanic rolling-hour capacity (E1) ---- */
  const shopMeta = useQuery(api.shops.getMyShops, {} as any) as any[] | undefined;
  const capacityCap = (shopMeta?.[0] as any)?.max_bookings_per_mechanic_rolling_hour ?? 2;
  const capacityWarning = useMemo(() => {
    if (isBackfill) return null;
    if (!mechanicId || !date || !time) return null;
    const startMins = toMins(time);
    const windowStart = startMins - 60;
    const windowEnd = startMins + (effectiveEstimateMinutes || 60);
    const sameWindow = bookings.filter((b) => {
      if (b.scheduledDate !== date) return false;
      if (b.status === "cancelled" || b.status === "declined" || b.status === "no_show") return false;
      if (b.mechanicId !== mechanicId) return false;
      const bStart = toMins(b.scheduledTime);
      return bStart >= windowStart && bStart <= windowEnd;
    });
    if (sameWindow.length >= capacityCap) {
      return `Heads up — this mechanic already has ${sameWindow.length} job${sameWindow.length === 1 ? "" : "s"} in the same rolling hour (cap is ${capacityCap}).`;
    }
    return null;
  }, [mechanicId, date, time, effectiveEstimateMinutes, bookings, assignmentPreference, capacityCap]);

  const blockingHoursError = useMemo(() => {
    if (isBackfill) return null;
    if (!date || !time) return null;

    const dayHours = getShopHoursForDate(shopHours, date);

    if (!dayHours || dayHours.isClosed) {
      return "The shop is closed on the requested day.";
    }

    const startMins = toMins(time);
    const openMins = toMins(dayHours.openTime);
    const closeMins = toMins(dayHours.closeTime);

    if (startMins < openMins || startMins >= closeMins) {
      return "The requested start time is outside the shop's operating hours.";
    }

    return null;
  }, [date, time, shopHours]);

  const computedEndLabel = useMemo(() => {
    if (!time) return null;
    const estMins = effectiveEstimateMinutes || 60;
    const endHHMM = getBookingEndTime(time, estMins);
    const [h, m] = endHHMM.split(":").map(Number);
    const ampm = h >= 12 ? "pm" : "am";
    const hour = h % 12 || 12;
    return `${hour}:${String(m).padStart(2, "0")} ${ampm}`;
  }, [time, effectiveEstimateMinutes]);

  const outsideHoursWarning = useMemo(() => {
    if (isBackfill) return null;
    if (!date || !time) return null;
    const estMins = effectiveEstimateMinutes || 60;
    const endTime = getBookingEndTime(time, estMins);
    const dayHours = getShopHoursForDate(shopHours, date);
    if (!dayHours || dayHours.isClosed) return null;

    return toMins(endTime) > toMins(dayHours.closeTime)
      ? "This booking would end after the shop closes."
      : null;
  }, [date, time, effectiveEstimateMinutes, shopHours]);

  /* ---- Filter categories/services by search ---- */
  const filteredCats = useMemo(() => {
    if (!search.trim()) return categories;
    const q = search.toLowerCase();
    return categories
      .map((cat) => ({ ...cat, services: cat.services.filter((s) => s.name.toLowerCase().includes(q)) }))
      .filter((cat) => cat.services.length > 0);
  }, [categories, search]);

  const toggleCat = (id: string) => {
    setExpandedCats((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const toggleService = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  /* ---- Submit ---- */
  async function submitBooking(
    allowOutsideShopHours = false,
    optionsOverride?: SelectedServiceOption[],
    tireSpecsOverride?: TireSpecs | null,
  ) {
    // React state updates are async — when a picker confirms and immediately
    // calls submitBooking(), the parent state still holds the pre-confirm
    // value in this closure. Callers pass fresh picks through overrides so
    // the request carries the actual selections.
    const effectiveSelectedOptions = optionsOverride ?? selectedServiceOptions;
    const effectiveTireSpecs =
      tireSpecsOverride !== undefined ? tireSpecsOverride : tireSpecs;
    setIsSaving(true);
    try {
      const catalogMinutes = catalogEstimateMinutes || undefined;
      const estMinutes =
        (mechanicEstimateMinutes ?? catalogEstimateMinutes) || undefined;
      const finalVin = vin.trim() || `SHOP${Date.now()}`;

      await createBooking({
        shopId: shopData.shopId as Id<"shops">,
        customerEmail: email.trim() || undefined,
        customerPhone: normalizePhoneToE164(phone) ?? undefined,
        customerFirstName: firstName.trim() || undefined,
        customerLastName: lastName.trim() || undefined,
        vin: finalVin,
        vehicleYear: year ? Number(year) : undefined,
        vehicleMake: make.trim() || undefined,
        vehicleModel: model.trim() || undefined,
        vehicleTrim: trim.trim() || undefined,
        scheduledDate: date,
        scheduledTime: time,
        serviceIds: Array.from(selectedIds) as Id<"services">[],
        customServices: customServices.length > 0 ? customServices : undefined,
        customerNotes: customerNotes.trim() || undefined,
        diagnosticSystem: isDiagnostic && diagnosticSystem ? diagnosticSystem : undefined,
        mechanicId: mechanicId ? (mechanicId as Id<"mechanics">) : undefined,
        assignmentPreference,
        laborCost: 0,
        partsCost: 0,
        estimatedLaborMinutes: estMinutes,
        status: "confirmed",
        allowOutsideShopHours: allowOutsideShopHours || undefined,
        selectedServiceOptions:
          effectiveSelectedOptions.length > 0
            ? effectiveSelectedOptions.map((p) => ({
                service_id: p.service_id,
                option_id: p.option_id,
                option_label: p.option_label,
                option_type: p.option_type,
              }))
            : undefined,
        tireSpecs: effectiveTireSpecs ?? undefined,
        source: "mechanic_walk_in",
        mechanicEstimatedMinutes: mechanicEstimateMinutes ?? undefined,
        catalogEstimatedMinutes: catalogMinutes,
        mechanicQuotedPrice: mechanicQuotedPrice ?? undefined,
        catalogQuotedPrice: 0,
      });

      onToast("Booking created");
      onClose();
    } catch (err: unknown) {
      onToast(getUserFacingErrorMessage(err));
    } finally {
      setIsSaving(false);
    }
  }

  async function submitBackfill(ackDuplicate = false) {
    if (!shopData?.shopId) return;
    // Defense in depth: pickers' onConfirm callbacks call submitBackfill
    // directly, bypassing handleSubmit's guards. Re-check the required
    // numeric inputs here so a null never reaches the server validator.
    if (mechanicEstimateMinutes == null || mechanicEstimateMinutes <= 0) {
      openSection("mechanic_estimate");
      onToast("Enter the actual time the job took.");
      return;
    }
    if (mechanicQuotedPrice == null || mechanicQuotedPrice <= 0) {
      openSection("mechanic_estimate");
      onToast("Enter the price charged.");
      return;
    }
    if (
      backfillCompletionMileage == null ||
      !Number.isFinite(backfillCompletionMileage) ||
      backfillCompletionMileage < 0
    ) {
      openSection("mechanic_estimate");
      onToast("Enter the completion mileage.");
      return;
    }
    const normalizedParts = backfillParts
      .map((p) => ({
        part_name: p.part_name.trim(),
        oem_number: p.oem_number.trim(),
        cost: Number(p.cost),
        quantity: p.quantity.trim() === "" ? 1 : Number(p.quantity),
        service_id: p.service_id as Id<"services">,
      }))
      .filter(
        (p) =>
          p.part_name.length > 0 &&
          p.oem_number.length > 0 &&
          Number.isFinite(p.cost) &&
          Number.isFinite(p.quantity),
      );
    // Each parts-required service must contribute ≥1 row. The flat-list
    // check ("at least one part used") was wrong on multi-service jobs.
    const missingPartsForServiceName = partsRequiredServicesForBackfill.find(
      (svc) =>
        !normalizedParts.some((p) => String(p.service_id) === svc._id),
    )?.name;
    if (missingPartsForServiceName) {
      openSection("mechanic_estimate");
      onToast(`Add at least one part for ${missingPartsForServiceName}.`);
      return;
    }
    const partsCost = normalizedParts.reduce(
      (sum, p) => sum + p.cost * (p.quantity || 1),
      0,
    );
    setIsSaving(true);
    try {
      const finalVin = vin.trim() || `SHOP${Date.now()}`;
      const result = await backfillBooking({
        shopId: shopData.shopId as Id<"shops">,
        customerEmail: email.trim() || undefined,
        customerPhone: normalizePhoneToE164(phone) ?? undefined,
        customerFirstName: firstName.trim() || undefined,
        customerLastName: lastName.trim() || undefined,
        vin: finalVin,
        vehicleYear: year ? Number(year) : undefined,
        vehicleMake: make.trim() || undefined,
        vehicleModel: model.trim() || undefined,
        vehicleTrim: trim.trim() || undefined,
        scheduledDate: date,
        scheduledTime: time,
        serviceIds: Array.from(selectedIds) as Id<"services">[],
        customServices: customServices.length > 0 ? customServices : undefined,
        customerNotes: customerNotes.trim() || undefined,
        diagnosticSystem:
          isDiagnostic && diagnosticSystem ? diagnosticSystem : undefined,
        mechanicId: mechanicId ? (mechanicId as Id<"mechanics">) : undefined,
        selectedServiceOptions:
          selectedServiceOptions.length > 0
            ? selectedServiceOptions.map((p) => ({
                service_id: p.service_id,
                option_id: p.option_id,
                option_label: p.option_label,
                option_type: p.option_type,
              }))
            : undefined,
        tireSpecs: tireSpecs ?? undefined,
        actualDurationMinutes: mechanicEstimateMinutes,
        actualPriceCharged: mechanicQuotedPrice,
        actualPartsCost: partsCost,
        postjob: {
          completion_mileage: backfillCompletionMileage,
          parts_used: normalizedParts,
          actual_labor_minutes: mechanicEstimateMinutes,
          actual_parts_cost: partsCost,
          technician_notes: backfillTechNotes.trim() || undefined,
        },
        sendCustomerReceipt: isRecentBackfill ? backfillSendReceipt : false,
        acknowledgedDuplicate: ackDuplicate || undefined,
      });
      onToast(
        `Backfill logged for ${date}${result?.bookingId ? "" : ""}`,
      );
      onClose();
    } catch (err: unknown) {
      // ConvexError surfaces structured data on `err.data` on the client.
      // Fall back to substring on `err.message` for safety in case the
      // payload is missing (older builds, transport quirks).
      const data = (err as { data?: { code?: string } } | undefined)?.data;
      const msg = err instanceof Error ? err.message : String(err);
      if (data?.code === "DUPLICATE_BACKFILL" || msg.includes("DUPLICATE_BACKFILL")) {
        setBackfillDuplicateConfirmOpen(true);
      } else {
        onToast(getUserFacingErrorMessage(err));
      }
    } finally {
      setIsSaving(false);
    }
  }

  async function handleSubmit() {
    if (!firstName.trim() || !shopData?.shopId) return;
    if (!isValidUsPhone(phone)) {
      onToast("Enter a valid 10-digit US phone number.");
      return;
    }

    if (isBackfill) {
      if (mechanicEstimateMinutes == null || mechanicEstimateMinutes <= 0) {
        openSection("mechanic_estimate");
        onToast("Enter the actual time the job took.");
        return;
      }
      if (mechanicQuotedPrice == null || mechanicQuotedPrice <= 0) {
        openSection("mechanic_estimate");
        onToast("Enter the price charged.");
        return;
      }
      if (
        backfillCompletionMileage == null ||
        !Number.isFinite(backfillCompletionMileage) ||
        backfillCompletionMileage < 0
      ) {
        openSection("mechanic_estimate");
        onToast("Enter the completion mileage.");
        return;
      }
      if (missingOptionServices.length > 0) {
        setShowOptionsPicker(true);
        return;
      }
      if (needsTireSpecs) {
        setShowTirePicker(true);
        return;
      }
      await submitBackfill(backfillDuplicateAcknowledged);
      return;
    }

    if (date < todayISO || (isToday && time < minTimeToday)) {
      onToast("Pick a time from now onward.");
      return;
    }

    if (mechanicEstimateMinutes == null || mechanicEstimateMinutes <= 0) {
      openSection("mechanic_estimate");
      onToast("Enter the mechanic's time estimate.");
      return;
    }
    if (mechanicQuotedPrice == null || mechanicQuotedPrice <= 0) {
      openSection("mechanic_estimate");
      onToast("Enter the quoted price.");
      return;
    }

    const preflightError = overlapError ?? blockingHoursError;
    if (preflightError) {
      onToast(preflightError);
      return;
    }

    if (missingOptionServices.length > 0) {
      setShowOptionsPicker(true);
      return;
    }

    if (needsTireSpecs) {
      setShowTirePicker(true);
      return;
    }

    if (outsideHoursWarning) {
      setOutsideHoursConfirmOpen(true);
      return;
    }

    await submitBooking(false);
  }

  /* ---- Render ---- */
  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-border shrink-0">
        <h2 className="text-base font-semibold text-foreground">Create booking</h2>
        <button
          onClick={onClose}
          className="p-1 rounded-lg hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto px-5 py-5 space-y-6">

        {isBackfill && (
          <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <div className="font-semibold">Logging a past job — backfill mode</div>
            <p className="mt-1 text-xs text-amber-800/90">
              Capacity, overlap, and shop-hours checks are skipped. Enter the
              actual time, price charged, and completion mileage. The job will
              be recorded as completed.
              {isStaleBackfill && (
                <span className="block mt-1 font-medium">
                  Heads up — this is more than 30 days old.
                </span>
              )}
            </p>
          </div>
        )}

        {/* ── Customer Info ── */}
        <CollapsibleSection
          sectionKey="customer"
          icon={User}
          label="Customer Info"
          open={openSections.has("customer")}
          onToggle={toggleSection}
          required
        >
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <DrawerFieldLabel>First Name <span className="text-destructive normal-case tracking-normal font-normal">*</span></DrawerFieldLabel>
                <input type="text" placeholder="James" value={firstName} onChange={(e) => setFirstName(e.target.value)} className={drawerInputClassName} />
              </div>
              <div>
                <DrawerFieldLabel>Last Name</DrawerFieldLabel>
                <input type="text" placeholder="Wilson" value={lastName} onChange={(e) => setLastName(e.target.value)} className={drawerInputClassName} />
              </div>
            </div>
            <div>
              <DrawerFieldLabel>Phone <span className="text-destructive normal-case tracking-normal font-normal">*</span></DrawerFieldLabel>
              <input type="tel" inputMode="tel" placeholder="(555) 123-4567" value={phone} onChange={(e) => setPhone(formatPhoneInput(e.target.value))} className={drawerInputClassName} />
            </div>
            <div>
              <DrawerFieldLabel>Email <span className="normal-case tracking-normal font-normal text-muted-foreground/60">(Optional)</span></DrawerFieldLabel>
              <input type="email" placeholder="customer@example.com" value={email} onChange={(e) => setEmail(e.target.value)} className={drawerInputClassName} />
            </div>
          </div>
        </CollapsibleSection>

        {/* ── Vehicle Info ── */}
        <CollapsibleSection
          sectionKey="vehicle"
          icon={Car}
          label="Vehicle Info"
          open={openSections.has("vehicle")}
          onToggle={toggleSection}
        >
          <div className="space-y-3">
            <div>
              <DrawerFieldLabel>VIN <span className="normal-case tracking-normal font-normal text-muted-foreground/60">(Optional)</span></DrawerFieldLabel>
              <div className="relative">
                <input
                  type="text"
                  placeholder="17-digit code"
                  value={vin}
                  onChange={(e) => setVin(e.target.value.toUpperCase())}
                  maxLength={17}
                  className={`${drawerInputClassName} font-mono uppercase pr-9`}
                />
                {vinLookupState === "loading" && (
                  <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground animate-spin" />
                )}
              </div>
              {vinLookupState === "error" && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Couldn&apos;t decode VIN. Enter make/model manually.
                </p>
              )}
              {vinLookupState === "idle" &&
                vinSuggestion &&
                lastDecodedVinRef.current === vin.trim().toUpperCase() &&
                !vinConfirmOpen &&
                (year === vinSuggestion.year || make === vinSuggestion.make) && (
                  <p className="mt-1 text-xs text-primary">
                    Decoded: {[vinSuggestion.year, vinSuggestion.make, vinSuggestion.model]
                      .filter(Boolean)
                      .join(" ")}
                  </p>
                )}
            </div>
            <VehicleYMMTPicker
              year={year}
              make={make}
              model={model}
              trim={trim}
              onChange={(next) => {
                if (next.year !== undefined) setYear(next.year);
                if (next.make !== undefined) setMake(next.make);
                if (next.model !== undefined) setModel(next.model);
                if (next.trim !== undefined) setTrim(next.trim);
              }}
            />
          </div>
        </CollapsibleSection>

        {/* ── Service Selection ── */}
        <CollapsibleSection
          sectionKey="services"
          icon={Wrench}
          label="Service Selection"
          open={openSections.has("services")}
          onToggle={toggleSection}
          required
        >

          {/* Selected chips */}
          {(selectedIds.size > 0 || customServices.length > 0) && (
            <div className="mb-3 flex flex-wrap gap-1.5">
              {categories
                .flatMap((c: any) => c.services)
                .filter((s: any) => selectedIds.has(s._id))
                .map((s: any) => (
                  <button
                    key={s._id}
                    type="button"
                    onClick={() => toggleService(s._id)}
                    className="inline-flex items-center gap-1.5 pl-2.5 pr-1.5 py-1 rounded-full bg-primary/10 text-primary text-xs font-medium hover:bg-primary/15 transition-colors"
                  >
                    <span>{s.name}</span>
                    <X className="w-3 h-3" />
                  </button>
                ))}
              {customServices.map((c, idx) => (
                <button
                  key={`custom-${idx}`}
                  type="button"
                  onClick={() =>
                    setCustomServices((prev) => prev.filter((_, i) => i !== idx))
                  }
                  className="inline-flex items-center gap-1.5 pl-2.5 pr-1.5 py-1 rounded-full bg-amber-100 text-amber-800 text-xs font-medium hover:bg-amber-200 transition-colors"
                >
                  <span>{c.name}{c.durationMinutes ? ` · ${c.durationMinutes}m` : ""}</span>
                  <X className="w-3 h-3" />
                </button>
              ))}
            </div>
          )}

          {(optionServices.length > 0 || tireService) && (
            <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50/60 p-2.5 text-xs text-amber-900">
              <div className="flex items-start justify-between gap-2">
                <div className="space-y-1">
                  {optionServices.map((s: any) => {
                    const pick = selectedServiceOptions.find(
                      (p) => String(p.service_id) === String(s._id),
                    );
                    return (
                      <div key={s._id} className="flex items-center gap-1.5">
                        <span className="font-medium">{s.name}:</span>
                        {pick ? (
                          <span>{pick.option_label}</span>
                        ) : (
                          <span className="italic">option required</span>
                        )}
                      </div>
                    );
                  })}
                  {tireService && (
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium">{tireService.name}:</span>
                      {tireSpecs ? (
                        <span>
                          {tireSpecs.size} · {tireSpecs.type} · {tireSpecs.tier} · {tireSpecs.quantity} tires
                        </span>
                      ) : (
                        <span className="italic">specs required</span>
                      )}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    if (optionServices.length > 0) setShowOptionsPicker(true);
                    else if (tireService) setShowTirePicker(true);
                  }}
                  className="shrink-0 rounded-md border border-amber-300 bg-white px-2 py-1 text-[11px] font-medium text-amber-900 hover:bg-amber-100"
                >
                  {selectedServiceOptions.length === optionServices.length && (tireService ? tireSpecs : true)
                    ? "Edit options"
                    : "Pick options"}
                </button>
              </div>
            </div>
          )}

          {/* Search */}
          <div className="relative mb-3">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
            <input
              type="text"
              placeholder="Search services…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-10 pr-4 py-2.5 bg-muted/70 border-0 rounded-lg text-sm text-foreground placeholder:text-muted-foreground/50 outline-none focus:ring-2 focus:ring-primary/20"
            />
          </div>

          {shopData === undefined ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-5 h-5 text-primary animate-spin" />
            </div>
          ) : filteredCats.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">No services found</p>
          ) : (
            <div className="space-y-2">
              {filteredCats.map((cat: any) => {
                const isExpanded = expandedCats.has(cat.id) || !!search.trim();
                const selectedCount = cat.services.filter((s: any) => selectedIds.has(s._id)).length;
                return (
                  <div key={cat.id} className="rounded-xl border border-border overflow-hidden">
                    <button
                      onClick={() => toggleCat(cat.id)}
                      className="flex justify-between items-center w-full px-3 py-2.5 bg-muted/30 hover:bg-muted/60 transition-colors"
                    >
                      <span className="text-xs font-semibold text-foreground">
                        {cat.name}
                        <span className="ml-2 text-muted-foreground font-normal">{cat.services.length}</span>
                        {selectedCount > 0 && (
                          <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded-full bg-primary text-primary-foreground text-[10px] font-semibold">
                            {selectedCount}
                          </span>
                        )}
                      </span>
                      <ChevronDown className={`w-3.5 h-3.5 text-muted-foreground transition-transform duration-200 ${isExpanded ? "rotate-180" : ""}`} />
                    </button>
                    {isExpanded && (
                      <div className="divide-y divide-border/60">
                        {cat.services.map((s: any) => {
                          const checked = selectedIds.has(s._id);
                          const mins = Math.round((s.defaultLaborHours ?? 0) * 60);
                          return (
                            <label
                              key={s._id}
                              className={`flex items-center gap-3 px-3 py-2 cursor-pointer transition-colors ${
                                checked ? "bg-primary/5" : "hover:bg-muted/40"
                              }`}
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleService(s._id)}
                                className="w-4 h-4 rounded border-border text-primary accent-primary shrink-0"
                              />
                              <span className="flex-1 text-sm text-foreground truncate">{s.name}</span>
                              {mins > 0 && (
                                <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground tabular-nums shrink-0">
                                  <Clock className="w-3 h-3" />
                                  {mins}m
                                </span>
                              )}
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Add custom service */}
          <div className="mt-3">
            {showCustomForm ? (
              <div className="rounded-xl border border-dashed border-border p-3 space-y-2 bg-muted/20">
                <div className="grid grid-cols-[1fr_88px] gap-2">
                  <input
                    type="text"
                    autoFocus
                    placeholder="Service name (e.g. Wheel alignment)"
                    value={customDraftName}
                    onChange={(e) => setCustomDraftName(e.target.value)}
                    className={drawerInputClassName}
                  />
                  <Select
                    selectedKey={customDraftMinutes || null}
                    onSelectionChange={(key) => setCustomDraftMinutes(key == null ? "" : String(key))}
                    placeholder="min"
                  >
                    <SelectTrigger className={drawerSelectTriggerClassName}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopover placement="bottom start">
                      <SelectListBox shouldFocusWrap>
                        {ESTIMATE_MINUTE_OPTIONS.map((m) => (
                          <SelectItem key={m} id={String(m)} textValue={formatMinutesLabel(m)}>
                            {formatMinutesLabel(m)}
                          </SelectItem>
                        ))}
                      </SelectListBox>
                    </SelectPopover>
                  </Select>
                </div>
                <div className="flex gap-2 justify-end">
                  <button
                    type="button"
                    onClick={() => {
                      setShowCustomForm(false);
                      setCustomDraftName("");
                      setCustomDraftMinutes("");
                    }}
                    className="px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={!customDraftName.trim()}
                    onClick={() => {
                      const name = customDraftName.trim();
                      if (!name) return;
                      const mins = customDraftMinutes ? Number(customDraftMinutes) : NaN;
                      setCustomServices((prev) => [
                        ...prev,
                        { name, durationMinutes: Number.isFinite(mins) && mins > 0 ? mins : undefined },
                      ]);
                      setShowCustomForm(false);
                      setCustomDraftName("");
                      setCustomDraftMinutes("");
                    }}
                    className="px-3 py-1.5 text-xs font-semibold rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
                  >
                    Add
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setShowCustomForm(true)}
                className="w-full flex items-center justify-center gap-1.5 py-2 rounded-xl border border-dashed border-border text-xs font-medium text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
                Add custom service
              </button>
            )}
          </div>
        </CollapsibleSection>

        {/* ── Mechanic estimate (walk-in data capture) — mandatory ──
            In backfill mode the same two inputs capture ACTUALS instead of
            estimates: time becomes actual duration, quoted price becomes
            price charged. The values land in actual_duration_minutes /
            actual_price_charged on the booking row. */}
        <CollapsibleSection
          sectionKey="mechanic_estimate"
          icon={Clock}
          label={isBackfill ? "Actuals" : "Mechanic estimate"}
          open={openSections.has("mechanic_estimate")}
          onToggle={toggleSection}
          required
        >
          <div className="grid grid-cols-2 gap-3">
            <div>
              <DrawerFieldLabel>
                {isBackfill ? "Actual time (minutes)" : "Time (minutes)"}{" "}
                <span className="text-destructive normal-case tracking-normal font-normal">
                  *
                </span>
              </DrawerFieldLabel>
              <Select
                selectedKey={mechanicEstimateMinutes != null ? String(mechanicEstimateMinutes) : null}
                onSelectionChange={(key) => {
                  if (key == null) {
                    setMechanicEstimateMinutes(null);
                    return;
                  }
                  const n = Number(key);
                  setMechanicEstimateMinutes(Number.isFinite(n) && n >= 0 ? n : null);
                }}
                placeholder={
                  catalogEstimateMinutes > 0
                    ? formatMinutesLabel(catalogEstimateMinutes)
                    : "Select duration"
                }
              >
                <SelectTrigger className={drawerSelectTriggerClassName}>
                  <SelectValue />
                </SelectTrigger>
                <SelectPopover placement="bottom start">
                  <SelectListBox shouldFocusWrap>
                    {ESTIMATE_MINUTE_OPTIONS.map((m) => (
                      <SelectItem key={m} id={String(m)} textValue={formatMinutesLabel(m)}>
                        {formatMinutesLabel(m)}
                      </SelectItem>
                    ))}
                  </SelectListBox>
                </SelectPopover>
              </Select>
              <p className="mt-1 text-xs text-muted-foreground">
                {isBackfill
                  ? "How long the job actually took."
                  : "Your estimate for total job time."}
              </p>
            </div>
            <div>
              <DrawerFieldLabel>
                {isBackfill ? "Price charged ($)" : "Quoted price ($)"}{" "}
                <span className="text-destructive normal-case tracking-normal font-normal">
                  *
                </span>
              </DrawerFieldLabel>
              <input
                type="number"
                min={0}
                step={1}
                inputMode="decimal"
                placeholder="e.g. 250"
                value={mechanicQuotedPrice ?? ""}
                onChange={(e) => {
                  const raw = e.target.value;
                  if (raw === "") {
                    setMechanicQuotedPrice(null);
                    return;
                  }
                  const n = Number(raw);
                  setMechanicQuotedPrice(Number.isFinite(n) && n >= 0 ? n : null);
                }}
                className={drawerInputClassName}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {isBackfill
                  ? "What you actually charged the customer."
                  : "What you quoted this walk-in."}
              </p>
            </div>
          </div>

          {isBackfill && (
            <div className="mt-4 space-y-3 rounded-xl border border-border bg-muted/20 p-3">
              <div>
                <DrawerFieldLabel>
                  Completion mileage{" "}
                  <span className="text-destructive normal-case tracking-normal font-normal">
                    *
                  </span>
                </DrawerFieldLabel>
                <input
                  type="number"
                  min={0}
                  step={1}
                  inputMode="numeric"
                  placeholder="e.g. 84210"
                  value={backfillCompletionMileage ?? ""}
                  onChange={(e) => {
                    const raw = e.target.value;
                    if (raw === "") {
                      setBackfillCompletionMileage(null);
                      return;
                    }
                    const n = Number(raw);
                    setBackfillCompletionMileage(
                      Number.isFinite(n) && n >= 0 ? n : null,
                    );
                  }}
                  className={drawerInputClassName}
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  Odometer reading when the job finished.
                </p>
              </div>
              {requiresPartsForBackfill && (
                <div className="space-y-4">
                  {partsRequiredServicesForBackfill.map((svc) => {
                    const rowsForService = backfillParts
                      .map((p, originalIdx) => ({ p, originalIdx }))
                      .filter(({ p }) => p.service_id === svc._id);
                    const hasAny = rowsForService.length > 0;
                    return (
                      <div
                        key={svc._id}
                        className="rounded-lg border border-border bg-background/40 p-3"
                      >
                        <DrawerFieldLabel>
                          {svc.name} — parts used{" "}
                          <span className="text-destructive normal-case tracking-normal font-normal">
                            *
                          </span>
                        </DrawerFieldLabel>
                        <div className="space-y-2">
                          {rowsForService.map(({ p, originalIdx }) => (
                            <div
                              key={originalIdx}
                              className="grid grid-cols-12 gap-2 items-start"
                            >
                              <input
                                type="text"
                                placeholder="Part name"
                                value={p.part_name}
                                onChange={(e) =>
                                  setBackfillParts((rows) =>
                                    rows.map((r, i) =>
                                      i === originalIdx
                                        ? { ...r, part_name: e.target.value }
                                        : r,
                                    ),
                                  )
                                }
                                className={`${drawerInputClassName} col-span-4`}
                              />
                              <input
                                type="text"
                                placeholder="OEM #"
                                value={p.oem_number}
                                onChange={(e) =>
                                  setBackfillParts((rows) =>
                                    rows.map((r, i) =>
                                      i === originalIdx
                                        ? { ...r, oem_number: e.target.value }
                                        : r,
                                    ),
                                  )
                                }
                                className={`${drawerInputClassName} col-span-3 font-mono uppercase`}
                              />
                              <input
                                type="number"
                                min={0}
                                step={1}
                                placeholder="Qty"
                                value={p.quantity}
                                onChange={(e) =>
                                  setBackfillParts((rows) =>
                                    rows.map((r, i) =>
                                      i === originalIdx
                                        ? { ...r, quantity: e.target.value }
                                        : r,
                                    ),
                                  )
                                }
                                className={`${drawerInputClassName} col-span-2`}
                              />
                              <input
                                type="number"
                                min={0}
                                step={0.01}
                                placeholder="Cost"
                                value={p.cost}
                                onChange={(e) =>
                                  setBackfillParts((rows) =>
                                    rows.map((r, i) =>
                                      i === originalIdx
                                        ? { ...r, cost: e.target.value }
                                        : r,
                                    ),
                                  )
                                }
                                className={`${drawerInputClassName} col-span-2`}
                              />
                              <button
                                type="button"
                                onClick={() =>
                                  setBackfillParts((rows) =>
                                    rows.filter((_, i) => i !== originalIdx),
                                  )
                                }
                                className="col-span-1 text-xs text-muted-foreground hover:text-destructive py-2"
                                aria-label="Remove part"
                              >
                                ×
                              </button>
                            </div>
                          ))}
                          <button
                            type="button"
                            onClick={() =>
                              setBackfillParts((rows) => [
                                ...rows,
                                {
                                  part_name: "",
                                  oem_number: "",
                                  cost: "",
                                  quantity: "1",
                                  service_id: svc._id,
                                },
                              ])
                            }
                            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                          >
                            <Plus className="w-3.5 h-3.5" />
                            Add part
                          </button>
                        </div>
                        {!hasAny && (
                          <p className="mt-1 text-xs text-amber-700">
                            Required — add at least one part for {svc.name}.
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              <div>
                <DrawerFieldLabel>What was done</DrawerFieldLabel>
                <textarea
                  value={backfillTechNotes}
                  onChange={(e) =>
                    setBackfillTechNotes(e.target.value.slice(0, 2000))
                  }
                  placeholder="Replaced front pads, resurfaced rotors, road test OK."
                  rows={3}
                  className={`${drawerInputClassName} resize-none leading-relaxed`}
                />
              </div>
              {isRecentBackfill && (
                <label className="flex items-start gap-2 text-xs text-foreground/90">
                  <input
                    type="checkbox"
                    checked={backfillSendReceipt}
                    onChange={(e) => setBackfillSendReceipt(e.target.checked)}
                    className="mt-0.5"
                  />
                  <span>
                    Send completion receipt to customer
                    <span className="block text-muted-foreground">
                      Only available for jobs within the last 24 hours.
                    </span>
                  </span>
                </label>
              )}
            </div>
          )}
        </CollapsibleSection>

        {/* ── Diagnostic system (only when a diagnostic service is selected) ── */}
        {isDiagnostic && (
          <CollapsibleSection
            sectionKey="diagnostic"
            icon={Stethoscope}
            label="Diagnostic system"
            open={openSections.has("diagnostic")}
            onToggle={toggleSection}
          >
            <DrawerFieldLabel>What&apos;s bothering the customer?</DrawerFieldLabel>
            <div className="space-y-1.5">
              {([
                { value: "brakes", label: "Brakes", hint: "Squealing, grinding, soft pedal" },
                { value: "tires_wheels", label: "Tires & Wheels", hint: "Vibration, thudding, pulling" },
                { value: "engine", label: "Engine", hint: "Rattle, rough idle, warning light" },
                { value: "battery_electrical", label: "Battery & Electrical", hint: "Won't start, dim lights" },
                { value: "not_sure", label: "Not sure", hint: "Let the mechanic look around" },
              ] as Array<{ value: DiagnosticSystem; label: string; hint: string }>).map((opt) => {
                const selected = diagnosticSystem === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setDiagnosticSystem(opt.value)}
                    className={`w-full flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl border text-left transition-colors ${
                      selected
                        ? "border-primary bg-primary/5"
                        : "border-border hover:bg-muted/40"
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-foreground">{opt.label}</div>
                      <div className="text-xs text-muted-foreground truncate">{opt.hint}</div>
                    </div>
                    <div
                      className={`w-4 h-4 rounded-full border-2 shrink-0 ${
                        selected ? "border-primary bg-primary" : "border-border"
                      }`}
                    />
                  </button>
                );
              })}
            </div>

            {diagnosticSystem && (
              <div className="mt-3 rounded-xl border border-border bg-muted/30 p-3 space-y-2">
                <div className="flex items-center justify-between gap-3 text-xs">
                  <span className="text-muted-foreground">Diagnostic fee</span>
                  <span className="font-semibold text-foreground tabular-nums">
                    $120–180
                    <span className="ml-1 font-normal text-muted-foreground">· captured on completion</span>
                  </span>
                </div>
                <p className="rounded-md bg-background/70 px-2.5 py-2 text-[11px] font-medium text-foreground border border-border">
                  🛡 No repair is booked or charged without the customer&apos;s confirmation.
                </p>
              </div>
            )}
          </CollapsibleSection>
        )}

        {/* ── Customer states ── */}
        <CollapsibleSection
          sectionKey="notes"
          icon={MessageSquare}
          label="Customer states"
          open={openSections.has("notes")}
          onToggle={toggleSection}
        >
          <DrawerFieldLabel>Notes from the customer (optional)</DrawerFieldLabel>
          <textarea
            value={customerNotes}
            onChange={(e) => setCustomerNotes(e.target.value.slice(0, 1000))}
            placeholder="Thudding from the front, gets worse around 50 mph. Started a week ago."
            rows={3}
            className={`${drawerInputClassName} resize-none leading-relaxed`}
          />
        </CollapsibleSection>

        {/* ── Scheduling ── */}
        <CollapsibleSection
          sectionKey="scheduling"
          icon={Calendar}
          label="Scheduling"
          open={openSections.has("scheduling")}
          onToggle={toggleSection}
          required
        >
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <DrawerFieldLabel>Date</DrawerFieldLabel>
                <DatePicker value={date} onChange={(next) => next && setDate(next)} />
              </div>
              <div>
                <DrawerFieldLabel>Time</DrawerFieldLabel>
                <Select selectedKey={time} onSelectionChange={(key) => setTime(String(key))}>
                  <SelectTrigger className={drawerSelectTriggerClassName}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopover placement="bottom start">
                    <SelectListBox shouldFocusWrap>
                      {filteredTimeOptions.map((o) => (
                        <SelectItem key={o.value} id={o.value} textValue={o.label}>{o.label}</SelectItem>
                      ))}
                    </SelectListBox>
                  </SelectPopover>
                </Select>
                {computedEndLabel ? (
                  <p className="mt-1 text-xs text-gray-500">Ends ~ {computedEndLabel}</p>
                ) : null}
              </div>
            </div>
            {mechanics.length > 0 && (
              <div>
                <DrawerFieldLabel>Assignment</DrawerFieldLabel>
                <Select
                  selectedKey={assignmentPreference === "any" ? "any" : mechanicId}
                  onSelectionChange={(key) => {
                    if (key === "any") {
                      setAssignmentPreference("any");
                      setMechanicId("");
                      return;
                    }
                    setAssignmentPreference("specific_mechanic");
                    setMechanicId(String(key));
                  }}
                >
                  <SelectTrigger className={drawerSelectTriggerClassName}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopover placement="bottom start">
                    <SelectListBox shouldFocusWrap>
                      <SelectItem id="any" textValue={entityLabel.anyLabel}>
                        <span className="text-muted-foreground">{entityLabel.anyLabel}</span>
                      </SelectItem>
                      {mechanics.map((m) => (
                        <SelectItem key={m._id} id={m._id} textValue={m.name}>{m.name}</SelectItem>
                      ))}
                    </SelectListBox>
                  </SelectPopover>
                </Select>
              </div>
            )}
            {overlapError && (
              <p className="form-error-text text-xs">{overlapError}</p>
            )}
            {blockingHoursError && (
              <p className="form-error-text text-xs">{blockingHoursError}</p>
            )}
            {capacityWarning && (
              <p className="text-xs text-amber-700">{capacityWarning}</p>
            )}
            {outsideHoursWarning && (
              <p className="form-error-text text-xs">
                This booking extends beyond normal shop hours and will require confirmation.
              </p>
            )}
          </div>
        </CollapsibleSection>

      </div>

      {/* Footer */}
      <div className="px-5 py-4 border-t border-border shrink-0">
        <button
          onClick={() => {
            void handleSubmit();
          }}
          disabled={!firstName.trim() || !isValidUsPhone(phone) || isSaving}
          className="w-full py-3 bg-primary text-primary-foreground text-sm font-semibold rounded-lg hover:opacity-90 active:scale-[0.98] transition-all flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {isSaving ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>{isBackfill ? "Logging…" : "Creating…"}</span>
            </>
          ) : (
            <>
              <span>{isBackfill ? "Log Completed Job" : "Create Booking"}</span>
              <ArrowRight className="w-4 h-4" />
            </>
          )}
        </button>
      </div>

      <ConfirmationDialog
        open={vinConfirmOpen && !!vinSuggestion}
        title="Is this the right vehicle?"
        description={
          vinSuggestion
            ? `${[vinSuggestion.year, vinSuggestion.make, vinSuggestion.model, vinSuggestion.trim]
                .filter(Boolean)
                .join(" ")} — VIN ${vinSuggestion.vin}.`
            : ""
        }
        onClose={() => setVinConfirmOpen(false)}
        secondaryAction={{
          label: <ShortcutLabel text="No, I'll edit" shortcutKey="n" />,
          onAction: () => setVinConfirmOpen(false),
          shortcutKey: "n",
        }}
        primaryAction={{
          label: <ShortcutLabel text="Yes, use this" shortcutKey="y" />,
          onAction: applyVinSuggestion,
          shortcutKey: "y",
          variant: "primary",
        }}
      >
        <div className="mb-4 flex items-center justify-center rounded-xl bg-muted/40 border border-border overflow-hidden" style={{ minHeight: 140 }}>
          {vinImageLoading ? (
            <Loader2 className="w-6 h-6 text-muted-foreground animate-spin" />
          ) : vinImageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={vinImageUrl}
              alt={
                vinSuggestion
                  ? `${vinSuggestion.year ?? ""} ${vinSuggestion.make ?? ""} ${vinSuggestion.model ?? ""}`.trim()
                  : "Vehicle"
              }
              className="max-h-48 w-full object-contain"
            />
          ) : (
            <p className="text-xs text-muted-foreground py-8">No image available for this VIN.</p>
          )}
        </div>
        {vinSource && (
          <p className="mb-3 text-center text-[11px] text-muted-foreground">
            {vinSource === "convex" ? "✓ Found in Otopair records" : "Decoded via NHTSA"}
          </p>
        )}
        {pendingOwners.length > 0 && (
          <div className="rounded-xl border border-border bg-muted/30 p-3">
            <p className="mb-2 text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
              {pendingOwners.length === 1 ? "Customer linked to this vehicle" : "Select customer"}
            </p>
            <div className="space-y-1.5">
              {pendingOwners.map((o) => (
                <button
                  key={o.userId}
                  type="button"
                  onClick={() => {
                    applyVehicleOnly();
                    applyOwner(o);
                  }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg border border-border bg-background hover:bg-muted/50 text-left transition-colors"
                >
                  <User className="w-4 h-4 text-muted-foreground shrink-0" />
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-foreground truncate">
                      {[o.firstName, o.lastName].filter(Boolean).join(" ") || "Unknown"}
                    </div>
                    <div className="text-xs text-muted-foreground truncate">{o.phone ?? o.email ?? ""}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}
      </ConfirmationDialog>

      {/* Owner picker — shown after vehicle confirm when multiple owners exist */}
      <ConfirmationDialog
        open={ownerPickerOpen}
        title="Who's the customer?"
        description="This vehicle has multiple registered owners. Select the customer for this booking."
        onClose={() => setOwnerPickerOpen(false)}
        secondaryAction={{
          label: <ShortcutLabel text="Skip" shortcutKey="s" />,
          onAction: () => setOwnerPickerOpen(false),
          shortcutKey: "s",
        }}
        primaryAction={{
          label: <ShortcutLabel text="Enter manually" shortcutKey="m" />,
          onAction: () => setOwnerPickerOpen(false),
          shortcutKey: "m",
          variant: "primary",
        }}
      >
        <div className="space-y-1.5 mb-2">
          {pendingOwners.map((o) => (
            <button
              key={o.userId}
              type="button"
              onClick={() => applyOwner(o)}
              className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl border border-border bg-background hover:bg-primary/5 hover:border-primary/40 text-left transition-colors"
            >
              <User className="w-4 h-4 text-muted-foreground shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-foreground truncate">
                  {[o.firstName, o.lastName].filter(Boolean).join(" ") || "Unknown"}
                </div>
                <div className="text-xs text-muted-foreground truncate">{o.phone ?? o.email ?? ""}</div>
              </div>
              <ArrowRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            </button>
          ))}
        </div>
      </ConfirmationDialog>

      <ConfirmationDialog
        open={backfillDuplicateConfirmOpen}
        title="Existing booking found at this time"
        description="A booking for this vehicle already sits within 30 minutes of the time you picked. Log this backfill anyway, or edit the existing record?"
        onClose={() => setBackfillDuplicateConfirmOpen(false)}
        secondaryAction={{
          label: <ShortcutLabel text="Cancel" shortcutKey="c" />,
          onAction: () => setBackfillDuplicateConfirmOpen(false),
          shortcutKey: "c",
        }}
        primaryAction={{
          label: <ShortcutLabel text="Log anyway" shortcutKey="l" />,
          onAction: () => {
            setBackfillDuplicateConfirmOpen(false);
            setBackfillDuplicateAcknowledged(true);
            void submitBackfill(true);
          },
          shortcutKey: "l",
          variant: "primary",
          disabled: isSaving,
        }}
      />

      <ConfirmationDialog
        open={outsideHoursConfirmOpen}
        title="Book Outside Shop Hours?"
        description="This booking would end after the shop closes. Would you like to create it anyway?"
        onClose={() => setOutsideHoursConfirmOpen(false)}
        secondaryAction={{
          label: <ShortcutLabel text="Cancel" shortcutKey="c" />,
          onAction: () => setOutsideHoursConfirmOpen(false),
          shortcutKey: "c",
        }}
        primaryAction={{
          label: <ShortcutLabel text="Create booking anyway" shortcutKey="b" />,
          onAction: () => {
            setOutsideHoursConfirmOpen(false);
            void submitBooking(true);
          },
          shortcutKey: "b",
          variant: "primary",
          disabled: isSaving,
        }}
      />

      <ServiceOptionsPicker
        open={showOptionsPicker}
        serviceIds={optionServices.map((s: any) => s._id as Id<"services">)}
        initialSelections={selectedServiceOptions}
        onCancel={() => setShowOptionsPicker(false)}
        onConfirm={(picks) => {
          setSelectedServiceOptions(picks);
          setShowOptionsPicker(false);
        }}
      />

      <TireSpecPicker
        open={showTirePicker}
        initial={tireSpecs}
        vehicleMake={make.trim() || null}
        passportTireSizes={[
          convexVehicleInfo?.tire_size_front ?? null,
          convexVehicleInfo?.tire_size_rear ?? null,
        ]}
        vehicleLabel={
          [year, make, model, trim].filter(Boolean).join(" ").trim() || null
        }
        onCancel={() => setShowTirePicker(false)}
        onConfirm={(specs) => {
          setTireSpecs(specs);
          setShowTirePicker(false);
          if (isBackfill) {
            void submitBackfill(backfillDuplicateAcknowledged);
          } else if (outsideHoursWarning) {
            setOutsideHoursConfirmOpen(true);
          } else {
            void submitBooking(false, undefined, specs);
          }
        }}
      />
    </div>
  );
}
