"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { FitZoom, Plate } from "@/components/flagship/product/device";
import { BoroughRail, Step, VerifiedPull } from "@/components/flagship/product/local";
import { PortalWindow } from "@/components/flagship/product/screens/portal";
import { BookServiceScreen, CategoryScreen, TABS, servicesInTab, type TabKey } from "@/components/flagship/product/screens/browse";
import { BRAKES, ChatScreen, OtoTurn, QuickReplies, UserBubble } from "@/components/flagship/product/screens/chat";
import { STATEN_ISLAND_PHONE, staticMapSrc } from "@/lib/static-map";
import { useReducedMotionSafe } from "@/components/flagship/shared";
import { PhoneAt, Rise, SectionHead } from "@/app/(marketing)/pricing/sections";

/**
 * Client compositions shared by the local pages (design pass 2026-09-05,
 * "the app, up close" applied to coverage, the boroughs, the Staten
 * Island hub and its service pages, and the shop directory). The server
 * pages keep their data, metadata and structured data and hand these
 * plain props. The composition matrix is in docs/design/local-pages.md.
 */
const EASE = [0.22, 1, 0.36, 1] as const;
const article = (w: string) => (/^[aeiou]/i.test(w) ? "an" : "a");
const PHONE_MAP = staticMapSrc(STATEN_ISLAND_PHONE, 390, 844);

/** The split hero's device: right-aligned from lg, centred below. */
export function HeroPhone({ children, w = 330 }: { children: ReactNode; w?: number }) {
  return (
    <div className="flex justify-center lg:justify-end lg:pr-6">
      <PhoneAt w={w}>{children}</PhoneAt>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Coverage                                                            */
/* ------------------------------------------------------------------ */

export function CoverageSections({ liveCount }: { liveCount: number | null }) {
  return (
    <>
      <section className="pb-16 tab:pb-24">
        <SectionHead id="ladder" title="Which borough is next." line="Brooklyn, then Queens, The Bronx and Manhattan. Each opens once enough verified shops are on the network to book from, and each has a waitlist now." />
        <Rise className="mt-10 tab:mt-14">
          <Plate tone="pale" className="px-6 py-10 tab:px-12 tab:py-14">
            <BoroughRail liveCount={liveCount} />
          </Plate>
        </Rise>
      </section>

      <section className="py-16 tab:py-24">
        <SectionHead id="how" title="Shops first, drivers second." line="A borough opens to drivers once it has verified shops to book from, not on a marketing date. Any New York City shop can start now." />
        <Plate tone="paper" className="relative mt-10 tab:mt-14" clip>
          <div className="grid items-center gap-10 px-6 py-10 tab:grid-cols-12 tab:px-14 tab:py-16">
            <div className="tab:col-span-4">
              <ol className="flex flex-col gap-6">
                <Step n={1} title="Apply">
                  Two minutes on the <Link href="/apply" className="text-[#4B82A5] underline decoration-[#4B82A5]/40 underline-offset-[3px] hover:decoration-[#4B82A5]">application</Link>. No subscription, no setup fee.
                </Step>
                <Step n={2} title="Get verified">
                  Otopair reviews and approves the shop by hand. Stripe, hours, a mechanic and the services it offers are read from its live dashboard.
                </Step>
                <Step n={3} title="Live on opening day">
                  Shops verified ahead of their borough&rsquo;s quarter are bookable the day it opens, at the rates they set.
                </Step>
              </ol>
            </div>
            <Rise className="tab:col-span-8" delay={0.1}>
              <div className="translate-x-[6%] tab:translate-x-[10%]">
                <FitZoom base={1100}>
                  <PortalWindow page="rates" shop="Your shop" />
                </FitZoom>
              </div>
            </Rise>
          </div>
        </Plate>
      </section>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Staten Island hub                                                   */
/* ------------------------------------------------------------------ */

function TabLoopPhone() {
  const reduce = useReducedMotionSafe();
  const [i, setI] = useState(1);
  // Reduced motion: hold Tires & Brakes (the busiest list).
  const idx = reduce ? 1 : i;
  useEffect(() => {
    if (reduce) return;
    const id = window.setInterval(() => setI((x) => (x + 1) % TABS.length), 3600);
    return () => window.clearInterval(id);
  }, [reduce]);
  const tab: TabKey = TABS[idx].key;
  return (
    <div className="flex flex-col items-center">
      <div className="relative">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div key={tab} initial={reduce ? { opacity: 0 } : { opacity: 0, transform: "translateY(10px)" }} animate={{ opacity: 1, transform: "translateY(0px)" }} exit={reduce ? { opacity: 0 } : { opacity: 0, transform: "translateY(-10px)" }} transition={{ duration: 0.36, ease: EASE }}>
            <PhoneAt w={320}>
              <CategoryScreen tab={tab} mapSrc={PHONE_MAP} />
            </PhoneAt>
          </motion.div>
        </AnimatePresence>
      </div>
      <div className="relative z-10 mt-5 flex h-10 items-center justify-center">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={tab}
            className="rounded-full border-[0.5px] border-white/60 bg-white/70 px-4 py-2 text-center text-[13px] tracking-[0.02em] text-[#1a1a1a] backdrop-blur-[20px] shadow-[0_6px_20px_rgba(20,40,80,0.10)]"
            initial={reduce ? { opacity: 0 } : { opacity: 0, transform: "translateY(8px)" }}
            animate={{ opacity: 1, transform: "translateY(0px)" }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, transform: "translateY(-8px)" }}
            transition={{ duration: 0.35, ease: EASE }}
          >
            {TABS[idx].label} · {servicesInTab(tab).length} services
          </motion.span>
        </AnimatePresence>
      </div>
    </div>
  );
}

export function HubServices({ local }: { local: { slug: string; name: string; description: string }[] }) {
  return (
    <section className="py-16 tab:py-24">
      <SectionHead id="services" title="Which services can I book on Staten Island?" line="All 22, in the four lists the app shows. The ten below have their own Staten Island page with the live shop list and the booking steps." />
      <Plate className="relative mt-10 tab:mt-14" clip>
        <div className="grid gap-8 px-6 pt-10 tab:grid-cols-12 tab:items-center tab:px-14 tab:pt-16">
          <div className="relative z-10 pb-4 tab:col-span-7 tab:pb-16">
            <ul className="grid gap-x-8 sm:grid-cols-2">
              {local.map((s) => (
                <li key={s.slug} className="border-b border-[#1a1a1a]/10 py-3.5">
                  <Link href={`/staten-island/${s.slug}`} className="serif-text text-[19px] leading-[1.25] text-[#1a1a1a] transition-colors duration-300 hover:text-[#4B82A5]">
                    {s.name}
                  </Link>
                  <p className="mt-1 text-[13.5px] leading-[1.5] text-[#6b655d]">{s.description}.</p>
                </li>
              ))}
            </ul>
            <p className="mt-5 text-[14.5px] text-[#4c5661]">
              <Link href="/services" className="text-[#4B82A5] underline decoration-[#4B82A5]/40 underline-offset-[3px] hover:decoration-[#4B82A5]">
                The full catalog
              </Link>{" "}
              covers the other twelve. Oto shows you only the services that apply to your car.
            </p>
          </div>
          {/* The phone stays whole (no hang off the plate): its caption chip
              sits under it and a hanging phone clipped both. */}
          <Rise className="flex justify-center pb-10 tab:col-span-5 tab:justify-end tab:pb-16">
            <TabLoopPhone />
          </Rise>
        </div>
      </Plate>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Local service page                                                  */
/* ------------------------------------------------------------------ */

export function ServiceBooking({ slug, name, children }: { slug: string; name: string; children: ReactNode }) {
  return (
    <section className="py-16 tab:py-24">
      <SectionHead id="book" title={`How do I book ${name} on Staten Island?`} line="Ask Oto for it by name, or pick it from the list. Then a shop, a time, and the full total before you confirm. Here is the whole path, as the app runs it." />
      <Plate tone="pale" className="relative mt-10 tab:mt-14" clip>
        <div className="grid items-end gap-8 px-6 pt-10 tab:grid-cols-12 tab:px-14 tab:pt-16">
          <Rise className="order-2 flex justify-center tab:order-1 tab:col-span-5 tab:justify-start">
            <div className="-mb-[30%] tab:-mb-[12%]">
              <PhoneAt w={320}>
                <BookServiceScreen slug={slug} ask={`Can you book me ${article(name)} ${name.toLowerCase()}?`} />
              </PhoneAt>
            </div>
          </Rise>
          <div className="relative z-10 order-1 pb-2 tab:order-2 tab:col-span-7 tab:pb-16">
            <div className="max-w-[56ch] text-[16px] leading-[1.6] text-[#4c5661] [&_ol]:flex [&_ol]:flex-col [&_ol]:gap-3 [&_ol]:pl-7 [&_ol]:[list-style:decimal-leading-zero] [&_ol>li]:pl-1 [&_ol>li::marker]:text-[#4B82A5] [&_strong]:font-medium [&_strong]:text-[#1a1a1a]">{children}</div>
          </div>
        </div>
      </Plate>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Borough pages                                                       */
/* ------------------------------------------------------------------ */

export function BoroughSections({ slug, name, date, liveCount }: { slug: string; name: string; date: string; liveCount: number | null }) {
  return (
    <>
      <section className="pb-16 tab:pb-24">
        <SectionHead id="day-one" title={`What opens in ${name} on day one.`} line="The same product that is live in Staten Island today: Oto, verified shops with the price each one set for your car, and a total that is locked before the car goes in." />
        <Plate className="relative mt-10 tab:mt-14" clip>
          <div className="grid items-end gap-8 px-6 pt-10 tab:grid-cols-12 tab:px-14 tab:pt-16">
            <Rise className="order-2 flex justify-center tab:order-1 tab:col-span-5 tab:justify-start">
              <div className="-mb-[30%] tab:-mb-[12%]">
                <PhoneAt w={320}>
                  <ChatScreen input="idle" animate={false}>
                    <UserBubble>{BRAKES.user}</UserBubble>
                    <OtoTurn thinking={false}>{BRAKES.question}</OtoTurn>
                    <QuickReplies items={BRAKES.chips} on={BRAKES.chips[0]} />
                    <OtoTurn>{BRAKES.answer}</OtoTurn>
                  </ChatScreen>
                </PhoneAt>
              </div>
            </Rise>
            <div className="relative z-10 order-1 grid gap-8 pb-2 tab:order-2 tab:col-span-7 tab:pb-16">
              <div>
                <h3 className="serif-text text-[22px] leading-[1.2] text-[#1a1a1a]">For drivers</h3>
                <p className="mt-3 max-w-[46ch] text-[16px] leading-[1.6] text-[#4c5661]">
                  You tell Oto what your car is doing. Oto turns that into a scoped job, shows you verified shops nearby with the price each one set, and locks the price when you book. A $20 hold reserves the slot; the locked price is what you pay, and any extra work has to be approved by you in the app first.
                </p>
                <p className="mt-3 text-[15px] text-[#4c5661]">
                  Until {name} opens, a {name} driver can book a Staten Island shop today.
                </p>
              </div>
              <div>
                <h3 className="serif-text text-[22px] leading-[1.2] text-[#1a1a1a]">For {name} repair shops</h3>
                <p className="mt-3 max-w-[46ch] text-[16px] leading-[1.6] text-[#4c5661]">
                  Applications are open now, and {name} shops that join ahead of {date} are the ones live on opening day. Otopair sends booked, pre-diagnosed customers at a price you set, runs payment through Stripe, and charges no subscription and no setup fee.
                </p>
                <p className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[15px]">
                  <Link href="/partner-with-us" className="text-[#4B82A5] underline decoration-[#4B82A5]/40 underline-offset-[3px] hover:decoration-[#4B82A5]">
                    How the network works for shops
                  </Link>
                  <Link href="/apply" className="text-[#4B82A5] underline decoration-[#4B82A5]/40 underline-offset-[3px] hover:decoration-[#4B82A5]">
                    Apply in two minutes
                  </Link>
                </p>
              </div>
            </div>
          </div>
        </Plate>
      </section>

      <section className="py-16 tab:py-24">
        <SectionHead id="ladder" title={`Where ${name} sits on the ladder.`} line="One borough at a time. Staten Island is live; the rest open in order, each once it has verified shops to book from." />
        <Rise className="mt-10 tab:mt-14">
          <Plate tone="pale" className="px-6 py-10 tab:px-12 tab:py-14">
            <BoroughRail current={slug} liveCount={liveCount} />
          </Plate>
        </Rise>
      </section>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Shop directory                                                      */
/* ------------------------------------------------------------------ */

export function ShopsVerified() {
  return (
    <section className="py-16 tab:py-24">
      <SectionHead id="verified" title="What verified means." line="A verified shop is one Otopair approved by hand, with three more things read from its live account, not from a form." />
      <Plate tone="paper" className="relative mt-10 tab:mt-14" clip>
        <div className="grid items-center gap-10 px-6 py-10 tab:grid-cols-12 tab:px-14 tab:py-16">
          <div className="relative z-10 tab:col-span-5">
            <VerifiedPull />
          </div>
          <Rise className="tab:col-span-7" delay={0.1}>
            <div className="translate-x-[6%] tab:translate-x-[12%]">
              <FitZoom base={1100}>
                <PortalWindow page="rates" shop="Your shop" />
              </FitZoom>
            </div>
          </Rise>
        </div>
      </Plate>
    </section>
  );
}
