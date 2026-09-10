"use client";

import { Check } from "lucide-react";
import { FitZoom, Plate } from "@/components/flagship/product/device";
import { PullCard } from "@/components/flagship/product/pullouts";
import { PortalWindow } from "@/components/flagship/product/screens/portal";
import { APP } from "@/components/flagship/product/device";
import { Rise, SectionHead } from "../pricing/sections";

/**
 * /partner-with-us sections: the shop dashboard in a browser window.
 *  1. The board, with the new booking landing on it and the booking card
 *     lifted out (what the shop actually receives).
 *  2. The job sheet after inspection, the estimate confirming itself.
 *  3. Payouts, and the three numbers a shop asks about first.
 */
function BookingPull() {
  return (
    <PullCard className="w-[min(100%,380px)] p-5" delay={0.2}>
      <p className="text-[11px] font-semibold uppercase tracking-[0.08em]" style={{ color: APP.blue }}>
        New booking · awaiting you
      </p>
      <p className="mt-2 text-[18px] font-bold leading-[22px]" style={{ color: APP.ink }}>
        Front brake pads
      </p>
      <p className="text-[14px]" style={{ color: APP.meta }}>
        2019 Honda Civic EX · Dee Ramos
      </p>
      <p className="mt-3 text-[14px] italic leading-[1.5]" style={{ color: APP.body }}>
        &ldquo;Squeaks when I brake, mostly first thing in the morning.&rdquo;
      </p>
      <div className="mt-4 flex flex-col gap-[6px] text-[14px]" style={{ color: APP.body }}>
        <span className="flex justify-between">
          <span>Requested</span>
          <span className="font-semibold" style={{ color: APP.ink }}>
            Tue, Sep 9 · 9:40 AM
          </span>
        </span>
        <span className="flex justify-between">
          <span>Your total for this car</span>
          <span className="font-semibold" style={{ color: APP.ink }}>
            $312.00
          </span>
        </span>
        <span className="flex justify-between">
          <span>On the driver&apos;s card</span>
          <span className="font-semibold" style={{ color: APP.ink }}>
            $20 hold
          </span>
        </span>
      </div>
      <div className="mt-4 flex gap-2">
        <span className="flex h-[42px] flex-1 items-center justify-center gap-1.5 rounded-[10px] bg-[#1a1a1a] text-[14px] font-semibold text-white">
          <Check className="h-[14px] w-[14px]" strokeWidth={2.5} />
          Accept
        </span>
        <span className="flex h-[42px] flex-1 items-center justify-center rounded-[10px] border text-[14px] font-medium" style={{ borderColor: "rgba(26,26,26,0.14)", color: APP.ink }}>
          Propose reschedule
        </span>
      </div>
    </PullCard>
  );
}

export function PartnerSections() {
  return (
    <>
      {/* 1 · a booking lands */}
      <section id="lands" className="scroll-mt-28 pb-16 tab:pb-24">
        <SectionHead title="A booking lands on your board." line="Oto scopes the job from the driver's own words and shows your total for their exact car. It arrives with a $20 hold already on the card." />
        <Plate className="relative mt-10 tab:mt-14" clip>
          <Rise className="px-4 pt-8 tab:px-12 tab:pt-14">
            <div className="-mb-[6%] tab:-mb-[4%]">
              <FitZoom base={1100}>
                <PortalWindow page="board" landing="Front brake pads" />
              </FitZoom>
            </div>
          </Rise>
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[30%] bg-[linear-gradient(to_top,#ffffff_10%,rgba(255,255,255,0))]" aria-hidden />
          <div className="relative z-10 -mt-[18%] flex justify-center px-6 pb-8 tab:-mt-[14%] tab:justify-end tab:px-14 tab:pb-12">
            <BookingPull />
          </div>
        </Plate>
      </section>

      {/* 2 · confirm after inspection */}
      <section className="py-16 tab:py-24">
        <SectionHead id="confirm" title="You confirm the price after inspection." line="Inside what the driver approved, it confirms itself. Above it, the driver has 24 hours to say yes. Nothing is settled from memory at pickup." />
        <Plate tone="pale" className="relative mt-10 tab:mt-14" clip>
          <Rise className="px-4 pt-8 tab:px-12 tab:pt-14">
            <div className="-mb-[3%]">
              <FitZoom base={1100}>
                <PortalWindow page="job" step={2} />
              </FitZoom>
            </div>
          </Rise>
        </Plate>
        <ul className="mt-8 grid gap-x-10 gap-y-3 text-[15.5px] leading-[1.55] text-[#4c5661] tab:grid-cols-3">
          <li>
            <span className="text-[#1a1a1a]">Inspect first.</span> You confirm the estimate in the job sheet with the car on the lift.
          </li>
          <li>
            <span className="text-[#1a1a1a]">Within the approved figure</span> it confirms on its own. No call, no counter.
          </li>
          <li>
            <span className="text-[#1a1a1a]">Unforeseen scope</span> goes to the driver in the app. Declined work is never charged; you complete what was booked.
          </li>
        </ul>
      </section>

      {/* 3 · paid through Stripe */}
      <section className="py-16 tab:py-24">
        <SectionHead id="paid" title="You get paid through Stripe." line="Funds are captured when you mark the job complete and paid out on Stripe's schedule. No subscription, no setup fee, no invoices to chase." />
        <div className="mt-10 grid items-start gap-8 tab:mt-14 tab:grid-cols-12 tab:gap-10">
          <div className="tab:col-span-8">
            <Plate tone="paper" className="relative" clip>
              <Rise className="px-4 pt-8 tab:px-8 tab:pt-10">
                <div className="-mb-[3%]">
                  <FitZoom base={1100}>
                    <PortalWindow page="payouts" />
                  </FitZoom>
                </div>
              </Rise>
            </Plate>
          </div>
          <dl className="grid grid-cols-3 gap-6 tab:col-span-4 tab:grid-cols-1 tab:gap-0 tab:divide-y tab:divide-[#1a1a1a]/10">
            {[
              ["100%", "of your rate, to you"],
              ["$0", "subscription"],
              ["$0", "setup fee"],
            ].map(([v, l]) => (
              <div key={l} className="tab:py-6 first:tab:pt-0">
                <dt className="sr-only">{l}</dt>
                <dd>
                  <span className="serif-display block text-[40px] leading-none text-[#1a1a1a] tab:text-[52px]">{v}</span>
                  <span className="mt-2 block text-[13px] tracking-[0.02em] text-[#777169] tab:text-[14px]">{l}</span>
                </dd>
              </div>
            ))}
          </dl>
        </div>
        <p className="mt-8 max-w-[62ch] text-[15.5px] leading-[1.55] text-[#4c5661]">
          Stripe verifies your identity and payout bank details, not Otopair. The captured amount is the price the driver confirmed in the app, paid to your bank on Stripe&apos;s payout schedule.
        </p>
      </section>
    </>
  );
}

