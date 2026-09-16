"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { ArrowRight, Calendar, Car, Check, Clock, MapPin, ShieldCheck, Sparkles, Star } from "lucide-react";
import { motion } from "motion/react";
import { APP_STORE_URL, PLAY_STORE_URL, storeIsLive } from "./download-app";
import { OtoCard } from "./oto-card";
import { useWaitlist } from "./waitlist-modal";
import {
  SAMPLE_JOB,
  SCHEDULING_PREVIEW,
  WEEK_DAYS,
  type Booking,
  type Shop,
  type Slot,
  type Vehicle,
} from "./oto-flow";
import { CountUp, Step } from "./shared";

const EASE = [0.22, 1, 0.36, 1] as const;

const usd = (n: number) =>
  n % 1 === 0 ? `$${n}` : `$${n.toFixed(2)}`;

function WeekStrip({ base = 0.2 }: { base?: number }) {
  return (
    <div className="flex items-center justify-between">
      {WEEK_DAYS.map((d, i) => (
        <motion.div
          key={i}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: base + i * 0.04, duration: 0.35, ease: EASE }}
          className="flex flex-col items-center gap-1.5"
        >
          <span className="text-[11px] text-[#1a1a1a]/40">{d.letter}</span>
          <motion.span
            initial={d.selected ? { scale: 0.6 } : false}
            animate={d.selected ? { scale: 1 } : {}}
            transition={{ delay: base + 0.3, type: "spring", stiffness: 500, damping: 18 }}
            className={
              d.selected
                ? "flex h-7 w-7 items-center justify-center rounded-md bg-[#1a1a1a] text-[13px] font-medium text-white"
                : "flex h-7 w-7 items-center justify-center text-[13px] text-[#1a1a1a]/70"
            }
          >
            {d.date}
          </motion.span>
        </motion.div>
      ))}
    </div>
  );
}

function PrimaryButton({
  children,
  onClick,
  delay = 0.3,
  className = "",
}: {
  children: React.ReactNode;
  onClick?: () => void;
  delay?: number;
  className?: string;
}) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay, duration: 0.5, ease: EASE }}
      whileHover={{ scale: 1.01 }}
      whileTap={{ scale: 0.985 }}
      className={`flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-[#1a1a1a] text-[13px] font-semibold uppercase tracking-[0.08em] text-white shadow-sm transition-colors hover:bg-[#5299fe] ${className}`}
    >
      {children}
    </motion.button>
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
    // Height, scrolling and the fade at the cut come from OtoCard. This card
    // was the only one of 24 that fit the panel properly; the shell now does
    // that for all of them.
    <OtoCard
      icon={Car}
      title="Your Vehicle"
      aside={
        vehicle.configLinked ? (
          <motion.span
            initial={{ opacity: 0, scale: 0.7 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.4, type: "spring", stiffness: 500, damping: 18 }}
            className="rounded-full bg-[#1a1a1a] px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-white"
          >
            Specs on file
          </motion.span>
        ) : null
      }
      footer={<PrimaryButton onClick={onContinue}>Find shops nearby</PrimaryButton>}
    >

      <Step delay={0.14}>
        <p
          className="mt-3 text-[24px] leading-tight text-[#1a1a1a]"
          style={{ fontFamily: "var(--font-Petrona)" }}
        >
          {vehicle.label}
        </p>
        {isRich && (
          <p className="mt-1 flex items-center gap-1.5 text-[11px] text-[#1a1a1a]/45">
            <Sparkles className="h-3 w-3" /> Otopair vehicle intelligence
          </p>
        )}
      </Step>

      <div className="my-3 space-y-4">
        {isRich ? (
          <>
            {groups.map((g, gi) => (
              <Step key={g.title} delay={0.24 + gi * 0.1}>
                <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-[#1a1a1a]/40">
                  {g.title}
                </p>
                <div className="space-y-1.5">
                  {g.rows.map(([label, value]) => (
                    <SpecRow key={label} label={label} value={value} />
                  ))}
                </div>
              </Step>
            ))}
            {tireSizes.length > 0 && (
              <Step delay={0.24 + groups.length * 0.1}>
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
              </Step>
            )}
            {packages.length > 0 && (
              <Step delay={0.24 + (groups.length + 1) * 0.1}>
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
              </Step>
            )}
            <Step delay={0.24 + (groups.length + 2) * 0.1}>
              <SpecRow label="VIN" value={vehicle.vin} mono />
            </Step>
          </>
        ) : (
          // NHTSA-only fallback (no config on file).
          <div className="space-y-1.5">
            {engine && (
              <Step delay={0.24}>
                <SpecRow label="Engine" value={engine} />
              </Step>
            )}
            {vehicle.drivetrain && (
              <Step delay={0.32}>
                <SpecRow label="Drivetrain" value={vehicle.drivetrain} />
              </Step>
            )}
            {vehicle.bodyClass && (
              <Step delay={0.4}>
                <SpecRow label="Body" value={vehicle.bodyClass} />
              </Step>
            )}
            <Step delay={0.48}>
              <SpecRow label="VIN" value={vehicle.vin} mono />
            </Step>
          </div>
        )}
      </div>
    </OtoCard>
  );
}

/* ------------------------------------------------------------------ */
/* 1. Scheduling (sample)                                              */
/* ------------------------------------------------------------------ */
export function SchedulingCard({ onConfirm }: { onConfirm: () => void }) {
  return (
    <OtoCard
      icon={Calendar}
      title="Pick a time"
      subtitle="Sample · how scheduling looks in the app"
      footer={
        <PrimaryButton onClick={onConfirm} delay={0.58}>
          Confirm Appointment
        </PrimaryButton>
      }
    >
      <div className="my-3">
        <WeekStrip base={0.18} />
      </div>

      <Step delay={0.42} className="flex items-center justify-between rounded-xl bg-[#1a1a1a]/[0.04] px-3.5 py-2.5">
        <span className="flex items-center gap-2 text-[13.5px] text-[#1a1a1a]">
          <Car className="h-4 w-4 text-[#1a1a1a]/70" strokeWidth={1.6} />
          {SCHEDULING_PREVIEW.service}
        </span>
        <span className="text-[13.5px] font-medium text-[#1a1a1a]">
          {usd(SCHEDULING_PREVIEW.price)}.00
        </span>
      </Step>
      <Step delay={0.5} className="mt-2 flex items-center justify-between rounded-xl bg-[#1a1a1a]/[0.04] px-3.5 py-2.5">
        <span className="flex items-center gap-2 text-[13.5px] text-[#1a1a1a]">
          <MapPin className="h-4 w-4 text-[#1a1a1a]/70" strokeWidth={1.6} />
          {SCHEDULING_PREVIEW.shop}
        </span>
        <span className="text-[12.5px] text-[#1a1a1a]/50">{SCHEDULING_PREVIEW.distance}</span>
      </Step>
    </OtoCard>
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
    <OtoCard
      icon={MapPin}
      title="Choose a Shop"
      subtitle="Verified Independent Shops · Staten Island, NY"
      footer={
        <PrimaryButton
          onClick={() => active && onContinue(active)}
          delay={0.16 + shops.length * 0.1 + 0.08}
        >
          Continue with {firstName}
        </PrimaryButton>
      }
    >
      <div className="mt-2.5 space-y-2">
        {shops.map((shop, i) => {
          const isActive = shop.id === active?.id;
          return (
            <motion.button
              key={shop.id}
              type="button"
              onClick={() => onSelect(shop)}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.16 + i * 0.08, duration: 0.4, ease: EASE }}
              whileHover={{ scale: 1.01 }}
              whileTap={{ scale: 0.99 }}
              className={`relative w-full rounded-xl px-3.5 py-2.5 text-left transition-all ${
                isActive
                  ? "bg-[#5299fe]/[0.08] ring-2 ring-[#5299fe] shadow-sm"
                  : "bg-[#1a1a1a]/[0.03] hover:bg-[#1a1a1a]/[0.06] ring-1 ring-black/[0.04]"
              }`}
            >
              <div className="flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <p className="text-[14px] font-medium text-[#1a1a1a]">{shop.name}</p>
                    <span className="inline-flex items-center gap-1 rounded-full bg-[#10b981]/10 px-2 py-0.5 text-[9.5px] font-medium text-[#059669]">
                      <ShieldCheck className="h-3 w-3" /> Verified
                    </span>
                  </div>
                  <p className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-[#1a1a1a]/55">
                    <span>{shop.distance}</span>
                    <span>·</span>
                    <span className="inline-flex items-center gap-1">
                      <Star className="h-3 w-3 fill-amber-400 text-amber-500" />
                      <span className="font-medium text-[#1a1a1a]">{shop.rating}</span>
                    </span>
                    <span>·</span>
                    <span className="inline-flex items-center gap-1 font-medium text-[#5299fe]">
                      <Clock className="h-3 w-3" /> {shop.eta}
                    </span>
                  </p>
                </div>
                <div className="text-right">
                  <span className="block text-[9.5px] uppercase tracking-wider text-[#1a1a1a]/40 font-semibold">Locked price</span>
                  <CountUp
                    to={shop.price}
                    prefix="$"
                    duration={0.8}
                    className="text-[15px] font-semibold text-[#1a1a1a]"
                  />
                </div>
              </div>
            </motion.button>
          );
        })}
      </div>

      <Step delay={0.16 + shops.length * 0.1}>
        <div className="mt-2 flex items-center justify-between rounded-xl bg-white/60 px-3 py-2 ring-1 ring-black/[0.05]">
          <p className="text-[11px] leading-relaxed text-[#1a1a1a]/60">
            All prices locked upfront for a {SAMPLE_JOB}. Includes parts, labor, taxes & fees with zero surprise add-ons.
          </p>
        </div>
      </Step>

      <div className="mt-2 text-center">
        <Link
          href="/shops"
          className="inline-flex items-center gap-1 text-[12px] font-medium text-[#5299fe] transition-colors hover:text-[#3d87ef]"
        >
          Browse all verified Staten Island shops <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>
    </OtoCard>
  );
}

/* ------------------------------------------------------------------ */
/* 3. Date & Time (sample)                                             */
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
    <OtoCard
      icon={Calendar}
      title="Pick a time"
      subtitle="Sample times · how the app shows open slots"
      footer={
        <PrimaryButton onClick={onConfirm} delay={0.42 + slots.length * 0.07 + 0.08}>
          Confirm Appointment
        </PrimaryButton>
      }
    >
      <div className="my-3">
        <WeekStrip base={0.18} />
      </div>

      <div className="grid grid-cols-2 gap-2">
        {slots.map((slot, i) => {
          const isActive = slot.id === selectedId;
          return (
            <motion.button
              key={slot.id}
              type="button"
              disabled={slot.disabled}
              onClick={() => onSelect(slot)}
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: 0.42 + i * 0.07, duration: 0.4, ease: EASE }}
              whileHover={slot.disabled ? undefined : { scale: 1.02 }}
              whileTap={slot.disabled ? undefined : { scale: 0.97 }}
              className={`h-10 rounded-xl text-[13px] font-medium transition-colors ${
                slot.disabled
                  ? "cursor-not-allowed bg-[#1a1a1a]/[0.03] text-[#1a1a1a]/25"
                  : isActive
                    ? "bg-[#1a1a1a] text-white"
                    : "bg-[#1a1a1a]/[0.04] text-[#1a1a1a] hover:bg-[#1a1a1a]/[0.07]"
              }`}
            >
              {slot.label}
            </motion.button>
          );
        })}
      </div>
    </OtoCard>
  );
}

/* ------------------------------------------------------------------ */
/* 4. Booking Confirmed                                                */
/* ------------------------------------------------------------------ */
const STORE_BUTTON_CLASS =
  "flex flex-1 items-center justify-center gap-2 rounded-xl bg-[#1a1a1a] px-3 py-2.5 text-white";
const STORE_BUTTON_MOTION = {
  whileHover: { y: -2, scale: 1.03 },
  whileTap: { scale: 0.97 },
  transition: { type: "spring", stiffness: 400, damping: 20 },
} as const;

function StoreButton({ store }: { store: "apple" | "google" }) {
  const { open } = useWaitlist();
  const url = store === "apple" ? APP_STORE_URL : PLAY_STORE_URL;
  const label = <StoreButtonLabel store={store} />;
  // Same launch flag as every other store control on the site: a real store
  // link once the listing exists, and until then a button that opens the
  // launch-list modal — never a dead "#" link (site audit 2026-08-31).
  if (storeIsLive(url)) {
    return (
      <motion.a href={url} target="_blank" rel="noopener noreferrer" className={STORE_BUTTON_CLASS} {...STORE_BUTTON_MOTION}>
        {label}
      </motion.a>
    );
  }
  return (
    <motion.button type="button" onClick={() => open()} className={STORE_BUTTON_CLASS} {...STORE_BUTTON_MOTION}>
      {label}
    </motion.button>
  );
}

function StoreButtonLabel({ store }: { store: "apple" | "google" }) {
  return (
    <>
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
    </>
  );
}

export function BookingConfirmedCard({
  booking,
  vehicle,
  onSavePreSignup,
  saved = false,
}: {
  booking: Booking;
  vehicle?: Vehicle | null;
  onSavePreSignup?: (email: string) => void;
  saved?: boolean;
}) {
  const [email, setEmail] = useState("");
  const [vehicleImg, setVehicleImg] = useState<string | null>(vehicle?.imageUrl ?? null);
  const carName = vehicle?.label || "Your Vehicle";

  useEffect(() => {
    if (vehicle?.imageUrl) {
      setVehicleImg(vehicle.imageUrl);
      return;
    }
    if (!vehicle?.label && !vehicle?.vin) return;

    let cancelled = false;
    const params = new URLSearchParams();
    if (vehicle.vin && !vehicle.vin.startsWith("ONBOARDING-")) {
      params.set("vin", vehicle.vin);
    }
    if (vehicle.label) {
      params.set("car", vehicle.label);
    }
    if (vehicle.year) params.set("year", String(vehicle.year));
    if (vehicle.make) params.set("make", vehicle.make);
    if (vehicle.model) params.set("model", vehicle.model);

    fetch(`/api/vehicle-image?${params.toString()}`)
      .then((r) => (r.ok ? r.json() : Promise.resolve({ imageUrl: null })))
      .then((d) => {
        if (!cancelled && d?.imageUrl) {
          setVehicleImg(d.imageUrl);
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [vehicle]);

  return (
    <OtoCard
      header={
        <div className="flex flex-col items-center">
          <motion.div
            initial={{ scale: 0, rotate: -25 }}
            animate={{ scale: 1, rotate: 0 }}
            transition={{ type: "spring", stiffness: 420, damping: 15, delay: 0.1 }}
            className="relative flex h-10 w-10 items-center justify-center rounded-full bg-[#10b981] shadow-md shadow-emerald-500/20"
          >
            <Check className="h-5 w-5 text-white" strokeWidth={2.5} />
            <motion.span
              aria-hidden
              className="absolute inset-0 rounded-full ring-2 ring-[#10b981]/40"
              initial={{ scale: 1, opacity: 0.6 }}
              animate={{ scale: 1.9, opacity: 0 }}
              transition={{ duration: 0.9, ease: "easeOut", delay: 0.18 }}
            />
          </motion.div>
          <Step delay={0.3}>
            <h3
              className="mt-3 text-center text-[22px] font-medium tracking-tight text-[#1a1a1a]"
              style={{ fontFamily: "var(--font-Petrona)" }}
            >
              Vehicle Matched
            </h3>
            <p className="mt-1 text-center text-[12px] text-[#1a1a1a]/60">
              Link your vehicle to view live, locked upfront pricing in the app
            </p>
          </Step>
        </div>
      }
    >
      {/* Vehicle Hero Card with Live Vehicle Database Render or Covered Car Fallback */}
      <Step delay={0.4} className="mt-2.5 overflow-hidden rounded-2xl border border-[#5299fe]/20 bg-gradient-to-b from-[#f0f6fe] via-white to-[#f0f6fe] p-3 text-center shadow-sm">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={vehicleImg || "/images/landing/app/covered-car.png"}
          alt={carName}
          className="mx-auto h-[65px] w-auto max-w-full object-contain drop-shadow-md transition-transform duration-300 hover:scale-105"
        />
        <p
          className="mt-1 text-[17px] font-bold leading-tight text-[#1a1a1a]"
          style={{ fontFamily: "var(--font-Petrona)" }}
        >
          {carName}
        </p>
        <div className="mt-1 flex items-center justify-center gap-1.5 flex-wrap">
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 border border-emerald-200/60 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
            <ShieldCheck className="h-3 w-3" /> Specs Identified
          </span>
          {booking.service && (
            <span className="inline-flex items-center gap-1 rounded-full bg-[#5299fe]/10 border border-[#5299fe]/20 px-2 py-0.5 text-[10px] font-medium text-[#5299fe]">
              {booking.service}
            </span>
          )}
        </div>
      </Step>

      {/* Value pillars - 100% truthful, no premature price locks */}
      <Step delay={0.5} className="mt-2 grid grid-cols-2 gap-2">
        <div className="flex items-center gap-2 rounded-xl bg-black/[0.03] px-2.5 py-1.5 text-left">
          <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-lg bg-[#5299fe]/10 text-[#5299fe]">
            <ShieldCheck className="h-3 w-3" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-[11px] font-semibold text-[#1a1a1a]">Locked Upfront</p>
            <p className="truncate text-[10px] text-[#1a1a1a]/60">Parts & labor included</p>
          </div>
        </div>
        <div className="flex items-center gap-2 rounded-xl bg-black/[0.03] px-2.5 py-1.5 text-left">
          <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600">
            <MapPin className="h-3 w-3" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-[11px] font-semibold text-[#1a1a1a]">Verified NYC Shops</p>
            <p className="truncate text-[10px] text-[#1a1a1a]/60">Insured mechanics</p>
          </div>
        </div>
      </Step>

      {/* Pre-signup capture — save the car so signup is seamless */}
      {onSavePreSignup &&
        (saved ? (
          <Step delay={0.65} className="mt-2.5 flex items-center justify-center gap-2 rounded-xl bg-[#10b981]/10 p-2.5 text-[12px] font-medium text-[#059669]">
            <Check className="h-3.5 w-3.5" strokeWidth={2.5} />
            Vehicle saved! Download the app below to view live pricing.
          </Step>
        ) : (
          <Step delay={0.65} className="mt-2.5">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (email.trim()) onSavePreSignup(email.trim());
              }}
              className="rounded-xl bg-white/70 p-2.5 ring-1 ring-black/[0.05]"
            >
              <p className="mb-1.5 text-[11.5px] font-medium text-[#1a1a1a]/70">
                Enter your email to link your vehicle to the app:
              </p>
              <div className="flex gap-2">
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="name@example.com"
                  className="h-9 flex-1 rounded-lg border border-black/10 bg-white px-2.5 text-[13px] text-[#1a1a1a] placeholder:text-[#1a1a1a]/40 focus:outline-none focus:ring-2 focus:ring-[#5299fe]/30"
                  style={{ fontSize: 16 }}
                />
                <motion.button
                  type="submit"
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.96 }}
                  className="h-9 shrink-0 rounded-lg bg-[#5299fe] px-3.5 text-[12px] font-medium text-white shadow-sm transition-colors hover:bg-[#3d87ef]"
                >
                  Continue
                </motion.button>
              </div>
            </form>
          </Step>
        ))}

      <Step delay={0.75} className="mt-2.5 flex gap-2">
        <StoreButton store="apple" />
        <StoreButton store="google" />
      </Step>

      <Step delay={0.85}>
        <p className="mt-2 text-center text-[10px] text-[#1a1a1a]/50">
          Complete your onboarding in the Otopair app to explore verified shop prices with zero hidden fees
        </p>
      </Step>
    </OtoCard>
  );
}

export const VehicleSignupCard = BookingConfirmedCard;
