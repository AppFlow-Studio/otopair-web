"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowLeft,
  ArrowRight,
  BatteryFull,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Clock,
  Disc,
  Droplet,
  Filter,
  HelpCircle,
  Info,
  ListChecks,
  Plus,
  Receipt,
  Wrench,
  X,
} from "lucide-react";
import PhoneFrame from "./phone-frame";

const EASE = [0.22, 1, 0.36, 1] as const;

const C = {
  blue: "#5299FE",
  ink: "#1F2937",
  meta: "#6B7280",
  dim: "#9CA3AF",
  red: "#EF4444",
  green: "#30D158",
  yellow: "#FFEA00",
};

type DrvPhase =
  | "cars"
  | "sheet"
  | "shift"
  | "hurting"
  | "closesheet"
  | "detailpress"
  | "detail"
  | "bookpress"
  | "picker";

const DRV_ORDER: DrvPhase[] = [
  "cars",
  "sheet",
  "shift",
  "hurting",
  "closesheet",
  "detailpress",
  "detail",
  "bookpress",
  "picker",
];

const DRV_CAPTIONS: Record<DrvPhase, string> = {
  cars: "Everything your car needs — one screen.",
  sheet: "A live health score for your exact car.",
  shift: "It updates with your car — in real time.",
  hurting: "It updates with your car — in real time.",
  closesheet: "Urgent work surfaces itself.",
  detailpress: "Every recommendation, explained in plain English.",
  detail: "Every recommendation, explained in plain English.",
  bookpress: "Booking drops it straight into your cart.",
  picker: "Booking drops it straight into your cart.",
};

/** rAF number tween — drives the score climb on sheet open and the live
 *  drop while it's up. `from` seeds the very first animation (e.g. 0→81). */
function useTween(target: number, ms: number, animate: boolean, from?: number) {
  const [v, setV] = useState(animate && from !== undefined ? from : target);
  const prev = useRef(animate && from !== undefined ? from : target);
  useEffect(() => {
    if (!animate) {
      prev.current = target;
      setV(target);
      return;
    }
    const from = prev.current;
    if (from === target) return;
    const t0 = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / ms);
      const e = 1 - Math.pow(1 - p, 3);
      setV(Math.round(from + (target - from) * e));
      if (p < 1) raf = requestAnimationFrame(tick);
      else prev.current = target;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms, animate]);
  return v;
}

function Ripple() {
  return (
    <motion.span
      className="pointer-events-none absolute left-1/2 top-1/2 z-10 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#1a1a1a]/15"
      initial={{ scale: 0.3, opacity: 0.6 }}
      animate={{ scale: 2.2, opacity: 0 }}
      transition={{ duration: 0.5, ease: "easeOut" }}
    />
  );
}

/* The app's health color coding: ≥75 green, ≥60 yellow, else red. */
const scoreColor = (s: number) => (s >= 75 ? C.green : s >= 60 ? C.yellow : "#FF3B30");

const TRACKER_OK = [
  { icon: Disc, name: "Brakes", sub: "49,500 mi remaining · In good standing" },
  { icon: CircleDot, name: "Tires", sub: "In good standing" },
  { icon: BatteryFull, name: "Battery", sub: "In good standing" },
];

/** My Cars — the single home base of the story. Ring + Maintenance Tracker;
 *  after the live score drop, the red NOW section with the urgent oil-change
 *  card takes over the tracker. */
function CarsScreen({ phase, score, reduce }: { phase: DrvPhase; score: number; reduce: boolean }) {
  const idx = DRV_ORDER.indexOf(phase);
  const at = (p: DrvPhase) => idx >= DRV_ORDER.indexOf(p);
  const alerted = at("closesheet");
  const R = 12;
  const CIRC = 2 * Math.PI * R;
  const col = scoreColor(score);

  return (
    <div className="absolute inset-0" style={{ backgroundColor: "#d3e5f4" }}>
      <div className="relative flex h-full flex-col px-2.5 pt-[24px]">
        {/* Header */}
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1">
            <span
              className="flex h-[16px] w-[16px] items-center justify-center rounded-full text-[5.5px] font-semibold text-white"
              style={{ background: "linear-gradient(135deg, #5299FE, #C5DAFF)" }}
            >
              DR
            </span>
            <span className="flex items-center gap-0.5 rounded-full bg-white/60 px-1.5 py-0.5 text-[6px] font-semibold" style={{ color: C.ink }}>
              Work
              <ChevronDown className="h-[6px] w-[6px]" style={{ color: C.meta }} />
            </span>
          </span>
          <Info className="h-[9px] w-[9px]" style={{ color: C.meta }} strokeWidth={2} />
        </div>

        {/* Covered-car hero */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/images/landing/app/covered-car.png" alt="" className="mx-auto mt-1 h-[70px] w-auto object-contain" />
        <p className="text-center text-[10px] font-bold leading-tight" style={{ color: C.ink }}>
          Audi Q5
        </p>
        <p className="text-center text-[6.5px]" style={{ color: C.meta }}>
          41,000 mi&nbsp;&nbsp;|&nbsp;&nbsp;2020
        </p>

        {/* Thumbnails + live ring */}
        <div className="mt-1 flex items-center justify-between">
          <span className="flex items-center gap-1 rounded-[9px] bg-white/70 px-1.5 py-1">
            {[0, 1].map((i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={i} src="/images/landing/app/covered-car.png" alt="" className="h-[10px] w-[16px] object-contain" style={{ opacity: i === 1 ? 1 : 0.55 }} />
            ))}
            <span className="flex h-[12px] w-[12px] items-center justify-center rounded-full border border-black/25">
              <Plus className="h-[7px] w-[7px] text-black/60" strokeWidth={2} />
            </span>
          </span>
          <span className="relative h-[34px] w-[34px]">
            <svg width="34" height="34" viewBox="0 0 34 34" className="-rotate-90">
              <circle cx="17" cy="17" r={R} stroke={col} strokeOpacity="0.2" strokeWidth="4.5" fill="none" />
              <circle
                cx="17"
                cy="17"
                r={R}
                stroke={col}
                strokeWidth="4.5"
                fill="none"
                strokeLinecap="round"
                strokeDasharray={CIRC}
                strokeDashoffset={CIRC * (1 - score / 100)}
              />
            </svg>
            <span className="absolute inset-0 flex items-center justify-center text-[7px] font-bold" style={{ color: C.ink }}>
              {score}%
            </span>
          </span>
        </div>

        {/* Maintenance Tracker */}
        <div className="mt-1.5 flex items-center justify-between">
          <span className="text-[8.5px] font-bold" style={{ color: C.ink }}>
            Maintenance Tracker
          </span>
          <span className="rounded-full bg-white px-1.5 py-0.5 text-[6px] font-medium" style={{ color: C.ink }}>
            Update Info
          </span>
        </div>

        {/* NOW section — pops in after the live score drop */}
        <AnimatePresence initial={false}>
          {alerted && (
            <motion.div
              key="now"
              initial={{ opacity: 0, y: 12, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0 }}
              transition={{ type: "spring", stiffness: 300, damping: 26 }}
            >
              <span className="mt-1 flex items-center gap-1">
                <span className="h-[5px] w-[5px] rounded-full" style={{ backgroundColor: C.red }} />
                <span className="text-[6px] font-bold tracking-[0.08em]" style={{ color: C.red }}>
                  NOW
                </span>
              </span>
              <div className="mt-1 rounded-[10px] bg-white p-2 shadow-sm">
                <div className="flex items-start gap-1.5">
                  <span className="flex h-[16px] w-[16px] shrink-0 items-center justify-center rounded-[5px]" style={{ backgroundColor: "#5299FE1A" }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src="/images/landing/app/oilchangeicon.png" alt="" className="h-[11px] w-[11px] object-contain" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[7.5px] font-bold" style={{ color: C.ink }}>
                      Oil Change
                    </span>
                    <span className="block text-[6px] leading-snug" style={{ color: C.meta }}>
                      Oil pressure warning light active — service urgently needed
                    </span>
                  </span>
                  <span className="shrink-0 rounded-[5px] px-1 py-0.5 text-[6px] font-bold" style={{ backgroundColor: "#DCFCE7", color: "#16A34A" }}>
                    +15%
                  </span>
                </div>
                <div className="mt-1.5 flex gap-1.5">
                  <span className="flex-1 rounded-full py-1 text-center text-[6.5px] font-semibold text-white" style={{ backgroundColor: C.blue }}>
                    Book Service
                  </span>
                  <span className="relative flex-1">
                    <motion.span
                      className="block rounded-full py-1 text-center text-[6.5px] font-semibold"
                      style={{ backgroundColor: "#EEF1F4", color: C.ink }}
                      animate={{ scale: phase === "detailpress" ? 0.94 : 1 }}
                      transition={{ duration: 0.18, ease: EASE }}
                    >
                      View Details
                    </motion.span>
                    {phase === "detailpress" && <Ripple />}
                  </span>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* HEALTHY section */}
        <span className="mt-1.5 flex items-center gap-1">
          <span className="h-[5px] w-[5px] rounded-full" style={{ backgroundColor: C.green }} />
          <span className="text-[6px] font-bold tracking-[0.08em]" style={{ color: C.green }}>
            HEALTHY
          </span>
        </span>
        <div className="mt-1 space-y-0 rounded-[10px] bg-white p-1 shadow-sm">
          {(alerted ? TRACKER_OK : [{ icon: Droplet, name: "Oil Change", sub: "3 months remaining" }, ...TRACKER_OK]).map((t) => (
            <div key={t.name} className="flex items-center gap-1.5 px-1 py-[3.5px]">
              <span className="flex h-[13px] w-[13px] items-center justify-center rounded-[4px]" style={{ backgroundColor: "#5299FE1A" }}>
                <t.icon className="h-[7px] w-[7px]" style={{ color: C.blue }} strokeWidth={2} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[6.5px] font-semibold" style={{ color: C.ink }}>
                  {t.name}
                </span>
                <span className="block truncate text-[5.5px]" style={{ color: C.meta }}>
                  {t.sub}
                </span>
              </span>
              <span className="flex h-[10px] w-[10px] items-center justify-center rounded-full" style={{ backgroundColor: C.blue }}>
                <Check className="h-[6px] w-[6px] text-white" strokeWidth={3} />
              </span>
            </div>
          ))}
        </div>

        {/* Service History */}
        <p className="mt-1.5 text-[8.5px] font-bold" style={{ color: C.ink }}>
          Service History
        </p>
        <div
          className="mt-1 rounded-[8px] border border-dashed bg-white/40 py-1 text-center text-[6px] font-semibold"
          style={{ borderColor: "#9CC1F7", color: C.blue }}
        >
          + Add Service History
        </div>
        <div className="mt-1.5 flex flex-col items-center rounded-[10px] bg-white px-3 py-2 shadow-sm">
          <span className="flex h-[16px] w-[16px] items-center justify-center rounded-[5px]" style={{ backgroundColor: "#5299FE1A" }}>
            <Receipt className="h-[9px] w-[9px]" style={{ color: C.blue }} strokeWidth={2} />
          </span>
          <span className="mt-1 max-w-[150px] text-center text-[5.5px] leading-snug" style={{ color: C.meta }}>
            No service history yet — your Otopair receipts will live here.
          </span>
        </div>
        <div
          className="mt-1.5 rounded-[8px] border bg-white/70 py-1 text-center text-[6.5px] font-semibold"
          style={{ borderColor: "#C9DEF7", color: C.blue }}
        >
          Remove Vehicle
        </div>
      </div>
    </div>
  );
}

/** Vehicle Health — ONE sheet at ~75%; the ring CLIMBS 0→81 on open, then
 *  the score drops LIVE while you watch, and the body scrolls to the
 *  factors where WHAT'S HURTING appears. */
function HealthSheet({ phase, reduce }: { phase: DrvPhase; reduce: boolean }) {
  const idx = DRV_ORDER.indexOf(phase);
  const at = (p: DrvPhase) => idx >= DRV_ORDER.indexOf(p);
  const shifted = at("shift");
  // Climb from 0 on mount, then live-drop to 66 on the shift beat.
  const score = useTween(shifted ? 66 : 81, shifted ? 1400 : 1200, !reduce, 0);
  const col = scoreColor(score);
  const RR = 33;

  return (
    <motion.div
      className="absolute inset-x-0 bottom-0 flex h-[75%] flex-col rounded-t-[14px] bg-white px-2.5 pt-1.5"
      initial={{ y: "100%" }}
      animate={{ y: 0 }}
      exit={{ y: "100%" }}
      transition={{ type: "spring", stiffness: 300, damping: 30 }}
    >
      <span className="mx-auto block h-[3px] w-7 shrink-0 rounded-full bg-black/15" />
      <div className="relative mt-1 shrink-0 border-b pb-1 text-center" style={{ borderColor: "rgba(0,0,0,0.06)" }}>
        <p className="text-[8.5px] font-bold" style={{ color: C.ink }}>
          Vehicle Health
        </p>
        <p className="text-[6px]" style={{ color: C.meta }}>
          Audi Q5 · Premium Package
        </p>
        <X className="absolute right-0 top-0.5 h-[9px] w-[9px]" style={{ color: C.meta }} />
      </div>

      {/* Scroll viewport — the story scrolls to the factors on "hurting" */}
      <div className="min-h-0 flex-1 overflow-hidden">
        <motion.div
          initial={false}
          animate={{ y: phase === "hurting" ? -78 : 0 }}
          transition={{ duration: reduce ? 0 : 1.1, ease: [0.25, 1, 0.4, 1] }}
        >
          {/* Ring — color + glow + number all track the live score */}
          <div className="relative mx-auto mt-2 h-[84px] w-[84px]">
            <motion.span
              className="absolute inset-[-6px] rounded-full"
              initial={false}
              animate={{ backgroundColor: score >= 75 ? "#30D15814" : "#FFEA0026" }}
              transition={{ duration: 0.6 }}
            />
            <svg width="84" height="84" viewBox="0 0 84 84" className="-rotate-90">
              <circle cx="42" cy="42" r={RR} stroke={col} strokeOpacity="0.14" strokeWidth="8" fill="none" />
              <circle
                cx="42"
                cy="42"
                r={RR}
                stroke={col}
                strokeWidth="8"
                fill="none"
                strokeLinecap="round"
                strokeDasharray={2 * Math.PI * RR}
                strokeDashoffset={2 * Math.PI * RR * (1 - score / 100)}
              />
            </svg>
            <span className="absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-[17px] font-bold leading-none" style={{ color: C.ink }}>
                {score}
              </span>
              <span className="mt-0.5 text-[5.5px]" style={{ color: C.meta }}>
                out of 100
              </span>
            </span>
          </div>

          <div className="mt-2.5 flex items-center justify-between">
            <p className="text-[5.5px] font-semibold uppercase tracking-[0.08em]" style={{ color: C.dim }}>
              What affects your score
            </p>
            <Info className="h-[7px] w-[7px]" style={{ color: C.dim }} />
          </div>
          {[
            { t: "Overall Vehicle Condition", s: "Based on your maintenance and Usage", v: `${score}%`, w: `${score}%` },
            { t: "Maintenance", s: "More services completed = higher score", v: shifted ? "3/4" : "4/4", w: shifted ? "75%" : "100%" },
            { t: "Usage & Wear", s: "Lower mileage = higher score", v: "41k mi", w: "72%" },
          ].map((r) => (
            <div key={r.t} className="mt-2">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1">
                  <span className="h-[4.5px] w-[4.5px] rounded-full" style={{ backgroundColor: C.green }} />
                  <span className="text-[6.5px] font-semibold" style={{ color: C.ink }}>
                    {r.t}
                  </span>
                </span>
                <span className="text-[6.5px] font-bold" style={{ color: C.ink }}>
                  {r.v}
                </span>
              </div>
              <span className="block text-[5.5px]" style={{ color: C.meta }}>
                {r.s}
              </span>
              <div className="mt-1 h-[3px] overflow-hidden rounded-full" style={{ backgroundColor: "#EDF2F7" }}>
                <motion.div
                  className="h-full rounded-full"
                  style={{ backgroundColor: C.green }}
                  initial={false}
                  animate={{ width: r.w }}
                  transition={{ duration: reduce ? 0 : 0.9, ease: EASE }}
                />
              </div>
            </div>
          ))}

          {/* Score Factors — WHAT'S HURTING appears with the live drop */}
          <div className="mb-2 mt-3 rounded-[10px] border p-2 shadow-sm" style={{ borderColor: "rgba(0,0,0,0.06)" }}>
            <p className="text-[7.5px] font-bold" style={{ color: C.ink }}>
              Score Factors
            </p>
            <p className="mt-1 text-[5.5px] font-semibold uppercase tracking-[0.08em]" style={{ color: "#7C93B5" }}>
              What&apos;s helping
            </p>
            <div className="flex items-center justify-between gap-1.5 py-1.5">
              <span className="flex min-w-0 items-start gap-1">
                <span className="mt-0.5 h-[4px] w-[4px] shrink-0 rounded-full" style={{ backgroundColor: C.green }} />
                <span className="min-w-0">
                  <span className="block text-[6.5px] font-medium" style={{ color: C.ink }}>
                    Healthy mileage
                  </span>
                  <span className="block text-[5.5px]" style={{ color: C.meta }}>
                    41,000 mi
                  </span>
                </span>
              </span>
              <span className="shrink-0 rounded-[5px] px-1 py-0.5 text-[6px] font-bold" style={{ backgroundColor: "#DCFCE7", color: "#16A34A" }}>
                +16
              </span>
            </div>

            <AnimatePresence initial={false}>
              {shifted && (
                <motion.div
                  key="hurting"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.4, ease: EASE }}
                >
                  <p className="mt-0.5 text-[5.5px] font-semibold uppercase tracking-[0.08em]" style={{ color: "#7C93B5" }}>
                    What&apos;s hurting
                  </p>
                  {[
                    {
                      t: "Overdue: Oil Change",
                      s: "Oil pressure warning light active — service urgently needed",
                      n: "−15",
                    },
                    { t: "Oil pressure warning", s: null, n: "−15" },
                  ].map((f, i) => (
                    <div
                      key={f.t}
                      className={`flex items-center justify-between gap-1.5 py-1.5 ${i > 0 ? "border-t" : ""}`}
                      style={i > 0 ? { borderColor: "rgba(0,0,0,0.05)" } : undefined}
                    >
                      <span className="flex min-w-0 items-start gap-1">
                        <span className="mt-0.5 h-[4px] w-[4px] shrink-0 rounded-full" style={{ backgroundColor: C.red }} />
                        <span className="min-w-0">
                          <span className="block text-[6.5px] font-medium" style={{ color: C.ink }}>
                            {f.t}
                          </span>
                          {f.s && (
                            <span className="block text-[5.5px] leading-snug" style={{ color: C.meta }}>
                              {f.s}
                            </span>
                          )}
                        </span>
                      </span>
                      <span className="shrink-0 rounded-[5px] px-1 py-0.5 text-[6px] font-bold" style={{ backgroundColor: "#FEE2E2", color: "#E11D48" }}>
                        {f.n}
                      </span>
                    </div>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </motion.div>
      </div>
    </motion.div>
  );
}

/** Service Detail — the OVERDUE oil-change explainer, matched to the app's
 *  sheet: deep-blue gradient header, medallion, big current → projected
 *  rings, +15 chip, plain-English copy, gradient CTA. */
function ServiceDetailSheet({ phase }: { phase: DrvPhase }) {
  const DR = 24;
  const DC = 2 * Math.PI * DR;
  return (
    <motion.div
      className="absolute inset-0 flex flex-col overflow-hidden"
      initial={{ y: "100%" }}
      animate={{ y: 0 }}
      exit={{ y: "100%" }}
      transition={{ type: "spring", stiffness: 280, damping: 30 }}
      style={{ background: "linear-gradient(180deg, #295E9E 0%, #6FA5D9 24%, #DDEBF7 40%, #FFFFFF 52%)" }}
    >
      <div className="relative px-4 pt-[26px] text-center">
        <p className="text-[6.5px] font-semibold uppercase tracking-[0.2em] text-white/90">
          Service detail
        </p>
        <p className="mt-1 text-[15px] font-bold tracking-tight text-white">Oil Change</p>
        <span
          className="mx-auto mt-2 inline-block rounded-full px-2.5 py-1 text-[6.5px] font-bold uppercase tracking-[0.06em] text-white"
          style={{ backgroundColor: "#DC2626" }}
        >
          Overdue
        </span>
        <span className="absolute right-3 top-[26px] flex h-[15px] w-[15px] items-center justify-center rounded-full bg-white/25">
          <X className="h-[9px] w-[9px] text-white" strokeWidth={2.5} />
        </span>
        {/* Icon medallion — glossy ringed circle */}
        <span className="mx-auto mt-3 flex h-[34px] w-[34px] items-center justify-center rounded-full bg-white/40 shadow-[0_6px_16px_rgba(20,40,80,0.28)]">
          <span className="flex h-[28px] w-[28px] items-center justify-center rounded-full bg-white">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/images/landing/app/oilchangeicon.png" alt="" className="h-[17px] w-[17px] object-contain" />
          </span>
        </span>
      </div>

      {/* Current → Projected rings */}
      <div className="mt-4 flex items-start justify-center gap-4">
        {[
          { n: 66, label: "Current", sub: "Health score", color: "#D22B2B" },
          { n: 81, label: "Projected", sub: "After service", color: "#2EBD4E" },
        ].map((r, i) => (
          <span key={r.label} className="flex items-start gap-4">
            {i === 1 && <ArrowRight className="mt-6 h-[10px] w-[10px]" style={{ color: C.dim }} />}
            <span className="flex flex-col items-center">
              <span className="relative h-[62px] w-[62px]">
                <svg width="62" height="62" viewBox="0 0 62 62" className="-rotate-90">
                  <circle cx="31" cy="31" r={DR} stroke={r.color} strokeOpacity="0.12" strokeWidth="5" fill="none" />
                  <motion.circle
                    cx="31"
                    cy="31"
                    r={DR}
                    stroke={r.color}
                    strokeWidth="5"
                    fill="none"
                    strokeLinecap="round"
                    strokeDasharray={DC}
                    initial={{ strokeDashoffset: DC }}
                    animate={{ strokeDashoffset: DC * (1 - r.n / 100) }}
                    transition={{ duration: 1.1, ease: EASE, delay: 0.3 + i * 0.35 }}
                  />
                </svg>
                <span className="absolute inset-0 flex items-center justify-center text-[15px] font-bold" style={{ color: C.ink }}>
                  {r.n}
                </span>
              </span>
              <span className="mt-1 text-[7.5px] font-semibold" style={{ color: C.ink }}>
                {r.label}
              </span>
              <span className="mt-0.5 text-[6px]" style={{ color: C.dim }}>
                {r.sub}
              </span>
            </span>
          </span>
        ))}
      </div>

      <span
        className="mx-auto mt-3 inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[7px] font-bold"
        style={{ backgroundColor: "#DCFCE7", color: "#16A34A" }}
      >
        ↑ +15 points
      </span>

      <div className="mx-auto mt-3 w-10 border-t" style={{ borderColor: "rgba(0,0,0,0.12)" }} />

      <p className="mx-auto mt-3 max-w-[185px] text-center text-[7.5px] leading-relaxed" style={{ color: "#374151" }}>
        Oil degrades over time and loses its ability to protect engine internals. Schedule an oil
        change as soon as possible to prevent long-term damage.
      </p>
      <p className="mt-2 text-center text-[6px]" style={{ color: C.dim }}>
        Last serviced ~14 months ago · Urgency:
      </p>
      <p className="mt-0.5 text-center text-[6.5px] font-semibold" style={{ color: C.blue }}>
        Immediate oil change recommended
      </p>

      <div className="mt-auto px-3.5 pb-2">
        <span className="relative block">
          <motion.span
            className="block rounded-[12px] py-2 text-center text-[8.5px] font-semibold text-white shadow-[0_6px_16px_rgba(82,153,254,0.4)]"
            style={{ background: "linear-gradient(90deg, #5D96E8, #8CB6FB)" }}
            animate={{ scale: phase === "bookpress" ? 0.95 : 1 }}
            transition={{ duration: 0.18, ease: EASE }}
          >
            Book Service Now
          </motion.span>
          {phase === "bookpress" && <Ripple />}
        </span>
        <span className="mx-auto mt-1.5 block h-[3px] w-8 rounded-full bg-black/20" />
      </div>
    </motion.div>
  );
}

const PICKER_SERVICES = [
  { icon: Droplet, name: "Oil & filter change", sub: "Fresh oil and a new oil filter", mins: "About 30 mins", selected: true },
  { icon: Filter, name: "Air & cabin filters", sub: "New engine and cabin air filters", mins: "About 30 mins" },
  { icon: BatteryFull, name: "Battery test", sub: "Check your battery's health", mins: "About 30 mins" },
  { icon: BatteryFull, name: "Battery replacement", sub: "Install a new battery", mins: "About 45 mins" },
];

/** The booking flow's Routine service picker — a real map behind (Mapbox
 *  static render of the launch borough), frosted panel over it, oil change
 *  pre-selected, cart FAB with 1 item, "Continue · 1 service". */
function PickerScreen() {
  return (
    <motion.div
      className="absolute inset-0 z-40"
      initial={{ y: "100%" }}
      animate={{ y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ type: "spring", stiffness: 260, damping: 30 }}
    >
      {/* Map backdrop + locate button */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/images/landing/app/map-placeholder.png"
        alt=""
        className="absolute inset-0 h-full w-full object-cover"
      />
      <span className="absolute right-2 top-[24px] flex h-[14px] w-[14px] items-center justify-center rounded-[4px] bg-white shadow-sm">
        <CircleDot className="h-[8px] w-[8px]" style={{ color: C.ink }} strokeWidth={2} />
      </span>

      {/* Frosted content panel over the map */}
      <div
        className="absolute inset-x-0 bottom-0 top-[38px] flex flex-col rounded-t-[16px] px-2.5 pt-1.5 backdrop-blur-[3px]"
        style={{ backgroundColor: "rgba(244,249,252,0.82)" }}
      >
        <span className="mx-auto block h-[3px] w-7 shrink-0 rounded-full bg-black/15" />
        <div className="mt-1.5 flex items-center justify-between">
          <span className="flex h-[15px] w-[15px] items-center justify-center rounded-full bg-white shadow-sm">
            <ArrowLeft className="h-[8px] w-[8px]" style={{ color: C.ink }} />
          </span>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/images/landing/app/covered-car.png" alt="" className="h-[13px] w-[20px] rounded-full bg-white object-contain p-[1px] shadow-sm" />
        </div>
        <p className="mt-1 flex items-center gap-1.5 text-[11px] font-bold" style={{ color: C.ink }}>
          <Wrench className="h-[9px] w-[9px]" style={{ color: C.ink }} />
          Routine
        </p>
        <p className="mt-0.5 text-[6.5px]" style={{ color: C.meta }}>
          Fluids, filters, battery · 4 services
        </p>

        <div className="mt-1.5 space-y-1.5">
          {PICKER_SERVICES.map((s) => (
            <div
              key={s.name}
              className="relative rounded-[11px] border p-2 shadow-sm"
              style={
                s.selected
                  ? { backgroundColor: "#DCE9FF", borderColor: "#B7D3FF" }
                  : { backgroundColor: "rgba(255,255,255,0.94)", borderColor: "rgba(0,0,0,0.05)" }
              }
            >
              <HelpCircle className="absolute right-2 top-2 h-[7.5px] w-[7.5px]" style={{ color: C.blue }} />
              <div className="flex items-center gap-2 pr-3">
                <span
                  className="flex h-[17px] w-[17px] shrink-0 items-center justify-center rounded-[6px] bg-white"
                  style={{ boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.06)" }}
                >
                  <s.icon className="h-[9px] w-[9px]" style={{ color: C.ink }} strokeWidth={2} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[7.5px] font-bold" style={{ color: C.ink }}>
                    {s.name}
                  </span>
                  <span className="block text-[6.5px]" style={{ color: C.meta }}>
                    {s.sub}
                  </span>
                  <span className="mt-0.5 flex items-center gap-0.5 text-[6px]" style={{ color: C.meta }}>
                    <Clock className="h-[6px] w-[6px]" />
                    {s.mins}
                  </span>
                </span>
                {s.selected ? (
                  <motion.span
                    className="flex h-[13px] w-[13px] shrink-0 items-center justify-center rounded-full bg-black"
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    transition={{ type: "spring", stiffness: 400, damping: 18, delay: 0.35 }}
                  >
                    <Check className="h-[8px] w-[8px] text-white" strokeWidth={3} />
                  </motion.span>
                ) : (
                  <ChevronRight className="h-[8px] w-[8px] shrink-0" style={{ color: C.dim }} />
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Cart FAB — floats above the CTA, right side */}
        <motion.span
          className="absolute bottom-[34px] right-3 flex h-[22px] w-[22px] items-center justify-center rounded-full shadow-md"
          style={{ backgroundColor: C.blue }}
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ type: "spring", stiffness: 380, damping: 18, delay: 0.5 }}
        >
          <ListChecks className="h-[11px] w-[11px] text-white" strokeWidth={2.2} />
          <span
            className="absolute -right-0.5 -top-1 flex h-[9px] w-[9px] items-center justify-center rounded-full border border-white bg-white text-[5.5px] font-bold"
            style={{ color: C.ink }}
          >
            1
          </span>
        </motion.span>

        {/* Bottom CTA */}
        <div className="mt-auto pb-2">
          <span
            className="flex items-center justify-center gap-1 rounded-full py-1.5 text-[7.5px] font-semibold text-white"
            style={{ backgroundColor: C.blue }}
          >
            Continue · 1 service
            <ArrowRight className="h-[7.5px] w-[7.5px]" strokeWidth={2.5} />
          </span>
          <span className="mx-auto mt-1 block h-[3px] w-8 rounded-full bg-black/20" />
        </div>
      </div>
    </motion.div>
  );
}

/** 01 — Drivers: one home base (My Cars) — the health sheet is open when the
 *  score DROPS live (warning light), WHAT'S HURTING explains it, the sheet
 *  falls away to the urgent NOW card, View Details explains the fix, and
 *  booking lands the service straight in the cart. */
export default function DriversPanel({ active, reduce }: { active: boolean; reduce: boolean }) {
  const [phase, setPhase] = useState<DrvPhase>("cars");
  const idx = DRV_ORDER.indexOf(phase);
  const at = (p: DrvPhase) => idx >= DRV_ORDER.indexOf(p);
  const score = useTween(at("shift") ? 66 : 81, 1400, !reduce);

  useEffect(() => {
    setPhase("cars");
    if (!active || reduce) return;
    const timers: number[] = [];
    const SEQ: [DrvPhase, number][] = [
      ["sheet", 2600],
      ["shift", 5600],
      ["hurting", 8000],
      ["closesheet", 11400],
      ["detailpress", 14000],
      ["detail", 14800],
      ["bookpress", 18600],
      ["picker", 19400],
    ];
    const run = () => {
      setPhase("cars");
      for (const [p, t] of SEQ) timers.push(window.setTimeout(() => setPhase(p), t));
      timers.push(window.setTimeout(run, 24400)); // loop length — mirrored in STORY_MS (price-lock-section)
    };
    run();
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [active, reduce]);

  const caption = DRV_CAPTIONS[phase];
  const sheetUp = phase === "sheet" || phase === "shift" || phase === "hurting";
  const detailUp = phase === "detail" || phase === "bookpress";

  return (
    <div className="flex h-full w-full flex-col p-1">
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <motion.div
          className="origin-center scale-[0.68] select-none sm:scale-100 lg:scale-[1.16]"
          initial={false}
          animate={{ opacity: active ? 1 : 0, y: active || reduce ? 0 : 14 }}
          transition={{ duration: 0.5, ease: EASE }}
        >
          <PhoneFrame tab={2}>
            <CarsScreen phase={phase} score={score} reduce={reduce} />

            {/* Vehicle Health sheet (backdrop + sheet) */}
            <AnimatePresence>
              {sheetUp && (
                <motion.div
                  key="healthwrap"
                  className="absolute inset-0 z-30"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.25 }}
                >
                  <div className="absolute inset-0 bg-black/25" />
                  <HealthSheet phase={phase} reduce={reduce} />
                </motion.div>
              )}
            </AnimatePresence>

            {/* Service Detail sheet */}
            <AnimatePresence>
              {detailUp && (
                <motion.div
                  key="detailwrap"
                  className="absolute inset-0 z-30"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.25 }}
                >
                  <div className="absolute inset-0 bg-black/25" />
                  <ServiceDetailSheet phase={phase} />
                </motion.div>
              )}
            </AnimatePresence>

            {/* Booking picker — covers everything incl. the tab bar */}
            <AnimatePresence>{phase === "picker" && <PickerScreen key="picker" />}</AnimatePresence>
          </PhoneFrame>
        </motion.div>
      </div>

      {/* Caption — pinned to the card bottom, same treatment as Shops */}
      <div className="flex h-8 shrink-0 items-center justify-center sm:h-9">
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={caption}
            className="whitespace-nowrap rounded-full bg-white/70 px-5 py-1.5 text-[12px] tracking-[0.03em] text-[#1a1a1a] ring-1 ring-black/5 backdrop-blur-md sm:text-[13px] lg:px-6 lg:py-2 lg:text-[13.5px]"
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8 }}
            animate={{ opacity: active ? 1 : 0, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: -8 }}
            transition={{ duration: 0.35, ease: EASE }}
          >
            {caption}
          </motion.span>
        </AnimatePresence>
      </div>
    </div>
  );
}
