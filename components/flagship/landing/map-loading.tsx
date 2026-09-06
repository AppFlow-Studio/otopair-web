"use client";

import { motion } from "motion/react";
import { useReducedMotionSafe } from "../shared";
import { serif } from "./reveal";

/**
 * Themed placeholder for the coverage map.
 *
 * The map used to arrive in two visible jumps: a static still, then a
 * half-drawn mapbox canvas painting its tiles in. This holds one continuous
 * state instead — from the moment the section is reached, through the deferred
 * boot, until mapbox reports `idle` (every tile loaded AND rendered, not just
 * `load`) — and only then does the finished map cross-fade in.
 *
 * Palette is the section's own: #EBF5FB ground, #4B82A5 mark, the same pair the
 * rollout bar and stats sidebar use.
 */
export default function MapLoading({ label = "Mapping the network" }: { label?: string }) {
  const reduce = useReducedMotionSafe();

  return (
    <div
      className="absolute inset-0 flex flex-col items-center justify-center overflow-hidden bg-[#EBF5FB]"
      role="status"
      aria-live="polite"
    >
      {/* Faint grid, so the ground reads as a map surface rather than a blank
          panel. Static — it is behind a live indicator already. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.5]"
        style={{
          backgroundImage:
            "linear-gradient(to right, rgba(75,130,165,0.10) 1px, transparent 1px), linear-gradient(to bottom, rgba(75,130,165,0.10) 1px, transparent 1px)",
          backgroundSize: "48px 48px",
        }}
      />

      <div className="relative flex flex-col items-center">
        {/* Pin, with the locating pulse rippling out from its point. */}
        <div className="relative h-[46px] w-[36px]">
          {!reduce &&
            [0, 1].map((i) => (
              <motion.span
                key={i}
                className="absolute bottom-0 left-1/2 h-[18px] w-[18px] -translate-x-1/2 rounded-full border border-[#4B82A5]/50"
                initial={{ scale: 0.4, opacity: 0.55 }}
                animate={{ scale: 3.4, opacity: 0 }}
                transition={{ duration: 2.2, ease: "easeOut", repeat: Infinity, delay: i * 1.1 }}
              />
            ))}
          <motion.svg
            viewBox="0 0 36 46"
            className="absolute inset-0 h-full w-full"
            aria-hidden
            initial={false}
            animate={reduce ? undefined : { y: [0, -3, 0] }}
            transition={{ duration: 2.4, ease: "easeInOut", repeat: Infinity }}
          >
            <path
              d="M18 1.5c-8.0 0-14.5 6.4-14.5 14.3 0 10.3 12.4 27.0 13.6 28.6a1.1 1.1 0 0 0 1.8 0c1.2-1.6 13.6-18.3 13.6-28.6C32.5 7.9 26.0 1.5 18 1.5Z"
              fill="none"
              stroke="#4B82A5"
              strokeWidth="1.6"
            />
            <circle cx="18" cy="15.6" r="4.6" fill="#4B82A5" />
          </motion.svg>
        </div>

        <p className="mt-5 text-[17px] leading-none text-[#4B82A5]" style={serif}>
          {label}
        </p>

        {/* Indeterminate sweep — the map has no real progress to report, so
            this reads as activity rather than pretending to be a percentage. */}
        <div className="relative mt-4 h-px w-[132px] overflow-hidden bg-[#4B82A5]/20">
          {!reduce && (
            <motion.span
              className="absolute inset-y-0 w-1/3 bg-[#4B82A5]"
              initial={{ x: "-100%" }}
              animate={{ x: "400%" }}
              transition={{ duration: 1.5, ease: "easeInOut", repeat: Infinity }}
            />
          )}
        </div>
      </div>

      <span className="sr-only">Loading the coverage map</span>
    </div>
  );
}
