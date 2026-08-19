"use client";

import Image from "next/image";
import { Reveal, Seq, SeqPop, SeqRule, Sequence, serif, serifDisplay } from "./reveal";

/* Each column runs the same internal beat — number, rule drawing itself in,
   title, body, then its mock — staggered by LEAD so the three read as one
   left-to-right cascade: 01 listens, 02 locks the price, 03 remembers you.
   Per-column clocks mean the beats replay individually once they stack. */
const LEAD = [0, 0.18, 0.36] as const;

const COPY = { number: 0, rule: 0.08, title: 0.16, body: 0.26 } as const;

/* Mock offsets, from each column's own start. Column 01 is an exchange (question
   then answer), 02 stacks the feed back-to-front, 03 greets you. */
const MOCK = {
  userBubble: 0.52,
  otoBubble: 0.78,
  pillBack: 0.5,
  pillMid: 0.64,
  pillFront: 0.8,
  blob: 0.52,
  welcome: 0.7,
} as const;

/**
 * "What Oto does" — editorial three-up on cream.
 * Eyebrow + serif headline (left) with a taupe subhead (upper-right), then three
 * numbered columns, each a hairline rule + serif title + taupe body + a small mock.
 */
export default function BuiltSection() {
  return (
    <section className="mx-auto w-full max-w-[1440px] px-4 pt-28 sm:px-10 sm:pt-36 lg:px-[78px]">
      {/* Header row: headline left, subhead upper-right */}
      <Reveal>
        <div className="flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between lg:gap-16">
          <div>
            <p className="text-[15px] leading-[28px] tracking-[0.05em] text-[#777169]">
              WHAT OTO DOES
            </p>
            <h2
              className="mt-3 text-[40px] leading-[0.95] text-[#1a1a1a] sm:text-[54px] lg:text-[68px]"
              style={serifDisplay}
            >
              Built to understand
              <br />
              your car.
            </h2>
          </div>
          <p className="text-[16px] leading-[22px] text-[#777169] lg:mb-3 lg:max-w-[398px]">
            Not a search engine. Not a form. Oto listens, identifies, and acts - the same way a
            trusted mechanic would if they were available at midnight.
          </p>
        </div>
      </Reveal>

      {/* Three numbered columns */}
      <div className="mt-16 grid grid-cols-1 gap-x-6 gap-y-16 sm:mt-24 lg:grid-cols-3">
        {/* 01 — Oto Listens */}
        <Column
          lead={LEAD[0]}
          number="01."
          title="Oto Listens."
          body="Describe the problem out loud. Oto understands symptoms, context, and your specific car — not just keywords."
        >
          <div className="relative mt-14 h-[110px]">
            <SeqPop at={MOCK.userBubble} x={8} className="absolute right-0 top-0">
              <div className="rounded-[8px] bg-white/70 px-3 py-3 backdrop-blur-sm">
                <p className="whitespace-nowrap text-[11px] leading-[20px] tracking-[0.05em] text-[#1a1a1a]">
                  “My brakes squeal in the cold. Can you check?”
                </p>
              </div>
            </SeqPop>
            <SeqPop at={MOCK.otoBubble} x={-8} className="absolute left-0 top-[57px]">
              <div className="rounded-[8px] bg-[#f9f9f8]/60 px-3.5 py-3 backdrop-blur-sm">
                <p className="whitespace-nowrap text-[11px] leading-[20px] tracking-[0.05em] text-[#1a1a1a]">
                  Classic glazed pads. Found 3 shops.
                </p>
              </div>
            </SeqPop>
          </div>
        </Column>

        {/* 02 — Oto locks the price */}
        <Column
          lead={LEAD[1]}
          number="02."
          title="Oto locks the price."
          body="Not an estimate. A fixed number from a real shop — confirmed before you book. No surprises. Ever."
        >
          <div className="relative mt-14 h-[130px]">
            {/* back — most faded */}
            <SeqPop at={MOCK.pillBack} y={-10} className="absolute left-[130px] top-0">
              <div className="rounded-full bg-[#e9e7e2] px-4 py-1.5 shadow-[inset_0_0_0_0.5px_rgba(26,26,26,0.06)]">
                <p className="whitespace-nowrap text-[9px] leading-[16px] tracking-[0.05em] text-[#1a1a1a]/45">
                  <span className="mr-1.5 text-[#777169]/50">•</span>
                  Maintenance . Annadale . 2 hrs ago
                </p>
              </div>
            </SeqPop>
            {/* mid */}
            <SeqPop at={MOCK.pillMid} y={-10} className="absolute left-[70px] top-[46px]">
              <div className="rounded-full bg-[#f2f1ed] px-4 py-2">
                <p className="whitespace-nowrap text-[10px] leading-[18px] tracking-[0.05em] text-[#1a1a1a]/70">
                  <span className="mr-1.5 text-[#777169]/50">•</span>
                  Tire Rotation . Stapleton . 1.5 hrs ago
                </p>
              </div>
            </SeqPop>
            {/* front — solid white */}
            <SeqPop at={MOCK.pillFront} y={-10} className="absolute left-0 top-[97px]">
              <div className="rounded-full bg-white px-4 py-2.5 shadow-sm">
                <p className="whitespace-nowrap text-[11px] leading-[20px] tracking-[0.05em] text-[#1a1a1a]">
                  <span className="mr-2 text-[#777169]/60">•</span>
                  Oil Change . Stapleton . 1.5 hrs ago
                </p>
              </div>
            </SeqPop>
          </div>
        </Column>

        {/* 03 — Oto remembers you */}
        <Column
          lead={LEAD[2]}
          number="03."
          title="Oto remembers you."
          body="Your car, your history, your shops. Next time you don't start from scratch. Oto knows your Audi."
        >
          <div className="relative mt-14 flex h-[110px] items-end">
            <div className="flex items-center gap-3">
              <SeqPop at={MOCK.blob} scale={0.6} y={0} className="shrink-0">
                <Image
                  src="/images/landing/oto-blob.png"
                  alt=""
                  width={32}
                  height={32}
                  className="rounded-full"
                />
              </SeqPop>
              <SeqPop at={MOCK.welcome} x={-8} y={0}>
                <div className="max-w-[230px] rounded-[8px] bg-white/60 px-3.5 py-2.5 backdrop-blur-sm">
                  <p className="text-[10px] leading-[15px] tracking-[0.05em] text-[#1a1a1a]">
                    Welcome back. Your 2020 Audi is due for an oil change in 800 miles.
                  </p>
                </div>
              </SeqPop>
            </div>
          </div>
        </Column>
      </div>
    </section>
  );
}

function Column({
  lead,
  number,
  title,
  body,
  children,
}: {
  lead: number;
  number: string;
  title: string;
  body: string;
  children: React.ReactNode;
}) {
  return (
    <Sequence delay={lead}>
      <Seq at={COPY.number} y={12}>
        <p className="text-[17px] leading-[23px] tracking-[0.05em] text-[#777169]">{number}</p>
      </Seq>
      <SeqRule at={COPY.rule} className="mt-2.5 h-px w-full bg-[#1a1a1a]/15" />
      <Seq at={COPY.title} y={16} className="mt-3">
        <h3 className="text-[25px] leading-[41px] tracking-[0.01em] text-[#1a1a1a]" style={serif}>
          {title}
        </h3>
      </Seq>
      <Seq at={COPY.body} y={14} className="mt-2">
        <p className="max-w-[300px] text-[14px] leading-[20px] tracking-[0.05em] text-[#777169]">
          {body}
        </p>
      </Seq>
      {children}
    </Sequence>
  );
}
