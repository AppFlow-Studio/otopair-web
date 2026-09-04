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
 *
 * Below `sm` the section follows the phone frame instead (Figma "iPhone 16 &
 * 17 Pro - 7", nodes 390:4516 + 390:4041–4147, 2026-09-03): a centred 28px
 * title, then the three cards stacked at the 27px inset — 300/302/302px tall,
 * near-white, radius 30, no chrome — each holding a blue stage with the
 * frame's own small-type mocks (8–11px), the control under the stage, and
 * the caption under the card. Everything mobile is a `max-tab:` class; every
 * `tab:` class restores today's larger layouts verbatim, so ≥640px is
 * untouched.
 */

const EASE = [0.22, 1, 0.36, 1] as const;
const BLUE = "#5299fe";

/** Per-card offset so the row assembles left to right. */
const LEAD = [0, 0.12, 0.24] as const;

type Beat = { shown: boolean; reduce: boolean; base: number };

/** Phone-frame geometry that differs card to card (the frame's three cards
 *  are 300/302/302 tall with 226/228/227 stages, and the control row's slot
 *  height/offset follows from those). All `max-tab:` classes. */
type MobileChrome = { card: string; stage: string; controls: string };

/** The frame's glass-panel fill: a white gradient, no blur (the phone frame
 *  draws its panels as a plain 32%→5.6% white wash — and a backdrop-blur
 *  under a transform entrance judders, which is a standing rule). */
const GLASS_48 =
  "max-tab:bg-[linear-gradient(48deg,rgba(255,255,255,0.32)_10.4%,rgba(255,255,255,0.056)_77.1%)]";
const GLASS_41 =
  "max-tab:bg-[linear-gradient(41deg,rgba(255,255,255,0.32)_10.4%,rgba(255,255,255,0.056)_77.1%)]";
const GLASS_28 =
  "max-tab:bg-[linear-gradient(28.5deg,rgba(255,255,255,0.32)_10.4%,rgba(255,255,255,0.056)_77.1%)]";
/** The frame renders each glass panel over a soft blurred "shadow" layer. */
const GLASS_SHADOW = "max-tab:shadow-[0_10px_24px_rgba(43,84,120,0.10)]";

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
  mobile,
  shown,
  reduce,
  base,
}: Beat & {
  stage: React.ReactNode;
  controls: React.ReactNode;
  lead: string;
  copy: string;
  mobile: MobileChrome;
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
          read as one edge-to-edge blue slab (design feedback 2026-08-30).
          The phone frame goes further: #f7fbfd, radius 30, no ring, no shadow,
          the stage at a 19px inset. */}
      <div
        className={`relative flex flex-1 flex-col max-tab:rounded-[30px] max-tab:bg-[#f7fbfd] max-tab:px-[19px] max-tab:pb-0 tab:rounded-[20px] tab:bg-[#fbfdfe] tab:p-4 tab:shadow-[0_18px_40px_rgba(43,84,120,0.10)] tab:ring-1 tab:ring-[#ecf2f8] ${mobile.card}`}
      >
        <div
          className={`relative overflow-hidden max-tab:flex-none max-tab:rounded-[20px] tab:flex-1 tab:rounded-[14px] tab:bg-[linear-gradient(180deg,#a5cfef_0%,#cfe5f7_62%,#ecf5fc_100%)] ${mobile.stage}`}
        >
          {stage}
        </div>
        <div className={`flex shrink-0 items-center justify-center tab:h-[60px] ${mobile.controls}`}>
          {controls}
        </div>
      </div>
      <Rise at={0.5} y={10} shown={shown} reduce={reduce} base={base}>
        {/* Phone frame: the caption sits 22px under the card at the full
            27px-inset width, 14/23 — the next card follows at a fixed gap
            (the grid's gap-y below). */}
        <p className="text-[14px] text-[#777169] max-tab:mt-[22px] max-tab:leading-[23px] tab:mt-4 tab:text-[15px] tab:leading-[1.55]">
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
  mobileWidth,
}: {
  onClick: () => void;
  children: React.ReactNode;
  label: string;
  /** The frame renders card 3's confirm a shade softer than card 1's talk. */
  tone?: "solid" | "soft";
  /** Phone frame: talk is a 62x34 plate, confirm a 100x34 one. */
  mobileWidth: string;
}) {
  return (
    <motion.button
      type="button"
      aria-label={label}
      onClick={onClick}
      whileHover={{ scale: 1.04 }}
      whileTap={{ scale: 0.95 }}
      /* Phone frame: a rounded-10 #5299fe plate with a 2px/5px 10% drop, the
         label 14px Light — both cards' buttons solid (no soft tone there). */
      className={`flex items-center justify-center text-white max-tab:h-[34px] max-tab:gap-[6px] max-tab:rounded-[10px] max-tab:bg-[#5299fe] max-tab:text-[14px] max-tab:font-light max-tab:shadow-[0_2px_5px_rgba(0,0,0,0.1)] tab:gap-2 tab:rounded-full tab:px-6 tab:py-2.5 tab:text-[13px] tab:font-medium ${mobileWidth} ${
        tone === "soft"
          ? "tab:bg-[rgba(82,153,254,0.78)] tab:shadow-[0_8px_20px_rgba(82,153,254,0.35)]"
          : "tab:bg-[#5299fe] tab:shadow-[0_10px_26px_rgba(82,153,254,0.45)]"
      }`}
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
    /* Phone frame 390:4060: 11/16, +0.44 tracking, a 235px column. */
    <p className="text-[#1a1a1a] max-tab:mt-[16px] max-tab:w-[235px] max-tab:max-w-full max-tab:text-[11px] max-tab:leading-[16px] max-tab:tracking-[0.44px] tab:mt-3 tab:min-h-[2.6em] tab:text-[14px] tab:leading-[1.4]">
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
      // Frame 390:4041/4044: 300 tall, stage 226 at y 18 (178° #86c9e7→white),
      // the talk plate centred in the 56px left under the stage (top 254).
      mobile={{
        card: "max-tab:h-[300px] max-tab:pt-[18px]",
        stage: "max-tab:h-[226px] max-tab:bg-[linear-gradient(178deg,#86c9e7_2.3%,#fff_127%)]",
        controls: "max-tab:h-[56px]",
      }}
      stage={
        <div className="absolute inset-0">
          {/* Booking Suggestions slides in from the right edge it's tucked into.
              Phone frame 390:4050: 154x63 flush with the stage's right edge at
              y 24, 60% white, left corners only. */}
          <Rise
            at={0.2}
            x={26}
            y={0}
            shown={shown}
            reduce={reduce}
            base={base}
            className="absolute max-tab:right-0 max-tab:top-[24px] max-tab:w-[154px] tab:-right-3 tab:top-6 tab:w-[62%]"
          >
            <div className="rounded-l-[10px] max-tab:h-[63px] max-tab:bg-white/60 max-tab:px-[15px] max-tab:pt-[8px] tab:bg-white/90 tab:px-5 tab:py-4 tab:shadow-[0_8px_20px_rgba(43,84,120,0.08)]">
              <p className="text-[#1a1a1a] max-tab:text-[10px] max-tab:leading-[20px] max-tab:font-normal max-tab:tracking-[0.5px] tab:text-[12px] tab:font-semibold">
                Booking Suggestions
              </p>
              {/* Rows 8/16 at +28 and +42 — the value column starts at x 112,
                  so the values run off the stage's edge like the frame's. */}
              <div className="flex text-[#777169] max-tab:text-[8px] max-tab:leading-[16px] max-tab:tracking-[0.4px] max-tab:whitespace-nowrap tab:mt-2 tab:justify-between tab:text-[10.5px]">
                <span className="max-tab:w-[97px] max-tab:shrink-0">Service</span>
                <span className="text-[#1a1a1a]">Front Brak…</span>
              </div>
              <div className="flex text-[#777169] max-tab:-mt-[2px] max-tab:text-[8px] max-tab:leading-[16px] max-tab:tracking-[0.4px] max-tab:whitespace-nowrap tab:mt-1.5 tab:justify-between tab:text-[10.5px]">
                <span className="max-tab:w-[97px] max-tab:shrink-0">Earliest Slot</span>
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
               dead blue field below it (design feedback 2026-08-31).
               Phone frame 390:4059: 128 tall at (12, 82), 8px off the right. */
            className="absolute max-tab:left-[12px] max-tab:right-[8px] max-tab:top-[82px] tab:inset-x-5 tab:bottom-4"
          >
            {/* Frosted glass, per the frame — the stage reads through it. */}
            <div
              className={`max-tab:h-[128px] max-tab:rounded-[15px] max-tab:px-[21px] max-tab:pt-[18px] ${GLASS_48} ${GLASS_SHADOW} tab:rounded-[16px] tab:border-[0.5px] tab:border-white/50 tab:bg-white/20 tab:px-6 tab:py-5 tab:backdrop-blur-[35px]`}
            >
              <div className="flex items-center max-tab:gap-[9px] max-tab:pl-[2px] tab:gap-2">
                <motion.span
                  className="rounded-full max-tab:h-[5px] max-tab:w-[5px] tab:h-1.5 tab:w-1.5"
                  style={{ backgroundColor: BLUE }}
                  animate={reduce || !shown ? undefined : { opacity: [1, 0.35, 1] }}
                  transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
                />
                <span
                  className="max-tab:text-[11px] max-tab:leading-[20px] max-tab:font-normal max-tab:tracking-[0.55px] tab:text-[9px] tab:font-medium tab:tracking-[0.14em]"
                  style={{ color: BLUE }}
                >
                  LISTENING
                </span>
              </div>
              {/* Phone frame: five 19.6px glyphs = a 102px run; the first 19
                  of the 28 bars measure the same (19×2.5 + 18×3 = 101.5). */}
              <Waveform
                active={!reduce}
                bars={28}
                className="max-tab:mt-[6px] max-tab:ml-[3px] max-tab:h-[15px] max-tab:text-[#5299fe] max-tab:[&>span:nth-child(n+20)]:hidden tab:mt-2.5 tab:h-[22px] tab:text-[#8db8f5]"
              />
              <TypedTranscript shown={shown} reduce={reduce} startAt={base + 0.6} />
            </div>
          </Rise>
        </div>
      }
      controls={
        <Pop at={0.62} shown={shown} reduce={reduce} base={base}>
          <ActionPill onClick={talk} label="Start talking to Oto" mobileWidth="max-tab:w-[62px]">
            <span className="rounded-full bg-white max-tab:h-2 max-tab:w-2 tab:h-1.5 tab:w-1.5" />
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
      /* Phone frame 390:4113/4114: 49x34 white squares, radius 10, a 2/5px 5%
         drop, the arrow a 13px glyph. */
      className="flex items-center justify-center bg-white text-[#1a1a1a] max-tab:h-[34px] max-tab:w-[49px] max-tab:rounded-[10px] max-tab:shadow-[0_2px_5px_rgba(0,0,0,0.05)] tab:h-9 tab:w-[44px] tab:rounded-[8px] tab:shadow-[0_6px_16px_rgba(43,84,120,0.12)] tab:ring-1 tab:ring-[#e7eef5]"
    >
      <Icon className="max-tab:h-[13px] max-tab:w-[13px] tab:h-4 tab:w-4" strokeWidth={2} />
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
      // Frame 390:4110/4112: 302 tall, stage 228 at y 19 (171° #86c9e7→white),
      // the pager squares centred in the 52px row under it (top 256).
      mobile={{
        card: "max-tab:h-[302px] max-tab:pt-[19px]",
        stage: "max-tab:h-[228px] max-tab:bg-[linear-gradient(171deg,#86c9e7_9%,#fff_117%)]",
        controls: "max-tab:h-[52px]",
      }}
      stage={
        /* Phone frame 390:4130: the quote card sits at (23, 27) in the stage,
           not centred. */
        <div className="absolute inset-0 flex flex-col max-tab:justify-start max-tab:px-[23px] max-tab:pt-[27px] tab:justify-center tab:px-8">
          {/* aria-live so paging announces the new quote to screen readers.
              The clip wrapper carries the card's own radius — a square
              overflow-hidden box crops the rounded bottom corners flat
              (design feedback 2026-08-31). */}
          <div className="relative overflow-hidden max-tab:rounded-[10px] tab:rounded-[14px]" aria-live="polite">
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
                /* Phone frame: 143 tall, 50% white, radius 10, 15/16px sides;
                   the rows are 8/20 with a 0.5px hairline at +109 and an
                   11px Total at +114. */
                className="max-tab:h-[143px] max-tab:rounded-[10px] max-tab:bg-white/50 max-tab:pl-[15px] max-tab:pr-[16px] max-tab:pt-[17px] tab:rounded-[16px] tab:bg-white/95 tab:px-6 tab:py-5 tab:shadow-[0_14px_34px_rgba(43,84,120,0.12)]"
              >
                <div className="flex justify-between max-tab:items-center max-tab:leading-[20px] tab:items-baseline">
                  {/* The phone frame sets the shop name in the sans (Book),
                      not the serif. */}
                  <p
                    className="text-[#1a1a1a] max-tab:text-[11px] max-tab:leading-[20px] max-tab:tracking-[0.55px] max-tab:font-sans! tab:text-[15px]"
                    style={serif}
                  >
                    {q.shop}
                  </p>
                  <span className="max-tab:text-[8px] max-tab:leading-[20px] max-tab:font-normal max-tab:tracking-[0.4px] max-tab:text-[#777169] tab:text-[9px] tab:font-medium tab:tracking-[0.03em] tab:text-[#8a9094]">
                    Verified Shop
                  </span>
                </div>
                <div className="text-[#777169] max-tab:mt-[5px] max-tab:space-y-[1.5px] max-tab:text-[8px] max-tab:leading-[20px] max-tab:tracking-[0.4px] tab:mt-3 tab:space-y-1.5 tab:text-[11.5px]">
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
                  className="flex justify-between border-t text-[#1a1a1a] max-tab:mt-[4px] max-tab:border-t-[0.5px] max-tab:border-[#777169]/30 max-tab:pt-[4px] max-tab:text-[11px] max-tab:leading-[20px] max-tab:font-normal max-tab:tracking-[0.55px] tab:mt-3 tab:border-[#1a1a1a]/10 tab:pt-2.5 tab:text-[13px] tab:font-semibold"
                  {...row(3)}
                >
                  <span>Total</span>
                  <span>${total}</span>
                </motion.div>
              </motion.div>
            </AnimatePresence>
          </div>

          {/* Comparing Shops + live dots — bottom-left ON the stage, per the
              frame (2026-08-31; an earlier read had it straddling the edge).
              Phone frame 390:4121: a 147x31 radius-8 glass chip at (22, 178),
              9px label, the three 5px dots at x 108. */}
          <Rise
            at={0.58}
            y={12}
            shown={shown}
            reduce={reduce}
            base={base}
            className="absolute max-tab:bottom-[19px] max-tab:left-[22px] tab:bottom-4 tab:left-5"
          >
            <div
              className={`inline-flex items-center max-tab:relative max-tab:h-[31px] max-tab:w-[147px] max-tab:rounded-[8px] max-tab:pl-[14px] ${GLASS_28} max-tab:shadow-[0_6px_16px_rgba(43,84,120,0.08)] tab:gap-2 tab:rounded-full tab:border-[0.5px] tab:border-white/50 tab:bg-white/20 tab:px-4 tab:py-2 tab:backdrop-blur-[35px]`}
            >
              <span className="text-[#1a1a1a] max-tab:text-[9px] max-tab:leading-[20px] max-tab:font-normal max-tab:tracking-[0.45px] max-tab:whitespace-nowrap tab:text-[11px] tab:font-medium">
                Comparing Shops
              </span>
              <span className="flex items-center max-tab:absolute max-tab:left-[108px] max-tab:top-[14px] max-tab:gap-[5px] tab:gap-1">
                {QUOTES.map((_, i) => (
                  <span
                    key={i}
                    className={`rounded-full transition-colors duration-300 max-tab:h-[5px] max-tab:w-[5px] tab:h-1.5 tab:w-1.5 ${
                      i === idx
                        ? "bg-[#5299fe]"
                        : "max-tab:bg-[rgba(81,152,254,0.2)] tab:bg-[rgba(26,26,26,0.18)]"
                    }`}
                  />
                ))}
              </span>
            </div>
          </Rise>
        </div>
      }
      controls={
        <Pop at={0.66} shown={shown} reduce={reduce} base={base}>
          <div className="flex items-center max-tab:gap-[27px] tab:gap-4">
            <PagerButton dir={-1} onClick={() => page(-1)} />
            <span className="text-center text-[13px] text-[#1a1a1a] tabular-nums max-tab:min-w-[21px] max-tab:font-light tab:min-w-[30px]">
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
      // Frame 390:4142/4149: 302 tall, stage 227 at y 18 (178° #86c9e7→white),
      // the confirm plate 7px under the stage (top 252).
      mobile={{
        card: "max-tab:h-[302px] max-tab:pt-[18px]",
        stage: "max-tab:h-[227px] max-tab:bg-[linear-gradient(178deg,#86c9e7_2.3%,#fff_127%)]",
        controls: "max-tab:h-[57px] max-tab:items-start max-tab:pt-[7px]",
      }}
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
               the map with a slim inset, not floated mid-stage (2026-08-31).
               Phone frame 390:4440: 98 tall at a 12px side inset, 15 off the
               bottom. */
            className="absolute max-tab:bottom-[15px] max-tab:left-[12px] max-tab:right-[12px] tab:inset-x-5 tab:bottom-4"
          >
            {/* min-h rather than a fixed 98: the live note is longer than the
                frame's, and wraps to two lines on narrower phones — the card
                grows upward over the map instead of clipping. */}
            <div
              className={`max-tab:min-h-[98px] max-tab:rounded-[10px] max-tab:px-[21px] max-tab:pt-[15px] max-tab:pb-[9px] ${GLASS_41} ${GLASS_SHADOW} tab:rounded-[16px] tab:border-[0.5px] tab:border-white/50 tab:bg-white/20 tab:px-5 tab:py-4 tab:backdrop-blur-[35px]`}
            >
              {/* The phone frame sets the amount in the sans (Book 16/20,
                  +0.8), not the serif. */}
              <p
                className="text-[#1a1a1a] max-tab:text-[16px] max-tab:leading-[20px] max-tab:tracking-[0.8px] max-tab:font-sans! max-tab:font-normal! tab:text-[22px] tab:leading-none"
                style={{ ...serif, fontWeight: 500 }}
              >
                $347
              </p>
              {/* Phone frame 390:4441: a 16px-tall 10%-white pill, 4px dot,
                  8px text. Auto width — the live status is longer than the
                  frame's "Authorized · held". */}
              <div className="inline-flex items-center rounded-full max-tab:mt-[4px] max-tab:h-[16px] max-tab:gap-[5px] max-tab:bg-white/10 max-tab:px-[10px] max-tab:ring-[0.5px] max-tab:ring-white/60 tab:mt-2 tab:gap-1.5 tab:bg-white/55 tab:px-2.5 tab:py-1 tab:ring-1 tab:ring-white/70">
                <motion.span
                  className="rounded-full max-tab:h-1 max-tab:w-1 tab:h-1.5 tab:w-1.5"
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
                    className="max-tab:text-[8px] max-tab:leading-[16px] max-tab:font-normal max-tab:tracking-[0.4px] max-tab:whitespace-nowrap max-tab:text-[#1a1a1a] tab:text-[9.5px] tab:font-medium tab:tracking-[0.04em] tab:text-[#33383b]"
                  >
                    {t.status}
                  </motion.span>
                </AnimatePresence>
              </div>

              {/* Progress line — a single unbroken bar, per the frame. The
                  phone frame's track is 50% white, 244 of the 248 content
                  width, 3px. */}
              <div className="relative h-[3px] overflow-hidden rounded-full max-tab:mx-[2px] max-tab:mt-[10px] max-tab:bg-white/50 tab:mt-3 tab:bg-[#1a1a1a]/10">
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

              <div className="max-tab:mt-[1px] tab:mt-3 tab:min-h-[1.4em]">
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.p
                    key={t.note}
                    initial={{ opacity: 0, y: 5 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -5 }}
                    transition={{ duration: 0.28, ease: EASE }}
                    className="max-tab:text-[11px] max-tab:leading-[20px] max-tab:tracking-[0.55px] max-tab:text-[#1a1a1a] tab:text-[11.5px] tab:text-[#33383b]"
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
            <ActionPill
              onClick={() => setTier(1)}
              label="Confirm the booking demo"
              tone="soft"
              mobileWidth="max-tab:w-[100px]"
            >
              <CornerDownLeft className="max-tab:h-[13px] max-tab:w-[13px] tab:h-3.5 tab:w-3.5" strokeWidth={2.2} />
              confirm
            </ActionPill>
          ) : (
            <motion.span
              key={t.control}
              initial={{ opacity: 0, scale: 0.94 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.3, ease: EASE }}
              className="flex items-center bg-white text-[#1a1a1a] max-tab:h-[34px] max-tab:w-[100px] max-tab:justify-center max-tab:gap-[6px] max-tab:rounded-[10px] max-tab:text-[14px] max-tab:font-light max-tab:shadow-[0_2px_5px_rgba(0,0,0,0.05)] tab:gap-2 tab:rounded-full tab:px-6 tab:py-2.5 tab:text-[13px] tab:font-medium tab:shadow-[0_8px_22px_rgba(43,84,120,0.14)]"
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
    /* Phone frame: the 27px side inset, the title 60px under the listens
       card. */
    <section className="mx-auto w-full max-w-[1440px] px-[27px] pt-[60px] tab:px-10 tab:pt-28 lg:px-[78px]">
      <Reveal>
        {/* Phone frame 390:4516: one centred 28/28 line in the text weight
            (Romie Regular → Petrona 400); the display cut's 250 weight and
            cap-height normalisation are desktop-only, as in the sibling
            sections. */}
        <h2
          className="max-w-[600px] text-[#1a1a1a] max-tab:mx-auto max-tab:max-w-none max-tab:text-center max-tab:text-[28px] max-tab:leading-[28px] max-tab:font-normal! max-tab:[font-size-adjust:none]! tab:text-[54px] tab:leading-[1.0] lg:text-[68px]"
          style={serifDisplay}
        >
          The whole path,{" "}
          <br className="max-tab:hidden" />
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
          meet it. Row gap is 0 because the caption carries its own `mt-4`.

          Phone frame: the cards start 26px under the title (top 54 from the
          title's top) and each caption's text runs 68px into the next card
          (card 1 bottom → card 2 top is 136 = 22 + two 23px lines + 68). */}
      <div
        ref={rowRef}
        className="grid grid-cols-1 max-tab:mt-[26px] max-tab:gap-y-[68px] tab:mt-10 tab:gap-6 lg:mt-14 lg:grid-cols-3 lg:grid-rows-[minmax(348px,1fr)_auto] lg:gap-x-5 lg:gap-y-0"
      >
        <div className="tab:min-h-[410px] lg:row-span-2 lg:grid lg:min-h-0 lg:grid-rows-subgrid">
          <VoiceIntakeCard shown={shown} reduce={reduce} base={LEAD[0]} />
        </div>
        <div className="tab:min-h-[410px] lg:row-span-2 lg:grid lg:min-h-0 lg:grid-rows-subgrid">
          <PayCard shown={shown} reduce={reduce} base={LEAD[1]} />
        </div>
        <div className="tab:min-h-[410px] lg:row-span-2 lg:grid lg:min-h-0 lg:grid-rows-subgrid">
          <AuthCard shown={shown} reduce={reduce} base={LEAD[2]} />
        </div>
      </div>
    </section>
  );
}
