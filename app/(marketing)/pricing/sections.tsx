"use client";

import type { ReactNode } from "react";
import { motion } from "motion/react";
import { ArrowRight } from "lucide-react";
import { PHONE_W, Plate, Zoom } from "@/components/flagship/product/device";
import { BreakdownPull, LifecyclePull } from "@/components/flagship/product/pullouts";
import { ReviewPayScreen } from "@/components/flagship/product/screens/pay";
import { ApproveEstimateScreen, BookingsScreen } from "@/components/flagship/product/screens/bookings";
import { useReducedMotionSafe } from "@/components/flagship/shared";

/**
 * /pricing sections. Three compositions, one idea each:
 *  1. The breakdown: the Review & Pay screen on a sky plate with its
 *     Service Breakdown card lifted out and enlarged beside it.
 *  2. The hold: the three-row payment lifecycle as one big receipt on a
 *     paper plate, no device.
 *  3. The ceiling: the two screens of the approval flow side by side,
 *     the amber banner in the Bookings tab and the approve screen it opens.
 */
const EASE = [0.22, 1, 0.36, 1] as const;
export const H2 = "serif-display max-w-[15ch] text-[32px] leading-[1.04] tracking-[-0.01em] text-[#1a1a1a] [text-wrap:balance] tab:text-[42px]";
export const LEAD = "max-w-[46ch] text-[17px] leading-[1.55] text-[#4c5661] [text-wrap:pretty]";

export function SectionHead({ id, title, line, className = "" }: { id?: string; title: string; line: string; className?: string }) {
  return (
    <div id={id} className={`grid gap-3 scroll-mt-28 tab:grid-cols-12 tab:items-end tab:gap-8 ${className}`}>
      <h2 className={`${H2} tab:col-span-6`}>{title}</h2>
      <p className={`${LEAD} tab:col-span-5 tab:col-start-8 tab:pb-1`}>{line}</p>
    </div>
  );
}

export function Rise({ children, delay = 0, className = "" }: { children: ReactNode; delay?: number; className?: string }) {
  const reduce = useReducedMotionSafe();
  return (
    <motion.div
      className={className}
      initial={reduce ? { opacity: 0 } : { opacity: 0, transform: "translateY(22px)" }}
      whileInView={{ opacity: 1, transform: "translateY(0px)" }}
      viewport={{ once: true, margin: "-12% 0px" }}
      transition={{ duration: reduce ? 0.3 : 0.8, delay, ease: EASE }}
    >
      {children}
    </motion.div>
  );
}

/** A full PhoneShell screen shown at `w` px, stepping down below `tab` (max 260). */
export function PhoneAt({ w, children }: { w: number; children: ReactNode }) {
  return (
    <>
      <div className="tab:hidden">
        <Zoom width={Math.min(w, 260)} base={PHONE_W + 20}>{children}</Zoom>
      </div>
      <div className="hidden tab:block">
        <Zoom width={w} base={PHONE_W + 20}>{children}</Zoom>
      </div>
    </>
  );
}

export function PricingSections() {
  return (
    <>
      {/* 1 · the breakdown */}
      <section className="pb-16 tab:pb-24">
        <SectionHead id="breakdown" title="The shop sets it. You see all of it." line="Labor, parts, tax and the service fee, built for your exact car, before you confirm. Nothing is added after." />
        <Plate className="relative mt-10 tab:mt-14" clip>
          <div className="grid items-end gap-8 px-6 pt-10 tab:grid-cols-12 tab:px-14 tab:pt-16">
            <Rise className="flex justify-center tab:col-span-6 tab:justify-start">
              <div className="-mb-[22%] tab:-mb-[16%]">
                <PhoneAt w={340}>
                  <ReviewPayScreen compact />
                </PhoneAt>
              </div>
            </Rise>
            <div className="relative z-10 pb-10 tab:col-span-6 tab:pb-16">
              <BreakdownPull className="mx-auto tab:mx-0 tab:ml-auto" />
            </div>
          </div>
        </Plate>
      </section>

      {/* 2 · the hold */}
      <section className="py-16 tab:py-24">
        <SectionHead id="hold" title="Twenty dollars, then nothing until inspection." line="Booking places a $20 hold on your card. It is an authorization, not a charge, and the most held before the shop sees the car." />
        <Rise className="mt-10 tab:mt-14">
          <Plate tone="paper" className="p-3 tab:p-5">
            <LifecyclePull />
          </Plate>
        </Rise>
      </section>

      {/* 3 · the ceiling */}
      <section className="py-16 tab:py-24">
        <SectionHead id="ceiling" title="It cannot go up without you." line="What you approve at booking is a ceiling. Anything above it comes to you in the app, with 24 hours to say yes or no." />
        <Plate className="relative mt-10 tab:mt-14" clip>
          <div className="flex flex-col items-center gap-8 px-6 pt-10 tab:flex-row tab:items-end tab:justify-center tab:gap-12 tab:px-14 tab:pt-16">
            <Rise className="-mb-[30%] tab:-mb-[12%]">
              <PhoneAt w={300}>
                <BookingsScreen stage={2} approval title="Marcus started at 10:05 AM" subtitle="Front pads off, rotors checked" />
              </PhoneAt>
            </Rise>
            <Rise delay={0.15} className="hidden tab:flex tab:self-center tab:pb-28">
              <span className="flex h-12 w-12 items-center justify-center rounded-full border-[0.5px] border-white/70 bg-white/50 backdrop-blur-[20px]">
                <ArrowRight className="h-5 w-5 text-[#1a1a1a]" strokeWidth={1.8} />
              </span>
            </Rise>
            <Rise delay={0.1} className="-mb-[30%] tab:-mb-[4%]">
              <PhoneAt w={300}>
                <ApproveEstimateScreen />
              </PhoneAt>
            </Rise>
          </div>
        </Plate>
        <ul className="mt-8 grid gap-x-10 gap-y-3 text-[15.5px] leading-[1.55] text-[#4c5661] tab:grid-cols-3">
          <li>
            <span className="text-[#1a1a1a]">Within what you approved</span>, the estimate confirms on its own and the job moves.
          </li>
          <li>
            <span className="text-[#1a1a1a]">Above it</span>, the shop sends the added work and its price. You have 24 hours to answer.
          </li>
          <li>
            <span className="text-[#1a1a1a]">Decline</span>, and it is stripped from the job and never charged. The shop completes what you booked.
          </li>
        </ul>
      </section>
    </>
  );
}
