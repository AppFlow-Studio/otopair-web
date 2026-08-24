"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useInView } from "motion/react";
import { useLenis } from "lenis/react";
import { ArrowLeft, ArrowRight, CornerDownLeft } from "lucide-react";
import { Waveform } from "../voice-bar";
import { useReducedMotionSafe } from "../shared";
import { Reveal, serif, serifDisplay } from "./reveal";

/*
 * "The whole path, shown." — rebuilt to Figma V2 (node 354:95, the three-card
 * row under Frame 73) per design feedback 2026-08-24, item 6: the cards are a
 * live, clickable demo now, not a screenshot.
 *   1. Voice Intake — the transcript types itself; ● talk actually hands the
 *      visitor to the hero's live Oto conversation (otopair:talk).
 *   2. What you'll actually pay — the ←/→ pager cycles three real-looking
 *      shop quotes; the dots track 1/3.
 *   3. Secure Authorization — ↵ confirm fills the hold's progress line and
 *      flips the status from "Authorized · held" to "Confirmed".
 *
 * The doc's overall goal is that the row "feel like a live, clickable demo
 * rather than a static screenshot", so the cards don't just fade in as flat
 * images: one section-level clock assembles each card's contents piece by
 * piece — panel, then rows, then controls — with the three cards cascading.
 * Reduced motion collapses all of it to plain fades.
 */

const EASE = [0.22, 1, 0.36, 1] as const;
const BLUE = "#5299fe";

/** Per-card offset so the row assembles left to right. */
const LEAD = [0, 0.12, 0.24] as const;

type Beat = { shown: boolean; reduce: boolean; base: number };

/** Fade + rise, `at` seconds into this card's slot of the section clock. */
function Rise({
  at,
  x = 0,
  y = 14,
  className,
  children,
  shown,
  reduce,
  base,
}: Beat & { at: number; x?: number; y?: number; className?: string; children: React.ReactNode }) {
  return (
    <motion.div
      className={className}
      initial={reduce ? { opacity: 0 } : { opacity: 0, x, y }}
      animate={shown ? { opacity: 1, x: 0, y: 0 } : undefined}
      transition={{ delay: reduce ? 0 : base + at, duration: reduce ? 0.4 : 0.6, ease: EASE }}
    >
      {children}
    </motion.div>
  );
}

/** Spring pop for the controls, so a button arrives like a button. */
function Pop({
  at,
  className,
  children,
  shown,
  reduce,
  base,
}: Beat & { at: number; className?: string; children: React.ReactNode }) {
  return (
    <motion.div
      className={className}
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 10, scale: 0.9 }}
      animate={shown ? { opacity: 1, y: 0, scale: 1 } : undefined}
      transition={
        reduce
          ? { duration: 0.4 }
          : { delay: base + at, type: "spring", stiffness: 260, damping: 20 }
      }
    >
      {children}
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/*  Shared card chrome                                                 */
/* ------------------------------------------------------------------ */

function PathCard({
  stage,
  controls,
  lead,
  copy,
  shown,
  reduce,
  base,
}: Beat & {
  stage: React.ReactNode;
  controls: React.ReactNode;
  lead: string;
  copy: string;
}) {
  return (
    <motion.div
      className="flex h-full flex-col"
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 26 }}
      animate={shown ? { opacity: 1, y: 0 } : undefined}
      transition={{ delay: reduce ? 0 : base, duration: reduce ? 0.4 : 0.7, ease: EASE }}
    >
      <div className="flex flex-1 flex-col rounded-[20px] bg-[linear-gradient(155deg,#f3f9fd_0%,#ddeefa_60%,#d3e9f8_100%)] p-4 shadow-[0_18px_44px_rgba(43,84,120,0.10)] ring-1 ring-white/70 sm:p-5">
        <div className="relative flex-1 overflow-hidden rounded-[14px] bg-[linear-gradient(160deg,#bcdcf3_0%,#e0effa_70%,#eef6fc_100%)]">
          {stage}
        </div>
        <div className="flex h-[64px] shrink-0 items-center justify-center">{controls}</div>
      </div>
      <Rise at={0.5} y={10} shown={shown} reduce={reduce} base={base}>
        <p className="mt-4 text-[14px] leading-[1.55] text-[#777169] sm:text-[15px]">
          <span className="font-semibold text-[#1a1a1a]">{lead}</span> {copy}
        </p>
      </Rise>
    </motion.div>
  );
}

function ActionPill({
  onClick,
  children,
  label,
}: {
  onClick: () => void;
  children: React.ReactNode;
  label: string;
}) {
  return (
    <motion.button
      type="button"
      aria-label={label}
      onClick={onClick}
      whileHover={{ scale: 1.04 }}
      whileTap={{ scale: 0.95 }}
      className="flex items-center gap-2 rounded-full px-6 py-2.5 text-[13px] font-medium text-white shadow-[0_10px_26px_rgba(82,153,254,0.45)]"
      style={{ backgroundColor: BLUE }}
    >
      {children}
    </motion.button>
  );
}

/* ------------------------------------------------------------------ */
/*  Card 1 — Voice Intake                                              */
/* ------------------------------------------------------------------ */

const TRANSCRIPT = "My brakes are squeaking when i slow down, mostly in the ";

/** Types the transcript in-stream, starting once the panel it sits in has
 *  landed. Reduced motion gets the finished line and a still caret. */
function TypedTranscript({ shown, reduce, startAt }: { shown: boolean; reduce: boolean; startAt: number }) {
  const [n, setN] = useState(0);

  // One timer chain: the first character waits for the panel to land, the
  // rest tick at typing speed. (A separate "has started" flag would be a
  // second piece of state doing nothing the delay can't.)
  useEffect(() => {
    if (!shown || reduce) return;
    if (n >= TRANSCRIPT.length) return;
    const delay = n === 0 ? startAt * 1000 : 42 + Math.random() * 46;
    const t = window.setTimeout(() => setN(n + 1), delay);
    return () => window.clearTimeout(t);
  }, [shown, reduce, startAt, n]);

  return (
    <p className="mt-3 min-h-[2.6em] text-[13px] leading-[1.4] text-[#1a1a1a] sm:text-[14px]">
      {reduce ? TRANSCRIPT : TRANSCRIPT.slice(0, n)}
      <motion.span
        className="ml-[1px] inline-block h-[1em] w-[1.5px] translate-y-[2px] bg-[#1a1a1a]"
        animate={reduce ? { opacity: 1 } : { opacity: [1, 0, 1] }}
        transition={reduce ? undefined : { duration: 1.05, repeat: Infinity, ease: "linear" }}
      />
    </p>
  );
}

function VoiceIntakeCard(beat: Beat) {
  const { shown, reduce, base } = beat;
  // The marketing layout scrolls through Lenis (root) — going around it with
  // a native smooth scrollTo makes the two animators fight.
  const lenis = useLenis();
  const talk = () => {
    // Same-gesture dispatch: the hero's startVoice runs inside this click's
    // task, so the browser treats the mic request as user-initiated.
    window.dispatchEvent(new Event("otopair:talk"));
    if (lenis) lenis.scrollTo(0);
    else window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <PathCard
      {...beat}
      lead="Voice Intake."
      copy="You describe the car and the symptom out loud. Transcribed in-stream — no form, no typing."
      stage={
        <div className="absolute inset-0">
          {/* Booking Suggestions slides in from the right edge it's tucked into. */}
          <Rise
            at={0.2}
            x={26}
            y={0}
            shown={shown}
            reduce={reduce}
            base={base}
            className="absolute -right-3 top-5 w-[62%]"
          >
            <div className="rounded-l-[10px] bg-white/55 px-4 py-3 backdrop-blur-sm">
              <p className="text-[11px] font-semibold text-[#1a1a1a]">Booking Suggestions</p>
              <div className="mt-1.5 flex justify-between text-[10px] text-[#777169]">
                <span>Service</span>
                <span className="text-[#1a1a1a]">Front Brak…</span>
              </div>
              <div className="mt-1 flex justify-between text-[10px] text-[#777169]">
                <span>Earliest Slot</span>
                <span className="text-[#1a1a1a]">Tomorrow,…</span>
              </div>
            </div>
          </Rise>

          {/* The live transcription panel. */}
          <Rise
            at={0.32}
            y={18}
            shown={shown}
            reduce={reduce}
            base={base}
            className="absolute inset-x-4 top-[34%] sm:inset-x-5"
          >
            <div className="rounded-[12px] bg-white/70 px-4 py-3.5 shadow-[0_14px_34px_rgba(43,84,120,0.14)] backdrop-blur-md">
              <div className="flex items-center gap-2">
                <motion.span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: BLUE }}
                  animate={reduce || !shown ? undefined : { opacity: [1, 0.35, 1] }}
                  transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
                />
                <span className="text-[9px] font-medium tracking-[0.14em]" style={{ color: BLUE }}>
                  LISTENING
                </span>
              </div>
              <Waveform active={!reduce} bars={14} className="mt-2 h-[20px] text-[#5299fe]" />
              <TypedTranscript shown={shown} reduce={reduce} startAt={base + 0.6} />
            </div>
          </Rise>
        </div>
      }
      controls={
        <Pop at={0.62} shown={shown} reduce={reduce} base={base}>
          <ActionPill onClick={talk} label="Start talking to Oto">
            <span className="h-1.5 w-1.5 rounded-full bg-white" />
            talk
          </ActionPill>
        </Pop>
      }
    />
  );
}

/* ------------------------------------------------------------------ */
/*  Card 2 — What you'll actually pay                                  */
/* ------------------------------------------------------------------ */

/** Same brake job, quoted by three shops from the landing's standing cast —
 *  labor hours × each shop's own rate, itemized parts, flat fee line. */
const QUOTES = [
  {
    shop: "Bay Ridge Motors",
    labor: { line: "Labor · 2.5 hr x $96", amount: 240 },
    parts: { line: "Front brake pads", amount: 84 },
    // $23 keeps this quote's computed total at the $347 the Secure
    // Authorization card holds — the two cards tell one story.
    fees: 23,
  },
  {
    shop: "Eltingville Auto Care",
    labor: { line: "Labor · 2.5 hr x $88", amount: 220 },
    parts: { line: "Front brake pads", amount: 78 },
    fees: 20,
  },
  {
    shop: "Precision Motors",
    labor: { line: "Labor · 2.5 hr x $102", amount: 255 },
    parts: { line: "Front brake pads", amount: 92 },
    fees: 24,
  },
] as const;

function PagerButton({ dir, onClick }: { dir: -1 | 1; onClick: () => void }) {
  const Icon = dir === -1 ? ArrowLeft : ArrowRight;
  return (
    <motion.button
      type="button"
      aria-label={dir === -1 ? "Previous quote" : "Next quote"}
      onClick={onClick}
      whileHover={{ scale: 1.06 }}
      whileTap={{ scale: 0.92 }}
      className="flex h-10 w-10 items-center justify-center rounded-full bg-white text-[#1a1a1a] shadow-[0_8px_22px_rgba(43,84,120,0.16)]"
    >
      <Icon className="h-4 w-4" strokeWidth={2} />
    </motion.button>
  );
}

function PayCard(beat: Beat) {
  const { shown, reduce, base } = beat;
  const [idx, setIdx] = useState(0);
  const [dir, setDir] = useState<1 | -1>(1);
  const [paged, setPaged] = useState(false);
  const q = QUOTES[idx];
  const total = q.labor.amount + q.parts.amount + q.fees;

  const page = (d: 1 | -1) => {
    setDir(d);
    setPaged(true);
    setIdx((i) => (i + d + QUOTES.length) % QUOTES.length);
  };

  // The invoice rows assemble line by line on first view; once the visitor
  // pages, the card swaps whole so the rows don't re-stagger each time.
  const row = (i: number) =>
    paged || reduce
      ? {}
      : {
          initial: { opacity: 0, x: 12 },
          animate: shown ? { opacity: 1, x: 0 } : undefined,
          transition: { delay: base + 0.34 + i * 0.08, duration: 0.45, ease: EASE },
        };

  return (
    <PathCard
      {...beat}
      lead="What you'll actually pay."
      copy="Labor, parts, and fees broken out line by line — the total you see is the total you pay. No padding, no surprises at pickup."
      stage={
        <div className="absolute inset-0 flex flex-col justify-center px-4 sm:px-5">
          {/* aria-live so paging announces the new quote to screen readers. */}
          <div className="relative overflow-hidden" aria-live="polite">
            {/* Direction must come through variants+custom: a plain exit prop
                bakes `dir` from the render BEFORE the click, so reversing
                direction would slide the outgoing card the wrong way. */}
            <AnimatePresence mode="popLayout" initial={false} custom={dir}>
              <motion.div
                key={q.shop}
                custom={dir}
                variants={{
                  enter: (d: 1 | -1) => ({ opacity: 0, x: paged ? d * 56 : 0, y: paged ? 0 : 16 }),
                  center: { opacity: 1, x: 0, y: 0 },
                  exit: (d: 1 | -1) => ({ opacity: 0, x: d * -56 }),
                }}
                initial="enter"
                animate={shown ? "center" : "enter"}
                exit="exit"
                transition={{
                  delay: paged || reduce ? 0 : base + 0.22,
                  duration: reduce ? 0.4 : 0.45,
                  ease: EASE,
                }}
                className="rounded-[12px] bg-white/80 px-5 py-4 shadow-[0_14px_34px_rgba(43,84,120,0.14)] backdrop-blur-md"
              >
                <div className="flex items-baseline justify-between">
                  <p className="text-[15px] text-[#1a1a1a]" style={serif}>
                    {q.shop}
                  </p>
                  <span className="text-[8.5px] font-medium uppercase tracking-[0.08em] text-[#8a9094]">
                    Verified Shop
                  </span>
                </div>
                <div className="mt-3 space-y-1.5 text-[11.5px] text-[#777169]">
                  <motion.div className="flex justify-between" {...row(0)}>
                    <span>{q.labor.line}</span>
                    <span className="text-[#1a1a1a]">${q.labor.amount}</span>
                  </motion.div>
                  <motion.div className="flex justify-between" {...row(1)}>
                    <span>{q.parts.line}</span>
                    <span className="text-[#1a1a1a]">${q.parts.amount}</span>
                  </motion.div>
                  <motion.div className="flex justify-between" {...row(2)}>
                    <span>Fees</span>
                    <span className="text-[#1a1a1a]">${q.fees}</span>
                  </motion.div>
                </div>
                <motion.div
                  className="mt-3 flex justify-between border-t border-[#1a1a1a]/10 pt-2.5 text-[13px] font-semibold text-[#1a1a1a]"
                  {...row(3)}
                >
                  <span>Total</span>
                  <span>${total}</span>
                </motion.div>
              </motion.div>
            </AnimatePresence>
          </div>

          {/* Comparing Shops + live dots */}
          <Rise at={0.58} y={12} shown={shown} reduce={reduce} base={base} className="mt-4 self-start">
            <div className="inline-flex items-center gap-2 rounded-full bg-white/55 px-4 py-2 backdrop-blur-sm">
              <span className="text-[11px] font-medium text-[#1a1a1a]">Comparing Shops</span>
              <span className="flex items-center gap-1">
                {QUOTES.map((_, i) => (
                  <motion.span
                    key={i}
                    className="h-1.5 w-1.5 rounded-full"
                    animate={{ backgroundColor: i === idx ? BLUE : "rgba(26,26,26,0.18)" }}
                    transition={{ duration: 0.3 }}
                  />
                ))}
              </span>
            </div>
          </Rise>
        </div>
      }
      controls={
        <Pop at={0.66} shown={shown} reduce={reduce} base={base}>
          <div className="flex items-center gap-5">
            <PagerButton dir={-1} onClick={() => page(-1)} />
            <span className="min-w-[30px] text-center text-[13px] text-[#1a1a1a] tabular-nums">
              {idx + 1}/{QUOTES.length}
            </span>
            <PagerButton dir={1} onClick={() => page(1)} />
          </div>
        </Pop>
      }
    />
  );
}

/* ------------------------------------------------------------------ */
/*  Card 3 — Secure Authorization                                      */
/* ------------------------------------------------------------------ */

/** Faint white street grid + two pins, standing in for the booked shop's map.
 *  The streets draw themselves in, then the pins drop. */
function MapArt({ shown, reduce, base }: Beat) {
  const draw = (i: number) => ({
    initial: reduce ? { opacity: 0 } : { pathLength: 0, opacity: 0 },
    animate: shown ? (reduce ? { opacity: 1 } : { pathLength: 1, opacity: 1 }) : undefined,
    transition: { delay: reduce ? 0 : base + 0.18 + i * 0.05, duration: reduce ? 0.4 : 0.9, ease: EASE },
  });
  const majors = [
    "M-10 60 C 90 40, 180 90, 410 55",
    "M-10 140 C 120 120, 240 165, 410 130",
    "M-10 225 C 100 210, 260 250, 410 215",
    "M70 -10 C 60 90, 95 200, 75 310",
    "M180 -10 C 175 80, 200 210, 185 310",
    "M300 -10 C 290 100, 320 190, 305 310",
  ];
  const minors = [
    "M-10 100 C 130 85, 250 120, 410 95",
    "M-10 185 C 110 170, 270 205, 410 175",
    "M125 -10 C 118 100, 140 220, 128 310",
    "M245 -10 C 240 90, 260 200, 250 310",
  ];
  return (
    <svg
      viewBox="0 0 400 300"
      className="absolute inset-0 h-full w-full"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden
    >
      <g stroke="rgba(255,255,255,0.75)" strokeWidth="2.5" fill="none">
        {majors.map((d, i) => (
          <motion.path key={d} d={d} {...draw(i)} />
        ))}
      </g>
      <g stroke="rgba(255,255,255,0.45)" strokeWidth="1.4" fill="none">
        {minors.map((d, i) => (
          <motion.path key={d} d={d} {...draw(i + 3)} />
        ))}
      </g>
      {[
        { cx: 148, cy: 84 },
        { cx: 302, cy: 64 },
      ].map((p, i) => (
        <motion.g
          key={i}
          initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0, y: -10 }}
          animate={shown ? { opacity: 1, scale: 1, y: 0 } : undefined}
          style={{ transformOrigin: `${p.cx}px ${p.cy}px` }}
          transition={
            reduce
              ? { duration: 0.4 }
              : { delay: base + 0.62 + i * 0.12, type: "spring", stiffness: 300, damping: 16 }
          }
        >
          <circle cx={p.cx} cy={p.cy} r="11" fill="white" opacity="0.9" />
          <circle cx={p.cx} cy={p.cy} r="6" fill={BLUE} />
        </motion.g>
      ))}
    </svg>
  );
}

/*
 * The authorization ladder. One click walks the card through three tiers —
 * the hold goes on, the hold is authorized, then the job settles — rather
 * than snapping straight from "Authorized · held" to "Confirmed". Each tier
 * owns a third of the progress line, and the line is notched into three
 * segments so the ladder reads even before it moves.
 *
 * Labels use the card's own vocabulary from the Figma mock ("Authorized ·
 * held", "Job complete · paid out in 24 hours"). They are data here, so
 * renaming a tier or reordering the ladder is a one-line edit.
 */
const AUTH_TIERS = [
  { status: "Awaiting authorization", note: "Tap confirm to place the hold.", fill: 0.06, done: false, control: "confirm" },
  { status: "Hold placed · $347", note: "Card verified — funds not captured.", fill: 0.36, done: false, control: "placing the hold" },
  { status: "Authorized · held", note: "Held until the job is done.", fill: 0.7, done: false, control: "authorizing" },
  { status: "Confirmed", note: "Job complete · paid out in 24 hours.", fill: 1, done: true, control: "confirmed" },
] as const;

const TIER_MS = 1050;

function AuthCard(beat: Beat) {
  const { shown, reduce, base } = beat;
  const [tier, setTier] = useState(0);
  const t = AUTH_TIERS[tier];
  const last = AUTH_TIERS.length - 1;

  // Once the visitor starts the ladder it climbs on its own to the top.
  useEffect(() => {
    if (tier === 0 || tier >= last) return;
    const id = window.setTimeout(() => setTier(tier + 1), reduce ? 300 : TIER_MS);
    return () => window.clearTimeout(id);
  }, [tier, last, reduce]);

  return (
    <PathCard
      {...beat}
      lead="Secure Authorization."
      copy="Apple Pay, Google Pay and Stripe. Your money doesn't move until the job is done."
      stage={
        <div className="absolute inset-0">
          <MapArt {...beat} />
          <Rise
            at={0.4}
            y={18}
            shown={shown}
            reduce={reduce}
            base={base}
            className="absolute inset-x-4 top-1/2 -translate-y-1/2 sm:inset-x-5"
          >
            <div className="rounded-[12px] bg-white/80 px-5 py-4 shadow-[0_14px_34px_rgba(43,84,120,0.16)] backdrop-blur-md">
              <p className="text-[22px] leading-none text-[#1a1a1a]" style={{ ...serif, fontWeight: 500 }}>
                $347
              </p>
              <div className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-[#eef4fb] px-2.5 py-1">
                <motion.span
                  className="h-1.5 w-1.5 rounded-full"
                  animate={{
                    backgroundColor: t.done ? "#22c55e" : BLUE,
                    // A tier still in flight pulses; the settled ones sit still.
                    opacity: reduce || t.done || tier === 0 ? 1 : [1, 0.35, 1],
                  }}
                  transition={{
                    backgroundColor: { duration: 0.3 },
                    opacity: { duration: 1, repeat: Infinity, ease: "easeInOut" },
                  }}
                />
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.span
                    key={t.status}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -6 }}
                    transition={{ duration: 0.28, ease: EASE }}
                    className="text-[9.5px] font-medium tracking-[0.04em] text-[#33383b]"
                  >
                    {t.status}
                  </motion.span>
                </AnimatePresence>
              </div>

              {/* Three-segment progress line: notched into thirds, one tier
                  per segment, filling as the ladder climbs. */}
              <div className="relative mt-3 h-[2.5px] overflow-hidden rounded-full bg-[#1a1a1a]/10">
                <motion.div
                  className="h-full origin-left rounded-full"
                  animate={{
                    scaleX: shown ? t.fill : 0,
                    backgroundColor: t.done ? "#22c55e" : BLUE,
                  }}
                  initial={{ scaleX: 0, backgroundColor: BLUE }}
                  transition={{
                    scaleX: {
                      delay: tier === 0 && !reduce ? base + 0.56 : 0,
                      duration: reduce ? 0.2 : 0.7,
                      ease: EASE,
                    },
                    backgroundColor: { duration: 0.4 },
                  }}
                />
                {[1, 2].map((n) => (
                  <span
                    key={n}
                    className="absolute inset-y-0 w-px bg-white/70"
                    style={{ left: `${(n / 3) * 100}%` }}
                    aria-hidden
                  />
                ))}
              </div>

              <div className="mt-3 min-h-[1.4em]">
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.p
                    key={t.note}
                    initial={{ opacity: 0, y: 5 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -5 }}
                    transition={{ duration: 0.28, ease: EASE }}
                    className="text-[11.5px] text-[#33383b]"
                  >
                    {t.note}
                  </motion.p>
                </AnimatePresence>
              </div>
            </div>
          </Rise>
        </div>
      }
      controls={
        <Pop at={0.7} shown={shown} reduce={reduce} base={base}>
          {tier === 0 ? (
            <ActionPill onClick={() => setTier(1)} label="Confirm the booking demo">
              <CornerDownLeft className="h-3.5 w-3.5" strokeWidth={2.2} />
              confirm
            </ActionPill>
          ) : (
            <motion.span
              key={t.control}
              initial={{ opacity: 0, scale: 0.94 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.3, ease: EASE }}
              className="flex items-center gap-2 rounded-full bg-white px-6 py-2.5 text-[13px] font-medium text-[#1a1a1a] shadow-[0_8px_22px_rgba(43,84,120,0.14)]"
            >
              {t.done ? (
                <span className="text-[#22c55e]">✓</span>
              ) : (
                <motion.span
                  className="h-3 w-3 rounded-full border-[1.5px] border-[#1a1a1a]/15 border-t-[#5299fe]"
                  animate={reduce ? undefined : { rotate: 360 }}
                  transition={{ duration: 0.8, repeat: Infinity, ease: "linear" }}
                />
              )}
              {t.control}
            </motion.span>
          )}
        </Pop>
      }
    />
  );
}

/* ------------------------------------------------------------------ */
/*  Section                                                            */
/* ------------------------------------------------------------------ */

/** "The whole path, shown." — voice intake → the real total → secure auth. */
export default function PathSection() {
  const reduce = useReducedMotionSafe();
  const rowRef = useRef<HTMLDivElement>(null);
  // One trigger for the row — every card beat above counts from here.
  const shown = useInView(rowRef, { once: true, margin: "0px 0px -12% 0px" });

  return (
    <section className="mx-auto w-full max-w-[1440px] px-4 pt-28 sm:px-10 sm:pt-36 lg:px-[78px]">
      <Reveal>
        <h2
          className="max-w-[600px] text-[40px] leading-[1.0] text-[#1a1a1a] sm:text-[54px] lg:text-[68px]"
          style={serifDisplay}
        >
          The whole path,
          <br />
          shown.
        </h2>
      </Reveal>

      <div
        ref={rowRef}
        className="mt-14 grid grid-cols-1 gap-6 lg:mt-20 lg:grid-cols-3 lg:gap-5"
      >
        <div className="min-h-[440px]">
          <VoiceIntakeCard shown={shown} reduce={reduce} base={LEAD[0]} />
        </div>
        <div className="min-h-[440px]">
          <PayCard shown={shown} reduce={reduce} base={LEAD[1]} />
        </div>
        <div className="min-h-[440px]">
          <AuthCard shown={shown} reduce={reduce} base={LEAD[2]} />
        </div>
      </div>
    </section>
  );
}
