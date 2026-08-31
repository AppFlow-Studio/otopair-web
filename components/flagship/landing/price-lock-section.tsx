"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import {
  AnimatePresence,
  motion,
  useInView,
  useMotionValueEvent,
  useScroll,
} from "motion/react";
import { useLenis } from "lenis/react";
import { useReducedMotionSafe } from "../shared";
import { Reveal, serif, serifDisplay } from "./reveal";
import DriversPanel from "./drivers-panel";
import OtoPanel from "./oto-panel";

const EASE = [0.22, 1, 0.36, 1] as const;

/* ------------------------------------------------------------------ */
/* The three roles — hovering one swaps the graphic on the right.      */
/* ------------------------------------------------------------------ */
const ROLES = [
  {
    num: "01.",
    title: "Drivers.",
    body: "Vehicle health diagnostics at your fingertips. Triages symptoms. Identifies the right service.",
  },
  {
    num: "02.",
    title: "The Shops.",
    body: "Real-time scheduling, recalculated as bays fill. Two-way ratings. 24-hour Stripe payouts.",
  },
  {
    num: "03.",
    title: "Oto",
    // Not a repeat of 01's triage lines (site audit 2026-08-31) — this row
    // sells the layer itself, matching the panel's records-pull → booking arc.
    body: "The intelligent layer that locks your quote. Reads your car's records. Books the right shop.",
  },
] as const;

/* ------------------------------------------------------------------ */
/* 02 — The Shops: the complete walkthrough from Figma's shops shelf   */
/* (canvas x~22700-38000): board frames 385:155→385:221→386:283→       */
/* 386:344 with notes 386:404/407/409, then the "shop portal" job      */
/* screens (357:98, 386:411/506/553/599/652/707/757) — the John        */
/* Wilson job sheet stepping 1→4 into the final Complete card. The     */
/* old mechanic-portal sim lives on in ./archive/shops-admin-sim.tsx.  */
/* ------------------------------------------------------------------ */

type ShopBeat =
  | "off" | "date" | "time" | "cols" | "rows" | "land" | "press"
  | "job1" | "job2" | "ready" | "start" | "step3" | "step4" | "alldone" | "complete";
const SHOP_BEATS: ShopBeat[] = [
  "off", "date", "time", "cols", "rows", "land", "press",
  "job1", "job2", "ready", "start", "step3", "step4", "alldone", "complete",
];

/*
 * Every line names something literally on screen at that beat — a caption that
 * describes the next beat, or the one before it, reads as a mismatch on
 * playback. Beats that share a line are one cause-and-effect moment (a press
 * and what it opens), so the sentence spans both instead of flashing twice.
 */
const SHOP_CAPTIONS: Record<ShopBeat, string> = {
  // Board assembling: date pager, TIME column, then the three mechanics.
  off: "Real-time scheduling, straight from the shop's board.",
  date: "Real-time scheduling, straight from the shop's board.",
  time: "Real-time scheduling, straight from the shop's board.",
  cols: "Real-time scheduling, straight from the shop's board.",
  // Hours cascade in — columns are mechanics, rows are hours, all open.
  rows: "Every mechanic, every hour — one live grid.",
  // One composed landing: date pages, block, now-line and "1 job" together.
  land: "A booking lands — the day recalculates.",
  press: "Tap in — the job opens, already confirmed.",
  job1: "Tap in — the job opens, already confirmed.",
  // The condition card reads "first time we're seeing this VIN".
  job2: "New VIN — Oto builds the vehicle profile.",
  ready: "Profile ready — one tap starts service.",
  start: "Profile ready — one tap starts service.",
  // Stepper on 3 of 4, no action button: the work itself.
  step3: "Service underway — every step tracked.",
  // Step 4 lights up and the COMPLETE button appears.
  step4: "Last step — one tap closes the job.",
  alldone: "Last step — one tap closes the job.",
  complete: "Job complete — paid out within 24 hours.",
};

/* Restart time for the full story loop — mirrored in STORY_MS. */
const SHOPS_LOOP_MS = 31300;

/* The cast on the board, exactly as the Figma frames name them. */
const MECHS = ["Twunna S.", "Temur S.", "Abubeckr E."] as const;
const HOURS = ["12:00 PM", "1:00 PM", "2:00 PM", "3:00 PM", "4:00 PM", "5:00 PM"] as const;

/** One node of the job-progress stepper (Ø40 in the Figma; done/active are
 *  ink-dark, upcoming sit on translucent white). */
function StepNode({ n, state }: { n: number; state: "done" | "active" | "todo" }) {
  const dark = state !== "todo";
  return (
    <motion.span
      className="z-[2] flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-medium sm:h-9 sm:w-9 sm:text-[14px]"
      initial={false}
      animate={{
        backgroundColor: dark ? "#1a1a1a" : "rgba(255,255,255,0.65)",
        color: dark ? "#ffffff" : "#1a1a1a",
      }}
      transition={{ duration: 0.35, ease: EASE }}
    >
      {state === "done" ? "✓" : n}
    </motion.span>
  );
}

/** The John Wilson job sheet (shop portal screens): stepper, scope row,
 *  vehicle-condition card and the state-dependent action button. */
function JobSheet({
  step,
  allDone,
  ready,
  startPressed,
  completePressed,
  reduce,
}: {
  step: 1 | 2 | 3 | 4;
  allDone: boolean;
  ready: boolean;
  startPressed: boolean;
  completePressed: boolean;
  reduce: boolean;
}) {
  const stateOf = (n: number): "done" | "active" | "todo" =>
    allDone || n < step ? "done" : n === step ? "active" : "todo";
  const doneSegments = allDone ? 3 : step - 1;
  const showStart = step === 2;
  const showComplete = step === 4 || allDone;

  return (
    <div>
      {/* Title (serif, like every headline on the shelf) */}
      <p className="text-[20px] leading-[26px] text-[#1a1a1a] sm:text-[25px] sm:leading-[32px]" style={serif}>
        Oil Change - John Wilson
      </p>

      {/* JOB PROGRESS + CONFIRMED pill */}
      <div className="mt-5 flex items-center justify-between sm:mt-7">
        <span className="text-[10px] font-medium uppercase tracking-[0.1em] text-[#33383b] sm:text-[12px]">
          Job Progress
        </span>
        <span className="rounded-full bg-[#dbe3e8]/90 px-2.5 py-1 text-[8px] font-medium uppercase tracking-[0.06em] text-[#33383b] sm:text-[9.5px]">
          Confirmed
        </span>
      </div>

      {/* Stepper — 4 nodes, connectors fill as steps complete */}
      <div className="relative mt-3 flex items-center sm:mt-4">
        {[1, 2, 3, 4].map((n) => (
          <Fragment key={n}>
            {n > 1 && (
              <span className="relative mx-1 h-[1.5px] min-w-0 flex-1 overflow-hidden rounded bg-[#c9d4dc]">
                <motion.span
                  className="absolute inset-y-0 left-0 w-full origin-left bg-[#1a1a1a]"
                  initial={false}
                  animate={{ scaleX: doneSegments >= n - 1 ? 1 : 0 }}
                  transition={{ duration: reduce ? 0.2 : 0.45, ease: EASE }}
                />
              </span>
            )}
            <StepNode n={n} state={stateOf(n)} />
          </Fragment>
        ))}
      </div>
      <p className="mt-2 text-[10px] text-[#8a9094] sm:text-[12.5px]">Mileage unknown</p>

      {/* Services scope row */}
      <div className="mt-4 flex items-center justify-between rounded-[4px] bg-white/35 px-4 py-3 sm:mt-5 sm:px-6 sm:py-4">
        <div>
          <p className="text-[9px] font-medium uppercase tracking-[0.1em] text-[#8a9094] sm:text-[10.5px]">
            Services
          </p>
          <p className="mt-1 text-[14px] font-semibold tracking-[-0.01em] text-[#1a1a1a] sm:text-[16.5px]">
            This job&apos;s scope
          </p>
        </div>
        <span className="text-[10px] text-[#6b7280] sm:text-[12px]">1 Service · 0 parts ⌄</span>
      </div>

      {/* Vehicle condition */}
      <p className="mt-4 text-[10px] font-medium uppercase tracking-[0.1em] text-[#33383b] sm:mt-5 sm:text-[12px]">
        Vehicle Condition
      </p>
      <div className="relative mt-2 rounded-[4px] bg-white/35 px-4 py-3 sm:px-6 sm:py-4">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={ready ? "ready" : "building"}
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: -8 }}
            transition={{ duration: 0.35, ease: EASE }}
          >
            <p className="text-[13px] font-semibold tracking-[-0.01em] text-[#1a1a1a] sm:text-[15px]">
              {ready ? "Vehicle profile ready" : "Building vehicle profile - 5 mins"}
            </p>
            <p className="mt-1 max-w-[340px] text-[10.5px] leading-[1.4] text-[#6b7280] sm:text-[12.5px]">
              {ready
                ? "Engine, fluids, and chassis data loaded."
                : "First time we're seeing this VIN — fetching engine, fluids, and chassis data."}
            </p>
          </motion.div>
        </AnimatePresence>
        <span className="absolute right-3 top-3 rounded-full bg-[#dbe3e8]/90 px-2 py-0.5 text-[7.5px] font-medium uppercase tracking-[0.05em] text-[#33383b] sm:text-[9px]">
          {showComplete ? "Complete" : "2 left"}
        </span>
      </div>

      {/* Action button — appears with step 2, turns white when pressed,
          becomes COMPLETE for the final step (per screens 2/5/7/8). */}
      <div className="mt-4 h-[44px] sm:mt-5 sm:h-[52px]">
        <AnimatePresence mode="wait" initial={false}>
          {(showStart || showComplete) && (
            <motion.div
              key={showComplete ? "complete" : startPressed ? "start-white" : "start-black"}
              className="relative flex h-full w-full items-center justify-center rounded-[4px] text-[11px] font-medium uppercase tracking-[0.12em] sm:text-[13px]"
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: 10 }}
              animate={{
                opacity: 1,
                y: 0,
                backgroundColor: showComplete ? "#1a1a1a" : startPressed ? "#ffffff" : "#1a1a1a",
                color: showComplete ? "#ffffff" : startPressed ? "#1a1a1a" : "#ffffff",
                boxShadow: startPressed && !showComplete
                  ? "0 10px 24px rgba(20,40,80,0.16)"
                  : "0 6px 18px rgba(15,23,42,0.18)",
                scale: !reduce && completePressed ? [1, 0.96, 1] : 1,
              }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, y: -8 }}
              transition={{ duration: 0.4, ease: EASE }}
            >
              {showComplete ? "Complete" : "Start Service"}
              {!reduce && (completePressed || (startPressed && !showComplete)) && (
                <motion.span
                  className="pointer-events-none absolute left-1/2 top-1/2 h-9 w-9 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#1a1a1a]/12"
                  initial={{ scale: 0.3, opacity: 0.6 }}
                  animate={{ scale: 2.6, opacity: 0 }}
                  transition={{ duration: 0.6, ease: "easeOut" }}
                />
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

/** 02 — The Shops: the full designed walkthrough. Act 1 is the live day
 *  board (entry per the notes layer: TIME first, then columns in order;
 *  booking lands June 22; 12:56 now-line; block click). Act 2 opens the
 *  John Wilson job sheet and steps it 1→4 (vehicle profile builds, service
 *  starts, completes), ending on the ✓ Complete card. */
function ShopsPanel({ active, reduce }: { active: boolean; reduce: boolean }) {
  const [beat, setBeat] = useState<ShopBeat>("off");

  // All beat changes go through timers (never synchronously in the effect
  // body) — the reset to the first/last beat is just a 0ms timer.
  useEffect(() => {
    const timers: number[] = [];
    const later = (b: ShopBeat, t: number) =>
      timers.push(window.setTimeout(() => setBeat(b), t));
    if (!active || reduce) {
      later(reduce ? "complete" : "off", 0);
      return () => timers.forEach((t) => window.clearTimeout(t));
    }
    // Only the calendar's initial load was too slow (design feedback
    // 2026-08-24, item 3: "takes about 5 seconds to fully populate with all
    // the time slots and mechanics"). So the four board-assembly beats moved
    // up and their transitions got quicker — the grid is now up in ~2.5s.
    // Everything from `land` on keeps its original spacing, just shifted
    // earlier by the time the faster load saved; the rest of the story was
    // never the problem and is not retimed.
    const SEQ: [ShopBeat, number][] = [
      ["off", 0],
      ["date", 200],
      ["time", 650],
      ["cols", 1000],
      ["rows", 1900],
      // The assembled grid used to hold 3.8s before the booking landed —
      // "holds its position for too long" (design feedback 2026-08-31).
      // `land` now follows ~1.3s after the cascade settles; everything after
      // keeps its original spacing, shifted up by the 2.5s saved.
      ["land", 3200],
      ["press", 6700],    // block click…
      ["job1", 7500],     // …opens the sheet 0.8s later
      ["job2", 10500],
      ["ready", 14300],
      ["start", 17300],   // START SERVICE press…
      ["step3", 18100],   // …advances the stepper 0.8s later
      ["step4", 21900],
      ["alldone", 25300], // COMPLETE press + all checks…
      ["complete", 26500],// …collapse into the ✓ card
    ];
    const run = () => {
      for (const [b, t] of SEQ) later(b, t);
      timers.push(window.setTimeout(run, SHOPS_LOOP_MS));
    };
    run();
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [active, reduce]);

  const idx = SHOP_BEATS.indexOf(beat);
  const at = (b: ShopBeat) => idx >= SHOP_BEATS.indexOf(b);
  const june22 = at("land");
  const view = at("complete") ? "done" : at("job1") ? "job" : "board";
  const jobStep: 1 | 2 | 3 | 4 = at("step4") ? 4 : at("step3") ? 3 : at("job2") ? 2 : 1;

  /* 0.34s per element, not 0.5 — the populate animation itself had to get
     faster (design feedback 2026-08-24, item 3), not just start earlier. */
  const rise = (on: boolean, delay = 0) => ({
    initial: false as const,
    animate: reduce
      ? { opacity: on ? 1 : 0 }
      : { opacity: on ? 1 : 0, y: on ? 0 : 14 },
    transition: { duration: 0.34, ease: EASE, delay: on ? delay : 0 },
  });

  return (
    <div className="flex h-full w-full flex-col p-1">
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <div className="w-full max-w-[543px] select-none">
          <AnimatePresence mode="popLayout" initial={false}>
            {view === "board" && (
              <motion.div
                key="board"
                initial={false}
                animate={{ opacity: active ? 1 : 0, y: active || reduce ? 0 : 14 }}
                exit={reduce ? { opacity: 0 } : { opacity: 0, x: -44 }}
                transition={{ duration: 0.45, ease: EASE }}
              >
                {/* Date pager row (V1 385:258/259) */}
                <motion.div className="flex items-center" {...rise(at("date"))}>
                  <span className="px-1 text-[16px] text-[#1a1a1a]">‹</span>
                  <span className="relative mx-2 h-[30px] overflow-hidden sm:h-[34px]">
                    <AnimatePresence mode="popLayout" initial={false}>
                      <motion.span
                        key={june22 ? "22" : "21"}
                        className="block whitespace-nowrap text-[21px] leading-[30px] text-[#1a1a1a] sm:text-[26px] sm:leading-[34px]"
                        style={serif}
                        initial={reduce ? { opacity: 0 } : { opacity: 0, y: 22 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={reduce ? { opacity: 0 } : { opacity: 0, y: -22 }}
                        transition={{ duration: 0.45, ease: EASE }}
                      >
                        {june22 ? "Wednesday, June 22, 2026" : "Wednesday, June 21, 2026"}
                      </motion.span>
                    </AnimatePresence>
                  </span>
                  <span className="relative px-1 text-[16px] text-[#1a1a1a]">
                    ›
                    {/* Pager tap ripple right as the date pages over */}
                    {!reduce && beat === "land" && (
                      <motion.span
                        className="pointer-events-none absolute left-1/2 top-1/2 h-7 w-7 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#1a1a1a]/15"
                        initial={{ scale: 0.3, opacity: 0.6 }}
                        animate={{ scale: 2.2, opacity: 0 }}
                        transition={{ duration: 0.5, ease: "easeOut" }}
                      />
                    )}
                  </span>
                  <span className="ml-auto flex items-center gap-1 text-[11px] font-medium uppercase tracking-[0.1em] text-[#1a1a1a] sm:text-[13px]">
                    All Mechanics <span className="text-[9px]">⌄</span>
                  </span>
                </motion.div>

                {/* Column headers — TIME (EST) enters FIRST (the notes layer's
                    "time appears first"), then the mechanics in order. */}
                <div className="mt-7 grid grid-cols-[64px_repeat(3,1fr)] gap-2 sm:mt-10 sm:grid-cols-[96px_repeat(3,1fr)] sm:gap-[14px]">
                  <motion.div
                    className="flex h-[56px] items-center justify-center bg-[#1a1a1a] text-[9px] font-medium uppercase tracking-[0.08em] text-[#cfcfcf] sm:h-[74px] sm:text-[12px]"
                    {...rise(at("time"))}
                  >
                    Time (EST)
                  </motion.div>
                  {MECHS.map((name, i) => (
                    <motion.div
                      key={name}
                      className="flex h-[56px] flex-col items-center justify-center bg-white/55 sm:h-[74px]"
                      {...rise(at("cols"), i * 0.13)}
                    >
                      <span className="text-[11px] font-semibold tracking-[-0.01em] text-[#1a1a1a] sm:text-[14px]">
                        {name}
                      </span>
                      <span className="relative mt-0.5 h-[16px] text-[10px] sm:text-[12.5px]">
                        <AnimatePresence mode="popLayout" initial={false}>
                          <motion.span
                            key={i === 0 && june22 ? "job" : "avail"}
                            className="block"
                            style={{ color: i === 0 && june22 ? "#5299fe" : "#8a9094" }}
                            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={reduce ? { opacity: 0 } : { opacity: 0, y: -8 }}
                            transition={{ duration: 0.35, ease: EASE }}
                          >
                            {i === 0 && june22 ? "1 job" : "Available"}
                          </motion.span>
                        </AnimatePresence>
                      </span>
                    </motion.div>
                  ))}
                </div>

                {/* Hour rows — cascade in after the columns. */}
                <div className="relative mt-3 sm:mt-4">
                  {HOURS.map((h, i) => (
                    <motion.div
                      key={h}
                      className="relative flex h-[38px] items-center sm:h-[49px]"
                      {...rise(at("rows"), i * 0.05)}
                    >
                      {i > 0 && <span className="absolute inset-x-0 top-0 h-px bg-white/60" />}
                      <span className="pl-2 text-[10.5px] tracking-[0.02em] text-[#33383b] sm:pl-[22px] sm:text-[14px]">
                        {h}
                      </span>
                    </motion.div>
                  ))}

                  {/* Current-time line at 12:56pm (frame-3, note: "blue dot
                      fades in and blue line reveals/slides from left to
                      right, time 12:56 fades in") */}
                  <motion.div
                    className="pointer-events-none absolute inset-x-0 top-[35px] z-10 sm:top-[46px]"
                    initial={false}
                    animate={{ opacity: at("land") ? 1 : 0 }}
                    transition={{ duration: reduce ? 0.2 : 0.35, ease: EASE, delay: reduce ? 0 : 0.3 }}
                  >
                    <motion.span
                      className="absolute -top-[13px] left-[18px] text-[8.5px] font-medium text-[#5299fe] sm:left-[24px] sm:text-[10px]"
                      initial={false}
                      animate={{ opacity: at("land") ? 1 : 0 }}
                      transition={{ duration: 0.4, ease: EASE, delay: reduce ? 0 : 1.0 }}
                    >
                      12:56pm
                    </motion.span>
                    <motion.span
                      className="block h-[1.5px] origin-left bg-[#5299fe]"
                      initial={false}
                      animate={{ scaleX: at("land") ? 1 : 0 }}
                      transition={{ duration: reduce ? 0.2 : 0.9, ease: EASE, delay: reduce ? 0 : 0.35 }}
                    />
                    <span className="absolute -top-[2.5px] left-0 h-[6px] w-[6px] rounded-full bg-[#5299fe]" />
                  </motion.div>

                  {/* The booked time block — Twunna's column. On the press
                      beat it turns almost white with a drop shadow (frame-4,
                      note: "kinda like a click effect"). */}
                  <motion.div
                    className="absolute left-[72px] top-[48px] z-20 w-[calc((100%-64px-3*8px)/3)] sm:left-[110px] sm:top-[62px] sm:w-[calc((100%-96px-3*14px)/3)]"
                    initial={false}
                    animate={
                      reduce
                        ? { opacity: at("land") ? 1 : 0 }
                        : { opacity: at("land") ? 1 : 0, y: at("land") ? 0 : 56 }
                    }
                    transition={{ duration: 0.65, ease: EASE, delay: reduce ? 0 : 0.2 }}
                  >
                    <motion.div
                      className="relative h-[128px] border border-white/70 p-2.5 sm:h-[164px] sm:p-3.5"
                      initial={false}
                      animate={{
                        backgroundColor: at("press") ? "rgba(255,255,255,0.94)" : "rgba(255,255,255,0.55)",
                        boxShadow: at("press")
                          ? "0 16px 34px rgba(20,40,80,0.20)"
                          : "0 0 0 rgba(20,40,80,0)",
                        scale: !reduce && beat === "press" ? [1, 0.97, 1.01, 1] : 1,
                      }}
                      transition={{ duration: 0.55, ease: EASE }}
                    >
                      <p className="text-[12.5px] font-semibold tracking-[-0.01em] text-[#1a1a1a] sm:text-[15px]">
                        John Wilson
                      </p>
                      <p className="mt-0.5 text-[11px] text-[#33383b] sm:text-[13px]">Oil Change</p>
                      {/* An everyday car, deliberately — the Figma frame's
                          Bugatti Chiron read as a joke against the premium-calm
                          register (site audit 2026-08-31). */}
                      <p className="mt-1.5 text-[9px] leading-[1.35] text-[#8a9094] sm:text-[10.5px]">
                        2021 Toyota
                        <br />
                        Camry · 5303
                      </p>
                      <span className="absolute bottom-2 right-2 rounded-full bg-[#dbe3e8]/90 px-2 py-0.5 text-[8.5px] font-medium text-[#33383b] sm:bottom-2.5 sm:right-2.5 sm:text-[10px]">
                        12:50p
                      </span>
                    </motion.div>
                  </motion.div>
                </div>
              </motion.div>
            )}

            {view === "job" && (
              <motion.div
                key="job"
                initial={reduce ? { opacity: 0 } : { opacity: 0, x: 44 }}
                animate={{ opacity: active ? 1 : 0, x: 0 }}
                exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.9 }}
                transition={{ duration: 0.5, ease: EASE }}
              >
                <JobSheet
                  step={jobStep}
                  allDone={at("alldone")}
                  ready={at("ready")}
                  startPressed={at("start") && !at("step3")}
                  completePressed={beat === "alldone"}
                  reduce={reduce}
                />
              </motion.div>
            )}

            {view === "done" && (
              <motion.div
                key="done"
                className="flex justify-center"
                initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.94, y: 8 }}
                animate={{ opacity: active ? 1 : 0, scale: 1, y: 0 }}
                transition={{ duration: 0.55, ease: EASE }}
              >
                {/* Final state (shop portal screen 9): the sheet collapses to
                    a small centered Complete card. */}
                <div className="flex w-[300px] flex-col items-center bg-white/35 px-8 py-9 sm:w-[330px]">
                  <p className="text-[15px] text-[#1a1a1a] sm:text-[16px]" style={serif}>
                    Oil Change - John Wilson
                  </p>
                  <motion.span
                    className="mt-4 flex h-9 w-9 items-center justify-center rounded-full bg-[#1a1a1a] text-[14px] text-white"
                    initial={reduce ? false : { scale: 0 }}
                    animate={{ scale: 1 }}
                    transition={{ type: "spring", stiffness: 320, damping: 18, delay: reduce ? 0 : 0.25 }}
                  >
                    ✓
                  </motion.span>
                  <p className="mt-3 text-[15px] text-[#1a1a1a] sm:text-[16px]" style={serif}>
                    Complete
                  </p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Caption — one selling point per beat, same pattern as the sibling panels */}
      {/* popLayout, not wait: "wait" empties the row for a full exit+enter
          cycle, so the subtitle blinks out between beats. The crossfade
          keeps a line on screen at all times, and `relative` gives the
          exiting chip something to pin to while it fades. */}
      <div className="relative flex h-8 shrink-0 items-center justify-center sm:h-9">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={SHOP_CAPTIONS[beat]}
            className="whitespace-nowrap rounded-full border-[0.5px] border-white/50 bg-white/20 px-5 py-1.5 text-[12px] tracking-[0.03em] text-[#1a1a1a] backdrop-blur-[35px] sm:text-[13px] lg:px-6 lg:py-2 lg:text-[13.5px]"
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8 }}
            animate={{ opacity: active ? 1 : 0, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: -8 }}
            transition={{ duration: 0.35, ease: EASE }}
          >
            {SHOP_CAPTIONS[beat]}
          </motion.span>
        </AnimatePresence>
      </div>
    </div>
  );
}

/** The story stage — no card, no border: the three product demos float
 *  directly on the page and cross-fade to the active role. `resetToken`
 *  remounts the panels so their story clocks restart in sync with the
 *  section's auto-advance reel. */
function PriceLockCard({
  active,
  reduce,
  resetToken,
}: {
  active: number;
  reduce: boolean;
  resetToken: number;
}) {
  return (
    <motion.div
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 40 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "0px 0px -12% 0px" }}
      transition={{ duration: 0.9, ease: EASE }}
      className="relative h-[440px] w-full sm:h-[560px] lg:h-[clamp(400px,calc(100vh_-_400px),640px)]"
    >
      {[0, 1, 2].map((i) => (
        <div
          key={`${i}:${resetToken}`}
          className="absolute inset-0"
          style={{ pointerEvents: active === i ? "auto" : "none" }}
        >
          {i === 0 && <DriversPanel active={active === 0} reduce={reduce} />}
          {i === 1 && <ShopsPanel active={active === 1} reduce={reduce} />}
          {i === 2 && <OtoPanel active={active === 2} reduce={reduce} />}
        </div>
      ))}
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/* Section                                                             */
/* ------------------------------------------------------------------ */
export default function PriceLockSection() {
  const reduce = useReducedMotionSafe();
  // Default focus is "Drivers" (index 0).
  const [active, setActive] = useState(0);
  // Bumped when the section scrolls into view — remounts the panels so the
  // story clock and the advance clock start together.
  const [resetToken, setResetToken] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const listInView = useInView(listRef, { amount: 0.35 });

  // ── Scroll-driven stories (design feedback 2026-08-31) ──
  // On lg the WHOLE COMPOSITION — headline + card — pins inside a 280vh
  // runway (the composition pin keeps the headline gap intact). Stories are
  // driven by exactly two things — scroll and the story clock — hover/click/
  // focus switching is gone. SCROLL IS TRUTH in both directions: scrolling
  // down steps 01→02→03, scrolling back up rewinds. The clock only ever
  // moves FORWARD (a watched story hands off to the next when it completes)
  // and stops at 03 — no loop back to 01, which would yank the reel out from
  // under a visitor whose scroll still sits in zone 3.
  const advanceTo = (i: number) =>
    setActive((a) => Math.max(a, Math.min(i, ROLES.length - 1)));

  const [pinnedMode, setPinnedMode] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const sync = () => setPinnedMode(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  // Short-desktop compact mode: the pinned composition must fit one
  // viewport, and the card's height is driven by the role rows' type +
  // padding — so on sub-1000px-tall screens the headline, row padding and
  // card tail all step down a size. Class swaps via state rather than
  // stacked media variants: `lg:` and `[@media(max-height:…)]:` utilities
  // tie on specificity and resolve by stylesheet order.
  const [shortPin, setShortPin] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px) and (max-height: 1099px)");
    const sync = () => setShortPin(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  // Fit-scale: when the nav-clearing hold plus the composition can't fit
  // the viewport (short laptops), the pinned composition scales down
  // visually — layout (and the sticky release point) stay untouched.
  const stickyRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(1);
  useEffect(() => {
    if (!pinnedMode) {
      setFit(1);
      return;
    }
    const measure = () => {
      const h = stickyRef.current?.offsetHeight ?? 0; // layout height, pre-transform
      const top = shortPin ? 88 : 104;
      setFit(Math.min(1, (window.innerHeight - top - 12) / Math.max(1, h)));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [pinnedMode, shortPin]);

  const runwayRef = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({
    target: runwayRef,
    offset: ["start start", "end end"],
  });
  useMotionValueEvent(scrollYProgress, "change", (p) => {
    if (!pinnedMode) return;
    // Direct set, not advanceTo: scroll rewinds as well as advances.
    setActive(p < 1 / 3 ? 0 : p < 2 / 3 ? 1 : 2);
  });

  // Full loop length of each role's story, minus a beat so we hand off just
  // before the loop restarts. MUST track the SEQ restart times in
  // DriversPanel (24400), ShopsPanel (SHOPS_LOOP_MS) and OtoPanel
  // (OTO_LOOP_MS, 37700).
  const STORY_MS = [24100, SHOPS_LOOP_MS - 300, 37400];

  useEffect(() => {
    if (listInView) setResetToken((t) => t + 1);
  }, [listInView]);

  // The watch path: a visitor who stays on a story sees it hand off to the
  // next when it completes. Stops at the last story — no loop back.
  //
  // A timed hand-off ALSO moves the scroll position to the new story's zone.
  // While pinned this is invisible (the composition is fixed to the
  // viewport; runway progress has no visual) — but it keeps scroll ⇄ story
  // in sync, so the visitor's next scroll gesture continues from the story
  // they're actually watching instead of rewinding them through the zones
  // they timed past (design feedback 2026-08-31). Forward jumps only.
  const lenis = useLenis();
  useEffect(() => {
    if (reduce || !listInView || resetToken === 0) return;
    if (active >= ROLES.length - 1) return;
    const t = window.setTimeout(() => {
      const next = active + 1;
      advanceTo(next);
      if (pinnedMode && runwayRef.current) {
        const r = runwayRef.current.getBoundingClientRect();
        const rTop = r.top + window.scrollY;
        const span = r.height - window.innerHeight;
        const target = Math.round(rTop + span * (next / 3 + 0.02));
        if (target > window.scrollY) {
          if (lenis) lenis.scrollTo(target, { immediate: true });
          else window.scrollTo(0, target);
        }
      }
    }, STORY_MS[active]);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, listInView, reduce, resetToken, pinnedMode]);

  return (
    <section
      id="how-it-works"
      className="mx-auto w-full max-w-[1440px] px-4 pt-12 sm:px-10 sm:pt-16 lg:px-[78px]"
    >
      {/* V1's gradient card (node 302:1074 — section 2's 1269x642 card
          rotated 180°: white fading to #95C7E7, radius 40). The rail sits 76px
          in from the card's left edge, the demo stage fills the right — V1's
          arrangement (rail x160, UI x726 on the page). On mobile the stage
          still stacks first, so the DOM order is stage → list and the swap
          happens with order utilities at lg; mobile stays ordinary flow with
          the timed hand-offs only.

          The sticky box is exactly one viewport tall — pin window and
          `scrollYProgress` are identical by construction (both run from
          "runway top hits viewport top" to "runway bottom hits viewport
          bottom"). No hand-computed card-height constants: the stage height
          flexes with a clamp so headline + card fit one viewport down to
          short laptops. Margins must NOT sit on the sticky box's children in
          normal flow — they collapse out and drag the pin. */}
      {/* `relative` anchors motion's useScroll offset math (it warns on
          static targets). */}
      <div ref={runwayRef} className="relative mt-2 sm:mt-3 lg:h-[280vh]">
        {/* Natural height + fixed top offset, NOT h-screen centering — the
            centered box padded (viewport − composition)/2 of slack under the
            card at release, inflating the gap to the payout section on tall
            monitors (design feedback 2026-08-31, "I hate that you're forcing
            spacing"). Released flush with the runway's end, the next section
            follows at its own padding — constant everywhere. */}
        <div
          ref={stickyRef}
          className={`lg:sticky lg:flex lg:flex-col lg:items-center ${
            shortPin ? "lg:top-[88px] lg:gap-7" : "lg:top-[104px] lg:gap-12"
          }`}
          style={
            pinnedMode && fit < 1
              ? { transform: `scale(${fit})`, transformOrigin: "top center" }
              : undefined
          }
        >
          {/* Centered three-line headline (V1 302:1149: 912x204 box, 68px
              line pitch, page-centered; steps down a size when the pin is
              height-bound) */}
          <Reveal>
            <h2
              className={`mx-auto max-w-[912px] text-center text-[38px] leading-[1.19] text-[#1a1a1a] sm:text-[50px] ${
                shortPin ? "lg:text-[44px] lg:leading-[52px]" : "lg:text-[57px] lg:leading-[68px]"
              }`}
              style={serifDisplay}
            >
              The shop sets the price.
              <br />
              Oto locks it.
              <br />
              You never negotiate.
            </h2>
          </Reveal>

          <div className="mx-auto mt-10 w-full max-w-[1269px] overflow-clip rounded-[28px] bg-[linear-gradient(to_bottom,#FFFFFF,#95C7E7)] sm:mt-12 sm:rounded-[40px] lg:mt-0">
            {/* pb keeps the phone mock + caption chips off the card's bottom
                edge on every step (design feedback 2026-08-24, item 4). */}
            <div
              className={`grid grid-cols-1 gap-12 px-5 pt-10 pb-16 sm:px-10 lg:grid-cols-[minmax(0,0.83fr)_minmax(0,1fr)] lg:items-center lg:gap-10 lg:pt-5 lg:pl-[76px] lg:pr-[27px] ${
                shortPin ? "lg:pb-10" : "lg:pb-20"
              }`}
            >
              {/* The story stage */}
              <div className="lg:order-2">
                <PriceLockCard active={active} reduce={reduce} resetToken={resetToken} />
              </div>

              {/* Numbered roles — display only: they light up as the story
                  advances (scroll or hand-off), never on hover/click. */}
              <div ref={listRef} className="relative lg:order-1">
                {ROLES.map((role, i) => {
                  const on = active === i;
                  return (
                    <div
                      key={role.num}
                      aria-current={on || undefined}
                      className={`relative flex flex-col justify-center rounded-[16px] px-0 [transition:filter_400ms_ease] lg:h-[33.333%] lg:px-8 ${
                        shortPin ? "py-4" : "py-8"
                      }`}
                      style={{ filter: on ? "blur(0px)" : "blur(5px)" }}
                    >
                      <p
                        className="text-[17px] tracking-[0.05em] [transition:color_350ms_ease]"
                        style={{ color: on ? "rgb(119,113,105)" : "rgba(119,113,105,0.35)" }}
                      >
                        {role.num}
                      </p>
                      <div
                        className="mt-3 h-px w-full [transition:background-color_350ms_ease]"
                        style={{ backgroundColor: on ? "rgb(26,26,26)" : "rgba(26,26,26,0.18)" }}
                      />
                      <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-8">
                        <h3
                          className="w-[130px] shrink-0 text-[25px] [transition:color_350ms_ease]"
                          style={{ ...serif, color: on ? "rgb(26,26,26)" : "rgba(26,26,26,0.28)" }}
                        >
                          {role.title}
                        </h3>
                        <p
                          className="max-w-[320px] text-[17px] leading-[23px] tracking-[0.05em] [transition:color_350ms_ease]"
                          style={{ color: on ? "rgb(26,26,26)" : "rgba(26,26,26,0.28)" }}
                        >
                          {role.body}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
