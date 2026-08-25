"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { formatHoursValue, hoursToMinutes, parseHoursInput } from "@/lib/labor-units";
import { useMutation, useQuery } from "convex/react";
import { formatPhoneInput, isValidUsPhone, normalizePhoneToE164 } from "@/lib/phone";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useEntityLabel } from "@/lib/use-entity-label";
import { ArrowRight, Car, Check, ChevronDown, Clock, ExternalLink, Loader2, MessageSquare, Package, Plus, Search, Stethoscope, User, Wrench, X } from "lucide-react";
import {
  Select,
  SelectItem,
  SelectListBox,
  SelectPopover,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Combobox } from "@/components/ui/combobox";
import {
  drawerInputClassName,
  drawerCardClassName,
  DrawerCardSectionHeader,
  DrawerFieldLabel,
} from "@/components/drawer-panel-styles";
import { cn } from "@/lib/utils";
import ConfirmationDialog, { ShortcutLabel } from "@/components/confirmation-dialog";
import ServiceOptionsPicker, { type SelectedServiceOption } from "@/components/booking/service-options-picker";
import TireSpecPicker, { type TireSpecs } from "@/components/booking/tire-spec-picker";
import TirePartsEditor, {
  type TireLine,
  tireLinesToPartPayloads,
} from "@/components/booking/tire-parts-editor";
import DatePicker from "@/components/ui/date-picker";
import { getBookingEndTime } from "@/lib/schedule-overlap";
import VehicleYMMTPicker from "./vehicle-ymmt-picker";
import { formatFixedCentCurrency } from "@/lib/fixed-cent-currency";
import FixedCentCurrencyInput from "@/components/ui/fixed-cent-currency-input";
import ServiceSuggestions from "@/components/booking/service-suggestions";
import {
  CustomJobTaxonomyPicker,
  isCustomJobTaxonomyComplete,
} from "@/components/custom-job-taxonomy-picker";
import KnownNameSuggestions from "@/components/booking/known-name-suggestions";
import { sanitizeVinInput } from "@/lib/vin";
import {
  resolveCombinedLabor,
  type CombinedLaborServiceInput,
} from "@/convex/lib/combinedLabor";
import { parseAxlePosition } from "@/convex/lib/brakeScope";

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
  /** Per-checkout session id owned by the schedule page (so the grid can
   *  exclude this drawer's own hold from its "On hold" overlay). */
  holdSessionId: string;
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

// How many "Done here before" shortcut pills to show at a glance before the rest
// fold behind the search box. Keeps the closed picker tidy for shops with a long
// off-catalog history without hiding the search itself.
const SHORTCUT_PILL_CAP = 8;

function toMins(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function getShopHoursForDate(shopHours: ShopHour[], date: string) {
  const dayOfWeek = new Date(`${date}T00:00:00`).getDay();
  return shopHours.find((hour) => hour.dayOfWeek === dayOfWeek) ?? null;
}

function getUserFacingErrorMessage(err: unknown): string {
  const fallback = "Failed to create booking";
  if (!(err instanceof Error)) return fallback;

  // Prefer a structured ConvexError payload when present (no stack noise).
  const data = (err as { data?: unknown }).data;
  let message =
    typeof data === "string" && data.trim()
      ? data.trim()
      : data && typeof (data as { message?: unknown }).message === "string"
        ? String((data as { message: string }).message).trim()
        : err.message.trim();

  // Strip the Convex wrapper prefix: "[CONVEX M(...)] [Request ID: ...]
  // Server Error Uncaught Error: <real message> ...".
  const afterUncaught = message.match(/Uncaught Error:\s*([\s\S]+)$/);
  if (afterUncaught?.[1]) message = afterUncaught[1].trim();

  // Cut everything from the first stack frame (" at fn (path:line:col)") and
  // drop the "Called by client" trailer — leaving just the human sentence.
  message = message
    // Cut the first stack frame (" at fn (path)") and everything after it —
    // [\s\S]* spans newlines without needing the es2018 dotAll flag.
    .replace(/\s+at\s+(?:async\s+)?[\w.$<>[\]]+\s*\([\s\S]*/, "")
    .replace(/\s*\.?\s*Called by client\.?\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();

  return message || fallback;
}

function CollapsibleSection({
  sectionKey,
  icon: Icon,
  label,
  open,
  onToggle,
  required,
  meta,
  children,
}: {
  sectionKey: string;
  icon: React.ElementType<{ className?: string }>;
  label: string;
  open: boolean;
  onToggle: (key: string) => void;
  required?: boolean;
  meta?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className={cn(drawerCardClassName, "overflow-hidden")}>
      <button
        type="button"
        onClick={() => onToggle(sectionKey)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left"
      >
        <DrawerCardSectionHeader
          icon={Icon}
          label={label}
          required={required}
          meta={meta}
          className="flex-1"
        />
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open ? <div className="px-4 pb-3.5">{children}</div> : null}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Component                                                           */
/* ------------------------------------------------------------------ */

/** Bucket key for parts attached to an off-catalog line. Not an id — custom
 *  lines have none — so it's the line's name behind a prefix no Convex id can
 *  collide with. The submit mapper splits it back out into
 *  `custom_service_name` on the wire. */
/** Universal, make-agnostic OEM-number tidy: trim, uppercase, collapse
 *  internal whitespace runs to a single space. Deliberately does NOT touch
 *  hyphens or other punctuation — it never inserts or strips a separator, so
 *  it's safe for every make's format (Toyota `90981-15021`, VAG `5Q0 698 451
 *  A`, Honda `12345-XXX-000`). Just makes the stored value match what the
 *  uppercased field already shows. (The hyphen-stripped MATCH key is a
 *  separate concern handled server-side.) */
function tidyOem(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, " ");
}

/** Favicon URL for a pasted source link, via Google's public s2 service.
 *  Returns null until the input parses as a host (so we render nothing rather
 *  than a broken/globe icon while the mechanic is still typing). Bare domains
 *  are accepted by prepending https://. */
function faviconUrl(rawUrl: string | undefined): string | null {
  const value = (rawUrl ?? "").trim();
  if (!value) return null;
  try {
    const withProto = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    const host = new URL(withProto).hostname;
    if (!host || !host.includes(".")) return null;
    return `https://www.google.com/s2/favicons?sz=32&domain=${encodeURIComponent(host)}`;
  } catch {
    return null;
  }
}

const CUSTOM_BUCKET_PREFIX = "custom::";

export default function CreateBookingDrawer({
  date,
  time,
  mechanicId,
  onDraftChange,
  mechanics,
  bookings,
  shopHours,
  holdSessionId,
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
  // What the field last auto-fixed on the most recent keystroke, so the change
  // is surfaced rather than silent. Cleared once a keystroke needs no fixing.
  const [vinCorrection, setVinCorrection] = useState<{
    correctedOI: boolean;
    droppedInvalid: boolean;
  } | null>(null);
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
  /* Off-catalog lines. `complaint` and the taxonomy don't affect the booking —
     they populate the custom_jobs row (Off-Catalog Work spec, §7). The complaint
     is the one field nothing else in the system captures, and the taxonomy is
     what lets a cluster of names aggregate into "engine · service" rather than
     staying three unrelated strings. */
  const [customServices, setCustomServices] = useState<
    Array<{
      name: string;
      durationMinutes?: number;
      complaint?: string;
      systemTags: string[];
      workType: string;
      shopCustomServiceId?: string;
    }>
  >([]);
  const [showCustomForm, setShowCustomForm] = useState(false);
  const [customDraftName, setCustomDraftName] = useState("");
  const [customDraftMinutes, setCustomDraftMinutes] = useState("");
  const [customDraftComplaint, setCustomDraftComplaint] = useState("");
  const [customDraftSystemTags, setCustomDraftSystemTags] = useState<string[]>(
    [],
  );
  const [customDraftWorkType, setCustomDraftWorkType] = useState<string | null>(
    null,
  );
  /* Set when the form was opened by pressing an existing shortcut. Carrying it
     through is what makes a repeat exactly countable rather than fuzzy-matched
     back together later (Off-Catalog Work spec, §3). */
  const [customDraftShortcutId, setCustomDraftShortcutId] = useState("");
  const [customDraftSaveShortcut, setCustomDraftSaveShortcut] = useState(false);
  // Filters the "Done here before" shortcut pills so a long off-catalog history
  // stays findable by name instead of forcing the mechanic to eyeball the list.
  const [shortcutSearch, setShortcutSearch] = useState("");

  /* ---- Customer states / notes ---- */
  const [customerNotes, setCustomerNotes] = useState("");

  /* ---- Collapsible sections ---- */
  const SECTION_KEYS = [
    "customer",
    "vehicle",
    "services",
    "mechanic_estimate",
    "catalog_parts",
    "diagnostic",
    "notes",
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
  // Mechanics enter labor in decimal HOURS; mechanicEstimateMinutes stays in
  // minutes (scheduling/booking rows need minutes) and this raw hours text
  // buffer backs the input so mid-typing values like "0." aren't reformatted away.
  const [estimateHoursText, setEstimateHoursText] = useState("");
  const estimateHoursFocused = useRef(false);
  const [mechanicQuotedPrice, setMechanicQuotedPrice] = useState<number | null>(null);
  // Once the mechanic types in the quoted price we stop auto-prefilling it from
  // the tier rate, so we never clobber a hand-entered quote.
  const [quotedPriceTouched, setQuotedPriceTouched] = useState(false);
  // Same guard for the time estimate: once the mechanic picks a duration we stop
  // auto-prefilling it from the selected services, so a manual override sticks.
  const [estimateMinutesTouched, setEstimateMinutesTouched] = useState(false);

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
  // Priced tire lines (size/brand/model/per-tire price) for a walk-in tire
  // replacement — there's no quote, so the mechanic enters them directly. These
  // become is_tire priced_parts_snapshot rows (see TirePartsEditor).
  const [tirePartLines, setTirePartLines] = useState<TireLine[]>([]);
  const [showOptionsPicker, setShowOptionsPicker] = useState(false);
  const [showTirePicker, setShowTirePicker] = useState(false);
  const [pendingSubmitOutsideHours, setPendingSubmitOutsideHours] = useState<boolean | null>(null);

  /* ---- Parts declaration + editor (walk-in confirmed flow) ----
     The mechanic declares whether this job has parts. "Add parts" reveals the
     editor, prefilled from quotes.previewCatalogPartsByVin (OEM catalog) and
     freely editable / extendable. Declared parts become the booking's
     priced_parts_snapshot + parts_cost — feeding the job scope, pre-job and
     post-job — and are ALSO recorded in parts_quote_snapshots for catalog
     accuracy analytics. */
  type MechanicPartEdit = {
    key: string; // role_key || oem_number || part_name (within a service)
    service_id: string;
    part_name: string;
    oem_number: string;
    brand: string;
    /** Optional provenance link the mechanic pasted for this part/price. */
    source_url?: string;
    /** UI-only: mechanic clicked "Save part" → row collapses to a summary.
     *  Persistence still happens with the booking submit; this is a clarity
     *  affordance, not a separate write. */
    saved?: boolean;
    quantity: string;
    unit_price: string; // dollars (string input)
    catalog_origin: boolean;
    price_unknown: boolean;
    // Catalog identity, threaded through to the snapshot so pre/post-job
    // seeding + part-preference accrual work. Present only on kept catalog rows.
    part_id?: string;
    role_key?: string;
    quantity_basis?: string;
  };
  const [catalogPartEdits, setCatalogPartEdits] = useState<
    Record<string, MechanicPartEdit[]>
  >({});
  // How the mechanic chose to handle parts on this walk-in. null = undecided
  // (soft-gated at submit). "add" reveals the editor and bills the parts;
  // "none" = labor-only; "skip" = defer to pre-job.
  const [partsDeclaration, setPartsDeclaration] = useState<
    "none" | "add" | "skip" | null
  >(null);
  const dirtyPartKeysRef = useRef<Set<string>>(new Set());
  const addedPartSeqRef = useRef(0);

  const shopData = useQuery(api.schedule.getShopServicesWithCategories);
  // OEM brand picker options — the full (deduped) makes catalog. Brand on a
  // walk-in part defaults to the vehicle's make (OEM), but stays free-form so
  // supplier brands (Denso, Bosch…) or custom values can still be typed.
  const makesList = useQuery(api.makes.list);
  // The shop's remembered custom brands (Bosch, Denso, a one-off supplier…),
  // added by an explicit "Add … as custom" tap on a prior booking. Surfaced
  // first in the picker so a shop reaches for what it used last.
  const customBrandList = useQuery(
    (api as any).shopCustomPartBrands.listForShop,
    shopData?.shopId ? { shopId: shopData.shopId } : "skip",
  ) as { _id: string; name: string }[] | undefined;
  const addCustomBrand = useMutation((api as any).shopCustomPartBrands.add);
  const makeOptions = useMemo(() => {
    const seen = new Set<string>();
    const opts: { value: string; label: string }[] = [];
    for (const b of customBrandList ?? []) {
      const key = b.name.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      opts.push({ value: b.name, label: b.name });
    }
    for (const m of makesList ?? []) {
      const key = m.name.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      opts.push({ value: m.name, label: m.name });
    }
    return opts;
  }, [customBrandList, makesList]);
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

  // Per-vehicle labor times — the SAME ladder the customer app books through
  // (empirical → book/VDB → sibling chassis → Camry×tier "Yassin fallback" →
  // catalog default), resolved by VIN for every catalog service so the list
  // badges + running estimate reflect THIS vehicle instead of a flat default.
  const allCatalogServiceIds = useMemo(
    () =>
      categories.flatMap((c: any) =>
        (c.services as any[]).map((s) => s._id as Id<"services">),
      ),
    [categories],
  );
  const vehicleLaborTimes = useQuery(
    api.laborTimes.getLaborHoursForServicesByVin,
    validVin && allCatalogServiceIds.length > 0
      ? { vin: validVin, serviceIds: allCatalogServiceIds }
      : "skip",
  );
  // serviceId → per-service labor for O(1) badge lookup + combine input.
  // `isEstimate` true for the tier fallback / catalog default (app renders an
  // "est." pill); `unroundedHours`/`slug`/`source` feed the combined-labor pass.
  const vehicleLaborByServiceId = useMemo(() => {
    const m = new Map<
      string,
      { minutes: number; isEstimate: boolean; unroundedHours: number; slug: string; source: string }
    >();
    for (const r of vehicleLaborTimes ?? []) {
      m.set(String(r.serviceId), {
        minutes: Math.round(r.hours * 60),
        isEstimate: r.source === "default",
        unroundedHours: r.unroundedHours ?? r.hours,
        slug: r.serviceSlug,
        source: r.source,
      });
    }
    return m;
  }, [vehicleLaborTimes]);
  const hasVehicleLabor = vehicleLaborByServiceId.size > 0;

  // Combined labor operations (honest overlap deduction), gated by the director
  // flag. Runs the SAME pure resolver the quote engine uses so the drawer's
  // estimate matches what the customer would be quoted.
  const directorSettings = useQuery(api.directorSettings.getGlobal, {});
  const combinedLaborEnabled = directorSettings?.combined_labor_enabled === true;
  const roundLaborTo15 = directorSettings?.round_labor_times_to_15min ?? true;
  // Axle position per selected service (brakes), from the option picker.
  const positionByServiceId = useMemo(() => {
    const m = new Map<string, "front" | "rear" | "both">();
    for (const o of selectedServiceOptions) {
      const pos = parseAxlePosition(o.option_label);
      if (pos) m.set(String(o.service_id), pos);
    }
    return m;
  }, [selectedServiceOptions]);
  // { combinedMinutes, savedMinutes, notes } for the SELECTED services. Falls
  // back to a naive sum when the flag is off or nothing shares teardown.
  const combinedLabor = useMemo(() => {
    const inputs = Array.from(selectedIds)
      .map((sid) => {
        const l = vehicleLaborByServiceId.get(String(sid));
        if (!l) return null;
        return {
          serviceId: String(sid),
          slug: l.slug,
          standaloneHours: l.unroundedHours,
          position: positionByServiceId.get(String(sid)) ?? null,
          source: l.source,
        };
      })
      .filter(Boolean) as CombinedLaborServiceInput[];
    const res = resolveCombinedLabor(inputs, {
      enabled: combinedLaborEnabled && inputs.length >= 2,
    });
    // Round the combined total (and the naive baseline) to 15 min ONCE, then
    // derive the saving as the difference so `saved + combined = naive` holds.
    const ceil15 = (h: number) =>
      roundLaborTo15 ? Math.ceil((h * 60) / 15) * 15 : Math.round(h * 60);
    const combinedMinutes = ceil15(res.combinedHours);
    const naiveMinutes = ceil15(res.combinedHours + res.savedHours);
    return {
      combinedMinutes,
      savedMinutes: Math.max(0, naiveMinutes - combinedMinutes),
      notes: res.notes,
      applied: res.savedHours > 0,
    };
  }, [selectedIds, vehicleLaborByServiceId, positionByServiceId, combinedLaborEnabled, roundLaborTo15]);

  // Reactive OEM-catalog prefill for the parts editor (seeds the "Add parts"
  // rows for the chosen services + options).
  const catalogPartsPreview = useQuery(
    api.quotes.previewCatalogPartsByVin,
    validVin && selectedIds.size > 0
      ? {
          vin: validVin,
          serviceIds: Array.from(selectedIds) as Id<"services">[],
          selectedServiceOptions:
            selectedServiceOptions.length > 0
              ? selectedServiceOptions.map((o) => ({
                  service_id: o.service_id,
                  option_label: o.option_label,
                  option_type: o.option_type,
                }))
              : undefined,
        }
      : "skip",
  );

  // Seed editable rows from the catalog preview without clobbering the
  // mechanic's edits (tracked in dirtyPartKeysRef) or any manually-added rows.
  // Rebuilds for the currently-selected services so deselected ones drop out.
  useEffect(() => {
    if (catalogPartsPreview === undefined) return;
    const previewBySvc = new Map<string, any>();
    if (catalogPartsPreview.hasConfig) {
      for (const svc of catalogPartsPreview.services) {
        previewBySvc.set(String(svc.service_id), svc);
      }
    }
    setCatalogPartEdits((prev) => {
      // Custom-line buckets survive verbatim. This rebuild is driven by the
      // CATALOG preview and keys off selectedIds, so anything off-catalog would
      // otherwise be dropped every time the preview re-resolved — silently
      // deleting parts the mechanic had already typed.
      const next: Record<string, MechanicPartEdit[]> = {};
      for (const [bucket, rows] of Object.entries(prev)) {
        if (bucket.startsWith(CUSTOM_BUCKET_PREFIX)) next[bucket] = rows;
      }
      for (const sid of Array.from(selectedIds).map(String)) {
        const existing = prev[sid] ?? [];
        const svc = previewBySvc.get(sid);
        const catalogRows: MechanicPartEdit[] = (svc?.rows ?? []).map(
          (r: any) => {
            const key = r.role_key || r.oem_number || r.part_name;
            const composite = `${sid}::${key}`;
            if (dirtyPartKeysRef.current.has(composite)) {
              const edited = existing.find((e) => e.key === key);
              if (edited) return edited;
            }
            return {
              key,
              service_id: sid,
              part_name: r.part_name,
              oem_number: r.oem_number,
              // OEM parts are branded by the make — if the catalog row has no
              // brand, fall back to the vehicle make so Brand is never blank.
              brand: (r.brand ?? "").trim() || make.trim() || "",
              quantity: String(r.quantity),
              unit_price: r.price_unknown
                ? "0.00"
                : formatFixedCentCurrency(r.unit_price_cents / 100),
              catalog_origin: true,
              price_unknown: r.price_unknown === true,
              part_id: r.part_id ?? undefined,
              role_key: r.role_key ?? undefined,
              quantity_basis: r.quantity_basis ?? undefined,
            };
          },
        );
        const added = existing.filter((e) => !e.catalog_origin);
        next[sid] = [...catalogRows, ...added];
      }
      return next;
    });
  }, [catalogPartsPreview, selectedIds]);

  // Reset the parts declaration when the booking has no work on it at all.
  // Custom lines count: a booking whose only line is off-catalog still has
  // parts to declare, and clearing the answer under the mechanic would re-arm
  // the submit gate they already satisfied.
  useEffect(() => {
    if (selectedIds.size === 0 && customServices.length === 0) {
      setPartsDeclaration(null);
    }
  }, [selectedIds, customServices.length]);

  const setCatalogPartField = (
    sid: string,
    idx: number,
    field:
      | "part_name"
      | "oem_number"
      | "brand"
      | "source_url"
      | "quantity"
      | "unit_price",
    value: string,
  ) =>
    setCatalogPartEdits((prev) => {
      const rows = prev[sid] ?? [];
      const row = rows[idx];
      if (row) dirtyPartKeysRef.current.add(`${sid}::${row.key}`);
      return {
        ...prev,
        [sid]: rows.map((r, i) => (i === idx ? { ...r, [field]: value } : r)),
      };
    });

  const addCatalogPartRow = (sid: string) =>
    setCatalogPartEdits((prev) => {
      const rows = prev[sid] ?? [];
      const key = `manual-${addedPartSeqRef.current++}`;
      dirtyPartKeysRef.current.add(`${sid}::${key}`);
      return {
        ...prev,
        [sid]: [
          ...rows,
          {
            key,
            service_id: sid,
            part_name: "",
            oem_number: "",
            // OEM parts are branded by the vehicle make — default to it, but
            // the field stays a free-form/searchable picker for supplier brands.
            brand: make.trim() || "",
            source_url: "",
            quantity: "1",
            unit_price: "0.00",
            catalog_origin: false,
            price_unknown: false,
          },
        ],
      };
    });

  const removeCatalogPartRow = (sid: string, idx: number) =>
    setCatalogPartEdits((prev) => {
      const rows = prev[sid] ?? [];
      const row = rows[idx];
      if (row) dirtyPartKeysRef.current.delete(`${sid}::${row.key}`);
      return { ...prev, [sid]: rows.filter((_, i) => i !== idx) };
    });

  // "Save part" — tidy the OEM one last time and collapse the row to a
  // summary so the mechanic gets clear feedback the part is on the job. The
  // actual write still happens with the booking submit.
  const saveCatalogPartRow = (sid: string, idx: number) =>
    setCatalogPartEdits((prev) => {
      const rows = prev[sid] ?? [];
      const row = rows[idx];
      if (!row) return prev;
      dirtyPartKeysRef.current.add(`${sid}::${row.key}`);
      return {
        ...prev,
        [sid]: rows.map((r, i) =>
          i === idx
            ? { ...r, oem_number: tidyOem(r.oem_number), saved: true }
            : r,
        ),
      };
    });

  const editCatalogPartRow = (sid: string, idx: number) =>
    setCatalogPartEdits((prev) => {
      const rows = prev[sid] ?? [];
      return {
        ...prev,
        [sid]: rows.map((r, i) => (i === idx ? { ...r, saved: false } : r)),
      };
    });

  /* Every line on this booking that can carry parts — catalog services first,
     then the off-catalog ones.

     Custom lines were previously absent, so a mechanic who added "Power window
     switch replacement" and fitted an $78 switch had nowhere to record it: the
     parts editor only ever bucketed by service_id, and a custom line has none.
     The part then existed only as prose in the post-job resolution text, which
     no total, receipt or catalog-gap read can see.

     They're keyed CUSTOM_BUCKET_PREFIX + name rather than an id, and the submit
     mapper turns that back into `custom_service_name` on the wire. */
  const catalogPartServices = useMemo(() => {
    const all = categories.flatMap((c: any) => c.services as any[]);
    const catalog = Array.from(selectedIds)
      .map((sid) => {
        const svc = all.find((s: any) => s._id === sid);
        return svc
          ? { service_id: String(sid), name: svc.name as string, custom: false }
          : null;
      })
      .filter(Boolean) as Array<{
      service_id: string;
      name: string;
      custom: boolean;
    }>;
    const custom = customServices.map((c) => ({
      service_id: `${CUSTOM_BUCKET_PREFIX}${c.name}`,
      name: c.name,
      custom: true,
    }));
    return [...catalog, ...custom];
  }, [categories, selectedIds, customServices]);

  // Sum of declared part line totals (dollars) for selected services — drives
  // the "parts exceed quote" warning. Only meaningful when declaration === "add".
  const declaredPartsTotal = useMemo(() => {
    let sum = 0;
    const buckets = [
      ...Array.from(selectedIds).map(String),
      ...customServices.map((c) => `${CUSTOM_BUCKET_PREFIX}${c.name}`),
    ];
    for (const sid of buckets) {
      for (const r of catalogPartEdits[sid] ?? []) {
        const qty = Number(r.quantity);
        const price = Number(r.unit_price);
        if (
          Number.isFinite(qty) &&
          Number.isFinite(price) &&
          qty > 0 &&
          price > 0
        ) {
          sum += qty * price;
        }
      }
    }
    // Priced tire lines contribute to the parts total too.
    for (const l of tirePartLines) {
      const qty = Math.max(1, l.quantity || 1);
      const price = Number(l.perTirePrice);
      if (Number.isFinite(price) && price > 0) sum += qty * price;
    }
    return sum;
  }, [catalogPartEdits, selectedIds, customServices, tirePartLines]);

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

  // Walk-in tire pricing: seed the per-axle tire editor from the tire specs the
  // mechanic picked (size + how many corners on each axle), preserving any
  // brand / model / price already entered. Cleared when the tire service is
  // deselected.
  useEffect(() => {
    if (!tireService || !tireSpecs) {
      setTirePartLines((cur) => (cur.length ? [] : cur));
      return;
    }
    const positions = tireSpecs.positions ?? [];
    const frontQty = positions.filter((p) => p === "FL" || p === "FR").length;
    const rearQty = positions.filter((p) => p === "RL" || p === "RR").length;
    setTirePartLines((cur) => {
      const byPos = new Map(cur.map((l) => [l.position, l] as const));
      const next: TireLine[] = [];
      const axles: Array<["front" | "rear", number]> = [
        ["front", frontQty],
        ["rear", rearQty],
      ];
      // No corner-level positions (older specs) → default a single front line
      // carrying the full quantity so the mechanic can still price the tires.
      if (frontQty === 0 && rearQty === 0) {
        axles[0][1] = tireSpecs.quantity ?? 4;
      }
      for (const [position, qty] of axles) {
        if (qty <= 0) continue;
        const prev = byPos.get(position);
        next.push({
          position,
          size: tireSpecs.size,
          brand: prev?.brand ?? "",
          model: prev?.model ?? "",
          perTirePrice: prev?.perTirePrice ?? "",
          quantity: qty,
        });
      }
      return next;
    });
  }, [tireService, tireSpecs]);

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
    const naive =
      selected.reduce((sum: number, s: any) => {
        // Vehicle-specific labor (the customer-app ladder) wins once the VIN
        // resolves; otherwise the flat catalog default. Keeps the running
        // estimate — end time, slot hold, suggested price — car-aware too.
        const vehicleMins = vehicleLaborByServiceId.get(String(s._id))?.minutes;
        return sum + (vehicleMins ?? (s.defaultLaborHours ?? 0) * 60);
      }, 0) + customMins;
    // Honest overlap: shave the shared teardown once (custom + non-vehicle
    // lines still count fully — the saving only covers the combineable set).
    return Math.max(0, naive - (combinedLaborEnabled ? combinedLabor.savedMinutes : 0));
  }, [categories, selectedIds, customServices, vehicleLaborByServiceId, combinedLaborEnabled, combinedLabor]);

  // Mechanic override wins when present; otherwise fall back to catalog sum.
  const effectiveEstimateMinutes = useMemo(
    () => mechanicEstimateMinutes ?? catalogEstimateMinutes,
    [mechanicEstimateMinutes, catalogEstimateMinutes],
  );

  /* ---- Slot hold (StubHub-style) ------------------------------------ */
  // Reserve the chosen mechanic+window for THIS checkout so a customer (mobile)
  // or another staffer can't grab the same slot while this drawer is open — the
  // window the old flow left wide open. The hold is idempotent per session,
  // refreshes as the draft changes, is consumed by createByShop on submit, and
  // released on close (the 1-min cron reaps it if the tab is killed).
  const holdSlot = useMutation(api.slotHolds.holdSlot);
  const releaseSlotHold = useMutation(api.slotHolds.releaseSlotHold);
  // Session id is owned by the parent (schedule page) so its grid can exclude
  // this drawer's own hold from the "On hold" overlay.
  const [hold, setHold] = useState<{
    holdId: Id<"slot_holds">;
    expiresAt: number;
  } | null>(null);
  const [holdNowMs, setHoldNowMs] = useState(() => Date.now());
  const holdRef = useRef(hold);
  holdRef.current = hold;
  const holdDurationMinutes =
    effectiveEstimateMinutes > 0 ? effectiveEstimateMinutes : 60;

  useEffect(() => {
    const shopId = shopData?.shopId;
    if (!shopId || !date || !time) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await holdSlot({
          shop_id: shopId as Id<"shops">,
          mechanic_id: mechanicId ? (mechanicId as Id<"mechanics">) : undefined,
          date,
          start_time: time,
          duration_minutes: holdDurationMinutes,
          session_id: holdSessionId,
        });
        if (cancelled) return;
        setHold(
          res?.holdId && res.expiresAt != null
            ? { holdId: res.holdId, expiresAt: res.expiresAt }
            : null,
        );
      } catch {
        // Taken by another session / unavailable — clear the badge. The submit
        // path re-asserts availability server-side and surfaces the real error.
        if (!cancelled) setHold(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    shopData?.shopId,
    date,
    time,
    mechanicId,
    holdDurationMinutes,
    holdSlot,
    holdSessionId,
  ]);

  // 1s countdown tick while a hold is active.
  useEffect(() => {
    if (!hold) return;
    const id = setInterval(() => setHoldNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hold]);

  // Release the hold when the drawer unmounts (close / cancel). After a
  // successful submit the server already deleted it, so this is a safe no-op.
  useEffect(() => {
    return () => {
      const h = holdRef.current;
      if (h) {
        releaseSlotHold({ holdId: h.holdId, session_id: holdSessionId }).catch(
          () => {},
        );
      }
    };
  }, [releaseSlotHold, holdSessionId]);

  const holdRemainingMs = hold ? Math.max(0, hold.expiresAt - holdNowMs) : 0;
  const holdExpired = hold != null && holdRemainingMs <= 0;
  const holdCountdownLabel = hold
    ? `${Math.floor(holdRemainingMs / 60000)}:${String(
        Math.floor((holdRemainingMs % 60000) / 1000),
      ).padStart(2, "0")}`
    : null;

  /* ---- Suggested quoted price (tier labor rate × time + parts) ---- */
  // Tier-aware $/hr labor rate for this vehicle at this shop. Falls back to the
  // shop's flat rate server-side when the vehicle has no resolvable tier.
  const suggestedRate = useQuery(
    api.bookings.getWalkInSuggestedLaborRate,
    shopData?.shopId
      ? {
          shopId: shopData.shopId as Id<"shops">,
          vin: validVin || undefined,
        }
      : "skip",
  );
  // labor = rate × hours; total = labor + declared parts. Rounded to a whole
  // dollar so the prefill reads like a clean quote. null when we can't price it.
  const suggestedQuotedPrice = useMemo(() => {
    const rate = suggestedRate?.ratePerHour;
    if (rate == null) return null;
    const mins = effectiveEstimateMinutes || 0;
    if (mins <= 0) return null;
    const labor = (rate * mins) / 60;
    const total = labor + declaredPartsTotal;
    return total > 0 ? Math.round(total) : null;
  }, [suggestedRate, effectiveEstimateMinutes, declaredPartsTotal]);

  // Prefill the quoted price from the suggestion and keep it in sync as the
  // service/time/parts change — until the mechanic edits the field themselves.
  // Backfill captures actuals, not estimates, so it's left untouched there.
  useEffect(() => {
    if (isBackfill) return;
    if (quotedPriceTouched) return;
    if (suggestedQuotedPrice == null) return;
    setMechanicQuotedPrice((prev) =>
      prev === suggestedQuotedPrice ? prev : suggestedQuotedPrice,
    );
  }, [isBackfill, quotedPriceTouched, suggestedQuotedPrice]);

  // Prefill the time estimate from the selected catalog + custom services and
  // keep it in sync as the selection changes — until the mechanic sets it
  // themselves. Selecting a job already tells us how long it should take, so the
  // mechanic shouldn't have to re-enter that duration by hand; it stays editable.
  // Backfill captures the actual time taken, so we don't seed a default there.
  useEffect(() => {
    if (isBackfill) return;
    if (estimateMinutesTouched) return;
    if (catalogEstimateMinutes <= 0) return;
    setMechanicEstimateMinutes((prev) =>
      prev === catalogEstimateMinutes ? prev : catalogEstimateMinutes,
    );
  }, [isBackfill, estimateMinutesTouched, catalogEstimateMinutes]);

  // Mirror the (possibly prefilled) minutes value into the hours input, except
  // while the mechanic is actively typing in it.
  useEffect(() => {
    if (estimateHoursFocused.current) return;
    setEstimateHoursText(
      mechanicEstimateMinutes != null ? formatHoursValue(mechanicEstimateMinutes) : "",
    );
  }, [mechanicEstimateMinutes]);

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

  const resetCustomDraft = () => {
    setShowCustomForm(false);
    setCustomDraftName("");
    setCustomDraftMinutes("");
    setCustomDraftComplaint("");
    setCustomDraftSystemTags([]);
    setCustomDraftWorkType(null);
    setCustomDraftShortcutId("");
    setCustomDraftSaveShortcut(false);
  };

  /* Pressing a shortcut opens the form prefilled rather than adding the line
     blind. The mechanic saves the retyping, and the complaint — the one field
     worth having and the one that's genuinely per-job — is what they land on. */
  const openShortcut = (shortcut: {
    _id: string;
    name: string;
    default_minutes: number | null;
    system_tags?: string[] | null;
    work_type?: string | null;
  }) => {
    setCustomDraftName(shortcut.name);
    setCustomDraftMinutes(
      shortcut.default_minutes ? String(shortcut.default_minutes) : "",
    );
    // The shortcut carries its taxonomy, so a press stays one tap — the
    // mechanic only re-answers if this instance was genuinely different work.
    setCustomDraftSystemTags(shortcut.system_tags ?? []);
    setCustomDraftWorkType(shortcut.work_type ?? null);
    setCustomDraftComplaint("");
    setCustomDraftShortcutId(shortcut._id);
    setCustomDraftSaveShortcut(false);
    setShowCustomForm(true);
  };

  /* The shop's own shortcuts for off-catalog work (Off-Catalog Work spec, §3).
     Not a catalog and never driver-facing — "things you've typed before". */
  const shopShortcuts = useQuery(
    api.shopCustomServices.listForShop,
    shopData?.shopId
      ? // Fetch the fuller list (still best-first) so the search box below can
        // reach past jobs beyond the handful of pills shown at a glance.
        { shopId: shopData.shopId as Id<"shops">, limit: 50 }
      : "skip",
  );
  const saveShortcut = useMutation(api.shopCustomServices.create);

  // Best-first pills capped for a tidy default view; the search box widens the
  // net across the whole fetched list once the mechanic starts typing.
  const shortcutMatches = useMemo(() => {
    const all = (shopShortcuts ?? []) as any[];
    const q = shortcutSearch.trim().toLowerCase();
    if (!q) {
      return {
        visible: all.slice(0, SHORTCUT_PILL_CAP),
        hidden: Math.max(0, all.length - SHORTCUT_PILL_CAP),
        searching: false,
      };
    }
    return {
      visible: all.filter((sc) => sc.name.toLowerCase().includes(q)),
      hidden: 0,
      searching: true,
    };
  }, [shopShortcuts, shortcutSearch]);

  /* The services this shop actually offers. The match gate scores against the
     whole catalog, but suggesting a service that isn't in `categories` would
     put an id in selectedIds that the duration/price maths can't resolve — so
     gate suggestions are filtered to this set. */
  const offeredServiceIds = useMemo(
    () =>
      new Set<string>(
        categories.flatMap((c: any) =>
          (c.services as any[]).map((s) => String(s._id)),
        ),
      ),
    [categories],
  );

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
      // Send the VIN exactly as typed (possibly empty). The server decides
      // what the car's canonical identity is — it reuses this customer's
      // existing placeholder when they return with the same vehicle, and mints
      // a new one only when it has to. We used to mint `SHOP${Date.now()}`
      // here, which is exactly 17 characters and so read as a real VIN to
      // every downstream length check, and which forked a new vehicle row on
      // every single visit. See convex/lib/vinIdentity.ts.
      const finalVin = vin.trim();

      // The mechanic's declared parts (catalog-prefilled + manually added).
      // When partsDeclaration === "add" the server bills these
      // (priced_parts_snapshot + parts_cost); they're also recorded for
      // catalog-accuracy analytics (parts_quote_snapshots).
      const toPartNum = (s: string) => {
        const n = Number(s);
        return s.trim() !== "" && Number.isFinite(n) ? n : undefined;
      };
      const customBucketNames = new Set(
        customServices.map((c) => `${CUSTOM_BUCKET_PREFIX}${c.name}`),
      );
      const mechanicPartEntries = Object.values(catalogPartEdits)
        .flat()
        .filter(
          (r) =>
            (selectedIds.has(r.service_id) ||
              customBucketNames.has(r.service_id)) &&
            (r.part_name.trim() !== "" || r.oem_number.trim() !== ""),
        )
        .map((r) => {
          const priceDollars = toPartNum(r.unit_price);
          const isCustom = r.service_id.startsWith(CUSTOM_BUCKET_PREFIX);
          return {
            // Exactly one of the two — the server rejects neither-nor and the
            // snapshot row keeps whichever identifies the line.
            service_id: isCustom
              ? undefined
              : (r.service_id as Id<"services">),
            custom_service_name: isCustom
              ? r.service_id.slice(CUSTOM_BUCKET_PREFIX.length)
              : undefined,
            key: r.key,
            part_name: r.part_name.trim(),
            oem_number: tidyOem(r.oem_number),
            brand: r.brand.trim() || undefined,
            source_url: r.source_url?.trim() || undefined,
            quantity: toPartNum(r.quantity),
            unit_price_cents:
              priceDollars != null ? Math.round(priceDollars * 100) : undefined,
            catalog_origin: r.catalog_origin,
            // Catalog identity (kept catalog rows only) so the bill snapshot
            // carries part_id/role_key for pre/post-job seeding + preferences.
            part_id:
              r.catalog_origin && !isCustom
                ? (r.part_id as Id<"oem_parts"> | undefined)
                : undefined,
            role_key: r.catalog_origin && !isCustom ? r.role_key : undefined,
            quantity_basis:
              r.catalog_origin && !isCustom ? r.quantity_basis : undefined,
            // Tire identity — unset on generic part rows; the inferred element
            // type must include these so the tire lines can be pushed below.
            is_tire: undefined as boolean | undefined,
            tire_size: undefined as string | undefined,
            tire_brand: undefined as string | undefined,
            tire_model: undefined as string | undefined,
            tire_position: undefined as string | undefined,
          };
        });

      // Priced tire lines (walk-in tire replacement) → mechanic part entries.
      // Tires carry no OEM number; oem_number is the `TIRE-{size}` sentinel and
      // identity lives in the is_tire/tire_* fields. Attributed to the tire
      // service so the snapshot rows land under it. Only when the mechanic chose
      // "Add parts" (the only declaration the server bills the snapshot for).
      if (
        tireService &&
        tirePartLines.length > 0 &&
        partsDeclaration === "add"
      ) {
        const tsid = String(tireService._id);
        for (const payload of tireLinesToPartPayloads(tirePartLines, tsid)) {
          mechanicPartEntries.push({
            service_id: tsid as Id<"services">,
            custom_service_name: undefined,
            key: `tire-${payload.tire_position ?? "axle"}-${payload.tire_size ?? ""}`,
            part_name: payload.part_name,
            oem_number: payload.oem_number,
            brand: payload.brand ?? undefined,
            source_url: undefined,
            quantity: payload.quantity,
            unit_price_cents:
              typeof payload.cost === "number" && payload.cost > 0
                ? Math.round(payload.cost * 100)
                : undefined,
            catalog_origin: false,
            part_id: undefined,
            role_key: undefined,
            quantity_basis: undefined,
            is_tire: true,
            tire_size: payload.tire_size ?? undefined,
            tire_brand: payload.tire_brand ?? undefined,
            tire_model: payload.tire_model ?? undefined,
            tire_position: payload.tire_position ?? undefined,
          });
        }
      }

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
        customServices:
          customServices.length > 0
            ? (customServices.map((c) => ({
                name: c.name,
                durationMinutes: c.durationMinutes,
                complaint: c.complaint,
                systemTags: c.systemTags,
                workType: c.workType,
                shopCustomServiceId: c.shopCustomServiceId as
                  | Id<"shop_custom_services">
                  | undefined,
              })) as never)
            : undefined,
        customerNotes: customerNotes.trim() || undefined,
        diagnosticSystem: isDiagnostic && diagnosticSystem ? diagnosticSystem : undefined,
        mechanicId: mechanicId ? (mechanicId as Id<"mechanics">) : undefined,
        assignmentPreference,
        // Walk-ins quote a single all-in price. The server derives the split:
        // parts_cost from the declared parts (when partsDeclaration === "add"),
        // labor_cost = quoted − parts. These legacy split inputs stay 0.
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
        // Honest overlap deduction (director flag). Persisted so the booking
        // detail / receipt can show the shared-labor saving.
        combinedLaborSavedMinutes:
          combinedLaborEnabled && combinedLabor.applied
            ? combinedLabor.savedMinutes
            : undefined,
        combinedLaborNotes:
          combinedLaborEnabled && combinedLabor.applied && combinedLabor.notes.length > 0
            ? combinedLabor.notes
            : undefined,
        mechanicQuotedPrice: mechanicQuotedPrice ?? undefined,
        catalogQuotedPrice: 0,
        mechanicPartEntries:
          mechanicPartEntries.length > 0 ? mechanicPartEntries : undefined,
        partsDeclaration: partsDeclaration ?? undefined,
        // Consume the checkout hold atomically with the insert (server verifies
        // + deletes it). sessionId lets the server ignore our own hold so it
        // can't block the booking it was reserving.
        sessionId: holdSessionId,
        holdId: hold?.holdId,
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
      // Send the VIN exactly as typed (possibly empty). The server decides
      // what the car's canonical identity is — it reuses this customer's
      // existing placeholder when they return with the same vehicle, and mints
      // a new one only when it has to. We used to mint `SHOP${Date.now()}`
      // here, which is exactly 17 characters and so read as a real VIN to
      // every downstream length check, and which forked a new vehicle row on
      // every single visit. See convex/lib/vinIdentity.ts.
      const finalVin = vin.trim();
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
        customServices:
          customServices.length > 0
            ? (customServices.map((c) => ({
                name: c.name,
                durationMinutes: c.durationMinutes,
                complaint: c.complaint,
                systemTags: c.systemTags,
                workType: c.workType,
                shopCustomServiceId: c.shopCustomServiceId as
                  | Id<"shop_custom_services">
                  | undefined,
              })) as never)
            : undefined,
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
    // A half-typed VIN used to be stored verbatim as the vehicle's permanent
    // identity — nothing validated it on the way in. Blank is fine (the car is
    // then identified by year/make/model), but a partial one is a typo we
    // should catch here rather than immortalize.
    const typedVin = vin.trim().toUpperCase();
    if (typedVin && !VIN_REGEX.test(typedVin)) {
      onToast(
        typedVin.length === 17
          ? "That VIN contains invalid characters (VINs never use I, O or Q)."
          : `A VIN is 17 characters — you entered ${typedVin.length}. Leave it blank to identify the car by year/make/model.`,
      );
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

    if (
      (selectedIds.size > 0 || customServices.length > 0) &&
      partsDeclaration === null
    ) {
      openSection("catalog_parts");
      onToast("Choose how to handle parts (No parts / Add parts / Skip).");
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
      {/* Header — scheduling lives here so date, time, and assignment are
          always visible and editable without scrolling. */}
      <div className="shrink-0 border-b border-border px-5 py-3">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-foreground">Create booking</h2>
          <div className="flex items-center gap-2">
            {holdCountdownLabel && (
              <span
                className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                  holdExpired
                    ? "bg-red-100 text-red-700"
                    : "bg-emerald-100 text-emerald-700"
                }`}
                title={
                  holdExpired
                    ? "This slot hold expired — the slot may now be taken. Re-pick a time."
                    : "This slot is held for you while you finish."
                }
              >
                <Clock className="w-3 h-3" />
                {holdExpired ? "Hold expired" : `Held ${holdCountdownLabel}`}
              </span>
            )}
            <button
              onClick={onClose}
              className="p-1 rounded-lg hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Date + time + end, inline */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <DatePicker
            className="w-40"
            value={date}
            onChange={(next) => next && setDate(next)}
          />
          <Select selectedKey={time} onSelectionChange={(key) => setTime(String(key))}>
            <SelectTrigger className="h-9 w-32 rounded-lg border-border bg-card text-sm px-3">
              <SelectValue />
            </SelectTrigger>
            <SelectPopover placement="bottom start">
              <SelectListBox shouldFocusWrap>
                {filteredTimeOptions.map((o) => (
                  <SelectItem key={o.value} id={o.value} textValue={o.label}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectListBox>
            </SelectPopover>
          </Select>
          {computedEndLabel ? (
            <span className="text-xs text-muted-foreground">Ends ~ {computedEndLabel}</span>
          ) : null}
        </div>

        {/* Mechanic assignment — small, unboxed, free-flowing */}
        {mechanics.length > 0 && (
          <div className="mt-2 flex items-center gap-1.5 text-sm text-muted-foreground">
            <span>Assigned to</span>
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
              <SelectTrigger className="inline-flex h-auto w-auto items-center gap-1 rounded-md border-0 bg-transparent px-1.5 py-0.5 text-sm font-medium text-foreground shadow-none ring-offset-0 hover:text-primary">
                <SelectValue />
              </SelectTrigger>
              <SelectPopover placement="bottom start">
                <SelectListBox shouldFocusWrap>
                  <SelectItem id="any" textValue={entityLabel.anyLabel}>
                    <span className="text-muted-foreground">{entityLabel.anyLabel}</span>
                  </SelectItem>
                  {mechanics.map((m) => (
                    <SelectItem key={m._id} id={m._id} textValue={m.name}>
                      {m.name}
                    </SelectItem>
                  ))}
                </SelectListBox>
              </SelectPopover>
            </Select>
          </div>
        )}

        {/* Scheduling validation */}
        {(overlapError || blockingHoursError || capacityWarning || outsideHoursWarning) && (
          <div className="mt-2 space-y-1">
            {overlapError && <p className="form-error-text text-xs">{overlapError}</p>}
            {blockingHoursError && (
              <p className="form-error-text text-xs">{blockingHoursError}</p>
            )}
            {capacityWarning && <p className="text-xs text-amber-700">{capacityWarning}</p>}
            {outsideHoursWarning && (
              <p className="form-error-text text-xs">
                This booking extends beyond normal shop hours and will require confirmation.
              </p>
            )}
          </div>
        )}
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto px-5 pt-4 pb-3 space-y-3">

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
              <DrawerFieldLabel>VIN <span className="normal-case tracking-normal font-normal text-muted-foreground/60">(Recommended)</span></DrawerFieldLabel>
              <div className="relative">
                <input
                  type="text"
                  placeholder="17-digit code"
                  value={vin}
                  onChange={(e) => {
                    // Auto-correct the ISO ambiguous typos (O→0, I→1) and strip
                    // anything a VIN can't contain BEFORE it reaches state, so a
                    // VIN entered with an "O" still hits the 17-char check and
                    // fires enrichment instead of silently stalling one char shy.
                    const { value, correctedOI, droppedInvalid } =
                      sanitizeVinInput(e.target.value);
                    setVin(value);
                    setVinCorrection(
                      correctedOI || droppedInvalid
                        ? { correctedOI, droppedInvalid }
                        : null,
                    );
                  }}
                  maxLength={17}
                  className={`${drawerInputClassName} font-mono uppercase pr-9`}
                />
                {vinLookupState === "loading" && (
                  <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground animate-spin" />
                )}
              </div>
              {/* Tell the mechanic what we just fixed, so an auto-correct never
                  changes their input behind their back. */}
              {vinCorrection && (
                <p className="mt-1 text-xs text-amber-600">
                  {vinCorrection.correctedOI && vinCorrection.droppedInvalid
                    ? "Fixed that VIN — read O/I as 0/1 and dropped characters a VIN can't contain (no I, O or Q)."
                    : vinCorrection.correctedOI
                      ? "VINs never use the letters O or I — read those as 0 and 1."
                      : "Dropped a character a VIN can't contain (no I, O or Q)."}
                </p>
              )}
              {/* Live length feedback while the VIN is partial — the "can't take
                  it yet" state, surfaced at the field instead of at submit. */}
              {vin.length > 0 && vin.length < 17 && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {vin.length}/17 characters
                </p>
              )}
              {vinLookupState === "error" && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Couldn&apos;t decode VIN. Enter make/model manually.
                </p>
              )}
              {/* Off-Catalog Work spec, §5. Without a VIN the car gets a
                  placeholder identity: no decoded engine or options, no parts
                  fitment, and if the customer later adds the same car properly
                  it becomes a SECOND car with a separate history — this visit
                  stranded on the placeholder. The mechanic at the windscreen is
                  the only person who can prevent that, so tell them why. */}
              {vin.trim().length === 0 && (
                <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                  Worth the 20 seconds: without it we can&apos;t pull exact parts
                  for this car, and if the customer adds it to their own account
                  later it won&apos;t connect to today&apos;s work.
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
          meta={
            selectedIds.size > 0 ? `${selectedIds.size} selected` : undefined
          }
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
                  <span>{c.name}{c.durationMinutes ? ` · ${formatHoursValue(c.durationMinutes)}h` : ""}</span>
                  <X className="w-3 h-3" />
                </button>
              ))}
            </div>
          )}

          {/* Combined labor savings — the honest overlap deduction. Only shows
              when the director flag is on AND co-booked services shared teardown. */}
          {combinedLaborEnabled && combinedLabor.applied && combinedLabor.savedMinutes > 0 && (
            <div className="mb-3 rounded-lg border border-emerald-200 bg-emerald-50/70 p-2.5 text-xs text-emerald-900">
              <div className="flex items-center gap-1.5 font-semibold">
                <Check className="h-3.5 w-3.5" />
                Combined labor savings · −{formatHoursValue(combinedLabor.savedMinutes)}h
              </div>
              {combinedLabor.notes.length > 0 && (
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-emerald-800/90">
                  {combinedLabor.notes.map((n, i) => (
                    <li key={i}>{n}</li>
                  ))}
                </ul>
              )}
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

          {hasVehicleLabor && (
            <p className="mb-2 text-[11px] text-muted-foreground">
              Labor times shown for{" "}
              <span className="font-medium text-foreground">
                {[year, make, model].filter(Boolean).join(" ") || "this vehicle"}
              </span>
              {" · "}
              <span className="tabular-nums">~</span> = tier estimate
            </p>
          )}

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
                          // Prefer the per-vehicle labor time once a VIN
                          // resolves; else the flat catalog default. `~` +
                          // muted tone flags a tier/default estimate (the
                          // "Yassin fallback"), matching the app's Estimate pill.
                          const vehicleLabor = vehicleLaborByServiceId.get(String(s._id));
                          const mins = vehicleLabor
                            ? vehicleLabor.minutes
                            : Math.round((s.defaultLaborHours ?? 0) * 60);
                          const isEstimate = vehicleLabor?.isEstimate ?? false;
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
                                <span
                                  className={cn(
                                    "inline-flex items-center gap-1 text-[11px] tabular-nums shrink-0",
                                    isEstimate ? "text-muted-foreground/70" : "text-muted-foreground",
                                  )}
                                  title={
                                    vehicleLabor
                                      ? isEstimate
                                        ? "Estimated from vehicle tier"
                                        : "Based on this vehicle"
                                      : undefined
                                  }
                                >
                                  <Clock className="w-3 h-3" />
                                  {isEstimate ? "~" : ""}{formatHoursValue(mins)}h
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
          <div className="mt-3 space-y-2">
            {/* Past jobs this shop has done before. Lifted out of the closed-state
                branch so the search box + shortcuts stay reachable whether or not
                the custom form is open, and searchable once the list grows. */}
            {shopShortcuts && shopShortcuts.length > 0 ? (
              <div>
                <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                  Done here before
                </p>
                <div className="relative mb-2">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <input
                    type="text"
                    value={shortcutSearch}
                    onChange={(e) => setShortcutSearch(e.target.value)}
                    placeholder="Search past jobs…"
                    className="w-full rounded-lg border-0 bg-muted/70 py-2 pl-8 pr-3 text-xs text-foreground outline-none placeholder:text-muted-foreground/50 focus:ring-2 focus:ring-primary/20"
                  />
                </div>
                {shortcutMatches.visible.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {shortcutMatches.visible.map((sc: any) => (
                      <button
                        key={String(sc._id)}
                        type="button"
                        onClick={() => openShortcut(sc)}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-muted/30 px-2.5 py-1.5 text-[11px] font-medium text-foreground transition-colors hover:border-primary/40 hover:bg-primary/5"
                      >
                        {sc.name}
                        {sc.default_minutes ? (
                          <span className="text-[10px] tabular-nums text-muted-foreground">
                            {sc.default_minutes}m
                          </span>
                        ) : null}
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="text-[11px] text-muted-foreground">
                    No past jobs match “{shortcutSearch.trim()}”.
                  </p>
                )}
                {shortcutMatches.hidden > 0 ? (
                  <p className="mt-1.5 text-[10px] text-muted-foreground/70">
                    +{shortcutMatches.hidden} more — search to find them.
                  </p>
                ) : null}
              </div>
            ) : null}
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
                  <input
                    type="text"
                    inputMode="decimal"
                    value={customDraftMinutes}
                    onChange={(e) =>
                      setCustomDraftMinutes(e.target.value.replace(/[^0-9.]/g, ""))
                    }
                    placeholder="hr"
                    className={drawerInputClassName}
                  />
                </div>
                <CustomNameGate
                  typed={customDraftName.trim()}
                  offeredServiceIds={offeredServiceIds}
                  onUseService={(id) => {
                    toggleService(id);
                    resetCustomDraft();
                  }}
                />
                {/* Second band: not a catalog service, but work other shops
                    have already named. Taking one converges the cluster
                    instead of forking it — see the component header. */}
                <KnownNameSuggestions
                  typed={customDraftName}
                  shopId={shopData?.shopId ? String(shopData.shopId) : undefined}
                  onPick={(s) => {
                    setCustomDraftName(s.name);
                    // The shops that already did this work have effectively
                    // voted on what it is; don't make this one re-answer.
                    if (s.system_tags.length > 0) {
                      setCustomDraftSystemTags(s.system_tags);
                    }
                    if (s.work_type) setCustomDraftWorkType(s.work_type);
                  }}
                />
                {/* Why the work is happening. Optional, but it's the field that
                    turns "walnut blast" from a string into something we can
                    understand well enough to decide whether to build it. */}
                <textarea
                  value={customDraftComplaint}
                  onChange={(e) => setCustomDraftComplaint(e.target.value)}
                  placeholder="What did the customer report, or what did you see? (optional)"
                  className="w-full min-h-[52px] resize-y rounded-lg border border-border bg-background px-2.5 py-2 text-xs leading-relaxed outline-none focus:border-primary"
                />
                {/* Two mandatory axes, replacing the old "Category (optional)"
                    dropdown. That dropdown read service_categories — the
                    catalog's merchandising taxonomy, which describes what a
                    driver can BOOK. Off-catalog work is by definition work that
                    taxonomy can't name, which is how a power-window switch ended
                    up filed under "Inspections". */}
                <CustomJobTaxonomyPicker
                  systemTags={customDraftSystemTags}
                  workType={customDraftWorkType}
                  onSystemTagsChange={setCustomDraftSystemTags}
                  onWorkTypeChange={setCustomDraftWorkType}
                />
                {/* Only offered when this isn't already a shortcut. Ticking it
                    is what turns forty spellings into one key pressed forty
                    times, so the data is worth the one extra tap. */}
                {!customDraftShortcutId ? (
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={customDraftSaveShortcut}
                      onChange={(e) => setCustomDraftSaveShortcut(e.target.checked)}
                      className="w-3.5 h-3.5 rounded border-border text-primary accent-primary"
                    />
                    <span className="text-[11px] text-muted-foreground">
                      Save for next time
                    </span>
                  </label>
                ) : null}
                <div className="flex gap-2 justify-end">
                  <button
                    type="button"
                    onClick={resetCustomDraft}
                    className="px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={
                      !customDraftName.trim() ||
                      !isCustomJobTaxonomyComplete(
                        customDraftSystemTags,
                        customDraftWorkType,
                      )
                    }
                    onClick={async () => {
                      const name = customDraftName.trim();
                      if (!name) return;
                      if (
                        !isCustomJobTaxonomyComplete(
                          customDraftSystemTags,
                          customDraftWorkType,
                        )
                      ) {
                        return;
                      }
                      const customDraftHours = parseHoursInput(customDraftMinutes);
                      const minutes =
                        customDraftHours != null && customDraftHours > 0
                          ? hoursToMinutes(customDraftHours)
                          : undefined;

                      // Saving a shortcut runs the strict gate server-side. If it
                      // refuses, surface the canonical service and add nothing —
                      // the mechanic picks the real service or explicitly insists.
                      let shortcutId = customDraftShortcutId;
                      if (customDraftSaveShortcut && shopData?.shopId) {
                        try {
                          const res: any = await saveShortcut({
                            shopId: shopData.shopId as Id<"shops">,
                            name,
                            systemTags: customDraftSystemTags,
                            workType: customDraftWorkType,
                            defaultMinutes: minutes,
                            lastComplaint: customDraftComplaint.trim() || undefined,
                          });
                          shortcutId = String(res.id);
                        } catch {
                          // A failed shortcut save must not cost the mechanic the
                          // line they're adding — carry on without the shortcut.
                        }
                      }

                      setCustomServices((prev) => [
                        ...prev,
                        {
                          name,
                          durationMinutes: minutes,
                          complaint: customDraftComplaint.trim() || undefined,
                          systemTags: customDraftSystemTags,
                          workType: customDraftWorkType,
                          shopCustomServiceId: shortcutId || undefined,
                        },
                      ]);
                      resetCustomDraft();
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
                {isBackfill ? "Actual time (hours)" : "Time (hours)"}{" "}
                <span className="text-destructive normal-case tracking-normal font-normal">
                  *
                </span>
              </DrawerFieldLabel>
              <input
                type="text"
                inputMode="decimal"
                value={estimateHoursText}
                onFocus={() => {
                  estimateHoursFocused.current = true;
                }}
                onBlur={() => {
                  estimateHoursFocused.current = false;
                  setEstimateHoursText(
                    mechanicEstimateMinutes != null
                      ? formatHoursValue(mechanicEstimateMinutes)
                      : "",
                  );
                }}
                onChange={(e) => {
                  if (!isBackfill) setEstimateMinutesTouched(true);
                  const raw = e.target.value.replace(/[^0-9.]/g, "");
                  setEstimateHoursText(raw);
                  const parsed = parseHoursInput(raw);
                  setMechanicEstimateMinutes(
                    parsed == null ? null : hoursToMinutes(parsed),
                  );
                }}
                placeholder={
                  catalogEstimateMinutes > 0
                    ? formatHoursValue(catalogEstimateMinutes)
                    : "e.g. 1.5"
                }
                className={drawerInputClassName}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {isBackfill
                  ? "How long the job actually took."
                  : !estimateMinutesTouched && catalogEstimateMinutes > 0
                    ? "Prefilled from the selected service. Editable."
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
                  if (!isBackfill) setQuotedPriceTouched(true);
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
                  : !quotedPriceTouched && suggestedQuotedPrice != null
                    ? `Prefilled from ${suggestedRate?.tier ?? "shop"} labor rate × time + parts. Editable.`
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

        {/* ── Parts (declaration → editor; feeds the bill + job scope) ──
            "Add parts" itemizes the parts on this bill (prefilled from the OEM
            catalog, fully editable). They become priced_parts_snapshot +
            parts_cost and feed the job scope, pre-job and post-job. */}
        {!isBackfill && (selectedIds.size > 0 || customServices.length > 0) && (
          <CollapsibleSection
            sectionKey="catalog_parts"
            icon={Package}
            label="Parts"
            open={openSections.has("catalog_parts")}
            onToggle={toggleSection}
            required
            meta={
              partsDeclaration
                ? { add: "Add parts", none: "No parts", skip: "Skip" }[
                    partsDeclaration
                  ]
                : undefined
            }
          >
            <DrawerFieldLabel>Does this job have parts?</DrawerFieldLabel>
            <div className="space-y-1.5">
              {([
                { value: "add", label: "Add parts", hint: "List the parts on this bill — prefilled from our catalog" },
                { value: "none", label: "No parts", hint: "Labor-only job — nothing to install" },
                { value: "skip", label: "Skip for now", hint: "Decide later — pre-job will suggest from the catalog" },
              ] as Array<{ value: "add" | "none" | "skip"; label: string; hint: string }>).map((opt) => {
                const selected = partsDeclaration === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => {
                      setPartsDeclaration(opt.value);
                      if (opt.value === "add") openSection("catalog_parts");
                    }}
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

            {partsDeclaration === "none" && (
              <p className="mt-3 text-xs text-muted-foreground">
                Labor-only — no parts will be billed.
              </p>
            )}

            {partsDeclaration === "add" && (
              <div className="mt-4 space-y-4">
                {catalogPartsPreview && !catalogPartsPreview.hasConfig && (
                  <p className="text-xs text-amber-700">
                    No catalog match for this VIN yet — add the parts manually below.
                  </p>
                )}
                {mechanicQuotedPrice != null &&
                  mechanicQuotedPrice > 0 &&
                  declaredPartsTotal > mechanicQuotedPrice && (
                    <p className="text-xs text-amber-700">
                      {`Parts ($${declaredPartsTotal.toFixed(2)}) exceed the quoted price ($${mechanicQuotedPrice.toFixed(2)}) — labor will show as $0.`}
                    </p>
                  )}
                {catalogPartServices.map(({ service_id: sid, name, custom }) => {
                  const rows = catalogPartEdits[sid] ?? [];
                  // Tire replacement has no OEM parts — the mechanic enters the
                  // tires directly (size / brand / model / per-tire price).
                  if (tireService != null && sid === String(tireService._id)) {
                    return (
                      <div
                        key={sid}
                        className="rounded-lg border border-border bg-background/40 p-3"
                      >
                        <DrawerFieldLabel>{name} — tires</DrawerFieldLabel>
                        {tireSpecs == null ? (
                          <p className="mt-1 text-xs text-muted-foreground">
                            Pick the tire specs above first, then set the brand,
                            model, and price per tire here.
                          </p>
                        ) : (
                          <div className="mt-2">
                            <TirePartsEditor
                              value={tirePartLines}
                              onChange={setTirePartLines}
                              oemSizes={[
                                tireSpecs.size,
                                convexVehicleInfo?.tire_size_front ?? null,
                                convexVehicleInfo?.tire_size_rear ?? null,
                              ]}
                            />
                          </div>
                        )}
                      </div>
                    );
                  }
                  return (
                    <div
                      key={sid}
                      className="rounded-lg border border-border bg-background/40 p-3"
                    >
                      <DrawerFieldLabel>
                        {name} — parts
                        {custom ? (
                          <span className="ml-1.5 rounded border border-primary/30 bg-primary/5 px-1 py-px text-[9px] font-semibold uppercase tracking-[0.06em] text-primary">
                            custom
                          </span>
                        ) : null}
                      </DrawerFieldLabel>
                      <div className="space-y-3">
                        {rows.length === 0 && (
                          <p className="text-xs text-muted-foreground">
                            {custom
                              ? "Off-catalog work — we have nothing to prefill. Add what you fitted."
                              : "No catalog parts for this service — add one below."}
                          </p>
                        )}
                        {rows.map((p, idx) =>
                          p.saved ? (
                            <div
                              key={p.key}
                              className="relative flex items-center gap-3 rounded-lg border border-border/70 bg-muted/30 px-3 py-2"
                            >
                              {faviconUrl(p.source_url) ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                  src={faviconUrl(p.source_url)!}
                                  alt=""
                                  width={20}
                                  height={20}
                                  className="h-5 w-5 shrink-0 rounded-sm"
                                  onError={(e) => {
                                    e.currentTarget.style.visibility = "hidden";
                                  }}
                                />
                              ) : (
                                <Package className="h-5 w-5 shrink-0 text-muted-foreground" />
                              )}
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-sm font-medium">
                                  {p.part_name.trim() ||
                                    p.oem_number.trim() ||
                                    "Part"}
                                </p>
                                <p className="truncate text-[11px] text-muted-foreground">
                                  {[
                                    p.oem_number.trim(),
                                    p.brand?.trim(),
                                    `Qty ${p.quantity || "1"}`,
                                    `$${p.unit_price || "0.00"}`,
                                  ]
                                    .filter(Boolean)
                                    .join(" · ")}
                                </p>
                              </div>
                              {p.source_url?.trim() && (
                                <a
                                  href={p.source_url.trim()}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="shrink-0 text-muted-foreground hover:text-primary"
                                  aria-label="Open source link"
                                >
                                  <ExternalLink className="h-4 w-4" />
                                </a>
                              )}
                              <button
                                type="button"
                                onClick={() => editCatalogPartRow(sid, idx)}
                                className="shrink-0 text-xs text-primary hover:underline"
                              >
                                Edit
                              </button>
                              <button
                                type="button"
                                onClick={() => removeCatalogPartRow(sid, idx)}
                                className="shrink-0 text-muted-foreground hover:text-destructive"
                                aria-label="Remove part"
                              >
                                <X className="w-4 h-4" />
                              </button>
                            </div>
                          ) : (
                            <div
                              key={p.key}
                              className="relative rounded-lg border border-border/70 bg-muted/30 p-3 space-y-3"
                            >
                            <button
                              type="button"
                              onClick={() => removeCatalogPartRow(sid, idx)}
                              className="absolute right-2 top-2 text-muted-foreground hover:text-destructive"
                              aria-label="Remove part"
                            >
                              <X className="w-4 h-4" />
                            </button>
                            <div className="pr-6">
                              <DrawerFieldLabel>Part name</DrawerFieldLabel>
                              <input
                                type="text"
                                placeholder="e.g. Front brake pad set"
                                value={p.part_name}
                                onChange={(e) =>
                                  setCatalogPartField(sid, idx, "part_name", e.target.value)
                                }
                                className={drawerInputClassName}
                              />
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                              <div>
                                <DrawerFieldLabel>Part Number</DrawerFieldLabel>
                                <input
                                  type="text"
                                  placeholder="Part number"
                                  value={p.oem_number}
                                  onChange={(e) =>
                                    setCatalogPartField(sid, idx, "oem_number", e.target.value)
                                  }
                                  onBlur={() =>
                                    setCatalogPartField(
                                      sid,
                                      idx,
                                      "oem_number",
                                      tidyOem(p.oem_number),
                                    )
                                  }
                                  className={`${drawerInputClassName} font-mono uppercase`}
                                />
                              </div>
                              <div>
                                <DrawerFieldLabel>Brand</DrawerFieldLabel>
                                <Combobox
                                  ariaLabel="Brand"
                                  placeholder="Search or type a brand…"
                                  value={p.brand ?? ""}
                                  onChange={(value) =>
                                    setCatalogPartField(sid, idx, "brand", value)
                                  }
                                  options={makeOptions}
                                  loading={makesList === undefined}
                                  emptyText="No matching brand — type one, then tap Add"
                                  onAddCustom={(value) => {
                                    // Select it on this part now…
                                    setCatalogPartField(sid, idx, "brand", value);
                                    // …and remember it for this shop's future
                                    // bookings. Fire-and-forget: a failed save must
                                    // never cost the mechanic the brand they typed.
                                    if (shopData?.shopId) {
                                      addCustomBrand({
                                        shopId: shopData.shopId as Id<"shops">,
                                        name: value,
                                      }).catch(() => {});
                                    }
                                  }}
                                  inputClassName={drawerInputClassName}
                                />
                              </div>
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                              <div>
                                <DrawerFieldLabel>Qty</DrawerFieldLabel>
                                <input
                                  type="number"
                                  min={0}
                                  step={1}
                                  placeholder="Qty"
                                  value={p.quantity}
                                  onChange={(e) =>
                                    setCatalogPartField(sid, idx, "quantity", e.target.value)
                                  }
                                  className={drawerInputClassName}
                                />
                              </div>
                              <div>
                                <DrawerFieldLabel>Unit price ($)</DrawerFieldLabel>
                                <FixedCentCurrencyInput
                                  placeholder="0.00"
                                  value={p.unit_price}
                                  onValueChange={(value) =>
                                    setCatalogPartField(
                                      sid,
                                      idx,
                                      "unit_price",
                                      value,
                                    )
                                  }
                                  className={drawerInputClassName}
                                />
                                {p.price_unknown && (
                                  <p className="mt-1 text-[11px] text-amber-700">
                                    Catalog had no price — enter what you charge.
                                  </p>
                                )}
                              </div>
                            </div>
                            <div>
                              <DrawerFieldLabel>
                                Source link (optional)
                              </DrawerFieldLabel>
                              <div className="flex items-center gap-2">
                                {faviconUrl(p.source_url) && (
                                  // eslint-disable-next-line @next/next/no-img-element
                                  <img
                                    src={faviconUrl(p.source_url)!}
                                    alt=""
                                    width={16}
                                    height={16}
                                    className="h-4 w-4 shrink-0 rounded-sm"
                                    onError={(e) => {
                                      e.currentTarget.style.visibility = "hidden";
                                    }}
                                  />
                                )}
                                <input
                                  type="url"
                                  inputMode="url"
                                  placeholder="https://… where you sourced this part"
                                  value={p.source_url ?? ""}
                                  onChange={(e) =>
                                    setCatalogPartField(
                                      sid,
                                      idx,
                                      "source_url",
                                      e.target.value,
                                    )
                                  }
                                  className={`${drawerInputClassName} flex-1`}
                                />
                              </div>
                            </div>
                            <div className="flex justify-end pt-1">
                              <button
                                type="button"
                                onClick={() => saveCatalogPartRow(sid, idx)}
                                disabled={
                                  !p.part_name.trim() && !p.oem_number.trim()
                                }
                                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                <Check className="w-3.5 h-3.5" />
                                Save part
                              </button>
                            </div>
                          </div>
                          )
                        )}
                        <button
                          type="button"
                          onClick={() => addCatalogPartRow(sid)}
                          className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                        >
                          <Plus className="w-3.5 h-3.5" />
                          Add part
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CollapsibleSection>
        )}

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

      </div>

      {/* Footer */}
      <div className="px-5 py-3 border-t border-border shrink-0">
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
          // When the mechanic chose "Add parts", tire brand / model / price is
          // entered in the drawer's tire editor — return there instead of
          // submitting immediately so the priced lines make it onto the booking.
          if (!isBackfill && partsDeclaration === "add") {
            return;
          }
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

/**
 * Matching catalog services, surfaced under the name field as you type.
 *
 * Suggestions only — whatever the mechanic typed stays the default, and picking
 * one is an option rather than an answer to a question. Limited to services this
 * shop actually offers: selecting one it doesn't carry would put an id in
 * selectedIds that the duration and price maths can't resolve.
 */
function CustomNameGate({
  typed,
  offeredServiceIds,
  onUseService,
}: {
  typed: string;
  offeredServiceIds: Set<string>;
  onUseService: (serviceId: string) => void;
}) {
  return (
    <ServiceSuggestions
      typed={typed}
      offeredServiceIds={offeredServiceIds}
      onPick={(s) => onUseService(String(s.serviceId))}
    />
  );
}
