"use client";

import { Clock, UserX } from "lucide-react";
import { APP, FitZoom, Plate } from "@/components/flagship/product/device";
import { PullCard } from "@/components/flagship/product/pullouts";
import { PortalWindow } from "@/components/flagship/product/screens/portal";
import { Rise, SectionHead } from "../pricing/sections";

/**
 * /for-shops sections: a tour of the shop dashboard, one window per
 * section, each cropped differently so the page does not repeat itself.
 *  1. Rates and services: the settings page, full width.
 *  2. The rules: the job sheet waiting on a driver, with the two rules
 *     that protect the shop lifted out beside it.
 *  3. The desk: the day board, full width, and what each seat sees.
 */
function RulesPull() {
  return (
    <PullCard className="w-[min(100%,420px)] overflow-hidden" delay={0.15}>
      {[
        {
          icon: UserX,
          t: "A no-show keeps the $20 for you.",
          b: "The appointment time passes with no arrival, the app reminds the driver, then asks your desk. Mark it a no-show and the deposit is captured to the shop.",
        },
        {
          icon: Clock,
          t: "An unanswered estimate captures the $20 for the inspection.",
          b: "You sent added scope; the driver has 24 hours. If nobody decides, the $20 covers your inspection time and the car is returned.",
        },
      ].map((r, i) => (
        <div key={r.t} className={`flex gap-4 p-5 ${i > 0 ? "border-t" : ""}`} style={i > 0 ? { borderColor: "rgba(0,0,0,0.06)" } : undefined}>
          <span className="mt-[2px] flex h-[36px] w-[36px] shrink-0 items-center justify-center rounded-full" style={{ backgroundColor: "#EBF5FB" }}>
            <r.icon className="h-[17px] w-[17px]" style={{ color: "#4B82A5" }} strokeWidth={1.8} />
          </span>
          <span>
            <span className="block text-[16px] font-semibold leading-[1.3]" style={{ color: APP.ink }}>
              {r.t}
            </span>
            <span className="mt-1.5 block text-[13.5px] leading-[1.5]" style={{ color: APP.meta, fontFamily: "Inter, system-ui, sans-serif" }}>
              {r.b}
            </span>
          </span>
        </div>
      ))}
    </PullCard>
  );
}

export function ForShopsSections() {
  return (
    <>
      {/* 1 · rates */}
      <section className="pb-16 tab:pb-24">
        <SectionHead id="rates" title="Your rates. Your tiers. Your services." line="A labor rate for each vehicle tier you take, a flat price where you want one, and any of the 22 services on or off. Otopair never discounts or negotiates it." />
        <Plate className="relative mt-10 tab:mt-14" clip>
          <Rise className="px-4 pt-8 tab:px-12 tab:pt-14">
            <div className="-mb-[3%]">
              <FitZoom base={1100}>
                <PortalWindow page="rates" />
              </FitZoom>
            </div>
          </Rise>
        </Plate>
      </section>

      {/* 2 · rules */}
      <section className="py-16 tab:py-24">
        <SectionHead id="rules" title="Rules that protect the shop, too." line="A no-show keeps the $20 deposit for you. An estimate left unanswered for 24 hours captures the $20 for the inspection." />
        <Plate tone="pale" className="relative mt-10 tab:mt-14" clip>
          <Rise className="px-4 pt-8 tab:px-12 tab:pt-14">
            <div className="-mb-[8%] tab:-mb-[6%]">
              <FitZoom base={1100}>
                <PortalWindow page="job" step={2} estimate="awaiting" />
              </FitZoom>
            </div>
          </Rise>
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[34%] bg-[linear-gradient(to_top,#ffffff_10%,rgba(255,255,255,0))]" aria-hidden />
          <div className="relative z-10 -mt-[20%] flex justify-center px-6 pb-8 tab:-mt-[16%] tab:justify-start tab:px-14 tab:pb-12">
            <RulesPull />
          </div>
        </Plate>
      </section>

      {/* 3 · the desk */}
      <section className="py-16 tab:py-24">
        <SectionHead id="desk" title="One dashboard for the desk." line="Schedule, bookings, rates, team, messages and payments. Mechanics sign in to their own view and see the job, never the driver's approved figure." />
        <Plate tone="paper" className="relative mt-10 tab:mt-14" clip>
          <Rise className="px-4 pt-8 tab:px-12 tab:pt-14">
            <div className="-mb-[3%]">
              <FitZoom base={1100}>
                <PortalWindow page="board" nowAt={2.6} />
              </FitZoom>
            </div>
          </Rise>
        </Plate>
        <ul className="mt-8 grid gap-x-10 gap-y-3 text-[15.5px] leading-[1.55] text-[#4c5661] tab:grid-cols-3">
          <li>
            <span className="text-[#1a1a1a]">The owner</span> sets rates, hours, services and the team, and sees payouts.
          </li>
          <li>
            <span className="text-[#1a1a1a]">The desk</span> runs the board: accept, reschedule, walk-ins, messages with the driver.
          </li>
          <li>
            <span className="text-[#1a1a1a]">Each mechanic</span> signs in to their own column and job sheets. Progress, parts, inspection notes. Not the price.
          </li>
        </ul>
      </section>
    </>
  );
}
