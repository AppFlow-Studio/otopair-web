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
 *
 * Mobile (< sm), to the "iPhone 16 & 17 Pro - 7" frame (390:3245 headline,
 * 390:3312–3323 cards; y 1781–2327 of node 390:3173):
 *  - headline top 69px under the price-lock card's blue foot, 28/28 Romie
 *    Regular at x=33 — 6px further in than the cards' 27px inset
 *  - cards 348 wide on the 402 frame (x=27 → fluid calc(100% − 54px)), 152
 *    tall, r20, rgba(157,203,233,0.2), 15px apart; the first sits 32px under
 *    the headline's line box (60px under its top when the line holds)
 *  - inside, all #4B82A5: stat 20/28 Romie Medium at (21,26), label 13/23
 *    Semibold at (21,62), body 13/18 Regular at (21,92), 310 wide → 17px
 *    right inset
 * The mobile headline uses `serif` (Petrona 400, no cap normalization): at
 * 28px that sets the line 333px wide against Romie's 339 in the frame, so it
 * holds one line exactly where Romie would (402+) and wraps where Romie would
 * (390 and under). Cap-normalized Petrona would run 374px — 10% wider than
 * the design — and wrap at every phone width.
 */

const COLUMNS = [
  {
    stat: "100%",
    label: "of your rate, to you",
    body: "You set your hourly. The customer pays it in full. We never touch it.",
  },
  {
    stat: "Daily",
    label: "To your account",
    body: "Stripe Connect Express. Daily payouts on Stripe's rolling schedule, once the job is complete.",
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
      className="mx-auto w-full max-w-[1440px] px-[27px] pt-[69px] tab:px-10 tab:pt-28 lg:px-[78px]"
    >
      {/* V1's content box: 1190 wide, centred — 125px in from a 1440 page. */}
      <div className="mx-auto w-full max-w-[1190px]">
        {/* Two headings, one per band, because the two faces are different
            objects: the mobile frame wants text-size Petrona (`serif`, 400,
            un-normalized — see the header note) and ≥sm keeps `serifDisplay`
            (250, cap-matched). Only one is ever displayed, so the hidden one
            is out of the accessibility tree. */}
        <Reveal>
          <h2
            className="pl-[6px] text-[28px] leading-[28px] text-[#1a1a1a] tab:hidden"
            style={serif}
          >
            You keep 100% of your rate.
          </h2>
          {/* 580px measure forces V1's break: "You keep 100% of / your rate."
              Cap-normalized Petrona sets that line at V1's own 552px; the next
              word pushes it past 700. */}
          <h2
            className="hidden max-w-[580px] text-[40px] leading-[1.05] text-[#1a1a1a] tab:block tab:text-[54px] lg:text-[68px] lg:leading-[68px]"
            style={serifDisplay}
          >
            You keep 100% of your rate.
          </h2>
        </Reveal>

        <div className="mt-10 grid grid-cols-1 gap-5 max-tab:mt-[32px] max-tab:gap-[15px] lg:mt-[40px] lg:grid-cols-3 lg:gap-[20px]">
          {/* Cards follow the headline rather than racing it: 0.15s lead, then
              0.09s apart — the same rhythm section 2 gives its stats
              (delayChildren 0.15 / staggerChildren 0.09). At i * 0.1 the first
              card rose in lockstep with the h2 and read as a glitch. */}
          {COLUMNS.map((col, i) => (
            <Reveal key={col.stat} delay={0.15 + i * 0.09}>
              {/* Mobile: 26 + 28 + 8 + 23 + 7 + 36 + 24 = 152 with a two-line
                  body (still two lines at 360); min-h holds 152 should a body
                  ever fit one line, and a three-line body simply grows it. */}
              <div
                className="h-full rounded-[16px] bg-[#EBF5FB] px-7 pb-[26px] pt-[22px] max-tab:min-h-[152px] max-tab:rounded-[20px] max-tab:bg-[rgba(157,203,233,0.2)] max-tab:pt-[26px] max-tab:pr-[17px] max-tab:pb-[24px] max-tab:pl-[21px]"
                style={{ color: BLUE }}
              >
                {/* Weight lives in classes (Romie Medium → 500 on the phone
                    frame, V1's Regular → 400 above) so `serif`'s inline 400
                    can't pin it across breakpoints. */}
                <p
                  className="text-[24px] font-normal leading-[26px] max-tab:text-[20px] max-tab:font-medium max-tab:leading-[28px] lg:text-[26px] lg:leading-[28px]"
                  style={{ fontFamily: serif.fontFamily }}
                >
                  {col.stat}
                </p>
                <p className="mt-[15px] text-[14px] font-semibold leading-[20px] max-tab:mt-[8px] max-tab:text-[13px] max-tab:leading-[23px]">
                  {col.label}
                </p>
                <p className="mt-[13px] text-[15px] leading-[23px] max-tab:mt-[7px] max-tab:text-[13px] max-tab:leading-[18px] lg:max-w-[258px]">
                  {col.body}
                </p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
