"use client";

import { useRef } from "react";
import { motion, useInView } from "motion/react";
import { useReducedMotionSafe } from "../shared";
import { serif } from "./reveal";

/**
 * Stylized shop-network illustration (design inspiration: Kit's "Creator
 * Network"). Satellite shops orbit a central "Your shop" node, connected by
 * hairlines that draw themselves in on scroll. Purely decorative — no data
 * deps, no map/globe. Reduced-motion renders the graph fully drawn and still.
 */

type Node = {
  x: number; // % across the panel
  y: number; // % down the panel
  initials: string;
  verified: boolean;
};

// Names echo the coverage-section stand-in feed for a consistent Staten Island
// story; positions hand-placed to orbit the centre without overlapping.
const NODES: Node[] = [
  { x: 20, y: 20, initials: "BR", verified: true },
  { x: 79, y: 16, initials: "PR", verified: true },
  { x: 88, y: 50, initials: "EA", verified: false },
  { x: 74, y: 82, initials: "GK", verified: true },
  { x: 30, y: 84, initials: "TT", verified: true },
  { x: 11, y: 54, initials: "ND", verified: false },
  { x: 50, y: 10, initials: "SS", verified: true },
];

const CENTER = { x: 50, y: 54 };
const LINE = "rgba(26,26,26,0.20)";

export default function NetworkGraph() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "0px 0px -12% 0px" });
  const reduce = useReducedMotionSafe();
  const shown = reduce ? true : inView;

  return (
    <div
      ref={ref}
      aria-hidden
      className="relative aspect-[5/4] w-full overflow-hidden rounded-[20px] border border-[#1a1a1a]/8 bg-[#dfe6ee]"
    >
      {/* Soft glow behind the centre node */}
      <div
        className="pointer-events-none absolute left-1/2 top-1/2 h-[55%] w-[55%] -translate-x-1/2 -translate-y-1/2 rounded-full"
        style={{
          top: `${CENTER.y}%`,
          background:
            "radial-gradient(circle, rgba(82,153,254,0.22) 0%, rgba(82,153,254,0) 70%)",
        }}
      />

      {/* Connectors — hairlines from each satellite to the centre */}
      <svg
        className="absolute inset-0 h-full w-full"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
      >
        {NODES.map((n, i) => (
          <motion.line
            key={i}
            x1={n.x}
            y1={n.y}
            x2={CENTER.x}
            y2={CENTER.y}
            stroke={LINE}
            strokeWidth={1}
            strokeDasharray="3 3"
            vectorEffect="non-scaling-stroke"
            initial={{ pathLength: reduce ? 1 : 0, opacity: reduce ? 1 : 0 }}
            animate={shown ? { pathLength: 1, opacity: 1 } : {}}
            transition={{ delay: 0.15 + i * 0.08, duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
          />
        ))}
      </svg>

      {/* Satellite shop nodes */}
      {NODES.map((n, i) => (
        <motion.div
          key={i}
          className="absolute -translate-x-1/2 -translate-y-1/2"
          style={{ left: `${n.x}%`, top: `${n.y}%` }}
          initial={{ opacity: reduce ? 1 : 0, scale: reduce ? 1 : 0.6 }}
          animate={
            shown
              ? reduce
                ? { opacity: 1, scale: 1 }
                : { opacity: 1, scale: 1, y: [0, -4, 0] }
              : {}
          }
          transition={{
            opacity: { delay: 0.3 + i * 0.08, duration: 0.4 },
            scale: { delay: 0.3 + i * 0.08, type: "spring", stiffness: 260, damping: 20 },
            y: reduce
              ? undefined
              : { delay: 0.9 + i * 0.15, duration: 3.5 + (i % 3), repeat: Infinity, ease: "easeInOut" },
          }}
        >
          <div className="relative flex h-11 w-11 items-center justify-center rounded-full bg-white text-[13px] font-semibold text-[#1a1a1a] shadow-[0_6px_16px_rgba(0,0,0,0.10)] ring-1 ring-[#1a1a1a]/5 sm:h-12 sm:w-12">
            {n.initials}
            {n.verified && (
              <span className="absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-white">
                <span className="h-2.5 w-2.5 rounded-full bg-[#457942]" />
              </span>
            )}
          </div>
        </motion.div>
      ))}

      {/* Centre "Your shop" node */}
      <motion.div
        className="absolute -translate-x-1/2 -translate-y-1/2"
        style={{ left: `${CENTER.x}%`, top: `${CENTER.y}%` }}
        initial={{ opacity: reduce ? 1 : 0, scale: reduce ? 1 : 0.7 }}
        animate={shown ? { opacity: 1, scale: 1 } : {}}
        transition={{ delay: reduce ? 0 : 0.1, type: "spring", stiffness: 240, damping: 20 }}
      >
        <div className="flex items-center gap-2.5 rounded-full bg-[#5299fe] px-5 py-3 shadow-[0_10px_30px_rgba(82,153,254,0.4)]">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white/25">
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="white" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 21s-7-5.3-7-11a7 7 0 0 1 14 0c0 5.7-7 11-7 11z" />
              <circle cx="12" cy="10" r="2.4" />
            </svg>
          </span>
          <span className="text-[15px] font-medium text-white" style={serif}>
            Your shop
          </span>
        </div>
      </motion.div>
    </div>
  );
}
