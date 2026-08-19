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

function valueClass(digits?: boolean) {
  return digits
    ? "text-[48px] leading-none tracking-[0.374px] text-[#1a1a1a] sm:text-[60px] lg:text-[70px]"
    : "text-[50px] leading-none tracking-[0.374px] text-[#1a1a1a] sm:text-[62px] lg:text-[73px]";
}
function valueStyle(digits?: boolean) {
  return { ...statSerif, fontWeight: digits ? 250 : 240 } as React.CSSProperties;
}

export default function WhyOtoSection() {
  const reduce = useReducedMotionSafe();

  return (
    <section className="w-full">
      {/* Ticker — blue serif floating on white, no rule (V1 302:1005). */}
      <Reveal>
        <p
          className="pt-10 pb-7 text-center text-[19px] leading-[1.6] text-[#4B82A5] sm:text-[24px] lg:text-[28px]"
          style={serif}
        >
          Now onboarding · Staten Island, NYC
        </p>
      </Reveal>

      {/* Blue-wash card (V1 302:1073). */}
      <Reveal y={32}>
        <div
          className="mx-auto w-[calc(100%-32px)] max-w-[1269px] overflow-clip rounded-[28px] bg-[linear-gradient(to_bottom,#95C7E7,#FFFFFF)] sm:w-[calc(100%-80px)] sm:rounded-[40px]"
        >
          {/* Heading — per-word reveal (motion-primitives pattern). */}
          <TextEffect
            as="h2"
            className="mx-auto block max-w-[969px] px-6 pt-14 text-center text-[32px] leading-[1.3] text-[#1a1a1a] sm:text-[44px] lg:pt-[82px] lg:text-[52px] lg:leading-[75px] lg:tracking-[-0.01em]"
            style={serifDisplay}
          >
            Why drivers download Oto
          </TextEffect>

          {/* Stats — staggered rise; the true numeral counts up (magicui
              number-ticker pattern). Dividers draw in after. */}
          <motion.div
            className="mx-auto mt-10 grid max-w-[1240px] grid-cols-2 gap-y-12 px-5 sm:px-10 lg:mt-[50px] lg:grid-cols-4 lg:gap-y-0"
            initial={reduce ? undefined : "hidden"}
            whileInView={reduce ? undefined : "visible"}
            viewport={{ once: true, margin: "0px 0px -12% 0px" }}
            transition={{ staggerChildren: 0.09, delayChildren: 0.15 }}
          >
            {STATS.map((stat, i) => (
              <motion.div
                key={stat.value}
                className="relative flex flex-col px-5 sm:px-8 lg:px-10"
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
                {/* 83px hairline dividers between columns (V1 302:1098/99/96) */}
                {i % 2 === 1 && (
                  <motion.span
                    className="pointer-events-none absolute left-0 top-1/2 h-[83px] w-px -translate-y-1/2 bg-[#1a1a1a]/20 lg:hidden"
                    variants={{ hidden: { scaleY: 0 }, visible: { scaleY: 1, transition: { duration: 0.5, delay: 0.35 } } }}
                  />
                )}
                {i > 0 && (
                  <motion.span
                    className="pointer-events-none absolute left-0 top-1/2 hidden h-[83px] w-px -translate-y-1/2 bg-[#1a1a1a]/20 lg:block"
                    variants={{ hidden: { scaleY: 0 }, visible: { scaleY: 1, transition: { duration: 0.5, delay: 0.35 } } }}
                  />
                )}

                <div className="flex h-[50px] items-end sm:h-[62px] lg:h-[73px]">
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
                <span className="mt-4 text-[14px] leading-[20px] tracking-[0.05em] text-[#777169] sm:text-[15px]">
                  {stat.lines[0]}
                  <br />
                  {stat.lines[1]}
                </span>
              </motion.div>
            ))}
          </motion.div>

          {/* CTA row (W1: single device-detecting download). */}
          <Reveal delay={0.15}>
            <div className="mt-14 flex flex-wrap items-center justify-center gap-3 lg:mt-[70px]">
              <DownloadApp />
            </div>
          </Reveal>

          {/* Breathing room — the gradient fades to white under empty space
              before the card ends (V1 leaves ~170px). */}
          <div className="h-24 lg:h-[170px]" aria-hidden />
        </div>
      </Reveal>
    </section>
  );
}
