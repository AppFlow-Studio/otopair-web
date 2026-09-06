"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAction, useMutation, useQuery } from "convex/react";
import { Check, ScanLine, Car } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatPhoneInput, isValidUsPhone, normalizePhoneToE164 } from "@/lib/phone";
import { sanitizeVinInput } from "@/lib/vin";

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatTodayLabel(): string {
  const d = new Date();
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

/** "09:00" → "9:00 AM", "17:30" → "5:30 PM". Handles bad input by returning it. */
function formatTime12h(hhmm: string): string {
  const m = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return hhmm;
  let hour = Number(m[1]);
  const minute = m[2];
  const suffix = hour >= 12 ? "PM" : "AM";
  if (hour === 0) hour = 12;
  else if (hour > 12) hour -= 12;
  return `${hour}:${minute} ${suffix}`;
}

/**
 * Normalize free-text time input to backend "HH:mm" 24-hour format.
 * Accepts: "3:00", "3", "3 PM", "3:00 PM", "3:00pm", "15:00", "15:30".
 * When the input is a bare hour 1-11 with no am/pm, treats it as PM
 * (walk-ins are almost always business-hours afternoons; typing "3" for
 * 3 AM would surprise nobody less than typing "3" and getting 3 PM).
 */
function normalizeTimeInput(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const suffix = m[3];
  if (Number.isNaN(hour) || Number.isNaN(minute)) return null;
  if (minute > 59) return null;
  if (suffix === "am") {
    if (hour === 12) hour = 0;
    else if (hour > 12) return null;
  } else if (suffix === "pm") {
    if (hour === 12) {
      /* noop */
    } else if (hour > 12) return null;
    else hour += 12;
  } else {
    // No am/pm suffix. Treat 1-11 as PM, keep 0/12-23 as-is.
    if (hour >= 1 && hour <= 11) hour += 12;
    if (hour > 23) return null;
  }
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export default function WalkInNewPage() {
  const router = useRouter();
  const shopData = useQuery(api.schedule.getShopServicesWithCategories);
  const scheduleContext = useQuery(api.schedule.getScheduleContext);
  // Full otopair catalog — used as the service picker's source of truth so
  // walk-ins always see the same options regardless of what the shop has
  // opted into via shop_services.
  const catalogServices = useQuery(api.services.list);
  const createBooking = useMutation(api.bookings.createByShop);
  const mintClaimTokenForBooking = useMutation(
    api.walkin_claims.mintForBooking,
  );
  const decodeVin = useAction(api.vehicle_pipeline.decodeVin);
  const confirmVehicleForShopCustomer = useAction(
    api.vehicle_pipeline.confirmVehicleForShopCustomer,
  );

  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [vin, setVin] = useState("");
  // What the VIN field last auto-fixed, surfaced so O→0 / I→1 corrections and
  // dropped characters aren't silent (a silently-dropped O left the VIN 16 chars
  // long, which skipped the decode-on-submit enrichment entirely).
  const [vinCorrection, setVinCorrection] = useState<{
    correctedOI: boolean;
    droppedInvalid: boolean;
  } | null>(null);
  const [showManualVehicle, setShowManualVehicle] = useState(false);
  const [year, setYear] = useState("");
  const [make, setMake] = useState("");
  const [model, setModel] = useState("");
  const [trim, setTrim] = useState("");
  // Service: either a preset service id, "" (defaults to a generic walk-in
  // service on submit), or "__other__" (free-text into customServiceName).
  const [selectedServiceId, setSelectedServiceId] = useState<string>("");
  const [customServiceName, setCustomServiceName] = useState<string>("");
  const [date, setDate] = useState<string>(todayIso());
  const [time, setTime] = useState("");
  // Assignment: either a mechanic id, "" (unassigned/pick later), or "__other__"
  // (bay / custom label typed into customAssignment).
  const [selectedMechanicId, setSelectedMechanicId] = useState<string>("");
  const [customAssignment, setCustomAssignment] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mechanics = scheduleContext?.mechanics ?? [];
  const assignedTo =
    selectedMechanicId === "__other__"
      ? customAssignment.trim()
      : mechanics.find((m: { _id: string }) => m._id === selectedMechanicId)?.name ?? "";

  // Full otopair catalog. Sorted by category display order then service
  // display order so the picker reads like the mechanic-facing menu.
  const services = useMemo(() => {
    if (!catalogServices) return [];
    const sorted = [...catalogServices].sort((a, b) => {
      const catA = (a.serviceCategory?.display_order ?? 99) as number;
      const catB = (b.serviceCategory?.display_order ?? 99) as number;
      if (catA !== catB) return catA - catB;
      return (a.display_order ?? 0) - (b.display_order ?? 0);
    });
    return sorted.map((s) => ({ _id: s._id as string, name: s.name as string }));
  }, [catalogServices]);

  // Shop hours for the selected date — used to prefill Time to a value that
  // will pass the server's shop-hours guard, and to show helper text so the
  // mechanic knows the valid window before submitting.
  const todaysHours = useMemo(() => {
    if (!scheduleContext?.hours || !date) return null;
    const [y, mo, d] = date.split("-").map(Number);
    if (!y || !mo || !d) return null;
    const dayOfWeek = new Date(y, mo - 1, d).getDay(); // 0=Sun
    const entry = scheduleContext.hours.find(
      (h: { dayOfWeek: number }) => h.dayOfWeek === dayOfWeek,
    );
    if (!entry || entry.isClosed) return null;
    return { open: entry.openTime, close: entry.closeTime };
  }, [scheduleContext, date]);

  // Time slots — 15-minute increments from open to close for the selected
  // date. Stored + displayed as 12-hour labels ("9:00 AM") so the existing
  // normalizeTimeInput → "HH:mm" step still works unchanged.
  const timeSlots = useMemo<string[]>(() => {
    if (!todaysHours) return [];
    const [oh, om] = todaysHours.open.split(":").map(Number);
    const [ch, cm] = todaysHours.close.split(":").map(Number);
    const startMin = oh * 60 + om;
    const endMin = ch * 60 + cm;
    if (startMin >= endMin) return [];
    const out: string[] = [];
    for (let m = startMin; m <= endMin; m += 15) {
      const hh = Math.floor(m / 60);
      const mm = m % 60;
      const hhmm = `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
      out.push(formatTime12h(hhmm));
    }
    return out;
  }, [todaysHours]);

  // Prefill Time once shop hours load, so the default submit doesn't error
  // with "outside shop hours". Only fires if the user hasn't typed anything.
  useEffect(() => {
    if (time || !todaysHours) return;
    setTime(formatTime12h(todaysHours.open));
  }, [time, todaysHours]);

  // Resolve the picked service to a display name for the SMS preview.
  const selectedServiceName = useMemo(() => {
    if (selectedServiceId === "__other__") return customServiceName.trim();
    if (selectedServiceId) return services.find((s) => s._id === selectedServiceId)?.name ?? "";
    return "";
  }, [selectedServiceId, customServiceName, services]);

  const phoneValid = isValidUsPhone(phone);
  const canSubmit =
    fullName.trim().length > 0 &&
    phoneValid &&
    time.trim().length > 0 &&
    assignedTo.trim().length > 0 &&
    !saving;

  const smsPreview = useMemo(() => {
    const first = fullName.trim().split(" ")[0] || "there";
    const vehicleLabel =
      year && make && model ? `${year} ${make} ${model}` : "vehicle";
    const svcLabel = selectedServiceName
      ? selectedServiceName.toLowerCase()
      : "service";
    return `Hi ${first} — your shop has your ${vehicleLabel} in for ${svcLabel}. Track it live: otopair.com/t/…`;
  }, [fullName, year, make, model, selectedServiceName]);

  async function handleSubmit() {
    if (!canSubmit || !shopData?.shopId) return;
    setSaving(true);
    setError(null);
    try {
      const [firstName, ...rest] = fullName.trim().split(/\s+/);
      const lastName = rest.join(" ") || undefined;
      const finalVin = vin.trim() || `WALK${Date.now()}`;

      // Backend requires at least one service (either preset or custom).
      // If the mechanic didn't pick one, default to a generic walk-in row so
      // the appointment still lands and can be edited from the booking list.
      // NOTE: omit `durationMinutes` — createByShop has a snake_case
      // conversion bug that trips the bookings-table schema validator when
      // that field is present. Backend duration falls back to the estimate.
      const isOther = selectedServiceId === "__other__";
      const isPreset = selectedServiceId && !isOther;

      const presetServiceIds = isPreset
        ? [selectedServiceId as Id<"services">]
        : [];
      const effectiveCustomServices =
        isOther && customServiceName.trim()
          ? [{ name: customServiceName.trim() }]
          : presetServiceIds.length === 0
            ? [{ name: "Walk-in service" }]
            : undefined;

      const scheduledTime = normalizeTimeInput(time);
      if (!scheduledTime) {
        setError(`Couldn't read time "${time}" — try "3:00 PM" or "15:00".`);
        setSaving(false);
        return;
      }

      // Only forward mechanicId when a real mechanic is picked. "__other__"
      // means a free-text label (bay #, etc.) that only lives in the note.
      const mechanicIdArg =
        selectedMechanicId && selectedMechanicId !== "__other__"
          ? (selectedMechanicId as Id<"mechanics">)
          : undefined;

      const bookingResult = await createBooking({
        shopId: shopData.shopId as Id<"shops">,
        customerPhone: normalizePhoneToE164(phone) ?? undefined,
        customerFirstName: firstName,
        customerLastName: lastName,
        vin: finalVin,
        vehicleYear: year ? Number(year) : undefined,
        vehicleMake: make.trim() || undefined,
        vehicleModel: model.trim() || undefined,
        vehicleTrim: trim.trim() || undefined,
        scheduledDate: date,
        scheduledTime,
        serviceIds: presetServiceIds,
        customServices: effectiveCustomServices,
        mechanicId: mechanicIdArg,
        assignmentPreference: mechanicIdArg ? "specific_mechanic" : "any",
        laborCost: 0,
        partsCost: 0,
        estimatedLaborMinutes: 60,
        status: "confirmed",
        source: "mechanic_walk_in",
        // Walk-ins are physical-presence: the mechanic knows the shop is open
        // and is choosing when the job starts. Skip the shop-hours guard.
        allowOutsideShopHours: true,
        customerNotes:
          selectedMechanicId === "__other__" && assignedTo
            ? `Assigned: ${assignedTo}`
            : undefined,
      });

      const bookingId = bookingResult as unknown as Id<"bookings">;

      // Mint the tracker token so the mechanic gets a copyable
      // /t/[token] URL on the /bookings banner. If the mutation isn't
      // deployed yet (deploy is deferred pending visual approval), the
      // catch keeps submit + redirect working — the banner just falls
      // back to the "not yet available" hint.
      let token: string | null = null;
      try {
        const minted = await mintClaimTokenForBooking({ bookingId });
        token = (minted as { token: string | null })?.token ?? null;
      } catch {
        token = null;
      }

      // If a 17-char VIN was entered, decode via NHTSA and attach the
      // vehicle to the walk-in customer's stub row. Non-blocking: any
      // failure (bad VIN, network hiccup, etc.) just means the tracker
      // renders its "Your vehicle" fallback and the customer adds the
      // car themselves after claiming. Mobile terminal flagged this on
      // 2026-08-19: without it, vehicle fields stay null on the tracker
      // AND the customer's Cars page is empty when they open the app.
      let vehicleAttachFailedReason: string | null = null;
      if (vin.trim().length === 17) {
        try {
          const decoded = await decodeVin({ vin: vin.trim() });
          if (decoded.success) {
            await confirmVehicleForShopCustomer({
              bookingId,
              vin: decoded.vin,
              trimId: decoded.trimId,
              engineId: decoded.engineId,
              year: decoded.year,
              make: decoded.make,
              model: decoded.model,
              trim: decoded.trim,
              engineCode: decoded.engineCode,
              displacement: decoded.displacement,
              cylinders: decoded.cylinders,
              fuelType: decoded.fuelType,
              drivetrain: decoded.drivetrain ?? undefined,
              nhtsaVinKey: decoded.nhtsaVinKey ?? undefined,
            });
          } else {
            vehicleAttachFailedReason = decoded.error;
          }
        } catch (e) {
          vehicleAttachFailedReason =
            e instanceof Error ? e.message : "vehicle-attach failed";
        }
      }
      // Silence unused-var lint until we surface this on the banner too.
      void vehicleAttachFailedReason;

      const params = new URLSearchParams({
        walkinSuccess: "1",
        phone,
        assigned: assignedTo,
        time,
      });
      if (token) params.set("token", token);
      router.push(`/bookings?${params.toString()}`);
    } catch (err: unknown) {
      setError(
        err instanceof Error
          ? err.message
          : "Couldn't create the appointment. Please try again.",
      );
      setSaving(false);
    }
  }

  return (
    <div className="min-h-full -mx-6 -mt-6 -mb-6 flex flex-col bg-gray-50">
      {/* Sticky topbar: title left, WALK-IN pill right */}
      <div className="bg-white border-b border-gray-200 px-8 py-4 flex items-center">
        <h1 className="text-lg font-semibold text-gray-900">New appointment</h1>
        <div className="ml-auto flex items-center gap-3">
          <span className="inline-flex items-center rounded-full bg-emerald-100 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-emerald-700">
            Walk-in · 0% fee
          </span>
        </div>
      </div>

      {/* Body: form + info rail */}
      <div className="flex-1 px-8 py-8">
        <div className="mx-auto grid max-w-[1120px] grid-cols-1 gap-8 lg:grid-cols-[1fr_400px]">
          {/* ─── Form card ─── */}
          <section
            className={cn(
              "rounded-2xl border border-gray-200 bg-white p-8",
              "shadow-[0_1px_2px_-1px_rgba(0,0,0,0.04),0_4px_8px_-2px_rgba(0,0,0,0.03)]",
            )}
          >
            {/* CUSTOMER */}
            <FormEyebrow>Customer</FormEyebrow>
            <div className="mt-4 grid grid-cols-1 gap-6 sm:grid-cols-2">
              <FieldGroup label="Full name">
                <TextInput
                  value={fullName}
                  onChange={setFullName}
                  placeholder="Marcus Reyes"
                  autoFocus
                />
              </FieldGroup>
              <FieldGroup
                label="Mobile number"
                hint="Required — this is where the tracking link goes."
              >
                <TextInput
                  value={phone}
                  onChange={(v) => setPhone(formatPhoneInput(v))}
                  placeholder="(917) 555-4821"
                  type="tel"
                  invalid={phone.length > 0 && !phoneValid}
                  focused={phone.length > 0}
                />
              </FieldGroup>
            </div>

            {/* VEHICLE */}
            <FormEyebrow className="mt-8">Vehicle</FormEyebrow>
            <div className="mt-4">
              <FieldGroup
                label="VIN"
                hint={
                  vin.length > 0 && vin.length !== 17
                    ? `${vin.length}/17 characters`
                    : undefined
                }
              >
                <div className="relative">
                  <TextInput
                    value={vin}
                    onChange={(v) => {
                      // Auto-correct O→0 / I→1 (not just strip them) so a VIN
                      // typed with an "O" stays 17 chars and the decode-on-submit
                      // enrichment still runs.
                      const { value, correctedOI, droppedInvalid } =
                        sanitizeVinInput(v);
                      setVin(value);
                      setVinCorrection(
                        correctedOI || droppedInvalid
                          ? { correctedOI, droppedInvalid }
                          : null,
                      );
                    }}
                    placeholder="1HGBH41JXMN109186"
                  />
                  <button
                    type="button"
                    onClick={() => setShowManualVehicle((v) => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 inline-flex items-center gap-1 text-sm font-semibold text-primary hover:opacity-80"
                  >
                    <ScanLine className="h-4 w-4" />
                    {showManualVehicle ? "Hide details" : "Enter details"}
                  </button>
                </div>
                {vinCorrection && (
                  <p className="mt-1.5 text-xs text-amber-600">
                    {vinCorrection.correctedOI && vinCorrection.droppedInvalid
                      ? "Fixed that VIN — read O/I as 0/1 and dropped characters a VIN can't contain (no I, O or Q)."
                      : vinCorrection.correctedOI
                        ? "VINs never use the letters O or I — read those as 0 and 1."
                        : "Dropped a character a VIN can't contain (no I, O or Q)."}
                  </p>
                )}
              </FieldGroup>
              {/* Vehicle preview / manual entry */}
              {(showManualVehicle || year || make || model) && (
                <div className="mt-4 rounded-xl border border-blue-100 bg-blue-50 p-4">
                  <div className="flex items-start gap-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary text-white">
                      <Car className="h-5 w-5" />
                    </div>
                    <div className="flex-1 min-w-0">
                      {showManualVehicle ? (
                        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                          <MiniInput placeholder="Year" value={year} onChange={setYear} maxLength={4} />
                          <MiniInput placeholder="Make" value={make} onChange={setMake} />
                          <MiniInput placeholder="Model" value={model} onChange={setModel} />
                          <MiniInput placeholder="Trim (opt.)" value={trim} onChange={setTrim} />
                        </div>
                      ) : (
                        <>
                          <div className="text-sm font-semibold text-gray-900">
                            {year} {make} {model} {trim}
                          </div>
                          <div className="text-xs font-medium text-blue-700">
                            {vin ? `VIN ${vin.slice(0, 8)}…${vin.slice(-4)}` : "Manual entry"}
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* SERVICE */}
            <FormEyebrow className="mt-8">Service</FormEyebrow>
            <div className="mt-4">
              <ServiceSelect
                services={services}
                value={selectedServiceId}
                onChange={setSelectedServiceId}
              />
              {selectedServiceId === "__other__" && (
                <div className="mt-2">
                  <MiniInput
                    placeholder="e.g. Diagnostic"
                    value={customServiceName}
                    onChange={setCustomServiceName}
                  />
                </div>
              )}
              {!selectedServiceId && (
                <div className="mt-2 text-xs text-gray-500">
                  Leave empty for a generic walk-in, or pick a service.
                </div>
              )}
            </div>

            {/* DATE & BAY/TIME */}
            <div className="mt-8 grid grid-cols-1 gap-6 sm:grid-cols-2">
              <FieldGroup label="Date">
                <TextInput
                  value={date}
                  onChange={setDate}
                  placeholder={`Today · ${formatTodayLabel()}`}
                  type="date"
                />
              </FieldGroup>
              <FieldGroup
                label="Mechanic & time"
                hint={
                  todaysHours
                    ? `Shop hours today: ${formatTime12h(todaysHours.open)} – ${formatTime12h(todaysHours.close)}`
                    : scheduleContext?.hours
                      ? "Shop is closed today — pick another date or expect an out-of-hours warning."
                      : undefined
                }
              >
                <div className="grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] gap-2">
                  <MechanicSelect
                    mechanics={mechanics}
                    value={selectedMechanicId}
                    onChange={setSelectedMechanicId}
                  />
                  <TimeSelect
                    slots={timeSlots}
                    value={time}
                    onChange={setTime}
                    disabled={timeSlots.length === 0}
                  />
                </div>
                {selectedMechanicId === "__other__" && (
                  <div className="mt-2">
                    <MiniInput
                      placeholder="Bay # or other label"
                      value={customAssignment}
                      onChange={setCustomAssignment}
                    />
                  </div>
                )}
              </FieldGroup>
            </div>

            {/* Error */}
            {error && (
              <div className="mt-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
                {error}
              </div>
            )}

            {/* CTA */}
            <div className="mt-10 flex flex-wrap gap-3">
              <Button
                type="button"
                size="lg"
                disabled={!canSubmit}
                onClick={handleSubmit}
                className="flex-1 min-w-[280px] rounded-lg shadow-[0_2px_6px_-1px_rgba(82,153,254,0.35)]"
              >
                {saving ? "Creating…" : "Create appointment & text tracking link"}
              </Button>
              <Button asChild variant="outline" size="lg" className="rounded-lg">
                <Link href="/bookings">Cancel</Link>
              </Button>
            </div>
          </section>

          {/* ─── Info rail ─── */}
          <aside className="space-y-4">
            <div
              className={cn(
                "rounded-2xl border border-gray-200 bg-white p-6",
                "shadow-[0_1px_2px_-1px_rgba(0,0,0,0.04),0_4px_8px_-2px_rgba(0,0,0,0.03)]",
              )}
            >
              <h2 className="text-[15px] font-semibold text-gray-900">
                What your customer gets
              </h2>
              <ul className="mt-4 space-y-4">
                <Benefit title="Live job tracking">
                  They watch the repair progress — no more “is it ready yet?” calls.
                </Benefit>
                <Benefit title="Auto “ready for pickup” alert">
                  Sent the moment you mark the job done.
                </Benefit>
                <Benefit title="Your calendar stays true">
                  This bay and slot are blocked. The app won&apos;t double-book you.
                </Benefit>
                <Benefit title="Re-market later">
                  Customers who opt in can receive your promotions.
                </Benefit>
              </ul>
            </div>

            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5">
              <div className="text-sm font-semibold text-emerald-900">
                Walk-ins are 0% platform fee
              </div>
              <p className="mt-1.5 text-[13px] leading-relaxed text-emerald-700">
                You keep the full amount on this job. The customer pays you at
                the counter exactly as they do today.
              </p>
            </div>

            <div
              className={cn(
                "rounded-2xl border border-gray-200 bg-white p-6",
                "shadow-[0_1px_2px_-1px_rgba(0,0,0,0.04),0_4px_8px_-2px_rgba(0,0,0,0.03)]",
              )}
            >
              <div className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                Text they&apos;ll receive
              </div>
              <div className="mt-3 rounded-xl bg-gray-50 px-4 py-3 text-[13px] leading-relaxed text-gray-700">
                {smsPreview}
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────── UI helpers ───────────────────────── */

function FormEyebrow({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "text-[11px] font-semibold uppercase tracking-wider text-gray-500",
        className,
      )}
    >
      {children}
    </div>
  );
}

function FieldGroup({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
        {label}
      </label>
      <div className="mt-1.5">{children}</div>
      {hint && <div className="mt-1.5 text-xs text-gray-500">{hint}</div>}
    </div>
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
  type = "text",
  autoFocus,
  invalid,
  focused,
  onFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  autoFocus?: boolean;
  invalid?: boolean;
  focused?: boolean;
  onFocus?: React.FocusEventHandler<HTMLInputElement>;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      autoFocus={autoFocus}
      onFocus={onFocus}
      className={cn(
        "w-full rounded-lg border bg-white px-3.5 py-3 text-sm font-medium text-gray-900 outline-none transition",
        "placeholder:font-normal placeholder:text-gray-400",
        invalid
          ? "border-red-300 focus:border-red-500 focus:ring-4 focus:ring-red-500/10"
          : focused
            ? "border-primary ring-4 ring-primary/15"
            : "border-gray-200 focus:border-primary focus:ring-4 focus:ring-primary/15",
      )}
    />
  );
}

function ServiceSelect({
  services,
  value,
  onChange,
}: {
  services: { _id: string; name: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full min-w-0 truncate appearance-none rounded-lg border border-gray-200 bg-white bg-[url('data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2210%22%20height%3D%226%22%20viewBox%3D%220%200%2010%206%22%20fill%3D%22none%22%3E%3Cpath%20d%3D%22M1%201l4%204%204-4%22%20stroke%3D%22%236B7280%22%20stroke-width%3D%221.5%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%2F%3E%3C%2Fsvg%3E')] bg-[length:10px_6px] bg-[right_1rem_center] bg-no-repeat pl-3.5 pr-9 py-3 text-sm font-medium text-gray-900 outline-none transition focus:border-primary focus:ring-4 focus:ring-primary/15"
    >
      <option value="">Pick service</option>
      {services.map((s) => (
        <option key={s._id} value={s._id}>
          {s.name}
        </option>
      ))}
      <option value="__other__">Other (custom)</option>
    </select>
  );
}

function TimeSelect({
  slots,
  value,
  onChange,
  disabled,
}: {
  slots: string[];
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      className="w-full min-w-0 truncate appearance-none rounded-md border border-gray-200 bg-white bg-[url('data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2210%22%20height%3D%226%22%20viewBox%3D%220%200%2010%206%22%20fill%3D%22none%22%3E%3Cpath%20d%3D%22M1%201l4%204%204-4%22%20stroke%3D%22%236B7280%22%20stroke-width%3D%221.5%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%2F%3E%3C%2Fsvg%3E')] bg-[length:10px_6px] bg-[right_0.75rem_center] bg-no-repeat pl-3 pr-8 py-2 text-sm text-gray-900 outline-none transition placeholder:text-gray-400 focus:border-primary focus:ring-2 focus:ring-primary/15 disabled:bg-gray-50 disabled:text-gray-400"
    >
      {disabled ? (
        <option value="">Shop closed</option>
      ) : (
        <>
          {/* Show currently-selected time even if it's outside the slot
              grid (e.g. edited via URL) so it doesn't silently disappear */}
          {value && !slots.includes(value) && (
            <option value={value}>{value}</option>
          )}
          {slots.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </>
      )}
    </select>
  );
}

function MechanicSelect({
  mechanics,
  value,
  onChange,
}: {
  mechanics: { _id: string; name: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full min-w-0 truncate appearance-none rounded-md border border-gray-200 bg-white bg-[url('data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2210%22%20height%3D%226%22%20viewBox%3D%220%200%2010%206%22%20fill%3D%22none%22%3E%3Cpath%20d%3D%22M1%201l4%204%204-4%22%20stroke%3D%22%236B7280%22%20stroke-width%3D%221.5%22%20stroke-linecap%3D%22round%22%20stroke-linejoin%3D%22round%22%2F%3E%3C%2Fsvg%3E')] bg-[length:10px_6px] bg-[right_0.75rem_center] bg-no-repeat pl-3 pr-8 py-2 text-sm text-gray-900 outline-none transition placeholder:text-gray-400 focus:border-primary focus:ring-2 focus:ring-primary/15"
    >
      <option value="">Pick mechanic</option>
      {mechanics.map((m) => (
        <option key={m._id} value={m._id}>
          {m.name}
        </option>
      ))}
      <option value="__other__">Other (bay #)</option>
    </select>
  );
}

function MiniInput({
  value,
  onChange,
  placeholder,
  maxLength,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  maxLength?: number;
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      maxLength={maxLength}
      className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none transition placeholder:text-gray-400 focus:border-primary focus:ring-2 focus:ring-primary/15"
    />
  );
}

function Benefit({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex items-start gap-3">
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white">
        <Check className="h-3 w-3" strokeWidth={3} />
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold text-gray-900">{title}</div>
        <div className="text-[13px] leading-relaxed text-gray-600">
          {children}
        </div>
      </div>
    </li>
  );
}
