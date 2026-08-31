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
  badge,
  lead,
  copy,
  shown,
  reduce,
  base,
}: Beat & {
  stage: React.ReactNode;
  controls: React.ReactNode;
  /** Optional pill that straddles the stage's bottom-left edge — the stage
   *  clips its own children (overflow-hidden), so the straddle has to hang
   *  off the outer card (Figma: "Comparing Shops"). */
  badge?: React.ReactNode;
  lead: string;
  copy: string;
}) {
  return (
    <motion.div
      className="flex h-full flex-col lg:row-span-2 lg:grid lg:grid-rows-subgrid lg:gap-y-0"
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 26 }}
      animate={shown ? { opacity: 1, y: 0 } : undefined}
      transition={{ delay: reduce ? 0 : base, duration: reduce ? 0.4 : 0.7, ease: EASE }}
    >
      {/* Figma 354:95: the outer card is NEAR-WHITE — the blue lives only in
          the inset stage, which floats inside it with an even margin. The old
          blue-gradient outer card was so close to the stage color that the two
          read as one edge-to-edge blue slab (design feedback 2026-08-30). */}
      <div className="relative flex flex-1 flex-col rounded-[18px] bg-[#f7fafd] p-3.5 shadow-[0_24px_50px_rgba(43,84,120,0.12)] ring-1 ring-[#e7eef5] sm:p-4">
        <div className="relative flex-1 overflow-hidden rounded-[14px] bg-[linear-gradient(168deg,#9fcbef_0%,#c7e1f6_58%,#e9f3fb_100%)]">
          {stage}
        </div>
        {/* The stage's bottom edge sits at 74px (60 controls + 14 padding).
            The pill rides mostly ON the stage with its lip hanging off — set
            high enough that it clears the pager row below (frame look). */}
        {badge && <div className="absolute bottom-[68px] left-7 z-10">{badge}</div>}
        <div className="flex h-[60px] shrink-0 items-center justify-center">{controls}</div>
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
            <div className="rounded-l-[10px] bg-white/90 px-4 py-3 shadow-[0_8px_20px_rgba(43,84,120,0.08)]">
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
            {/* Frosted glass, per the frame — the stage reads through it. */}
            <div className="rounded-[16px] bg-white/40 px-5 py-4 shadow-[0_14px_34px_rgba(43,84,120,0.12)] backdrop-blur-lg">
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
              <Waveform active={!reduce} bars={18} className="mt-2 h-[20px] text-[#7fb0f5]" />
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
      className="flex h-9 w-[44px] items-center justify-center rounded-[8px] bg-white text-[#1a1a1a] shadow-[0_6px_16px_rgba(43,84,120,0.12)] ring-1 ring-[#e7eef5]"
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
      badge={
        <Rise at={0.58} y={12} shown={shown} reduce={reduce} base={base}>
          <div className="inline-flex items-center gap-2 rounded-full bg-white/85 px-4 py-2 shadow-[0_10px_24px_rgba(43,84,120,0.12)] backdrop-blur-sm">
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
      }
      stage={
        <div className="absolute inset-0 flex flex-col justify-center px-6 sm:px-8">
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
                className="rounded-[14px] bg-white/60 px-6 py-5 shadow-[0_14px_34px_rgba(43,84,120,0.12)] backdrop-blur-lg"
              >
                <div className="flex items-baseline justify-between">
                  <p className="text-[15px] text-[#1a1a1a]" style={serif}>
                    {q.shop}
                  </p>
                  <span className="text-[9px] font-medium tracking-[0.03em] text-[#8a9094]">
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

        </div>
      }
      controls={
        <Pop at={0.66} shown={shown} reduce={reduce} base={base}>
          <div className="flex items-center gap-4">
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

/** The booked shop's neighborhood. The Figma frame shows a real street map —
 *  organic curves, varied road weights — with the brand's 3D glass pins, not
 *  a sparse abstract grid with dots (design feedback 2026-08-30). Streets
 *  draw themselves in, then the pins drop. */
function MapArt({ shown, reduce, base }: Beat) {
  const draw = (i: number) => ({
    initial: reduce ? { opacity: 0 } : { pathLength: 0, opacity: 0 },
    animate: shown ? (reduce ? { opacity: 1 } : { pathLength: 1, opacity: 1 }) : undefined,
    transition: { delay: reduce ? 0 : base + 0.14 + i * 0.04, duration: reduce ? 0.4 : 0.9, ease: EASE },
  });
  // The frame's map is a dense real-city network, not a sparse sketch —
  // deterministic wavy streets at three weights (no randomness: resume-safe
  // and stable between renders).
  const wave = (i: number, k: number) => ((i * 37 + k * 13) % 17) - 8;
  const horizontals = Array.from({ length: 11 }, (_, i) => {
    const y = 12 + i * 28 + wave(i, 1);
    return `M-10 ${y} C ${55 + ((i * 29) % 45)} ${y + wave(i, 2)}, ${190 + ((i * 53) % 55)} ${y - wave(i, 3)}, 410 ${y + wave(i, 4)}`;
  });
  const verticals = Array.from({ length: 10 }, (_, i) => {
    const x = 18 + i * 41 + wave(i, 5);
    return `M${x} -10 C ${x + wave(i, 6)} 70, ${x - wave(i, 7)} 190, ${x + wave(i, 8)} 310`;
  });
  const diagonals = [
    "M-10 30 C 90 70, 210 150, 410 250",
    "M60 -10 C 130 80, 260 160, 410 200",
    "M-10 250 C 120 220, 260 140, 410 40",
    "M200 310 C 250 220, 330 120, 410 90",
  ];
  // The booked shop gets the big pin; the runner-up sits smaller, further out.
  // Both live in the top strip of the stage — the $347 card overlays the
  // bottom ~60%, so anything below y≈100 hides behind it.
  const pins = [
    { cx: 132, cy: 92, w: 46 },
    { cx: 308, cy: 60, w: 30 },
  ];
  return (
    <svg
      viewBox="0 0 400 300"
      className="absolute inset-0 h-full w-full"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden
    >
      <g fill="none" strokeLinecap="round">
        {horizontals.map((d, i) => (
          <motion.path
            key={d}
            d={d}
            stroke={`rgba(255,255,255,${i % 3 === 0 ? 0.8 : 0.5})`}
            strokeWidth={i % 3 === 0 ? 2 : 1.1}
            {...draw(i % 6)}
          />
        ))}
        {verticals.map((d, i) => (
          <motion.path
            key={d}
            d={d}
            stroke={`rgba(255,255,255,${i % 3 === 1 ? 0.75 : 0.45})`}
            strokeWidth={i % 3 === 1 ? 1.8 : 1}
            {...draw((i + 2) % 6)}
          />
        ))}
        {diagonals.map((d, i) => (
          <motion.path
            key={d}
            d={d}
            stroke="rgba(255,255,255,0.4)"
            strokeWidth="1.2"
            {...draw((i + 4) % 6)}
          />
        ))}
      </g>
      {pins.map((p, i) => (
        <motion.g
          key={i}
          initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0, y: -12 }}
          animate={shown ? { opacity: 1, scale: 1, y: 0 } : undefined}
          style={{ transformOrigin: `${p.cx}px ${p.cy}px` }}
          transition={
            reduce
              ? { duration: 0.4 }
              : { delay: base + 0.62 + i * 0.12, type: "spring", stiffness: 300, damping: 16 }
          }
        >
          {/* White marker dot under the mark, like the frame's map pins. */}
          <circle cx={p.cx} cy={p.cy} r={p.w * 0.3} fill="white" opacity="0.95" />
          {/* Anchor the pin's tip (bottom-center of the mark) on the spot. */}
          <image
            href="/pin-logo-3d.png"
            x={p.cx - p.w / 2}
            y={p.cy - p.w * 0.88}
            width={p.w}
            height={p.w}
          />
        </motion.g>
      ))}
    </svg>
  );
}

/*
 * The authorization card. Two tiers, both worded straight from the Figma
 * frame: it rests at "Authorized · held" with the payout note, and ↵ confirm
 * settles it to "Confirmed". (The older four-tier walk-up ladder was replaced
 * 2026-08-30 when the section was matched to the frame verbatim.)
 */
const AUTH_TIERS = [
  // Resting state matches the Figma frame verbatim: the hold is already
  // authorized, the payout note showing, bar most of the way (2026-08-30 —
  // "exactly like the figma"). ↵ confirm settles it.
  { status: "Authorized · held", note: "Job complete · paid out in 24 hours.", fill: 0.85, done: false, control: "confirm" },
  { status: "Confirmed", note: "Job complete · paid out in 24 hours.", fill: 1, done: true, control: "confirmed" },
] as const;

function AuthCard(beat: Beat) {
  const { shown, reduce, base } = beat;
  const [tier, setTier] = useState(0);
  const t = AUTH_TIERS[tier];

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
            className="absolute inset-x-4 top-[57%] -translate-y-1/2 sm:inset-x-5"
          >
            <div className="rounded-[14px] bg-white/55 px-5 py-4 shadow-[0_14px_34px_rgba(43,84,120,0.14)] backdrop-blur-lg">
              <p className="text-[22px] leading-none text-[#1a1a1a]" style={{ ...serif, fontWeight: 500 }}>
                $347
              </p>
              <div className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-[#e9f1fa]/80 px-2.5 py-1">
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

              {/* Progress line — a single unbroken bar, per the frame. */}
              <div className="relative mt-3 h-[3px] overflow-hidden rounded-full bg-[#1a1a1a]/10">
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
    <section className="mx-auto w-full max-w-[1440px] px-4 pt-20 sm:px-10 sm:pt-28 lg:px-[78px]">
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

      {/* Two shared rows on lg — stage, then caption. Every column is a subgrid
          spanning both, so the blue cards all end on one line and the captions
          all start on one line, however many lines a caption wraps to (design
          feedback 2026-08-30: the middle caption runs to 3 lines where the
          outer two run to 2, which was stealing ~23px off the middle card).

          The height floor is on the stage row rather than on the column, so a
          longer caption lengthens the column instead of eating the stage. 380px
          is the height the stages already rendered at with 2-line captions —
          the middle one now matches them instead of the other two shrinking to
          meet it. Row gap is 0 because the caption carries its own `mt-4`. */}
      <div
        ref={rowRef}
        className="mt-10 grid grid-cols-1 gap-6 lg:mt-14 lg:grid-cols-3 lg:grid-rows-[minmax(380px,1fr)_auto] lg:gap-x-5 lg:gap-y-0"
      >
        <div className="min-h-[440px] lg:row-span-2 lg:grid lg:min-h-0 lg:grid-rows-subgrid">
          <VoiceIntakeCard shown={shown} reduce={reduce} base={LEAD[0]} />
        </div>
        <div className="min-h-[440px] lg:row-span-2 lg:grid lg:min-h-0 lg:grid-rows-subgrid">
          <PayCard shown={shown} reduce={reduce} base={LEAD[1]} />
        </div>
        <div className="min-h-[440px] lg:row-span-2 lg:grid lg:min-h-0 lg:grid-rows-subgrid">
          <AuthCard shown={shown} reduce={reduce} base={LEAD[2]} />
        </div>
      </div>
    </section>
  );
}
