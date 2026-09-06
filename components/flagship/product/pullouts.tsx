"use client";

import type { ReactNode } from "react";
import { motion } from "motion/react";
import { Check, Info } from "lucide-react";
import { useReducedMotionSafe } from "../shared";
import { APP, appFont } from "./device";

/**
 * Pull-outs: one object lifted out of the phone and enlarged so it can be
 * read across the room (the Superpower / Linear move). Same anatomy and
 * face as the screen it came from, at web scale: 20px radius, 18–26px
 * type, the app's hairlines. They sit beside or over a Phone on a Plate.
 */

const EASE = [0.22, 1, 0.36, 1] as const;

export function PullCard({ children, className = "", delay = 0 }: { children: ReactNode; className?: string; delay?: number }) {
  const reduce = useReducedMotionSafe();
  return (
    <motion.div
      className={`rounded-[20px] bg-white ${className}`}
      style={{ boxShadow: "0 24px 60px rgba(20,40,80,0.16), 0 4px 12px rgba(20,40,80,0.06)", ...appFont }}
      initial={reduce ? { opacity: 0 } : { opacity: 0, transform: "translateY(16px)" }}
      whileInView={{ opacity: 1, transform: "translateY(0px)" }}
      viewport={{ once: true, margin: "-15% 0px" }}
      transition={{ duration: reduce ? 0.3 : 0.7, delay, ease: EASE }}
    >
      {children}
    </motion.div>
  );
}

/** The Service Breakdown, big. */
export function BreakdownPull({ className = "" }: { className?: string }) {
  const lines = [
    ["Labor (1 h 20 min)", "$176.00"],
    ["Parts, fixed", "$104.00"],
    ["Tax + service fee", "$32.00"],
  ];
  return (
    <PullCard className={`w-[min(100%,420px)] p-6 tab:p-7 ${className}`}>
      <p className="text-[18px] font-bold" style={{ color: APP.ink }}>
        Service Breakdown
      </p>
      <div className="my-4 border-t" style={{ borderColor: "rgba(0,0,0,0.06)" }} />
      <p className="text-[17px] font-semibold" style={{ color: APP.ink }}>
        Front brake pads
      </p>
      <p className="text-[14px]" style={{ color: APP.meta }}>
        2019 Honda Civic EX · Eltingville Auto Care
      </p>
      <div className="mt-4 flex flex-col gap-3">
        {lines.map(([k, v], i) => (
          <div key={k} className="flex items-baseline justify-between">
            <span className={i === 2 ? "text-[15px]" : "text-[16px] font-medium"} style={{ color: i === 2 ? APP.meta : APP.text }}>
              {k}
            </span>
            <span className="text-[16px] font-semibold tabular-nums" style={{ color: APP.text }}>
              {v}
            </span>
          </div>
        ))}
      </div>
      <div className="my-4 border-t" style={{ borderColor: "rgba(0,0,0,0.06)" }} />
      <div className="flex items-baseline justify-between">
        <span className="text-[17px] font-bold" style={{ color: APP.ink }}>
          Fixed price
        </span>
        <span className="text-[34px] font-extrabold tabular-nums tracking-[-0.02em]" style={{ color: APP.blue }}>
          $312.00
        </span>
      </div>
      <div className="mt-4 flex items-start gap-2.5 rounded-[12px] border p-3.5" style={{ backgroundColor: "#EAF2FE", borderColor: "#BFDBFE" }}>
        <Info className="mt-[2px] h-[16px] w-[16px] shrink-0" style={{ color: APP.blue }} />
        <span className="text-[14px] leading-[20px]" style={{ color: "#334155" }}>
          $20 hold today. Charged only after the shop inspects the car.
        </span>
      </div>
    </PullCard>
  );
}

/** The three-row payment lifecycle, big (PaymentBreakdown). */
export function LifecyclePull({ approvedExtra = false, className = "" }: { approvedExtra?: boolean; className?: string }) {
  const final = approvedExtra ? "$452.00" : "$312.00";
  const rows: [string, string, string, boolean][] = [
    ["Hold placed at booking", "$20.00", "An authorization on your card. It reserves the slot and is the most held before the shop sees the car.", true],
    ["Estimate confirmed", final, "After inspection. Within what you approved it confirms on its own; above it, only with your yes.", false],
    ["Final charged", final, "When the shop marks the job complete. Never before, never more than you approved.", false],
  ];
  return (
    <PullCard className={`w-full overflow-hidden ${className}`}>
      {rows.map(([k, v, s, muted], i) => (
        <div key={k} className={`grid gap-x-8 gap-y-2 px-6 py-6 tab:grid-cols-[1fr_auto] tab:px-9 tab:py-8 ${i > 0 ? "border-t" : ""}`} style={i > 0 ? { borderColor: "rgba(0,0,0,0.06)" } : undefined}>
          <div className="flex items-baseline gap-4">
            <span className="w-[26px] shrink-0 text-[13px] tabular-nums" style={{ color: APP.dim }}>
              0{i + 1}
            </span>
            <div>
              <p className={`text-[19px] tab:text-[22px] ${i === 2 ? "font-bold" : "font-semibold"}`} style={{ color: muted ? "#8E8E93" : APP.text }}>
                {k}
              </p>
              <p className="mt-1 max-w-[52ch] text-[14.5px] leading-[1.5] tab:text-[15px]" style={{ color: APP.meta, fontFamily: "Inter, system-ui, sans-serif" }}>
                {s}
              </p>
            </div>
          </div>
          <span className={`self-start pl-[42px] tabular-nums tab:pl-0 ${i === 2 ? "text-[32px] font-extrabold tab:text-[40px]" : "text-[24px] font-semibold tab:text-[28px]"}`} style={{ color: muted ? "#8E8E93" : APP.text, letterSpacing: "-0.02em" }}>
            {v}
          </span>
        </div>
      ))}
    </PullCard>
  );
}

/** A big "verified" fact row for lists beside a device. */
export function FactRow({ children }: { children: ReactNode }) {
  return (
    <li className="flex items-start gap-3 text-[17px] leading-[1.55] text-[#1a1a1a]">
      <span className="mt-[5px] inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full" style={{ backgroundColor: "#10B981" }}>
        <Check className="h-[11px] w-[11px] text-white" strokeWidth={3} />
      </span>
      <span>{children}</span>
    </li>
  );
}

/* ------------------------------------------------------------------ */
/* Oto                                                                 */
/* ------------------------------------------------------------------ */

/** One Oto answer, big enough to read as prose. */
export function AnswerPull({ className = "" }: { className?: string }) {
  return (
    <PullCard className={`w-full p-6 tab:p-8 ${className}`}>
      <div className="flex items-center gap-2.5">
        <span className="flex h-[28px] w-[28px] items-center justify-center rounded-full" style={{ backgroundColor: APP.blue }}>
          <span className="h-[10px] w-[10px] rounded-full bg-white" />
        </span>
        <span className="text-[14px] font-semibold" style={{ color: APP.ink }}>
          Oto
        </span>
      </div>
      <p className="mt-4 text-[18px] leading-[1.55] tab:text-[20px]" style={{ color: APP.text }}>
        A squeal that fades as the brakes warm up is usually the wear indicator on the pads. On your Civic the front pads wear first, and your last brake service on file is 18 months ago.
      </p>
      <p className="mt-3 text-[18px] leading-[1.55] tab:text-[20px]" style={{ color: APP.text }}>
        I would scope a front brake pad replacement and let the shop confirm it on the lift. Nothing is charged before that.
      </p>
      <p className="mt-5 flex items-center gap-1.5 text-[14px] font-medium" style={{ color: APP.blue }}>
        Show thinking <span aria-hidden>⌄</span>
      </p>
    </PullCard>
  );
}

const FAN = [
  { name: "Service History", sub: "Four records on file. Oil change in March, tires in June. No brake work since March 2025.", rot: -3, dx: 0 },
  { name: "Manufacturer Data", sub: "VIN matched to a 2019 Civic EX. Front pad spec and service interval from Honda.", rot: 2, dx: 22 },
  { name: "Error Codes", sub: "None stored. Nothing pointing away from a wear item.", rot: -1.5, dx: 8 },
];

/** The three source cards, fanned. */
export function SourcesFan({ className = "" }: { className?: string }) {
  const reduce = useReducedMotionSafe();
  return (
    <div className={`flex flex-col gap-4 ${className}`}>
      {FAN.map((f, i) => (
        <motion.div
          key={f.name}
          className="rounded-[16px] bg-white p-5"
          style={{ boxShadow: "0 18px 44px rgba(20,40,80,0.14), 0 2px 8px rgba(20,40,80,0.06)", marginLeft: f.dx, ...appFont }}
          initial={reduce ? { opacity: 0 } : { opacity: 0, transform: `translateY(18px) rotate(0deg)` }}
          whileInView={{ opacity: 1, transform: `translateY(0px) rotate(${reduce ? 0 : f.rot}deg)` }}
          viewport={{ once: true, margin: "-15% 0px" }}
          transition={{ duration: reduce ? 0.3 : 0.7, delay: 0.15 + i * 0.12, ease: EASE }}
        >
          <p className="flex items-center gap-2 text-[15px] font-semibold" style={{ color: APP.ink }}>
            <span className="flex h-[18px] w-[18px] items-center justify-center rounded-full" style={{ backgroundColor: "#10B981" }}>
              <Check className="h-[11px] w-[11px] text-white" strokeWidth={3} />
            </span>
            {f.name}
          </p>
          <p className="mt-1.5 text-[13.5px] leading-[1.5]" style={{ color: APP.meta }}>
            {f.sub}
          </p>
        </motion.div>
      ))}
    </div>
  );
}

/** The voice bar, big: "Said, not typed." */
export function VoicePull({ className = "" }: { className?: string }) {
  const reduce = useReducedMotionSafe();
  return (
    <PullCard className={`flex w-[min(100%,380px)] items-center gap-4 px-5 py-4 ${className}`}>
      <span className="flex h-[40px] w-[40px] shrink-0 items-center justify-center rounded-full" style={{ backgroundColor: APP.blue }}>
        <span className="h-[14px] w-[14px] rounded-[3px] bg-white" />
      </span>
      <span className="flex h-[34px] flex-1 items-center gap-[4px]">
        {[10, 18, 26, 14, 22, 11, 30, 19, 10, 24, 15, 27, 17, 9, 20, 12].map((h, i) => (
          <motion.span
            key={i}
            className="w-[4px] rounded-full"
            style={{ backgroundColor: APP.blue, height: h }}
            animate={reduce ? undefined : { scaleY: [1, 0.4, 1] }}
            transition={{ duration: 1.1, repeat: Infinity, delay: i * 0.06, ease: "easeInOut" }}
          />
        ))}
      </span>
      <span className="shrink-0 text-[14px]" style={{ color: APP.meta }}>
        Said, not typed
      </span>
    </PullCard>
  );
}
