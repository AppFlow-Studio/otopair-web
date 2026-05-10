"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { ArrowRight, Calendar, Car, ChevronDown, Loader2, Search, User, Wrench, X } from "lucide-react";
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
  initialDate: string;
  initialTime: string;
  initialMechanicId: string;
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
  initialDate,
  initialTime,
  initialMechanicId,
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

  /* ---- Vehicle ---- */
  const [vin, setVin] = useState("");
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [make, setMake] = useState("");
  const [model, setModel] = useState("");

  /* ---- Services ---- */
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [expandedCats, setExpandedCats] = useState<Set<string>>(new Set());

  /* ---- Scheduling ---- */
  const [date, setDate] = useState(initialDate);
  const [time, setTime] = useState(initialTime);
  const [mechanicId, setMechanicId] = useState(initialMechanicId);
  const [assignmentPreference, setAssignmentPreference] = useState<
    "any" | "specific_mechanic"
  >(initialMechanicId ? "specific_mechanic" : "any");

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
    const estMins = selected.reduce((sum, s) => sum + s.defaultLaborHours * 60, 0) || 60;
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
  }, [mechanicId, date, time, selectedIds, categories, bookings]);

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
    const estMins = selected.reduce((sum, s) => sum + s.defaultLaborHours * 60, 0) || 60;
    const endTime = getBookingEndTime(time, estMins);
    const dayHours = getShopHoursForDate(shopHours, date);
    if (!dayHours || dayHours.isClosed) return null;

    return toMins(endTime) > toMins(dayHours.closeTime)
      ? "This booking would end after the shop closes."
      : null;
  }, [date, time, selectedIds, categories, shopHours]);

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
      const estMinutes = selected.reduce((sum, s) => sum + s.defaultLaborHours * 60, 0) || undefined;
      const finalVin = vin.trim() || `SHOP${Date.now()}`;

      await createBooking({
        shopId: shopData.shopId as Id<"shops">,
        customerEmail: email.trim(),
        customerFirstName: firstName.trim() || undefined,
        customerLastName: lastName.trim() || undefined,
        vin: finalVin,
        vehicleYear: year ? Number(year) : undefined,
        vehicleMake: make.trim() || undefined,
        vehicleModel: model.trim() || undefined,
        scheduledDate: date,
        scheduledTime: time,
        serviceIds: Array.from(selectedIds) as Id<"services">[],
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
    if (!email.trim() || !shopData?.shopId) return;

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
                <DrawerFieldLabel>First Name</DrawerFieldLabel>
                <input type="text" placeholder="James" value={firstName} onChange={(e) => setFirstName(e.target.value)} className={drawerInputClassName} />
              </div>
              <div>
                <DrawerFieldLabel>Last Name</DrawerFieldLabel>
                <input type="text" placeholder="Wilson" value={lastName} onChange={(e) => setLastName(e.target.value)} className={drawerInputClassName} />
              </div>
            </div>
            <div>
              <DrawerFieldLabel>Email <span className="text-destructive normal-case tracking-normal font-normal">*</span></DrawerFieldLabel>
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
              <input type="text" placeholder="17-digit code" value={vin} onChange={(e) => setVin(e.target.value)} className={drawerInputClassName} />
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
            <div className="space-y-4">
              {filteredCats.map((cat) => {
                const isExpanded = expandedCats.has(cat.id) || !!search.trim();
                return (
                  <div key={cat.id}>
                    <button
                      onClick={() => toggleCat(cat.id)}
                      className="flex justify-between items-center w-full mb-2 group"
                    >
                      <span className="text-[11px] font-bold text-muted-foreground tracking-widest group-hover:text-primary transition-colors">
                        {cat.name}
                      </span>
                      <ChevronDown className={`w-3.5 h-3.5 text-muted-foreground transition-transform duration-200 ${isExpanded ? "rotate-180" : ""}`} />
                    </button>
                    {isExpanded && (
                      <div className="space-y-1.5">
                        {cat.services.map((s) => (
                          <label
                            key={s._id}
                            className="flex items-center gap-3 px-3 py-2.5 rounded-xl bg-muted/40 hover:bg-muted transition-all cursor-pointer border border-transparent hover:border-primary/10"
                          >
                            <input
                              type="checkbox"
                              checked={selectedIds.has(s._id)}
                              onChange={() => toggleService(s._id)}
                              className="w-4 h-4 rounded border-border text-primary accent-primary shrink-0"
                            />
                            <span className="text-sm font-medium text-foreground">{s.name}</span>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* ── Scheduling ── */}
        <section>
          <DrawerSectionHeader icon={Calendar} label="Scheduling" />
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <DrawerFieldLabel>Date</DrawerFieldLabel>
                <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={drawerInputClassName} />
              </div>
              <div>
                <DrawerFieldLabel>Time</DrawerFieldLabel>
                <Select selectedKey={time} onSelectionChange={(key) => setTime(String(key))}>
                  <SelectTrigger className={drawerSelectTriggerClassName}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopover placement="bottom start">
                    <SelectListBox shouldFocusWrap>
                      {TIME_OPTIONS.map((o) => (
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
          disabled={!email.trim() || isSaving}
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
