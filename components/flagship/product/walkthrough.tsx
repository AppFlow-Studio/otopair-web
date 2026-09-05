"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useInView } from "motion/react";
import { useReducedMotionSafe } from "../shared";
import { PHONE_H, PHONE_W, Plate, Zoom } from "./device";

/**
 * The pinned walkthrough (how-it-works). Steps scroll on the left; the
 * phone stays on the right and its screen changes to the step in view.
 * Below `tab` (phones and tablets) each step carries its own screen
 * inline instead, since a pinned phone would leave no room to read.
 *
 * Active step = the step whose block crosses the middle band of the
 * viewport (useInView with a -45% margin top and bottom), so a step
 * switches when its text reaches eye level, not when it enters at the
 * bottom. One IntersectionObserver per step, no scroll listeners.
 *
 * Motion (Emil Kowalski, "animate"): the screen swap is a 320ms crossfade
 * with a 10px lift on the incoming screen and an exponential ease-out;
 * the bezel is identical on both, so only the glass changes. The rail dot
 * moves with a spring because it is a physical marker; reduced motion
 * turns both into fades.
 */
export type WalkStep = {
  id: string;
  title: string;
  body: string;
  /** A full phone (PhoneShell) for this step. */
  screen: ReactNode;
};

const EASE = [0.22, 1, 0.36, 1] as const;

export function Walkthrough({ steps, heading }: { steps: WalkStep[]; heading?: ReactNode }) {
  const [active, setActive] = useState(0);
  const reduce = useReducedMotionSafe();
  return (
    <div className="grid gap-y-10 tab:grid-cols-12 tab:gap-x-10">
      {/* Steps */}
      <ol className="relative tab:col-span-5 lg:col-span-5">
        {heading && <li className="mb-10 tab:mb-20">{heading}</li>}
        {steps.map((s, i) => (
          <StepBlock key={s.id} index={i} step={s} total={steps.length} active={active === i} onEnter={() => setActive(i)} reduce={reduce} />
        ))}
      </ol>

      {/* Pinned phone (desktop) */}
      <div className="hidden tab:col-span-7 tab:block lg:col-span-7">
        <div className="sticky top-[96px] h-[calc(100vh-120px)] min-h-[560px]">
          <Plate className="flex h-full items-center justify-center">
            <PinnedPhone steps={steps} active={active} reduce={reduce} />
            <StepDots total={steps.length} active={active} />
          </Plate>
        </div>
      </div>
    </div>
  );
}

function StepBlock({ index, step, total, active, onEnter, reduce }: { index: number; step: WalkStep; total: number; active: boolean; onEnter: () => void; reduce: boolean }) {
  const ref = useRef<HTMLLIElement>(null);
  const inView = useInView(ref, { margin: "-45% 0px -45% 0px" });
  useEffect(() => {
    if (inView) onEnter();
  }, [inView, onEnter]);
  return (
    <li ref={ref} id={step.id} className="scroll-mt-32 border-t border-[#1a1a1a]/10 py-10 tab:min-h-[68vh] tab:py-14 first:border-t-0">
      <div className="flex items-baseline gap-4">
        <span className="serif shrink-0 text-[15px] tabular-nums tracking-[0.02em] text-[#4B82A5] tab:text-[17px]" aria-hidden>
          {String(index + 1).padStart(2, "0")}.
        </span>
        <div className="min-w-0">
          <h2
            className="serif-display max-w-[16ch] text-[30px] leading-[1.06] tracking-[-0.01em] [text-wrap:balance] tab:text-[38px]"
            style={{ color: "#1a1a1a", opacity: active ? 1 : undefined }}
          >
            {step.title}
          </h2>
          <motion.p
            className="mt-4 max-w-[42ch] text-[17px] leading-[1.6] text-[#4c5661] [text-wrap:pretty]"
            initial={false}
            animate={{ opacity: active ? 1 : 0.55 }}
            transition={{ duration: reduce ? 0 : 0.4, ease: EASE }}
          >
            {step.body}
          </motion.p>
          <span className="sr-only">
            Step {index + 1} of {total}
          </span>
        </div>
      </div>
      {/* Inline screen below tab */}
      <div className="mt-8 tab:hidden">
        <Plate tone="sky" className="flex justify-center px-6 pb-0 pt-8" clip>
          <div className="-mb-[18%] overflow-hidden">
            <Zoom width={250} base={PHONE_W + 20}>
              {step.screen}
            </Zoom>
          </div>
        </Plate>
      </div>
    </li>
  );
}

/** Fits the phone to the sticky box: width follows the box height so the
 *  whole device stays visible on short laptops and grows on tall ones. */
function PinnedPhone({ steps, active, reduce }: { steps: WalkStep[]; active: number; reduce: boolean }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(340);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const h = e.contentRect.height;
      const byH = ((h - 104) * (PHONE_W + 20)) / (PHONE_H + 20);
      setW(Math.max(240, Math.min(392, Math.floor(byH))));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const ph = Math.round((w * (PHONE_H + 20)) / (PHONE_W + 20));
  return (
    <div ref={boxRef} className="relative flex h-full w-full items-center justify-center pb-8">
      <div className="relative" style={{ width: w, height: ph }}>
        <AnimatePresence initial={false}>
          <motion.div
            key={steps[active].id}
            className="absolute inset-0"
            initial={reduce ? { opacity: 0 } : { opacity: 0, transform: "translateY(10px)" }}
            animate={{ opacity: 1, transform: "translateY(0px)" }}
            exit={{ opacity: 0, transform: "translateY(0px)" }}
            transition={{ duration: reduce ? 0.2 : 0.32, ease: EASE }}
          >
            <Zoom width={w} base={PHONE_W + 20}>
              {steps[active].screen}
            </Zoom>
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

function StepDots({ total, active }: { total: number; active: number }) {
  return (
    <div className="absolute bottom-6 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border-[0.5px] border-white/60 bg-white/40 px-3 py-2 backdrop-blur-[20px]" aria-hidden>
      {Array.from({ length: total }, (_, i) => (
        <span key={i} className="relative flex h-[6px] w-[6px] items-center justify-center">
          <span className="h-[6px] w-[6px] rounded-full bg-[#1a1a1a]/20" />
          {i === active && <motion.span layoutId="walk-dot" className="absolute inset-0 rounded-full bg-[#1a1a1a]" transition={{ type: "spring", stiffness: 500, damping: 40 }} />}
        </span>
      ))}
    </div>
  );
}
