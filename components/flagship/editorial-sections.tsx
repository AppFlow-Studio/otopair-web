"use client";

import type { ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { APP, FitZoom, Plate } from "@/components/flagship/product/device";
import { BoroughRail, Step } from "@/components/flagship/product/local";
import { PortalWindow } from "@/components/flagship/product/screens/portal";
import { PullCard } from "@/components/flagship/product/pullouts";
import { BookingsScreen } from "@/components/flagship/product/screens/bookings";
import { BRAKES, ChatScreen, OtoTurn, QuickReplies, UserBubble } from "@/components/flagship/product/screens/chat";
import { Reveal, Seq, Sequence } from "@/components/flagship/landing/reveal";
import { PhoneAt, Rise, SectionHead } from "@/app/(marketing)/pricing/sections";

/**
 * Client compositions for the editorial pages (design pass 2026-09-05,
 * the app up close): download, about, press, careers. Each page gets one
 * real product object where the copy makes a claim about the product,
 * and stays a document everywhere else. Matrix: docs/design/local-pages.md.
 */

/** The download hero: Oto listening, mid-sentence. (Server pages cannot
 *  read BRAKES, a client-module value, so the screen is composed here.) */
export function OtoListening() {
  return (
    <ChatScreen input="voice">
      <UserBubble>{BRAKES.user}</UserBubble>
      <OtoTurn>{BRAKES.question}</OtoTurn>
      <QuickReplies items={BRAKES.chips} on={BRAKES.chips[0]} />
    </ChatScreen>
  );
}

/** A row of phones with a caption under each (download: what you get). */
export function PhoneRow({ items }: { items: { caption: string; sub: string; screen: ReactNode }[] }) {
  return (
    <Plate className="relative" clip>
      <div className="grid gap-10 px-6 pt-10 tab:grid-cols-3 tab:gap-6 tab:px-12 tab:pt-16">
        {items.map((it, i) => (
          <Rise key={it.caption} delay={i * 0.1} className="flex flex-col items-center">
            <p className="serif-text text-center text-[22px] leading-[1.2] text-[#1a1a1a]">{it.caption}</p>
            <p className="mt-2 max-w-[30ch] text-center text-[14.5px] leading-[1.5] text-[#4c5661]">{it.sub}</p>
            {/* Phones: crop each screen to its top half with a soft fade so the
                three captions do not overlap; from tab the phones hang off the
                plate's bottom edge instead. */}
            <div className="mt-7 h-[300px] overflow-hidden [mask-image:linear-gradient(to_bottom,black_62%,transparent)] tab:-mb-[30%] tab:h-auto tab:overflow-visible tab:[mask-image:none]">
              <PhoneAt w={280}>{it.screen}</PhoneAt>
            </div>
          </Rise>
        ))}
      </div>
    </Plate>
  );
}

/** The borough rail on its plate (download: where it works). */
export function WhereItWorks({ liveCount }: { liveCount: number | null }) {
  return (
    <Rise>
      <Plate tone="pale" className="px-6 py-10 tab:px-12 tab:py-14">
        <BoroughRail liveCount={liveCount} />
      </Plate>
    </Rise>
  );
}

/** About: the driver's booking card and the shop's job sheet, one booking
 *  seen from both sides, the estimate confirming itself on each. */
export function TwoSides() {
  return (
    <section className="pb-16 tab:pb-24">
      <Reveal>
        <SectionHead id="two-sides" title="One booking, two sides." line="The driver watches it from the Bookings tab; the shop runs it from the dashboard. Otopair sits between them: it verified the shop, locked the price, and settles the payment through Stripe." />
      </Reveal>
      <Plate className="relative mt-10 tab:mt-14" clip>
        <div className="flex flex-col items-center gap-8 px-6 pt-10 tab:flex-row tab:items-end tab:gap-8 tab:px-10 tab:pt-16">
          <Rise className="order-2 -mb-[30%] tab:order-1 tab:-mb-[10%] tab:shrink-0">
            <PhoneAt w={280}>
              <BookingsScreen stage={1} title="Estimate confirmed, $312" subtitle="Within what you approved" />
            </PhoneAt>
          </Rise>
          <Rise delay={0.15} className="hidden tab:order-2 tab:flex tab:self-center tab:pb-24">
            <span className="flex h-12 w-12 items-center justify-center rounded-full border-[0.5px] border-white/70 bg-white/50 backdrop-blur-[20px]">
              <ArrowRight className="h-5 w-5 text-[#1a1a1a]" strokeWidth={1.8} />
            </span>
          </Rise>
          <Rise delay={0.1} className="order-1 w-full min-w-0 pb-4 tab:order-3 tab:pb-16">
            <FitZoom base={1100}>
              <PortalWindow page="job" estimate="confirmed" />
            </FitZoom>
          </Rise>
        </div>
      </Plate>
    </section>
  );
}

/** Press: the two products in one frame, the driver app in front of the
 *  shop dashboard. */
export function ProductStack() {
  return (
    <Rise>
      <Plate tone="paper" className="relative" clip>
        {/* Phones: the driver app alone, hanging off the plate. From tab: the
            dashboard with the phone in front of its bottom-left corner. */}
        <div className="flex justify-center px-6 pt-10 tab:hidden">
          <div className="-mb-[30%]">
            <PhoneAt w={260}>
              <OtoListening />
            </PhoneAt>
          </div>
        </div>
        <div className="relative hidden px-14 pt-16 tab:block">
          <div className="translate-x-[14%]">
            <FitZoom base={1100}>
              <PortalWindow page="board" />
            </FitZoom>
          </div>
          <div className="absolute bottom-0 left-14 w-[26%] max-w-[260px] translate-y-[22%]">
            <PhoneAt w={260}>
              <OtoListening />
            </PhoneAt>
          </div>
          <div className="h-24" />
        </div>
      </Plate>
    </Rise>
  );
}

/**
 * About: the provenance card. Every value in the vehicle-data catalogue
 * carries the layer it came from (convex/lib/dataLayers.ts); these are the
 * four the product serves. No vendor names, and the two internal-only
 * layers are not listed because they never leave the building.
 */
const LAYERS: [string, string, string][] = [
  ["A", "Official", "Owner's manuals and manufacturer data."],
  ["C", "Researched", "Our own enrichment work, checked against the car's specification."],
  ["D", "Measured", "Timings and parts read from completed Otopair jobs."],
  ["E", "Confirmed", "A mechanic or the Otopair team verified it by hand."],
];

export function DataProvenance({ className = "" }: { className?: string }) {
  return (
    <PullCard className={`w-full p-6 tab:p-7 ${className}`}>
      <p className="text-[12px] font-semibold uppercase tracking-[0.08em]" style={{ color: APP.blue }}>
        Every value carries its source
      </p>
      <p className="mt-2 text-[19px] font-bold leading-[1.2]" style={{ color: APP.ink }}>
        Four layers, one car.
      </p>
      <ul className="mt-5 flex flex-col divide-y" style={{ borderColor: "rgba(0,0,0,0.06)" }}>
        {LAYERS.map(([letter, name, body]) => (
          <li key={letter} className="flex items-start gap-3.5 py-3.5 first:pt-0 last:pb-0" style={{ borderColor: "rgba(0,0,0,0.06)" }}>
            <span className="mt-[1px] flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full text-[12px] font-bold" style={{ backgroundColor: "#5299FE1A", color: APP.blue }}>
              {letter}
            </span>
            <span>
              <span className="block text-[15.5px] font-semibold" style={{ color: APP.ink }}>
                {name}
              </span>
              <span className="mt-[2px] block text-[13.5px] leading-[1.5]" style={{ color: APP.meta }}>
                {body}
              </span>
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-5 text-[13px] leading-[1.5]" style={{ color: APP.meta }}>
        A value the system cannot stand behind is held back rather than shown.
      </p>
    </PullCard>
  );
}

/** Careers: the shop's day as the dashboard shows it, beside the three
 *  products the team builds. */
export function ShopDay() {
  return (
    <Plate tone="paper" className="relative" clip>
      <div className="grid items-center gap-10 px-6 py-10 tab:grid-cols-12 tab:px-14 tab:py-16">
        {/* The order of the three products is the content, but Step renders
            the <li> itself and nothing may come between an <ol> and its items —
            so the list arrives as one block and the note follows a beat later,
            on the same clock. The dashboard beside it keeps its own entrance. */}
        <Sequence className="tab:col-span-4">
          <Seq>
            <ol className="flex flex-col gap-6">
              <Step n={1} title="Oto">
                The assistant that turns &ldquo;it squeals when I brake&rdquo; into a scoped job a shop can price.
              </Step>
              <Step n={2} title="Pricing and booking">
                Holds $20, locks a total built for one exact car, takes approvals inside 24 hours, settles through Stripe.
              </Step>
              <Step n={3} title="The shop dashboard">
                Runs a real garage&rsquo;s day: the board, the job sheet, the estimate, the payout.
              </Step>
            </ol>
          </Seq>
          <Seq at={0.12}>
            <p className="mt-8 max-w-[38ch] text-[15px] leading-[1.55] text-[#777169]">Underneath all three is a vehicle-data asset built from verified shop work.</p>
          </Seq>
        </Sequence>
        <Rise className="tab:col-span-8" delay={0.1}>
          <div className="translate-x-[6%] tab:translate-x-[10%]">
            <FitZoom base={1100}>
              <PortalWindow page="board" landing="Front brake pads" />
            </FitZoom>
          </div>
        </Rise>
      </div>
    </Plate>
  );
}
