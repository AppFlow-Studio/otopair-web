"use client";

import { useEffect, useRef, useState } from "react";
import { animate, motion, useInView } from "motion/react";
import { useReducedMotionSafe } from "../shared";

/*
 * Small animation primitives for the landing sections, patterned on the
 * libraries in the team's design reference folder (Abubeckr's Arc list):
 *  - NumberTicker  → magicui.design/docs/components/number-ticker
 *  - TextEffect    → motion-primitives.com text effects
 * Both are copy-in component libraries, so these are local implementations on
 * the `motion` package the project already ships — no new dependency.
 */

/** Counts from `from` up to `value` when scrolled into view (once). The final
 *  value is the initial render — server markup must never ship the `from` 0
 *  as content (site audit 2026-08-31); the count-up replaces it on start. */
export function NumberTicker({
  value,
  from = 0,
  duration = 1.4,
  prefix = "",
  suffix = "",
  className,
  style,
}: {
  value: number;
  from?: number;
  duration?: number;
  prefix?: string;
  suffix?: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: "0px 0px -15% 0px" });
  const reduce = useReducedMotionSafe();
  const [display, setDisplay] = useState(value);

  useEffect(() => {
    if (!inView) return;
    if (reduce) {
      setDisplay(value);
      return;
    }
    const controls = animate(from, value, {
      duration,
      ease: [0.16, 1, 0.3, 1],
      onUpdate: (v) => setDisplay(Math.round(v)),
    });
    return () => controls.stop();
  }, [inView, reduce, from, value, duration]);

  return (
    <span ref={ref} className={className} style={style}>
      {prefix}
      {display}
      {suffix}
    </span>
  );
}

/** Reveals a line word-by-word — blur and rise with a soft stagger. */
export function TextEffect({
  children,
  className,
  style,
  as: Tag = "span",
  delay = 0,
}: {
  children: string;
  className?: string;
  style?: React.CSSProperties;
  as?: "span" | "h2" | "p";
  delay?: number;
}) {
  const reduce = useReducedMotionSafe();
  const words = children.split(" ");
  const MotionTag = motion[Tag];

  if (reduce) {
    return (
      <MotionTag
        className={className}
        style={style}
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
        viewport={{ once: true }}
        transition={{ duration: 0.5, delay }}
      >
        {children}
      </MotionTag>
    );
  }

  return (
    <MotionTag
      className={className}
      style={style}
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true, margin: "0px 0px -12% 0px" }}
      transition={{ staggerChildren: 0.07, delayChildren: delay }}
    >
      {words.map((w, i) => (
        <motion.span
          key={`${w}-${i}`}
          className="inline-block will-change-transform"
          variants={{
            hidden: { opacity: 0, y: 14, filter: "blur(6px)" },
            visible: {
              opacity: 1,
              y: 0,
              filter: "blur(0px)",
              transition: { duration: 0.6, ease: [0.22, 1, 0.36, 1] },
            },
          }}
        >
          {w}
          {i < words.length - 1 ? " " : null}
        </motion.span>
      ))}
    </MotionTag>
  );
}
