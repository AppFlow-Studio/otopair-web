"use client";

import { motion } from "motion/react";
import { AlertTriangle, BatteryFull, Check, ChevronDown, CircleDot, Clock, Disc, Droplet, Info, Plus, ShieldCheck, X } from "lucide-react";
import { APP, PhoneShell } from "../device";
import { AppButton, AppCard } from "../ui";

/**
 * My Cars (otopair-1 app/(main-tabs)/cars + components/cars). The tab
 * root: light-blue canvas, profile chip, the car hero (covered-car asset
 * until a photo exists), name and mileage, thumbnails + the health ring
 * (CarCarousel: circle, % inside, colour by band), Maintenance Tracker
 * (rows with a 5299FE/10 icon plate and a blue check; NOW / HEALTHY
 * groups), Service History. The Vehicle Health sheet opens at ~75%: the
 * big ring, "What affects your score" bars, Score Factors (helping /
 * hurting) with signed chips. The sheet's score is the app's circular
 * gradient ring (HealthRing); the rounded-square SquircleRing only
 * appears in onboarding in the app, so it is not used here.
 */

/* Colour bands from the app: ≥75 green, ≥60 yellow, else red. */
export const scoreColor = (s: number) => (s >= 75 ? "#30D158" : s >= 60 ? "#FFCC00" : "#FF3B30");

export function Ring({ score, size = 56, stroke = 7 }: { score: number; size?: number; stroke?: number }) {
  const r = size / 2 - stroke / 2 - 1;
  const c = 2 * Math.PI * r;
  const col = scoreColor(score);
  return (
    <span className="relative inline-block" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} stroke={col} strokeOpacity="0.18" strokeWidth={stroke} fill="none" />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={col}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={c}
          initial={false}
          animate={{ strokeDashoffset: c * (1 - score / 100) }}
          transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center font-bold tabular-nums" style={{ color: APP.ink, fontSize: Math.round(size * 0.25) }}>
        {score}%
      </span>
    </span>
  );
}

/**
 * The Vehicle Health ring (CarCarousel VehicleHealthModal): a circle at
 * 180 with a 12px stroke, a 15% track, a gradient stroke in the band
 * colour (green >= 75, yellow >= 60, else red), a 20% halo stroke 4px
 * wider, and a soft glow behind. Number + "out of 100" in the centre.
 * Scaled by `size`; the app's proportions are kept (stroke = size/15,
 * radius = size/2 - stroke/2 - size/22.5).
 */
export function HealthRing({ score, size = 180, children }: { score: number; size?: number; children?: React.ReactNode }) {
  const stroke = size / 15;
  const r = size / 2 - stroke / 2 - size / 22.5;
  const c = 2 * Math.PI * r;
  const col = score >= 75 ? "#30D158" : score >= 60 ? "#FFEA00" : "#FF3B5C";
  const id = "hr-" + Math.round(size) + "-" + score;
  return (
    <span className="relative inline-block" style={{ width: size, height: size }}>
      <span className="absolute inset-[-10%] rounded-full" style={{ backgroundColor: col, opacity: 0.12 }} />
      <span className="absolute inset-[-3%] rounded-full" style={{ backgroundColor: col, opacity: 0.06 }} />
      <svg width={size} height={size} viewBox={"0 0 " + size + " " + size} className="relative -rotate-90">
        <defs>
          <linearGradient id={id} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor={col} />
            <stop offset="50%" stopColor={col} stopOpacity={0.9} />
            <stop offset="100%" stopColor={col} stopOpacity={0.8} />
          </linearGradient>
        </defs>
        <circle cx={size / 2} cy={size / 2} r={r} stroke={col} strokeWidth={stroke} fill="none" opacity={0.15} />
        <motion.circle cx={size / 2} cy={size / 2} r={r} stroke={col} strokeWidth={stroke + 4} fill="none" strokeLinecap="round" strokeDasharray={c} opacity={0.2} initial={false} animate={{ strokeDashoffset: c * (1 - score / 100) }} transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }} />
        <motion.circle cx={size / 2} cy={size / 2} r={r} stroke={"url(#" + id + ")"} strokeWidth={stroke} fill="none" strokeLinecap="round" strokeDasharray={c} initial={false} animate={{ strokeDashoffset: c * (1 - score / 100) }} transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }} />
      </svg>
      <span className="absolute inset-0 flex flex-col items-center justify-center">
        {children ?? (
          <>
            <span className="font-bold leading-none tabular-nums" style={{ color: APP.ink, fontSize: Math.round(size * 0.29) }}>
              {score}
            </span>
            <span className="mt-1" style={{ color: APP.meta, fontSize: Math.max(10, Math.round(size * 0.085)) }}>
              out of 100
            </span>
          </>
        )}
      </span>
    </span>
  );
}

/** Tier chip header (MaintenanceTracker groupLabelStyles): 11px caps at
 *  0.06em, 8px radius, 8/4 padding, a dot; NOW red-50/red-700, SOON
 *  amber-50/amber-700, HEALTHY emerald-50/emerald-600 with the count. */
function TierChip({ tier, count }: { tier: "now" | "soon" | "healthy"; count?: number }) {
  const m = {
    now: { bg: "#FEF2F2", fg: "#B91C1C", dot: "#EF4444", label: "NOW" },
    soon: { bg: "#FFFBEB", fg: "#B45309", dot: "#F59E0B", label: "SOON" },
    healthy: { bg: "#ECFDF5", fg: "#059669", dot: "#059669", label: count != null ? "HEALTHY · " + count : "HEALTHY" },
  }[tier];
  return (
    <span className="mb-2 mt-3 flex items-center justify-between">
      <span className="inline-flex items-center gap-[6px] rounded-[8px] px-2 py-1" style={{ backgroundColor: m.bg }}>
        <motion.span
          className="h-[8px] w-[8px] rounded-full"
          style={{ backgroundColor: m.dot }}
          animate={tier === "healthy" ? undefined : { opacity: [1, 0.5, 1], scale: [1, 1.4, 1] }}
          transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
        />
        <span className="text-[11px] font-bold uppercase tracking-[0.06em]" style={{ color: m.fg }}>
          {m.label}
        </span>
      </span>
      {tier === "healthy" && <ChevronDown className="h-[16px] w-[16px]" style={{ color: "#C7C7CC" }} />}
    </span>
  );
}

const HEALTHY = [
  { icon: Droplet, name: "Oil Change", sub: "3 months remaining" },
  { icon: BatteryFull, name: "Battery", sub: "In good standing" },
];

export function MyCarsScreen({
  score = 81,
  car = { name: "Honda Civic EX", miles: "41,200 mi", year: "2019" },
  checkin = false,
  rotated = false,
}: {
  score?: number;
  car?: { name: string; miles: string; year: string };
  checkin?: boolean;
  /** The tire rotation has been logged: the Tires row reads on time. */
  rotated?: boolean;
}) {
  return (
    <PhoneShell tab={2} bg="#d3e5f4">
      <div className="flex h-full flex-col px-4 pt-[60px]">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-2">
            <span className="flex h-[32px] w-[32px] items-center justify-center rounded-full text-[11px] font-semibold text-white" style={{ background: "linear-gradient(135deg, #5299FE, #C5DAFF)" }}>
              DR
            </span>
            <span className="flex items-center gap-1 rounded-full bg-white/60 px-3 py-[6px] text-[12px] font-semibold" style={{ color: APP.ink }}>
              Work
              <ChevronDown className="h-[12px] w-[12px]" style={{ color: APP.meta }} />
            </span>
          </span>
          <Info className="h-[18px] w-[18px]" style={{ color: APP.meta }} strokeWidth={2} />
        </div>

        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/images/landing/app/covered-car.png" alt="" className="mx-auto mt-2 h-[132px] w-auto object-contain" />
        <p className="text-center text-[20px] font-bold leading-tight" style={{ color: APP.ink }}>
          {car.name}
        </p>
        <p className="text-center text-[13px]" style={{ color: APP.meta }}>
          {car.miles}&nbsp;&nbsp;|&nbsp;&nbsp;{car.year}
        </p>

        <div className="mt-3 flex items-center justify-between">
          <span className="flex items-center gap-2 rounded-[14px] bg-white/70 px-3 py-2">
            {[0, 1].map((i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={i} src="/images/landing/app/covered-car.png" alt="" className="h-[20px] w-[32px] object-contain" style={{ opacity: i === 1 ? 1 : 0.55 }} />
            ))}
            <span className="flex h-[24px] w-[24px] items-center justify-center rounded-full border border-black/25">
              <Plus className="h-[14px] w-[14px] text-black/60" strokeWidth={2} />
            </span>
          </span>
          <Ring score={score} />
        </div>

        {checkin && (
          <div className="mt-3 flex items-center gap-3 rounded-[14px] border px-3 py-[10px]" style={{ backgroundColor: "#FFFBEB", borderColor: "#FDE68A" }}>
            <Clock className="h-[20px] w-[20px] shrink-0" style={{ color: "#F59E0B" }} />
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-semibold" style={{ color: APP.ink }}>
                Time for a quick update
              </span>
              <span className="block text-[12px]" style={{ color: APP.meta }}>
                Info last updated 3 months ago
              </span>
            </span>
            <span className="text-[12px] font-semibold" style={{ color: APP.blue }}>
              Start
            </span>
          </div>
        )}

        <div className="mt-4 flex items-center justify-between">
          <span className="text-[17px] font-bold" style={{ color: APP.ink }}>
            Maintenance Tracker
          </span>
          <span className="rounded-full bg-white px-3 py-[5px] text-[12px] font-medium" style={{ color: APP.ink }}>
            Update Info
          </span>
        </div>

        {/* NOW: the urgent card, with the score impact and the two actions */}
        {!rotated && (
          <>
            <TierChip tier="now" />
            <div className="rounded-[16px] bg-white p-3 shadow-sm">
              <div className="flex items-start gap-3">
                <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[8px]" style={{ backgroundColor: "#5299FE1A" }}>
                  <CircleDot className="h-[16px] w-[16px]" style={{ color: APP.blue }} strokeWidth={2} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-semibold" style={{ color: APP.ink }}>
                    Tire Rotation
                  </span>
                  <span className="block text-[12px] leading-[16px]" style={{ color: APP.meta }}>
                    1,200 mi past the 6,000 mi interval
                  </span>
                </span>
                <span className="shrink-0 rounded-[6px] px-[6px] py-[2px] text-[12px] font-bold" style={{ backgroundColor: "#DCFCE7", color: "#16A34A" }}>
                  +7
                </span>
              </div>
              <div className="mt-3 flex gap-2">
                <span className="flex-1 rounded-full py-[8px] text-center text-[13px] font-semibold text-white" style={{ backgroundColor: APP.blue }}>
                  Book Service
                </span>
                <span className="flex-1 rounded-full py-[8px] text-center text-[13px] font-semibold" style={{ backgroundColor: "#EEF1F4", color: APP.ink }}>
                  View Details
                </span>
              </div>
            </div>
          </>
        )}

        {/* SOON */}
        <TierChip tier="soon" />
        <div className="rounded-[16px] bg-white p-2 shadow-sm">
          <div className="flex items-center gap-3 px-2 py-[8px]">
            <span className="flex h-[30px] w-[30px] items-center justify-center rounded-[8px]" style={{ backgroundColor: "#5299FE1A" }}>
              <Disc className="h-[16px] w-[16px]" style={{ color: APP.blue }} strokeWidth={2} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[14px] font-semibold" style={{ color: APP.ink }}>
                Brakes
              </span>
              <span className="block truncate text-[12px]" style={{ color: APP.meta }}>
                Front pads due soon
              </span>
            </span>
            <ChevronDown className="h-[16px] w-[16px] -rotate-90" style={{ color: "#C7C7CC" }} />
          </div>
        </div>

        {/* HEALTHY · N, check circles like the home page panel */}
        <TierChip tier="healthy" count={rotated ? 3 : 2} />
        <div className="rounded-[16px] bg-white p-2 shadow-sm">
          {(rotated ? [HEALTHY[0], { icon: CircleDot, name: "Tires", sub: "Rotated today · next at 47,200 mi" }, HEALTHY[1]] : HEALTHY).map((t) => (
            <div key={t.name} className="flex items-center gap-3 px-2 py-[8px]">
              <span className="flex h-[30px] w-[30px] items-center justify-center rounded-[8px]" style={{ backgroundColor: "#5299FE1A" }}>
                <t.icon className="h-[16px] w-[16px]" style={{ color: APP.blue }} strokeWidth={2} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[14px] font-semibold" style={{ color: APP.ink }}>
                  {t.name}
                </span>
                <span className="block truncate text-[12px]" style={{ color: APP.meta }}>
                  {t.sub}
                </span>
              </span>
              <span className="flex h-[20px] w-[20px] items-center justify-center rounded-full" style={{ backgroundColor: APP.blue }}>
                <Check className="h-[12px] w-[12px] text-white" strokeWidth={3} />
              </span>
            </div>
          ))}
        </div>
      </div>
    </PhoneShell>
  );
}

/* ------------------------------------------------------------------ */
/* Vehicle Health sheet                                                */
/* ------------------------------------------------------------------ */

export function HealthSheet({ score = 81, car = "2019 Honda Civic EX", hurting = true }: { score?: number; car?: string; hurting?: boolean }) {
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-t-[28px] bg-white px-5 pt-3" style={{ boxShadow: "0 -8px 30px rgba(20,40,80,0.12)" }}>
      <span className="mx-auto block h-[5px] w-[44px] rounded-full bg-black/15" />
      <div className="relative mt-3 border-b pb-3 text-center" style={{ borderColor: "rgba(0,0,0,0.06)" }}>
        <p className="text-[17px] font-bold" style={{ color: APP.ink }}>
          Vehicle Health
        </p>
        <p className="text-[12px]" style={{ color: APP.meta }}>
          {car}
        </p>
        <X className="absolute right-0 top-1 h-[18px] w-[18px]" style={{ color: APP.meta }} />
      </div>
      <div className="mt-6 flex justify-center">
        <HealthRing score={score} size={150} />
      </div>
      <div className="mt-5 flex items-center justify-between">
        <p className="text-[11px] font-semibold uppercase tracking-[0.08em]" style={{ color: APP.dim }}>
          What affects your score
        </p>
        <Info className="h-[14px] w-[14px]" style={{ color: APP.dim }} />
      </div>
      {[
        { t: "Maintenance", s: "Services completed on their interval", v: "3/4", w: 75 },
        { t: "Warning lights", s: "None active", v: "Clear", w: 100 },
        { t: "Usage & wear", s: "41,200 mi on a 2019", v: "Typical", w: 72 },
      ].map((r) => (
        <div key={r.t} className="mt-3">
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-semibold" style={{ color: APP.ink }}>
              {r.t}
            </span>
            <span className="text-[13px] font-bold" style={{ color: APP.ink }}>
              {r.v}
            </span>
          </div>
          <span className="block text-[11px]" style={{ color: APP.meta }}>
            {r.s}
          </span>
          <div className="mt-1.5 h-[6px] overflow-hidden rounded-full" style={{ backgroundColor: "#EDF2F7" }}>
            <motion.div className="h-full rounded-full" style={{ backgroundColor: "#30D158" }} initial={false} animate={{ width: `${r.w}%` }} transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }} />
          </div>
        </div>
      ))}
      <div className="mt-5 rounded-[16px] border p-4" style={{ borderColor: "rgba(0,0,0,0.06)", boxShadow: "0 1px 4px rgba(0,0,0,0.04)" }}>
        <p className="text-[15px] font-bold" style={{ color: APP.ink }}>
          Score Factors
        </p>
        <p className="mt-2 text-[11px] font-semibold uppercase tracking-[0.08em]" style={{ color: "#7C93B5" }}>
          What&apos;s helping
        </p>
        <div className="flex items-center justify-between py-2">
          <span className="flex items-start gap-2">
            <span className="mt-[6px] h-[7px] w-[7px] rounded-full" style={{ backgroundColor: "#30D158" }} />
            <span>
              <span className="block text-[13px] font-medium" style={{ color: APP.ink }}>
                Oil changed on time
              </span>
              <span className="block text-[11px]" style={{ color: APP.meta }}>
                Mar 2026, from your receipt
              </span>
            </span>
          </span>
          <span className="rounded-[6px] px-2 py-[3px] text-[12px] font-bold" style={{ backgroundColor: "#DCFCE7", color: "#16A34A" }}>
            +8
          </span>
        </div>
        {hurting && (
          <>
            <p className="mt-1 text-[11px] font-semibold uppercase tracking-[0.08em]" style={{ color: "#7C93B5" }}>
              What&apos;s hurting
            </p>
            <div className="flex items-center justify-between border-t py-2" style={{ borderColor: "rgba(0,0,0,0.05)" }}>
              <span className="flex items-start gap-2">
                <span className="mt-[6px] h-[7px] w-[7px] rounded-full" style={{ backgroundColor: "#FF3B30" }} />
                <span>
                  <span className="block text-[13px] font-medium" style={{ color: APP.ink }}>
                    Tire rotation overdue
                  </span>
                  <span className="block text-[11px]" style={{ color: APP.meta }}>
                    1,200 mi past the 6,000 mi interval
                  </span>
                </span>
              </span>
              <span className="rounded-[6px] px-2 py-[3px] text-[12px] font-bold" style={{ backgroundColor: "#FEE2E2", color: "#E11D48" }}>
                −7
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** My Cars with the health sheet up. */
export function HealthScreen({ score = 81, hurting = true }: { score?: number; hurting?: boolean }) {
  return (
    <PhoneShell bg="#d3e5f4">
      <div className="absolute inset-0 opacity-60">
        <div className="px-4 pt-[60px]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/images/landing/app/covered-car.png" alt="" className="mx-auto mt-6 h-[132px] w-auto object-contain" />
        </div>
      </div>
      <div className="absolute inset-0 bg-black/20" />
      <div className="absolute inset-x-0 bottom-0 h-[76%]">
        <HealthSheet score={score} hurting={hurting} />
      </div>
    </PhoneShell>
  );
}

/* ------------------------------------------------------------------ */
/* Quarterly check-in — app/quarterly-checkin.tsx                      */
/* ------------------------------------------------------------------ */

export function CheckinScreen({ step = 1, picked }: { step?: 1 | 2; picked?: string }) {
  return (
    <PhoneShell>
      <div className="flex h-full flex-col px-5 pt-[64px]">
        <p className="text-[12px] font-semibold uppercase tracking-[0.08em]" style={{ color: APP.blue }}>
          Quick check-in · {step} of 3
        </p>
        <p className="mt-2 text-[26px] font-bold leading-[31px] tracking-[-0.01em]" style={{ color: APP.ink }}>
          {step === 1 ? "What's the odometer showing?" : "Anything the car is telling you?"}
        </p>
        <p className="mt-2 text-[14px] leading-[21px]" style={{ color: APP.meta }}>
          {step === 1 ? "A rough number is fine. It keeps your intervals honest." : "Warning lights, noises, or nothing at all."}
        </p>
        {step === 1 ? (
          <AppCard className="mt-6">
            <p className="text-[11px] font-semibold uppercase tracking-[0.06em]" style={{ color: APP.dim }}>
              Mileage
            </p>
            <p className="mt-1 text-[34px] font-bold tabular-nums tracking-[-0.01em]" style={{ color: APP.ink }}>
              41,200<span className="ml-2 text-[16px] font-medium" style={{ color: APP.meta }}>mi</span>
            </p>
            <p className="mt-1 text-[12px]" style={{ color: APP.meta }}>
              Last confirmed 38,900 mi · Jun 2026
            </p>
          </AppCard>
        ) : (
          <div className="mt-6 flex flex-col gap-2">
            {[
              { l: "All good", i: ShieldCheck },
              { l: "Warning light on", i: AlertTriangle },
              { l: "Something feels off", i: Info },
            ].map((o) => {
              const on = o.l === picked;
              return (
                <span key={o.l} className="flex items-center gap-3 rounded-[14px] border bg-white px-4 py-[14px] text-[15px] font-semibold" style={on ? { borderColor: APP.blue, backgroundColor: "#EAF2FF", color: APP.blue } : { borderColor: APP.border, color: APP.ink }}>
                  <o.i className="h-[18px] w-[18px]" strokeWidth={2} />
                  <span className="flex-1">{o.l}</span>
                  {on && <Check className="h-[18px] w-[18px]" strokeWidth={2.5} />}
                </span>
              );
            })}
          </div>
        )}
        <div className="mt-auto pb-[34px]">
          <p className="mb-3 text-center text-[12px]" style={{ color: APP.dim }}>
            Takes about 30 seconds
          </p>
          <AppButton>Next</AppButton>
        </div>
      </div>
    </PhoneShell>
  );
}
