"use client";

import { createContext, useContext, useRef } from "react";
import { motion, useInView } from "motion/react";
import { useReducedMotionSafe } from "../shared";

/** Serif used for every landing headline (design: Romie → site serif). */
export const serif = { fontFamily: "var(--font-Lora)" } as const;

/** Fade-up once the element scrolls into view — the landing sections' shared entrance. */
export function Reveal({
  children,
  delay = 0,
  y = 26,
  className,
}: {
  children: React.ReactNode;
  delay?: number;
  y?: number;
  className?: string;
}) {
  const reduce = useReducedMotionSafe();
  return (
    <motion.div
      className={className}
      initial={reduce ? { opacity: 0 } : { opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "0px 0px -10% 0px" }}
      transition={{ delay: reduce ? 0 : delay, duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  );
}

/** Spring pop for the small in-card mock elements (chat bubbles, quote cards,
 *  badges) — item-level sibling of Reveal. Sequence a group by stepping
 *  `delay`; reduced motion falls back to a plain fade. */
export function PopIn({
  children,
  delay = 0,
  x = 0,
  y = 12,
  scale = 0.96,
  className,
}: {
  children: React.ReactNode;
  delay?: number;
  x?: number;
  y?: number;
  scale?: number;
  className?: string;
}) {
  const reduce = useReducedMotionSafe();
  return (
    <motion.div
      className={className}
      initial={reduce ? { opacity: 0 } : { opacity: 0, x, y, scale }}
      whileInView={reduce ? { opacity: 1 } : { opacity: 1, x: 0, y: 0, scale: 1 }}
      viewport={{ once: true, margin: "0px 0px -8% 0px" }}
      transition={
        reduce
          ? { duration: 0.4 }
          : { delay, type: "spring", stiffness: 260, damping: 22 }
      }
    >
      {children}
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/*  Sequence — one scroll trigger, many choreographed items            */
/* ------------------------------------------------------------------ */

/* Reveal/PopIn each carry their own `whileInView`, so an item's `delay` counts
   from the moment *that item* crossed the viewport — fine for a lone element,
   useless for choreography. Sequence puts one observer at the group root and
   broadcasts it, so every `at` inside is a true offset from a shared t=0 and
   the order holds however the user scrolls. Nest a Sequence per sub-group
   (with its own `delay`) to keep the cascade when the group wraps on mobile. */

const SequenceCtx = createContext<{ active: boolean; base: number }>({
  active: true,
  base: 0,
});

const EASE = [0.22, 1, 0.36, 1] as const;

/** Group root: starts the clock when it scrolls in. `delay` shifts every child. */
export function Sequence({
  children,
  delay = 0,
  className,
}: {
  children: React.ReactNode;
  delay?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const active = useInView(ref, { once: true, margin: "0px 0px -12% 0px" });
  const reduce = useReducedMotionSafe();
  return (
    <div ref={ref} className={className}>
      <SequenceCtx.Provider value={{ active, base: reduce ? 0 : delay }}>
        {children}
      </SequenceCtx.Provider>
    </div>
  );
}

/** Fade-up item, `at` seconds into its Sequence. */
export function Seq({
  children,
  at = 0,
  x = 0,
  y = 18,
  duration = 0.62,
  className,
}: {
  children: React.ReactNode;
  at?: number;
  x?: number;
  y?: number;
  duration?: number;
  className?: string;
}) {
  const { active, base } = useContext(SequenceCtx);
  const reduce = useReducedMotionSafe();
  return (
    <motion.div
      className={className}
      variants={{
        out: reduce ? { opacity: 0 } : { opacity: 0, x, y },
        in: reduce ? { opacity: 1 } : { opacity: 1, x: 0, y: 0 },
      }}
      initial="out"
      animate={active ? "in" : "out"}
      transition={{ delay: reduce ? 0 : base + at, duration, ease: EASE }}
    >
      {children}
    </motion.div>
  );
}

/** Spring-pop item for the small in-card mocks — Sequence's PopIn. */
export function SeqPop({
  children,
  at = 0,
  x = 0,
  y = 12,
  scale = 0.96,
  className,
}: {
  children: React.ReactNode;
  at?: number;
  x?: number;
  y?: number;
  scale?: number;
  className?: string;
}) {
  const { active, base } = useContext(SequenceCtx);
  const reduce = useReducedMotionSafe();
  return (
    <motion.div
      className={className}
      variants={{
        out: reduce ? { opacity: 0 } : { opacity: 0, x, y, scale },
        in: reduce ? { opacity: 1 } : { opacity: 1, x: 0, y: 0, scale: 1 },
      }}
      initial="out"
      animate={active ? "in" : "out"}
      transition={
        reduce
          ? { duration: 0.4 }
          : { delay: base + at, type: "spring", stiffness: 260, damping: 22 }
      }
    >
      {children}
    </motion.div>
  );
}

/** Hairline that draws itself left-to-right. Give it the rule's own classes. */
export function SeqRule({ at = 0, className }: { at?: number; className?: string }) {
  const { active, base } = useContext(SequenceCtx);
  const reduce = useReducedMotionSafe();
  return (
    <motion.div
      className={className}
      style={{ transformOrigin: "left" }}
      variants={{
        out: reduce ? { opacity: 0, scaleX: 1 } : { opacity: 1, scaleX: 0 },
        in: { opacity: 1, scaleX: 1 },
      }}
      initial="out"
      animate={active ? "in" : "out"}
      transition={{ delay: reduce ? 0 : base + at, duration: reduce ? 0.4 : 0.7, ease: EASE }}
    />
  );
}
