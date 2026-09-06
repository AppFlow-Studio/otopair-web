"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, ChevronRight, Clock } from "lucide-react";
import { Plate } from "@/components/flagship/product/device";
import { PullCard } from "@/components/flagship/product/pullouts";
import { CheckinScreen, HealthRing, HealthScreen, MyCarsScreen } from "@/components/flagship/product/screens/cars";
import { APP, appFont } from "@/components/flagship/product/device";
import { useReducedMotionSafe } from "@/components/flagship/shared";
import { PhoneAt, Rise, SectionHead } from "../pricing/sections";

/**
 * /vehicle-health-score sections.
 *  1. The number: the Vehicle Health sheet in the phone, and the same
 *     score lifted out at web scale with the five items it grades.
 *  2. What moves it: ONE phone that flips between today and after the tire
 *     rotation on a loop (the score climbs, the Tires row turns on time),
 *     with the three things that move the number beside it.
 *  3. The check-in: the quarterly screen and the banner that opens it.
 */
const EASE = [0.22, 1, 0.36, 1] as const;

/* The five items the score grades, in the tracker's tiers (NOW / SOON /
   HEALTHY), the same chips the app and the home page panel use. */
const TIERS: { tier: "now" | "soon" | "healthy"; label: string; bg: string; fg: string; dot: string; items: { name: string; sub: string }[] }[] = [
  { tier: "now", label: "NOW", bg: "#FEF2F2", fg: "#B91C1C", dot: "#EF4444", items: [{ name: "Tires", sub: "Rotation 1,200 mi overdue" }] },
  { tier: "soon", label: "SOON", bg: "#FFFBEB", fg: "#B45309", dot: "#F59E0B", items: [{ name: "Brakes", sub: "Front pads due soon" }] },
  {
    tier: "healthy",
    label: "HEALTHY · 3",
    bg: "#ECFDF5",
    fg: "#059669",
    dot: "#059669",
    items: [
      { name: "Oil change", sub: "3 months remaining" },
      { name: "12-volt battery", sub: "In good standing" },
      { name: "State inspection", sub: "Passed Mar 2026" },
    ],
  },
];

function ScorePull() {
  return (
    <PullCard className="w-[min(100%,420px)] p-7">
      <div className="flex items-center gap-7">
        <HealthRing score={81} size={132} />
        <div>
          <p className="text-[17px] font-bold" style={{ color: APP.ink }}>
            2019 Honda Civic EX
          </p>
          <p className="mt-1 text-[13.5px] leading-[1.45]" style={{ color: APP.meta }}>
            41,200 mi · confirmed Sep 2
          </p>
          <p className="mt-2 text-[13.5px] leading-[1.45]" style={{ color: APP.meta }}>
            Upkeep, not a diagnosis.
          </p>
        </div>
      </div>
      <div className="mt-5 flex flex-col gap-1">
        {TIERS.map((t) => (
          <div key={t.tier}>
            <span className="mb-1.5 mt-2 inline-flex items-center gap-[6px] rounded-[8px] px-2 py-1" style={{ backgroundColor: t.bg }}>
              <span className="h-[8px] w-[8px] rounded-full" style={{ backgroundColor: t.dot }} />
              <span className="text-[11px] font-bold uppercase tracking-[0.06em]" style={{ color: t.fg }}>
                {t.label}
              </span>
            </span>
            {t.items.map((it) => (
              <div key={it.name} className="flex items-center justify-between py-[7px]">
                <span>
                  <span className="block text-[15px] font-medium" style={{ color: APP.ink }}>
                    {it.name}
                  </span>
                  <span className="block text-[12.5px]" style={{ color: APP.meta }}>
                    {it.sub}
                  </span>
                </span>
                {t.tier === "healthy" ? (
                  <span className="flex h-[20px] w-[20px] items-center justify-center rounded-full" style={{ backgroundColor: APP.blue }}>
                    <Check className="h-[12px] w-[12px] text-white" strokeWidth={3} />
                  </span>
                ) : (
                  <ChevronRight className="h-[16px] w-[16px]" style={{ color: "#C7C7CC" }} />
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    </PullCard>
  );
}

function MovesPhone() {
  const reduce = useReducedMotionSafe();
  const [flip, setFlip] = useState(false);
  // Reduced motion: hold the final frame (after the rotation) instead of looping.
  const after = reduce ? true : flip;
  useEffect(() => {
    if (reduce) return;
    const id = window.setInterval(() => setFlip((a) => !a), 3600);
    return () => window.clearInterval(id);
  }, [reduce]);
  return (
    <div className="flex flex-col items-center">
      <PhoneAt w={310}>
        <MyCarsScreen score={after ? 88 : 81} rotated={after} />
      </PhoneAt>
      <div className="relative z-10 mt-5 flex h-10 items-center justify-center">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={after ? "after" : "before"}
            className="whitespace-nowrap rounded-full border-[0.5px] border-white/60 bg-white/70 px-4 py-2 text-[13px] tracking-[0.02em] text-[#1a1a1a] backdrop-blur-[20px] shadow-[0_6px_20px_rgba(20,40,80,0.10)]"
            initial={reduce ? { opacity: 0 } : { opacity: 0, transform: "translateY(8px)" }}
            animate={{ opacity: 1, transform: "translateY(0px)" }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, transform: "translateY(-8px)" }}
            transition={{ duration: 0.35, ease: EASE }}
          >
            {after ? "Tire rotation logged · 81 to 88" : "Today · tires 1,200 mi overdue"}
          </motion.span>
        </AnimatePresence>
      </div>
    </div>
  );
}

function CheckinPull() {
  return (
    <PullCard className="w-[min(100%,400px)] p-5" delay={0.1}>
      <div className="flex items-center gap-4 rounded-[14px] border px-4 py-3" style={{ backgroundColor: "#FFFBEB", borderColor: "#FDE68A", ...appFont }}>
        <Clock className="h-[22px] w-[22px] shrink-0" style={{ color: "#F59E0B" }} />
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] font-semibold" style={{ color: APP.ink }}>
            Time for a quick update
          </span>
          <span className="block text-[13px]" style={{ color: APP.meta }}>
            Info last updated 3 months ago
          </span>
        </span>
        <span className="text-[13px] font-semibold" style={{ color: APP.blue }}>
          Start
        </span>
      </div>
      <ul className="mt-5 flex flex-col gap-3 text-[15px] leading-[1.5]" style={{ color: "#4c5661", fontFamily: "Inter, system-ui, sans-serif" }}>
        <li>
          <span className="text-[#1a1a1a]">Every 90 days.</span> Three questions: your mileage, anything done elsewhere, any warning lights.
        </li>
        <li>
          <span className="text-[#1a1a1a]">About 30 seconds.</span> Skip it and the score is shown as an estimate until you answer.
        </li>
        <li>
          <span className="text-[#1a1a1a]">Nothing is read from the car.</span> No telematics, no connected-car feed. What you confirm is what it knows.
        </li>
      </ul>
    </PullCard>
  );
}

export function HealthSections() {
  return (
    <>
      {/* 1 · one number */}
      <section className="pb-16 tab:pb-24">
        <SectionHead id="number" title="One number for your exact car." line="Oil, brakes, tires, the 12-volt battery and your state inspection, graded from their intervals and what shops measure. Upkeep, not a diagnosis." />
        <Plate className="relative mt-10 tab:mt-14" clip>
          <div className="grid items-end gap-8 px-6 pt-10 tab:grid-cols-12 tab:px-14 tab:pt-16">
            <Rise className="flex justify-center tab:col-span-6 tab:justify-start">
              <div className="-mb-[22%] tab:-mb-[14%]">
                <PhoneAt w={340}>
                  <HealthScreen score={81} />
                </PhoneAt>
              </div>
            </Rise>
            <div className="relative z-10 pb-10 tab:col-span-6 tab:pb-16">
              <ScorePull />
            </div>
          </div>
        </Plate>
      </section>

      {/* 2 · what moves it */}
      <section className="py-16 tab:py-24">
        <SectionHead id="moves" title="Only real upkeep moves it." line="Complete a due service, clear a warning light or let a shop inspect the car. Nothing you buy changes the number." />
        <Plate tone="pale" className="relative mt-10 tab:mt-14">
          <div className="grid items-center gap-10 px-6 py-10 tab:grid-cols-12 tab:px-14 tab:py-16">
            <div className="tab:col-span-5">
              <ol className="flex flex-col gap-6">
                {[
                  ["A due service gets done", "Your booking completes, or you log one done elsewhere. The item goes back to on time."],
                  ["A warning light clears", "Report it and the deduction goes; report a new one and it counts against the score."],
                  ["A shop inspects the car", "A mechanic's measurements land on the record shortly after the visit closes."],
                ].map(([t, b], i) => (
                  <li key={t} className="flex gap-4">
                    <span className="serif shrink-0 text-[15px] tabular-nums text-[#4B82A5]">0{i + 1}.</span>
                    <span>
                      <span className="block text-[18px] text-[#1a1a1a]" style={{ fontFamily: "var(--font-Petrona)", fontWeight: 400 }}>
                        {t}
                      </span>
                      <span className="mt-1 block max-w-[38ch] text-[15px] leading-[1.55] text-[#4c5661]">{b}</span>
                    </span>
                  </li>
                ))}
              </ol>
              <p className="mt-8 max-w-[38ch] text-[15px] leading-[1.55] text-[#777169]">Rewards, referrals and anything you pay for on the site change nothing here. There is no way to buy a higher score.</p>
            </div>
            <div className="flex justify-center tab:col-span-7">
              <MovesPhone />
            </div>
          </div>
        </Plate>
      </section>

      {/* 3 · the check-in */}
      <section className="py-16 tab:py-24">
        <SectionHead id="checkin" title="A quick check-in keeps it true." line="Every 90 days the app asks for your mileage, anything done elsewhere and any warning lights. Answer, and the score stays current." />
        <Plate tone="paper" className="relative mt-10 tab:mt-14" clip>
          <div className="grid items-end gap-8 px-6 pt-10 tab:grid-cols-12 tab:px-14 tab:pt-16">
            <div className="relative z-10 order-2 pb-10 tab:order-1 tab:col-span-6 tab:pb-16">
              <CheckinPull />
            </div>
            <Rise className="order-1 flex justify-center tab:order-2 tab:col-span-6 tab:justify-end">
              <div className="-mb-[22%] tab:-mb-[12%]">
                <PhoneAt w={320}>
                  <CheckinScreen step={2} picked="All good" />
                </PhoneAt>
              </div>
            </Rise>
          </div>
        </Plate>
      </section>
    </>
  );
}
