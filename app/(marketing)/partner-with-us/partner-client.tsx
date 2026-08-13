"use client";

import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Reveal, Sequence, Seq, SeqRule, serif } from "@/components/flagship/landing/reveal";
import NetworkGraph from "@/components/flagship/landing/network-graph";

const HOW_IT_WORKS = [
  {
    num: "01.",
    title: "Drivers find you",
    body: "Oto sends you booked customers with the job already diagnosed and scoped — no cold calls, no guesswork.",
  },
  {
    num: "02.",
    title: "The price is locked",
    body: "You set the price, Oto locks it. No haggling, no phone tag, no surprises at pickup.",
  },
  {
    num: "03.",
    title: "You get paid fast",
    body: "Payments run through Stripe and land straight in your account after the job is done.",
  },
  {
    num: "04.",
    title: "Grow on the network",
    body: "One dashboard for bookings, parts, and payouts — plus repeat business as the network grows around you.",
  },
];

const STATS = [
  { value: "$0", lines: ["setup fee", "to join the network"] },
  { value: "1", lines: ["dashboard for", "your whole shop"] },
  { value: "Both", lines: ["iOS + Android", "drivers reach you"] },
  { value: "24h", lines: ["typical payout", "after a completed job"] },
];

export default function PartnerClient() {
  return (
    <div className="w-full">
      {/* ---------- Hero ---------- */}
      <section className="mx-auto w-full max-w-[1120px] px-4 pt-[150px] text-center sm:px-10">
        <Reveal>
          <p className="text-[13px] tracking-[0.14em] text-[#777169]">FOR REPAIR SHOPS</p>
        </Reveal>
        <Reveal delay={0.05}>
          <h1
            className="mx-auto mt-4 max-w-[16ch] text-[42px] leading-[1.04] text-[#1a1a1a] sm:text-[52px] lg:text-[58px]"
            style={serif}
          >
            Fill your bays. Skip the phone tag.
          </h1>
        </Reveal>
        <Reveal delay={0.1}>
          <p className="mx-auto mt-6 max-w-[52ch] text-[17px] leading-relaxed text-[#6b655d]">
            Otopair sends you booked, pre-diagnosed customers at a price you set — and pays
            you fast. Join the network of shops growing without chasing calls.
          </p>
        </Reveal>
        <Reveal delay={0.15}>
          <div className="mt-9 flex justify-center">
            <Button asChild size="lg" className="bg-[#5299fe] px-7 text-white hover:bg-[#5299fe]/90">
              <Link href="/apply">
                Apply to partner
                <ChevronRight className="size-4" />
              </Link>
            </Button>
          </div>
        </Reveal>
      </section>

      {/* ---------- Network + how it works ---------- */}
      <section className="mx-auto w-full max-w-[1440px] px-4 pt-28 sm:px-10 sm:pt-36 lg:px-[78px]">
        <Reveal>
          <p className="text-[13px] tracking-[0.14em] text-[#777169]">THE NETWORK</p>
          <h2
            className="mt-3 max-w-[720px] text-[36px] leading-[1.05] text-[#1a1a1a] sm:text-[46px] lg:text-[54px]"
            style={serif}
          >
            Grow your shop on Otopair
          </h2>
        </Reveal>

        <div className="mt-14 grid grid-cols-1 items-center gap-10 lg:grid-cols-2 lg:gap-16">
          <Reveal delay={0.05}>
            <NetworkGraph />
          </Reveal>

          <div>
            <p className="text-[13px] tracking-[0.14em] text-[#777169]">HERE&apos;S HOW IT WORKS</p>
            <Sequence className="mt-6" delay={0.05}>
              {HOW_IT_WORKS.map((item, i) => (
                <div key={item.num}>
                  {i > 0 && <SeqRule at={i * 0.1} className="my-6 h-px w-full bg-[#1a1a1a]/12" />}
                  <Seq at={i * 0.1 + 0.02}>
                    <div className="flex gap-5">
                      <span className="text-[17px] text-[#5299fe]" style={serif}>
                        {item.num}
                      </span>
                      <div>
                        <h3 className="text-[22px] text-[#1a1a1a]" style={serif}>
                          {item.title}
                        </h3>
                        <p className="mt-1.5 text-[15px] leading-relaxed text-[#6b655d]">
                          {item.body}
                        </p>
                      </div>
                    </div>
                  </Seq>
                </div>
              ))}
            </Sequence>
          </div>
        </div>
      </section>

      {/* ---------- Benefits stat band ---------- */}
      <section className="mx-auto w-full max-w-[1440px] px-4 pt-28 sm:px-10 sm:pt-36 lg:px-[78px]">
        <Reveal>
          <p className="text-[13px] tracking-[0.14em] text-[#777169]">WHY SHOPS JOIN</p>
          <h2
            className="mt-3 max-w-[720px] text-[36px] leading-[1.05] text-[#1a1a1a] sm:text-[46px] lg:text-[54px]"
            style={serif}
          >
            Everything you need. Nothing you don&apos;t.
          </h2>
        </Reveal>

        <Reveal delay={0.05}>
          <div className="mt-14 grid grid-cols-2 gap-y-12 lg:grid-cols-4">
            {STATS.map((stat, i) => (
              <div
                key={stat.value + i}
                className={`px-2 sm:px-6 ${i > 0 ? "lg:border-l lg:border-[#1a1a1a]/12" : ""}`}
              >
                <span className="text-[52px] leading-none text-[#1a1a1a] sm:text-[64px]" style={serif}>
                  {stat.value}
                </span>
                <p className="mt-4 text-[14px] leading-[22px] text-[#777169]">
                  {stat.lines[0]}
                  <br />
                  {stat.lines[1]}
                </p>
              </div>
            ))}
          </div>
        </Reveal>
      </section>

      {/* ---------- Closing CTA band + footer ---------- */}
      <footer className="mt-28 w-full sm:mt-36">
        <div
          className="relative flex w-full flex-col items-center justify-center overflow-hidden px-4 py-24 text-center sm:px-10 lg:min-h-[440px] lg:py-28"
          style={{
            background:
              "radial-gradient(120% 130% at 50% 18%, #86bbf9 0%, #5093f3 52%, #3f82ec 100%)",
          }}
        >
          <Reveal>
            <h2
              className="max-w-[895px] text-[34px] leading-[1.08] text-white sm:text-[46px] lg:text-[58px]"
              style={serif}
            >
              Ready to grow your shop?
            </h2>
          </Reveal>
          <Reveal delay={0.12}>
            <p className="mt-5 max-w-[46ch] text-[17px] leading-relaxed text-white/85">
              Apply in two minutes. We&apos;ll review your shop and send a private invite to
              get set up.
            </p>
          </Reveal>
          <Reveal delay={0.18}>
            <div className="mt-9 flex justify-center">
              <Button asChild size="lg" className="bg-white px-7 text-[#1a1a1a] hover:bg-white/90">
                <Link href="/apply">
                  Apply to partner
                  <ChevronRight className="size-4" />
                </Link>
              </Button>
            </div>
          </Reveal>
        </div>

        {/* Dark footer strip (parity with the home footer) */}
        <div className="w-full bg-[#1a1a1a]">
          <div className="mx-auto flex w-full max-w-[1440px] flex-col items-center gap-6 px-6 py-8 text-[16px] text-[#eceae6] sm:px-10 sm:text-[18px] lg:grid lg:grid-cols-3 lg:items-center lg:gap-4 lg:px-[61px] lg:py-[54px] lg:text-[20px]">
            <span className="leading-[28px] lg:justify-self-start" style={serif}>
              Otopair
            </span>
            <p className="text-center leading-[28px]">© 2026 Otopair. All rights reserved.</p>
            <nav className="flex items-center gap-8 sm:gap-10 lg:justify-self-end lg:gap-[26px]">
              <Link href="/privacy" className="leading-[28px] transition-opacity hover:opacity-70">
                Privacy
              </Link>
              <Link href="/terms" className="leading-[28px] transition-opacity hover:opacity-70">
                Terms
              </Link>
              <Link href="/contact" className="leading-[28px] transition-opacity hover:opacity-70">
                Contact
              </Link>
            </nav>
          </div>
        </div>
      </footer>
    </div>
  );
}
