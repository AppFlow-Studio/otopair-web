"use client";

import { motion } from "motion/react";
import DownloadApp from "../download-app";
import { Reveal, serif, serifDisplay } from "./reveal";
import { NumberTicker, TextEffect } from "./motion-bits";
import { useReducedMotionSafe } from "../shared";

/*
 * Section 2, rebuilt to Figma V1 (node 302:1073 + 302:1075, declared values):
 *  - card: 1269 wide, rounded-[40px], vertical gradient #95C7E7 → white
 *  - blue serif ticker (#4B82A5, ~28px) floating above the card, no rule
 *  - heading ~56/75 inside the card, 82px below its top
 *  - four stats on 83px hairline dividers, CTA row, then ~170px of gradient
 *    breathing room before the card fades out
 * Copy differences from V1 are deliberate and stay: the ticker's stale launch
 * date is gone, "Both" reads "from day one", and the store-badge pair is the
 * single device-detecting DownloadApp (design review 2026-08-15, W1).
 *
 * Below sm the section follows the Figma mobile frame instead ("iPhone 16 &
 * 17 Pro - 7", nodes 390:3231 ticker / 390:3179 band / 390:3230 title /
 * 390:3232–3243 tiles), where it is no longer a card:
 *  - ticker 12/45 Petrona 500 in a 54px block
 *  - a FULL-BLEED 226px gradient band with 40px top corners, drawn as a
 *    fixed-size background behind the title and the top of the tiles; below
 *    it the page is white
 *  - title 25/75 Petrona 400 on one line, sitting inside the top of the band
 *  - 2x2 tiles, 72px rows on a 9px gap, columns at x=20 and x=50%+31px,
 *    value 26px Petrona 400 at (28,0), caption 8/11 at (28,41); no tile
 *    background, no dividers
 *  - no store badges; the section ends at the bottom of the tiles
 * Every `max-tab:` class below is that frame; nothing ≥sm changes.
 */

const STATS: {
  value: string;
  /** Digit values render a touch smaller and heavier than word values —
   *  matches V1's rendered heights (57px words / 53-63px numerals). */
  digits?: boolean;
  ticker?: { to: number; prefix?: string; suffix?: string };
  lines: [string, string];
}[] = [
  { value: "Fixed", lines: ["Locked before you book,", "Never negotiate."] },
  { value: "$0", digits: true, lines: ["No subscription.", "No Setup fee."] },
  { value: "Both", lines: ["iPhone & Android,", "from day one."] },
  { value: "90s", digits: true, ticker: { to: 90, suffix: "s" }, lines: ["From symptoms to", "booked."] },
];

/*
 * The stat values use Literata rather than the landing's Fraunces: measured
 * against the V1 render, Romie's stat cut (flat hairline slabs, narrow lining
 * digits, straight-tailed 9) is Literata anatomy, not Fraunces — Fraunces'
 * rounds run wide and wispy at these sizes. Sizes land each value on V1's
 * rendered ink height (73px -> 57px words; 70px -> 53-63px numerals) and the
 * weights on its ink density (words 0.98-1.05x, digits 0.98-1.04x).
 */
const statSerif = { fontFamily: "var(--font-Literata)" } as const;

/*
 * Mobile type plumbing. The mobile frame sets the ticker, title and values in
 * Romie Regular/Medium at literal sizes — i.e. Petrona 400/500 with no cap
 * normalisation — while ≥sm keeps the desktop faces above. Inline styles win
 * over classes, so the mobile overrides ride on custom properties that only
 * `max-tab:` classes define; the var() fallbacks are the exact desktop values,
 * so ≥sm computes to precisely what it did before.
 */
const tickerStyle = {
  ...serif,
  fontWeight: `var(--wo-w, ${serif.fontWeight})`,
} as React.CSSProperties;

const titleStyle = {
  ...serifDisplay,
  fontWeight: `var(--wo-w, ${serifDisplay.fontWeight})`,
  fontSizeAdjust: `var(--wo-fsa, ${serifDisplay.fontSizeAdjust})`,
} as React.CSSProperties;

const MOBILE_VALUE =
  "max-tab:text-[26px] max-tab:leading-[38px] max-tab:[--wo-ff:var(--font-Petrona)] max-tab:[--wo-w:400]";

function valueClass(digits?: boolean) {
  return (
    (digits
      ? "text-[48px] leading-none tracking-[0.374px] text-[#1a1a1a] tab:text-[60px] lg:text-[70px]"
      : "text-[50px] leading-none tracking-[0.374px] text-[#1a1a1a] tab:text-[62px] lg:text-[73px]") +
    " " +
    MOBILE_VALUE
  );
}
function valueStyle(digits?: boolean) {
  return {
    fontFamily: `var(--wo-ff, ${statSerif.fontFamily})`,
    fontWeight: `var(--wo-w, ${digits ? 250 : 240})`,
  } as React.CSSProperties;
}

export default function WhyOtoSection() {
  const reduce = useReducedMotionSafe();

  return (
    <section className="w-full">
      {/* Ticker — blue serif floating on white, no rule (V1 302:1005).
          Mobile: 15/45 Petrona 500 in a 54px block (390:3231 says 12px —
          too small on a phone, design feedback 2026-09-03). */}
      <Reveal>
        <p
          className="pt-2 pb-7 text-center text-[19px] leading-[1.6] text-[#4B82A5] tab:text-[24px] lg:text-[28px] max-tab:pt-0 max-tab:pb-[9px] max-tab:text-[15px] max-tab:leading-[45px] max-tab:[--wo-w:500]"
          style={tickerStyle}
        >
          Now onboarding · Staten Island, NYC
        </p>
      </Reveal>

      {/* Blue-wash card (V1 302:1073). Mobile: full-bleed, and the gradient is
          a fixed 226px band with 40px top corners rather than the card's fill
          (390:3179) — the tiles run past its bottom edge onto white. */}
      <Reveal y={32}>
        <div
          className="mx-auto w-[calc(100%-32px)] max-w-[1269px] overflow-clip rounded-[28px] bg-[linear-gradient(to_bottom,#95C7E7,#FFFFFF)] tab:w-[calc(100%-80px)] tab:rounded-[40px] max-tab:w-full max-tab:rounded-t-[40px] max-tab:rounded-b-none max-tab:bg-no-repeat max-tab:[background-size:100%_226px]"
        >
          {/* Heading — per-word reveal (motion-primitives pattern).
              Mobile: 25/75 Petrona 400, one line, top of the band (390:3230). */}
          <TextEffect
            as="h2"
            className="mx-auto block max-w-[969px] px-6 pt-14 text-center text-[32px] leading-[1.3] text-[#1a1a1a] tab:text-[44px] lg:pt-[82px] lg:text-[52px] lg:leading-[75px] lg:tracking-[-0.01em] max-tab:px-2 max-tab:pt-0 max-tab:text-[25px] max-tab:leading-[75px] max-tab:[--wo-w:400] max-tab:[--wo-fsa:none]"
            style={titleStyle}
          >
            Why drivers download Oto
          </TextEffect>

          {/* Stats — staggered rise; the true numeral counts up (magicui
              number-ticker pattern). Dividers draw in after.
              Mobile: 2x2 tiles, 72px rows / 9px gap, 62px column gap on a
              20px inset so the right column lands at 50%+31px (390:3232–43). */}
          <motion.div
            className="mx-auto mt-10 grid max-w-[1240px] grid-cols-2 gap-y-12 px-5 tab:px-10 lg:mt-[50px] lg:grid-cols-4 lg:gap-y-0 max-tab:mt-0 max-tab:gap-x-[62px] max-tab:gap-y-[9px]"
            initial={reduce ? undefined : "hidden"}
            whileInView={reduce ? undefined : "visible"}
            viewport={{ once: true, margin: "0px 0px -12% 0px" }}
            transition={{ staggerChildren: 0.09, delayChildren: 0.15 }}
          >
            {STATS.map((stat, i) => (
              <motion.div
                key={stat.value}
                className="relative flex flex-col px-5 tab:px-8 lg:px-10 max-tab:h-[72px] max-tab:pl-[28px] max-tab:pr-0"
                variants={{
                  hidden: { opacity: 0, y: 18, filter: "blur(4px)" },
                  visible: {
                    opacity: 1,
                    y: 0,
                    filter: "blur(0px)",
                    transition: { duration: 0.65, ease: [0.22, 1, 0.36, 1] },
                  },
                }}
              >
                {/* 83px hairline dividers between columns (V1 302:1098/99/96);
                    the mobile frame has none. */}
                {i % 2 === 1 && (
                  <motion.span
                    className="pointer-events-none absolute left-0 top-1/2 h-[83px] w-px -translate-y-1/2 bg-[#1a1a1a]/20 max-tab:hidden lg:hidden"
                    variants={{ hidden: { scaleY: 0 }, visible: { scaleY: 1, transition: { duration: 0.5, delay: 0.35 } } }}
                  />
                )}
                {i > 0 && (
                  <motion.span
                    className="pointer-events-none absolute left-0 top-1/2 hidden h-[83px] w-px -translate-y-1/2 bg-[#1a1a1a]/20 lg:block"
                    variants={{ hidden: { scaleY: 0 }, visible: { scaleY: 1, transition: { duration: 0.5, delay: 0.35 } } }}
                  />
                )}

                {/* Mobile: the value box is the 41px the caption sits below. */}
                <div className="flex h-[50px] items-end tab:h-[62px] lg:h-[73px] max-tab:h-[41px] max-tab:items-start">
                  {stat.ticker ? (
                    <NumberTicker
                      value={stat.ticker.to}
                      prefix={stat.ticker.prefix}
                      suffix={stat.ticker.suffix}
                      className={valueClass(stat.digits)}
                      style={valueStyle(stat.digits)}
                    />
                  ) : (
                    <span className={valueClass(stat.digits)} style={valueStyle(stat.digits)}>
                      {stat.value}
                    </span>
                  )}
                </div>
                <span className="mt-4 text-[14px] leading-[20px] tracking-[0.05em] text-[#777169] tab:text-[15px] max-tab:mt-0 max-tab:whitespace-nowrap max-tab:text-[8px] max-tab:leading-[11px] max-tab:tracking-[0.4px]">
                  {stat.lines[0]}
                  <br />
                  {stat.lines[1]}
                </span>
              </motion.div>
            ))}
          </motion.div>

          {/* CTA row (W1: single device-detecting download). The mobile frame
              carries no badges here — they live in the price-lock section. */}
          <Reveal delay={0.15} className="max-tab:hidden">
            <div className="mt-10 flex flex-wrap items-center justify-center gap-3 lg:mt-[44px]">
              <DownloadApp />
            </div>
          </Reveal>

          {/* Breathing room under the badges — V1's ~170px read as dead card
              on screen; halved (design feedback 2026-08-30). Mobile ends on
              the tiles. */}
          <div className="h-16 lg:h-[88px] max-tab:hidden" aria-hidden />
        </div>
      </Reveal>
    </section>
  );
}
