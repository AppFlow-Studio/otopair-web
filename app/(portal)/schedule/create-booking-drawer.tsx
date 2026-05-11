"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { formatPhoneInput, isValidUsPhone, normalizePhoneToE164 } from "@/lib/phone";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { ArrowRight, Calendar, Car, ChevronDown, Clock, Loader2, Plus, Search, User, Wrench, X } from "lucide-react";
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
  DrawerSectionHeader,
} from "@/components/drawer-panel-styles";
import ConfirmationDialog, { ShortcutLabel } from "@/components/confirmation-dialog";
import DatePicker from "@/components/ui/date-picker";
import { getBookingEndTime } from "@/lib/schedule-overlap";

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

  /* ---- VIN decode (NHTSA) ---- */
  const [vinLookupState, setVinLookupState] = useState<"idle" | "loading" | "error">("idle");
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

  const VIN_REGEX = /^[A-HJ-NPR-Z0-9]{17}$/i;

  useEffect(() => {
    const trimmed = vin.trim().toUpperCase();
    if (trimmed.length !== 17 || !VIN_REGEX.test(trimmed)) {
      setVinLookupState("idle");
      return;
    }
    if (trimmed === lastDecodedVinRef.current) return;

    let cancelled = false;
    setVinLookupState("loading");
    const handle = window.setTimeout(async () => {
      try {
        const res = await fetch(
          `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValuesExtended/${encodeURIComponent(
            trimmed
          )}?format=json`
        );
        if (!res.ok) throw new Error("NHTSA request failed");
        const data = await res.json();
        const row = data?.Results?.[0];
        if (cancelled) return;
        if (!row || row.ErrorCode === "11" || (!row.Make && !row.Model && !row.ModelYear)) {
          setVinLookupState("error");
          return;
        }
        lastDecodedVinRef.current = trimmed;
        setVinSuggestion({
          vin: trimmed,
          year: row.ModelYear || undefined,
          make: row.Make || undefined,
          model: row.Model || undefined,
          trim: row.Trim || undefined,
        });
        setVinImageUrl(null);
        setVinImageLoading(true);
        setVinConfirmOpen(true);
        setVinLookupState("idle");

        const imgParams = new URLSearchParams({ vin: trimmed });
        if (row.ModelYear) imgParams.set("year", String(row.ModelYear));
        if (row.Make) imgParams.set("make", String(row.Make));
        if (row.Model) imgParams.set("model", String(row.Model));
        if (row.Trim) imgParams.set("trim", String(row.Trim));
        fetch(`/api/vehicle-image?${imgParams.toString()}`)
          .then((r) => (r.ok ? r.json() : Promise.resolve({ imageUrl: null })))
          .then((data) => {
            if (cancelled) return;
            setVinImageUrl(data?.imageUrl ?? null);
          })
          .catch(() => {
            if (!cancelled) setVinImageUrl(null);
          })
          .finally(() => {
            if (!cancelled) setVinImageLoading(false);
          });
      } catch {
        if (!cancelled) setVinLookupState("error");
      }
    }, 400);

    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [vin]);

  function applyVinSuggestion() {
    if (!vinSuggestion) return;
    if (vinSuggestion.year) setYear(vinSuggestion.year);
    if (vinSuggestion.make) setMake(vinSuggestion.make);
    if (vinSuggestion.model) setModel(vinSuggestion.model);
    setVinConfirmOpen(false);
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
    return TIME_OPTIONS.filter((o) => {
      if (isToday && o.value < minTimeToday) return false;
      if (dayHours && !dayHours.isClosed) {
        const m = toMins(o.value);
        if (m < toMins(dayHours.openTime) || m >= toMins(dayHours.closeTime)) return false;
      }
      return true;
    });
  }, [isToday, minTimeToday, shopHours, date]);

  const [isSaving, setIsSaving] = useState(false);
  const [outsideHoursConfirmOpen, setOutsideHoursConfirmOpen] = useState(false);

  const shopData = useQuery(api.schedule.getShopServicesWithCategories);
  const createBooking = useMutation(api.bookings.createByShop);

  const categories = useMemo(() => shopData?.categories ?? [], [shopData?.categories]);

  /* ---- Overlap check ---- */
  const overlapError = useMemo(() => {
    if (!mechanicId || !date || !time) return null;
    const allServices = categories.flatMap((c) => c.services);
    const selected = allServices.filter((s) => selectedIds.has(s._id));
    const customMins = customServices.reduce((sum, c) => sum + (c.durationMinutes ?? 0), 0);
    const estMins = (selected.reduce((sum, s) => sum + s.defaultLaborHours * 60, 0) + customMins) || 60;
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
  }, [mechanicId, date, time, selectedIds, customServices, categories, bookings]);

  const blockingHoursError = useMemo(() => {
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

  const outsideHoursWarning = useMemo(() => {
    if (!date || !time) return null;

    const allServices = categories.flatMap((c) => c.services);
    const selected = allServices.filter((s) => selectedIds.has(s._id));
    const customMins = customServices.reduce((sum, c) => sum + (c.durationMinutes ?? 0), 0);
    const estMins = (selected.reduce((sum, s) => sum + s.defaultLaborHours * 60, 0) + customMins) || 60;
    const endTime = getBookingEndTime(time, estMins);
    const dayHours = getShopHoursForDate(shopHours, date);
    if (!dayHours || dayHours.isClosed) return null;

    return toMins(endTime) > toMins(dayHours.closeTime)
      ? "This booking would end after the shop closes."
      : null;
  }, [date, time, selectedIds, customServices, categories, shopHours]);

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
  async function submitBooking(allowOutsideShopHours = false) {
    setIsSaving(true);
    try {
      const allServices = categories.flatMap((c) => c.services);
      const selected = allServices.filter((s) => selectedIds.has(s._id));
      const customMinutes = customServices.reduce((sum, c) => sum + (c.durationMinutes ?? 0), 0);
      const baseMinutes = selected.reduce((sum, s) => sum + s.defaultLaborHours * 60, 0);
      const estMinutes = baseMinutes + customMinutes || undefined;
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
        scheduledDate: date,
        scheduledTime: time,
        serviceIds: Array.from(selectedIds) as Id<"services">[],
        customServices: customServices.length > 0 ? customServices : undefined,
        mechanicId: mechanicId ? (mechanicId as Id<"mechanics">) : undefined,
        assignmentPreference,
        laborCost: 0,
        partsCost: 0,
        estimatedLaborMinutes: estMinutes,
        status: "confirmed",
        allowOutsideShopHours: allowOutsideShopHours || undefined,
      });

      onToast("Booking created");
      onClose();
    } catch (err: unknown) {
      onToast(getUserFacingErrorMessage(err));
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

    if (date < todayISO || (isToday && time < minTimeToday)) {
      onToast("Pick a time from now onward.");
      return;
    }

    const preflightError = overlapError ?? blockingHoursError;
    if (preflightError) {
      onToast(preflightError);
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

        {/* ── Customer Info ── */}
        <section>
          <DrawerSectionHeader icon={User} label="Customer Info" />
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
        </section>

        {/* ── Vehicle Info ── */}
        <section>
          <DrawerSectionHeader icon={Car} label="Vehicle Info" />
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
            <div className="grid grid-cols-3 gap-3">
              <div>
                <DrawerFieldLabel>Year</DrawerFieldLabel>
                <input type="number" value={year} onChange={(e) => setYear(e.target.value)} className={drawerInputClassName} />
              </div>
              <div className="col-span-2">
                <DrawerFieldLabel>Make</DrawerFieldLabel>
                <input type="text" placeholder="Toyota" value={make} onChange={(e) => setMake(e.target.value)} className={drawerInputClassName} />
              </div>
            </div>
            <div>
              <DrawerFieldLabel>Model</DrawerFieldLabel>
              <input type="text" placeholder="Camry" value={model} onChange={(e) => setModel(e.target.value)} className={drawerInputClassName} />
            </div>
          </div>
        </section>

        {/* ── Service Selection ── */}
        <section>
          <DrawerSectionHeader icon={Wrench} label="Service Selection" />

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
                  <input
                    type="number"
                    min="0"
                    step="15"
                    placeholder="min"
                    value={customDraftMinutes}
                    onChange={(e) => setCustomDraftMinutes(e.target.value)}
                    className={drawerInputClassName}
                  />
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
        </section>

        {/* ── Scheduling ── */}
        <section>
          <DrawerSectionHeader icon={Calendar} label="Scheduling" />
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <DrawerFieldLabel>Date</DrawerFieldLabel>
                <DatePicker value={date} min={todayISO} onChange={(next) => next && setDate(next)} />
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
                      <SelectItem id="any" textValue="Any mechanic">
                        <span className="text-muted-foreground">Any mechanic</span>
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
            {outsideHoursWarning && (
              <p className="form-error-text text-xs">
                This booking extends beyond normal shop hours and will require confirmation.
              </p>
            )}
          </div>
        </section>

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
              <span>Creating…</span>
            </>
          ) : (
            <>
              <span>Create Booking</span>
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
                .join(" ")} — decoded from VIN ${vinSuggestion.vin}.`
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
        <div className="mb-5 flex items-center justify-center rounded-xl bg-muted/40 border border-border overflow-hidden" style={{ minHeight: 160 }}>
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
      </ConfirmationDialog>

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
    </div>
  );
}
