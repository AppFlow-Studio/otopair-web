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
      className="flex h-full flex-col lg:row-span-2 lg:grid lg:grid-rows-subgrid lg:gap-y-0"
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 26 }}
      animate={shown ? { opacity: 1, y: 0 } : undefined}
      transition={{ delay: reduce ? 0 : base, duration: reduce ? 0.4 : 0.7, ease: EASE }}
    >
      {/* Figma 354:95: the outer card is NEAR-WHITE — the blue lives only in
          the inset stage, which floats inside it with an even margin. The old
          blue-gradient outer card was so close to the stage color that the two
          read as one edge-to-edge blue slab (design feedback 2026-08-30). */}
      <div className="relative flex flex-1 flex-col rounded-[20px] bg-[#fbfdfe] p-3.5 shadow-[0_18px_40px_rgba(43,84,120,0.10)] ring-1 ring-[#ecf2f8] sm:p-4">
        <div className="relative flex-1 overflow-hidden rounded-[14px] bg-[linear-gradient(180deg,#a5cfef_0%,#cfe5f7_62%,#ecf5fc_100%)]">
          {stage}
        </div>
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
  tone = "solid",
}: {
  onClick: () => void;
  children: React.ReactNode;
  label: string;
  /** The frame renders card 3's confirm a shade softer than card 1's talk. */
  tone?: "solid" | "soft";
}) {
  return (
    <motion.button
      type="button"
      aria-label={label}
      onClick={onClick}
      whileHover={{ scale: 1.04 }}
      whileTap={{ scale: 0.95 }}
      className={`flex items-center gap-2 rounded-full px-6 py-2.5 text-[13px] font-medium text-white ${
        tone === "soft"
          ? "shadow-[0_8px_20px_rgba(82,153,254,0.35)]"
          : "shadow-[0_10px_26px_rgba(82,153,254,0.45)]"
      }`}
      style={{ backgroundColor: tone === "soft" ? "rgba(82,153,254,0.78)" : BLUE }}
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
            className="absolute -right-3 top-6 w-[62%]"
          >
            <div className="rounded-l-[10px] bg-white/90 px-5 py-4 shadow-[0_8px_20px_rgba(43,84,120,0.08)]">
              <p className="text-[12px] font-semibold text-[#1a1a1a]">Booking Suggestions</p>
              <div className="mt-2 flex justify-between text-[10.5px] text-[#777169]">
                <span>Service</span>
                <span className="text-[#1a1a1a]">Front Brak…</span>
              </div>
              <div className="mt-1.5 flex justify-between text-[10.5px] text-[#777169]">
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
            /* Anchored to the stage's BOTTOM, not floated at 34% — the frame
               keeps only a slim gap under the transcript; a top anchor left a
               dead blue field below it (design feedback 2026-08-31). */
            className="absolute inset-x-4 bottom-4 sm:inset-x-5"
          >
            {/* Frosted glass, per the frame — the stage reads through it. */}
            <div className="rounded-[16px] border-[0.5px] border-white/50 bg-white/20 px-6 py-5 backdrop-blur-[35px]">
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
              <Waveform active={!reduce} bars={28} className="mt-2.5 h-[22px] text-[#8db8f5]" />
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
 *  one flat labor line at each shop's own price (no hours-×-rate math on a
 *  marketing page — design feedback 2026-08-31), itemized parts, and a
 *  supplies-and-fees line. The differing labor totals alone carry the
 *  "each shop sets its own price" story. */
const QUOTES = [
  {
    shop: "Bay Ridge Motors",
    labor: 240,
    parts: { line: "Front brake pads", amount: 84 },
    // $23 keeps this quote's computed total at the $347 the Secure
    // Authorization card holds — the two cards tell one story.
    fees: 23,
  },
  {
    shop: "Eltingville Auto Care",
    labor: 220,
    parts: { line: "Front brake pads", amount: 78 },
    fees: 20,
  },
  {
    shop: "Precision Motors",
    labor: 255,
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
  const total = q.labor + q.parts.amount + q.fees;

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
        <div className="absolute inset-0 flex flex-col justify-center px-6 sm:px-8">
          {/* aria-live so paging announces the new quote to screen readers.
              The clip wrapper carries the card's own radius — a square
              overflow-hidden box crops the rounded bottom corners flat
              (design feedback 2026-08-31). */}
          <div className="relative overflow-hidden rounded-[14px]" aria-live="polite">
            {/* Direction must come through variants+custom: a plain exit prop
                bakes `dir` from the render BEFORE the click, so reversing
                direction would slide the outgoing card the wrong way. */}
            <AnimatePresence mode="popLayout" initial={false} custom={dir}>
              <motion.div
                key={q.shop}
                custom={dir}
                variants={{
                  enter: (d: 1 | -1) =>
                    paged
                      ? { opacity: 0, x: d * 40, y: 0, scale: 0.985 }
                      : { opacity: 0, x: 0, y: 16, scale: 1 },
                  center: { opacity: 1, x: 0, y: 0, scale: 1 },
                  exit: (d: 1 | -1) => ({ opacity: 0, x: d * -40, scale: 0.985 }),
                }}
                initial="enter"
                animate={shown ? "center" : "enter"}
                exit="exit"
                transition={{
                  delay: paged || reduce ? 0 : base + 0.22,
                  // A touch slower than the old 0.45s snap, with a smaller
                  // slide — the swap glides instead of flicking (2026-08-31).
                  duration: reduce ? 0.4 : 0.6,
                  ease: EASE,
                }}
                className="rounded-[16px] bg-white/95 px-6 py-5 shadow-[0_14px_34px_rgba(43,84,120,0.12)]"
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
                    <span>Labor</span>
                    <span className="text-[#1a1a1a]">${q.labor}</span>
                  </motion.div>
                  <motion.div className="flex justify-between" {...row(1)}>
                    <span>{q.parts.line}</span>
                    <span className="text-[#1a1a1a]">${q.parts.amount}</span>
                  </motion.div>
                  {/* "Shop supplies & fees", never a bare fee line — three
                      quotes with a pure fee row all near one ratio would let
                      a reader back out the confidential service-fee rate. */}
                  <motion.div className="flex justify-between" {...row(2)}>
                    <span>Shop supplies &amp; fees</span>
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

          {/* Comparing Shops + live dots — bottom-left ON the stage, per the
              frame (2026-08-31; an earlier read had it straddling the edge). */}
          <Rise
            at={0.58}
            y={12}
            shown={shown}
            reduce={reduce}
            base={base}
            className="absolute bottom-4 left-5"
          >
            <div className="inline-flex items-center gap-2 rounded-full border-[0.5px] border-white/50 bg-white/20 px-4 py-2 backdrop-blur-[35px]">
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

/** A real map preview of Bay Ridge, Brooklyn — the story's neighborhood
 *  (Bay Ridge Motors) — real Mapbox data, recolored to the frame's palette:
 *  blue ground, white roads (design feedback 2026-08-31). dark-v11 (near-
 *  black ground, bright roads) is grayscaled + brightness-boosted, then
 *  SCREEN-blended over a vertical donor gradient: full-strength blue at the
 *  top, dissolving into the stage's own pale gradient behind the $347 card
 *  (design feedback 2026-08-31 — "top unfaded, bottom fades"). A mask fades
 *  the white roads out on the same run. light-v11 can't be the donor — its
 *  ground sits 0.06 luminance below its roads, inseparable by filters. One
 *  Static Images request, no map runtime. */
const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? "";
const MAP_PREVIEW_URL = `https://api.mapbox.com/styles/v1/mapbox/dark-v11/static/-74.028,40.629,13.9/780x520@2x?logo=false&attribution=false&access_token=${MAPBOX_TOKEN}`;


/* The coverage map's teardrop pin, duplicated from coverage-map.tsx (paths
 * verbatim) — importing from that module would drag mapbox-gl into this
 * chunk. Same shape, but faded into the preview's palette — lighter blues,
 * soft shadow, a touch of transparency — so the pins sit IN the muted map
 * instead of popping at full saturation over it (design feedback
 * 2026-08-31, twice: not glassy-see-through, not loud-solid either). */
const PIN_BODY_D =
  "M90 15.192C85.5727 11.1575 80.3846 8.04754 74.7397 6.04433C69.0948 4.04111 63.1068 3.185 57.1267 3.52619C51.1467 3.86738 45.2949 5.39899 39.9145 8.03124C34.534 10.6635 29.7333 14.3434 25.7936 18.8552C21.8539 23.367 18.8546 28.62 16.9716 34.3061C15.0885 39.9922 14.3596 45.997 14.8275 51.9685C15.2954 57.94 16.9508 63.7579 19.6965 69.0813C22.4423 74.4047 26.2231 79.1264 30.8175 82.9695C41.3211 91.7021 50.0973 102.324 56.6925 114.286C57.0149 114.881 57.4927 115.379 58.0751 115.725C58.6574 116.071 59.3226 116.252 60 116.251C60.6769 116.25 61.341 116.067 61.922 115.72C62.503 115.372 62.9792 114.874 63.3 114.278L63.6075 113.701C70.2501 101.884 79.0081 91.388 89.445 82.737C94.2816 78.5572 98.1713 73.394 100.854 67.592C103.538 61.7899 104.953 55.4823 105.005 49.0901C105.058 42.6978 103.747 36.3679 101.159 30.5225C98.5716 24.6771 94.7673 19.4507 90 15.192ZM60 67.5007C56.2916 67.5007 52.6665 66.4011 49.5831 64.3408C46.4996 62.2805 44.0964 59.3522 42.6773 55.9261C41.2581 52.5 40.8868 48.7299 41.6103 45.0928C42.3337 41.4557 44.1195 38.1147 46.7417 35.4925C49.364 32.8703 52.7049 31.0845 56.3421 30.361C59.9792 29.6376 63.7492 30.0089 67.1753 31.428C70.6014 32.8472 73.5298 35.2504 75.5901 38.3338C77.6503 41.4172 78.75 45.0424 78.75 48.7508C78.744 53.7217 76.7667 58.4874 73.2517 62.0024C69.7367 65.5174 64.971 67.4948 60 67.5007Z";
const PIN_WRENCH_D =
  "M52.0381 16.9834C57.4005 15.6352 63.018 15.6743 68.3614 17.0957C68.9752 17.2602 69.5351 17.5829 69.9844 18.0322C70.4338 18.4816 70.7574 19.0414 70.9219 19.6553C71.0871 20.2716 71.0863 20.9212 70.92 21.5371C70.7536 22.1529 70.4274 22.7138 69.9747 23.1631L56.0977 37.04L58.0176 50.4814L71.459 52.4014L85.336 38.5244C85.7853 38.0717 86.3462 37.7454 86.962 37.5791C87.5779 37.4128 88.2275 37.412 88.8438 37.5771C89.4577 37.7417 90.0175 38.0653 90.4669 38.5146C90.9162 38.964 91.2389 39.5239 91.4034 40.1377C92.683 44.9133 92.8553 49.9072 91.9229 54.7422C88.854 69.5523 75.7355 80.6836 60.0157 80.6836C42.0185 80.6835 27.429 66.0939 27.4288 48.0967C27.4288 47.4476 27.4499 46.8028 27.4874 46.1631C27.6786 43.5991 28.1727 41.0565 28.9678 38.5898C30.6642 33.3272 33.6724 28.5824 37.7081 24.8027C41.7439 21.023 46.6756 18.3317 52.0381 16.9834Z";

function PinMark({ size, uid }: { size: number; uid: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 120 120"
      fill="none"
      aria-hidden
      className="opacity-90 [filter:drop-shadow(0_2px_3px_rgba(43,84,120,0.25))]"
    >
      <path d={PIN_BODY_D} fill={`url(#pb${uid})`} />
      <circle cx="60" cy="48" r="30" fill={`url(#pr${uid})`} />
      <path d={PIN_WRENCH_D} fill={`url(#pg${uid})`} />
      <defs>
        <linearGradient id={`pb${uid}`} x1="60" y1="3" x2="60" y2="116" gradientUnits="userSpaceOnUse">
          <stop stopColor="#79ADF3" />
          <stop offset="1" stopColor="#9AC4F8" />
        </linearGradient>
        <linearGradient id={`pr${uid}`} x1="60" y1="18" x2="60" y2="78" gradientUnits="userSpaceOnUse">
          <stop stopColor="#79ADF3" />
          <stop offset="1" stopColor="#9AC4F8" />
        </linearGradient>
        <linearGradient id={`pg${uid}`} x1="60" y1="16" x2="60" y2="81" gradientUnits="userSpaceOnUse">
          <stop stopColor="#EBF4FF" />
          <stop offset="1" stopColor="#fff" />
        </linearGradient>
      </defs>
    </svg>
  );
}

function MapArt({ shown, reduce, base }: Beat) {
  // The booked shop gets the big pin; the runner-up sits smaller, further
  // out. Both in the top strip — the $347 card overlays the lower half.
  const pins = [
    { left: "37%", top: "31%", w: 44 },
    { left: "70.5%", top: "19%", w: 30 },
  ];
  return (
    <div className="absolute inset-0" aria-hidden>
      {/* Donor for the screen blend: saturated up top where the map should
          read at full strength, gone by ~85% where the stage takes over. */}
      <div
        className="absolute inset-0 bg-[linear-gradient(180deg,#91c5eb_0%,#b7d8f3_55%,transparent_85%)]"
      />
      <motion.img
        src={MAP_PREVIEW_URL}
        alt=""
        loading="lazy"
        className="absolute inset-0 h-full w-full object-cover mix-blend-screen [mask-image:linear-gradient(180deg,black_0%,black_55%,transparent_92%)]"
        style={{ filter: "grayscale(1) brightness(2.6) contrast(1.9)" }}
        initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 1.06 }}
        animate={shown ? { opacity: 1, scale: 1 } : undefined}
        transition={{ delay: reduce ? 0 : base + 0.15, duration: reduce ? 0.4 : 1.1, ease: EASE }}
      />
      {pins.map((p, i) => (
        <motion.span
          key={i}
          className="absolute block"
          style={{
            left: p.left,
            top: p.top,
            width: p.w,
            height: p.w,
            // Anchor the teardrop's tip on the spot.
            marginLeft: -p.w / 2,
            marginTop: -p.w,
          }}
          initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0, y: -12 }}
          animate={shown ? { opacity: 1, scale: 1, y: 0 } : undefined}
          transition={
            reduce
              ? { duration: 0.4 }
              : { delay: base + 0.62 + i * 0.12, type: "spring", stiffness: 300, damping: 16 }
          }
        >
          <PinMark size={p.w} uid={`path${i}`} />
        </motion.span>
      ))}
      {/* Required credit when the API logo is off. */}
      <span className="absolute bottom-1.5 right-2.5 text-[6.5px] tracking-wide text-[#3a556e]/55">
        © Mapbox © OpenStreetMap
      </span>
    </div>
  );
}

/*
 * The authorization card. Two tiers, both worded straight from the Figma
 * frame: it rests at "Authorized · held" with the payout note, and ↵ confirm
 * settles it to "Confirmed". (The older four-tier walk-up ladder was replaced
 * 2026-08-30 when the section was matched to the frame verbatim.)
 */
const AUTH_TIERS = [
  // Resting state tells the SAME hold story as the Oto panel's Review & Pay
  // screen — a $20 booking hold against the locked total, per the real
  // Pre-Job Approval charge model in convex/payments_stripe.ts. The frame's
  // "Authorized · held" read as a full-amount hold next to the $20 one
  // (site audit 2026-08-31). ↵ confirm settles it.
  { status: "Price locked · $20 held", note: "Nothing more moves until the job is done.", fill: 0.62, done: false, control: "confirm" },
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
            /* Bottom-anchored and wide — the frame parks the card low over
               the map with a slim inset, not floated mid-stage (2026-08-31). */
            className="absolute inset-x-4 bottom-4 sm:inset-x-5"
          >
            <div className="rounded-[16px] border-[0.5px] border-white/50 bg-white/20 px-5 py-4 backdrop-blur-[35px]">
              <p className="text-[22px] leading-none text-[#1a1a1a]" style={{ ...serif, fontWeight: 500 }}>
                $347
              </p>
              <div className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-white/55 px-2.5 py-1 ring-1 ring-white/70">
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
            <ActionPill onClick={() => setTier(1)} label="Confirm the booking demo" tone="soft">
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
        className="mt-10 grid grid-cols-1 gap-6 lg:mt-14 lg:grid-cols-3 lg:grid-rows-[minmax(348px,1fr)_auto] lg:gap-x-5 lg:gap-y-0"
      >
        <div className="min-h-[410px] lg:row-span-2 lg:grid lg:min-h-0 lg:grid-rows-subgrid">
          <VoiceIntakeCard shown={shown} reduce={reduce} base={LEAD[0]} />
        </div>
        <div className="min-h-[410px] lg:row-span-2 lg:grid lg:min-h-0 lg:grid-rows-subgrid">
          <PayCard shown={shown} reduce={reduce} base={LEAD[1]} />
        </div>
        <div className="min-h-[410px] lg:row-span-2 lg:grid lg:min-h-0 lg:grid-rows-subgrid">
          <AuthCard shown={shown} reduce={reduce} base={LEAD[2]} />
        </div>
      </div>
    </section>
  );
}
