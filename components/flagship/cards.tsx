"use client";

import { useState } from "react";
import { Calendar, Car, Check, MapPin, Sparkles, Star } from "lucide-react";
import {
  SCHEDULING_PREVIEW,
  WEEK_DAYS,
  type Booking,
  type Shop,
  type Slot,
  type Vehicle,
} from "./oto-flow";

const CARD =
  "w-full rounded-[20px] border border-[#1a1a1a]/10 bg-white/65 p-6 backdrop-blur-2xl shadow-[0_20px_50px_rgba(0,0,0,0.08)]";

const usd = (n: number) =>
  n % 1 === 0 ? `$${n}` : `$${n.toFixed(2)}`;

function WeekStrip() {
  return (
    <div className="flex items-center justify-between">
      {WEEK_DAYS.map((d, i) => (
        <div key={i} className="flex flex-col items-center gap-1.5">
          <span className="text-[11px] text-[#1a1a1a]/40">{d.letter}</span>
          <span
            className={
              d.selected
                ? "flex h-7 w-7 items-center justify-center rounded-md bg-[#1a1a1a] text-[13px] font-medium text-white"
                : "flex h-7 w-7 items-center justify-center text-[13px] text-[#1a1a1a]/70"
            }
          >
            {d.date}
          </span>
        </div>
      ))}
    </div>
  );
}

function PrimaryButton({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mt-5 h-12 w-full rounded-xl bg-[#1a1a1a] text-[13px] font-medium uppercase tracking-[0.1em] text-white transition-transform hover:scale-[1.01] active:scale-[0.99]"
    >
      {children}
    </button>
  );
}

function SpecRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl bg-[#1a1a1a]/[0.04] px-4 py-2.5">
      <span className="text-[11px] uppercase tracking-wide text-[#1a1a1a]/45">{label}</span>
      <span
        className={`truncate text-right text-[13px] text-[#1a1a1a] ${mono ? "font-mono text-[12px]" : ""}`}
      >
        {value}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 0. Your Vehicle (decoded from VIN)                                  */
/* ------------------------------------------------------------------ */
export function VehicleCard({
  vehicle,
  onContinue,
}: {
  vehicle: Vehicle;
  onContinue: () => void;
}) {
  const engine = vehicle.engineLabel || vehicle.engine;
  const s = vehicle.specs;

  // Build grouped spec sections, dropping anything we don't have.
  const groups: { title: string; rows: [string, string][] }[] = [];
  const addGroup = (title: string, rows: ([string, string | number | undefined])[]) => {
    const filtered = rows
      .filter(([, v]) => v !== undefined && v !== "")
      .map(([l, v]) => [l, String(v)] as [string, string]);
    if (filtered.length) groups.push({ title, rows: filtered });
  };

  if (s) {
    addGroup("Engine & oil", [
      ["Engine", engine],
      ["Oil", s.oilViscosity ? `${s.oilViscosity}${s.oilCapacityQts ? ` · ${s.oilCapacityQts} qt` : ""}` : undefined],
      ["Coolant", s.coolantType ? `${s.coolantType}${s.coolantCapacityQts ? ` · ${s.coolantCapacityQts} qt` : ""}` : undefined],
      ["Spark plugs", s.sparkPlugQty ? `${s.sparkPlugQty}${s.sparkPlugGapMm ? ` · ${s.sparkPlugGapMm} mm gap` : ""}` : undefined],
      ["Timing", s.timingSystem],
    ]);
    addGroup("Transmission & drivetrain", [
      ["Transmission", s.transmission],
      ["Trans. fluid", s.transFluidType ? `${s.transFluidType}${s.transLifetimeFill ? " (lifetime)" : ""}` : undefined],
      ["Drivetrain", s.drivetrain ?? vehicle.drivetrain],
      ["Differential", s.diffFluidType],
      ["Transfer case", s.hasTransferCase ? "Yes" : undefined],
    ]);
    addGroup("Tires & alignment", [
      ["Tire pressure", s.tirePressureFront ? `${s.tirePressureFront}${s.tirePressureRear && s.tirePressureRear !== s.tirePressureFront ? ` / ${s.tirePressureRear}` : ""} psi` : undefined],
      ["Run-flat", s.runFlat ? "Yes" : undefined],
      ["Alignment", s.alignmentType],
    ]);
    addGroup("Brakes, battery & more", [
      ["Brake fluid", s.brakeFluidType],
      ["Power steering", s.psFluidType],
      ["Battery", s.batteryGroup ? `${s.batteryGroup}${s.batteryType ? ` · ${s.batteryType}` : ""}` : undefined],
      ["Steering", s.steeringType],
      ["Parking brake", s.parkingBrakeType],
    ]);
  }

  const isRich = vehicle.configLinked && groups.length > 0;
  const packages = s?.packages ?? [];
  // Available OEM tire sizes, with a sensible fallback to the front/rear sizes.
  const tireSizes =
    s?.tireOptions && s.tireOptions.length
      ? s.tireOptions
      : [s?.tireFront, s?.staggered ? s?.tireRear : undefined].filter(
          (x): x is string => Boolean(x)
        );

  return (
    <div className={`${CARD} flex max-h-[70vh] flex-col lg:max-h-[460px]`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Car className="h-[18px] w-[18px] text-[#1a1a1a]" strokeWidth={1.6} />
          <h3 className="text-[19px] text-[#1a1a1a]" style={{ fontFamily: "var(--font-Lora)" }}>
            Your Vehicle
          </h3>
        </div>
        {vehicle.configLinked && (
          <span className="rounded-full bg-[#1a1a1a] px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-white">
            Specs on file
          </span>
        )}
      </div>

      <p
        className="mt-3 text-[24px] leading-tight text-[#1a1a1a]"
        style={{ fontFamily: "var(--font-Lora)" }}
      >
        {vehicle.label}
      </p>
      {isRich && (
        <p className="mt-1 flex items-center gap-1.5 text-[11px] text-[#1a1a1a]/45">
          <Sparkles className="h-3 w-3" /> Otopair vehicle intelligence
        </p>
      )}

      {/* Scrollable spec area — capped so the card always fits the screen. */}
      <div className="my-3 min-h-0 flex-1 space-y-4 overflow-y-auto pr-1 [scrollbar-width:thin]">
        {isRich ? (
          <>
            {groups.map((g) => (
              <div key={g.title}>
                <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#1a1a1a]/40">
                  {g.title}
                </p>
                <div className="space-y-1.5">
                  {g.rows.map(([label, value]) => (
                    <SpecRow key={label} label={label} value={value} />
                  ))}
                </div>
              </div>
            ))}
            {tireSizes.length > 0 && (
              <div>
                <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#1a1a1a]/40">
                  Available tire sizes
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {tireSizes.map((t) => (
                    <span
                      key={t}
                      className="rounded-lg bg-[#1a1a1a]/[0.05] px-2.5 py-1 font-mono text-[12px] text-[#1a1a1a]"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {packages.length > 0 && (
              <div>
                <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#1a1a1a]/40">
                  Factory packages
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {packages.map((p) => (
                    <span
                      key={p}
                      className="rounded-lg bg-[#1a1a1a]/[0.05] px-2.5 py-1 text-[12px] text-[#1a1a1a]"
                    >
                      {p}
                    </span>
                  ))}
                </div>
              </div>
            )}
            <SpecRow label="VIN" value={vehicle.vin} mono />
          </>
        ) : (
          // NHTSA-only fallback (no config on file).
          <div className="space-y-1.5">
            {engine && <SpecRow label="Engine" value={engine} />}
            {vehicle.drivetrain && <SpecRow label="Drivetrain" value={vehicle.drivetrain} />}
            {vehicle.bodyClass && <SpecRow label="Body" value={vehicle.bodyClass} />}
            <SpecRow label="VIN" value={vehicle.vin} mono />
          </div>
        )}
      </div>

      <PrimaryButton onClick={onContinue}>Find shops nearby</PrimaryButton>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 1. Instant Scheduling                                               */
/* ------------------------------------------------------------------ */
export function SchedulingCard({ onConfirm }: { onConfirm: () => void }) {
  return (
    <div className={CARD}>
      <div className="flex items-center gap-2">
        <Calendar className="h-[18px] w-[18px] text-[#1a1a1a]" strokeWidth={1.6} />
        <h3 className="text-[19px] text-[#1a1a1a]" style={{ fontFamily: "var(--font-Lora)" }}>
          Instant Scheduling
        </h3>
      </div>
      <p className="mt-1 text-[12px] text-[#1a1a1a]/45">Secured with fixed pricing</p>

      <div className="my-5">
        <WeekStrip />
      </div>

      <div className="flex items-center justify-between rounded-xl bg-[#1a1a1a]/[0.04] px-4 py-3">
        <span className="flex items-center gap-2 text-[14px] text-[#1a1a1a]">
          <Car className="h-4 w-4 text-[#1a1a1a]/70" strokeWidth={1.6} />
          {SCHEDULING_PREVIEW.service}
        </span>
        <span className="text-[14px] font-medium text-[#1a1a1a]">
          {usd(SCHEDULING_PREVIEW.price)}.00
        </span>
      </div>
      <div className="mt-2 flex items-center justify-between rounded-xl bg-[#1a1a1a]/[0.04] px-4 py-3">
        <span className="flex items-center gap-2 text-[14px] text-[#1a1a1a]">
          <MapPin className="h-4 w-4 text-[#1a1a1a]/70" strokeWidth={1.6} />
          {SCHEDULING_PREVIEW.shop}
        </span>
        <span className="text-[13px] text-[#1a1a1a]/50">{SCHEDULING_PREVIEW.distance}</span>
      </div>

      <PrimaryButton onClick={onConfirm}>Confirm Appointment</PrimaryButton>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 2. Choose a Shop                                                    */
/* ------------------------------------------------------------------ */
export function ChooseShopCard({
  shops,
  selectedId,
  onSelect,
  onContinue,
}: {
  shops: Shop[];
  selectedId?: string;
  onSelect: (shop: Shop) => void;
  onContinue: (shop: Shop) => void;
}) {
  const active = shops.find((s) => s.id === selectedId) ?? shops[0];
  const firstName = active?.name.split(" ")[0] ?? "Shop";

  return (
    <div className={CARD}>
      <div className="flex items-center gap-2">
        <MapPin className="h-[18px] w-[18px] text-[#1a1a1a]" strokeWidth={1.6} />
        <h3 className="text-[19px] text-[#1a1a1a]" style={{ fontFamily: "var(--font-Lora)" }}>
          Choose a Shop
        </h3>
      </div>
      <p className="mt-1 text-[12px] text-[#1a1a1a]/45">3 found nearby · Best price first</p>

      <div className="mt-4 space-y-2">
        {shops.map((shop) => {
          const isActive = shop.id === active?.id;
          return (
            <button
              key={shop.id}
              type="button"
              onClick={() => onSelect(shop)}
              className={`relative w-full rounded-xl px-4 py-3 text-left transition-colors ${
                isActive
                  ? "bg-[#1a1a1a]/[0.06] ring-1 ring-[#1a1a1a]/15"
                  : "bg-[#1a1a1a]/[0.03] hover:bg-[#1a1a1a]/[0.05]"
              }`}
            >
              {shop.bestValue && (
                <span className="absolute -top-2 left-3 rounded-full bg-[#1a1a1a] px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-white">
                  Best value
                </span>
              )}
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-[14px] font-medium text-[#1a1a1a]">{shop.name}</p>
                  <p className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-[#1a1a1a]/50">
                    <span>{shop.distance}</span>
                    <span>·</span>
                    <span className="inline-flex items-center gap-0.5">
                      <Star className="h-3 w-3 fill-current text-[#1a1a1a]/60" />
                      {shop.rating}
                    </span>
                    <span>·</span>
                    <span>{shop.eta}</span>
                  </p>
                </div>
                <span className="text-[15px] font-medium text-[#1a1a1a]">{usd(shop.price)}</span>
              </div>
            </button>
          );
        })}
      </div>

      <PrimaryButton onClick={() => active && onContinue(active)}>
        Continue with {firstName}
      </PrimaryButton>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 3. Date & Time                                                      */
/* ------------------------------------------------------------------ */
export function DateTimeCard({
  slots,
  selectedId,
  onSelect,
  onConfirm,
}: {
  slots: Slot[];
  selectedId?: string;
  onSelect: (slot: Slot) => void;
  onConfirm: () => void;
}) {
  return (
    <div className={CARD}>
      <div className="flex items-center gap-2">
        <Calendar className="h-[18px] w-[18px] text-[#1a1a1a]" strokeWidth={1.6} />
        <h3 className="text-[19px] text-[#1a1a1a]" style={{ fontFamily: "var(--font-Lora)" }}>
          Instant Scheduling
        </h3>
      </div>
      <p className="mt-1 text-[12px] text-[#1a1a1a]/45">Secured with fixed pricing</p>

      <div className="my-5">
        <WeekStrip />
      </div>

      <div className="grid grid-cols-2 gap-2">
        {slots.map((slot) => {
          const isActive = slot.id === selectedId;
          return (
            <button
              key={slot.id}
              type="button"
              disabled={slot.disabled}
              onClick={() => onSelect(slot)}
              className={`h-11 rounded-xl text-[13.5px] font-medium transition-colors ${
                slot.disabled
                  ? "cursor-not-allowed bg-[#1a1a1a]/[0.03] text-[#1a1a1a]/25"
                  : isActive
                    ? "bg-[#1a1a1a] text-white"
                    : "bg-[#1a1a1a]/[0.04] text-[#1a1a1a] hover:bg-[#1a1a1a]/[0.07]"
              }`}
            >
              {slot.label}
            </button>
          );
        })}
      </div>

      <PrimaryButton onClick={onConfirm}>Confirm Appointment</PrimaryButton>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 4. Booking Confirmed                                                */
/* ------------------------------------------------------------------ */
function StoreButton({ store }: { store: "apple" | "google" }) {
  return (
    <a
      href="#get-oto"
      className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-[#1a1a1a] px-3 py-2.5 text-white transition-transform hover:scale-[1.02]"
    >
      {store === "apple" ? (
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden>
          <path d="M16.365 1.43c0 1.14-.42 2.21-1.18 3.02-.81.86-2.13 1.52-3.21 1.43-.13-1.1.42-2.27 1.13-3.01.79-.84 2.18-1.46 3.26-1.44zM20.5 17.2c-.55 1.27-.82 1.83-1.53 2.95-.99 1.57-2.39 3.53-4.12 3.54-1.54.02-1.93-.99-4.02-.98-2.09.01-2.52.99-4.06.98-1.73-.02-3.05-1.78-4.04-3.35C-.07 16.1-.34 11.36 1.4 8.95c1.06-1.46 2.74-2.32 4.32-2.32 1.6 0 2.61 1 3.93 1 1.28 0 2.06-1 3.91-1 1.4 0 2.89.76 3.94 2.08-3.46 1.9-2.9 6.85.99 8.49z" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden>
          <path d="M3.6 1.8 13.4 12 3.6 22.2c-.4-.2-.6-.6-.6-1.1V2.9c0-.5.2-.9.6-1.1zM15 13.6l2.6 2.7-9.9 5.7 7.3-8.4zm0-3.2L7.7 2l9.9 5.7L15 10.4zm1.5 1.6 3.2-1.9c.6-.4.6-1.4 0-1.8l-2.6-1.5L15 12l1.5 1.6z" />
        </svg>
      )}
      <span className="text-left leading-tight">
        <span className="block text-[8px] uppercase opacity-80">
          {store === "apple" ? "Download on the" : "Get it on"}
        </span>
        <span className="block text-[13px] font-medium">
          {store === "apple" ? "App Store" : "Google Play"}
        </span>
      </span>
    </a>
  );
}

export function BookingConfirmedCard({
  booking,
  onSavePreSignup,
  saved = false,
}: {
  booking: Booking;
  onSavePreSignup?: (email: string) => void;
  saved?: boolean;
}) {
  const [email, setEmail] = useState("");

  return (
    <div className={CARD}>
      <div className="flex flex-col items-center">
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[#1a1a1a]">
          <Check className="h-5 w-5 text-white" strokeWidth={2.5} />
        </div>
        <h3
          className="mt-3 text-[22px] text-[#1a1a1a]"
          style={{ fontFamily: "var(--font-Lora)" }}
        >
          Booking confirmed
        </h3>
      </div>

      <div className="mt-5 border-t border-[#1a1a1a]/10 pt-4">
        <p className="text-[10px] uppercase tracking-[0.15em] text-[#1a1a1a]/40">
          Service Details
        </p>
        <div className="mt-2 flex items-start justify-between">
          <p className="text-[15px] font-medium text-[#1a1a1a]">{booking.service}</p>
          <div className="text-right text-[12px] leading-relaxed text-[#1a1a1a]/55">
            <p>{booking.shop}</p>
            <p>{booking.mechanic}</p>
          </div>
        </div>
      </div>

      <div className="mt-4 border-t border-[#1a1a1a]/10 pt-4">
        <p className="text-[10px] uppercase tracking-[0.15em] text-[#1a1a1a]/40">Logistics</p>
        <div className="mt-2 flex items-center justify-between text-[13px] text-[#1a1a1a]">
          <span>{booking.date}</span>
          <span>{booking.time}</span>
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between border-t border-[#1a1a1a]/10 pt-4">
        <span className="text-[14px] font-medium text-[#1a1a1a]">Total Amount</span>
        <span className="text-[18px] font-semibold text-[#1a1a1a]">{usd(booking.total)}</span>
      </div>

      {/* Pre-signup capture — save the car so signup is seamless. */}
      {onSavePreSignup &&
        (saved ? (
          <div className="mt-5 flex items-center justify-center gap-2 rounded-xl bg-[#1a1a1a]/[0.05] px-4 py-3 text-[13px] text-[#1a1a1a]">
            <Check className="h-4 w-4" strokeWidth={2.5} />
            Saved — your car will be waiting when you download the app.
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (email.trim()) onSavePreSignup(email.trim());
            }}
            className="mt-5"
          >
            <p className="mb-2 text-[12px] text-[#1a1a1a]/55">
              Email it to yourself & save your car for the app:
            </p>
            <div className="flex gap-2">
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@email.com"
                className="h-11 flex-1 rounded-xl border border-[#1a1a1a]/15 bg-white/70 px-3 text-[14px] text-[#1a1a1a] placeholder:text-[#1a1a1a]/40 focus:outline-none focus:ring-2 focus:ring-[#1a1a1a]/15"
                style={{ fontSize: 16 }}
              />
              <button
                type="submit"
                className="h-11 shrink-0 rounded-xl bg-[#1a1a1a] px-4 text-[13px] font-medium text-white transition-transform hover:scale-[1.02] active:scale-95"
              >
                Save
              </button>
            </div>
          </form>
        ))}

      <div className="mt-5 flex gap-2">
        <StoreButton store="apple" />
        <StoreButton store="google" />
      </div>

      <p className="mt-3 text-center text-[10px] text-[#1a1a1a]/40">
        Secure transaction via Otopair Pay
      </p>
    </div>
  );
}
