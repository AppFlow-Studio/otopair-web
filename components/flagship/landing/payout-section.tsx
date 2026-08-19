"use client";

import { Reveal, serif, serifDisplay } from "./reveal";

/*
 * Section 4, rebuilt to Figma V1 (payout band, y 3050-3500 of node 302:886).
 * Measured off the V1 render rather than eyeballed:
 *  - content box 1190 wide, centred (125px inset at 1440)
 *  - headline breaks after "of", 68px cap-matched, 68px baseline pitch
 *  - three filled cards on a #EBF5FB wash, r16, ~383x171, 20px gaps
 *  - every tier of type inside a card is #4B82A5 — the same blue as the
 *    section-2 ticker: serif stat, semibold label, body
 *  - no download CTA in this band at all
 * Direction 2026-08-19: the 7% customer-fee column was dropped to match V1's
 * three, and the App Store / Play badges were removed from this section.
 */

const COLUMNS = [
  {
    stat: "100%",
    label: "of your rate, to you",
    body: "You set your hourly. The customer pays it in full. We never touch it.",
  },
  {
    stat: "24hr",
    label: "To your account",
    body: "Stripe Connect Express. Paid the day after the job is verified.",
  },
  {
    stat: "$0",
    label: "To join",
    body: "No subscription, no setup fee, no monthly. You earn, then we earn.",
  },
];

/** V1's blue for every tier of card type — the section-2 ticker tone. */
const BLUE = "#4B82A5";

/** "You keep 100% of your rate." — the shops' payout promise, three filled cards. */
export default function PayoutSection() {
  return (
    <section
      id="for-shops"
      className="mx-auto w-full max-w-[1440px] px-4 pt-28 sm:px-10 sm:pt-36 lg:px-[78px]"
    >
      {/* V1's content box: 1190 wide, centred — 125px in from a 1440 page. */}
      <div className="mx-auto w-full max-w-[1190px]">
        {/* 580px measure forces V1's break: "You keep 100% of / your rate."
            Cap-normalized Petrona sets that line at V1's own 552px; the next
            word pushes it past 700. */}
        <Reveal>
          <h2
            className="max-w-[580px] text-[40px] leading-[1.05] text-[#1a1a1a] sm:text-[54px] lg:text-[68px] lg:leading-[68px]"
            style={serifDisplay}
          >
            You keep 100% of your rate.
          </h2>
        </Reveal>

        <div className="mt-12 grid grid-cols-1 gap-5 lg:mt-[54px] lg:grid-cols-3 lg:gap-[20px]">
          {/* Cards follow the headline rather than racing it: 0.15s lead, then
              0.09s apart — the same rhythm section 2 gives its stats
              (delayChildren 0.15 / staggerChildren 0.09). At i * 0.1 the first
              card rose in lockstep with the h2 and read as a glitch. */}
          {COLUMNS.map((col, i) => (
            <Reveal key={col.stat} delay={0.15 + i * 0.09}>
              <div
                className="h-full rounded-[16px] bg-[#EBF5FB] px-7 pb-[26px] pt-[22px]"
                style={{ color: BLUE }}
              >
                <p className="text-[24px] leading-[26px] lg:text-[26px] lg:leading-[28px]" style={serif}>
                  {col.stat}
                </p>
                <p className="mt-[15px] text-[14px] font-semibold leading-[20px]">
                  {col.label}
                </p>
                <p className="mt-[13px] text-[15px] leading-[23px] lg:max-w-[258px]">{col.body}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
