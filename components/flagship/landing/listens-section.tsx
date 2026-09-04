"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { AnimatePresence, motion, useInView } from "motion/react";
import { useReducedMotionSafe } from "../shared";
import { serif } from "./reveal";

/*
 * "Oto Listens." — a self-rotating story reel of three selling points, in
 * ordinary page flow (design feedback 2026-08-31: one scroll-driven section
 * on the page is a moment, two is a pattern — this one holds still). Stories
 * advance on their own clock. Two indicators, per design feedback
 * 2026-08-31: the tick bars above the title say WHICH story is active (and
 * are clickable to jump — clicking retires the auto-advance), while ONE
 * full progress bar runs along the very bottom of the box, stopping at the
 * end of the blur panel — its fill length is the time to the next story
 * (patterned on the dev page's step underline).
 *
 * Story 1 keeps the original layered composite (dash photo + driver
 * close-up card + chat bubbles). Stories 2–3 are full-bleed photos behind
 * the SAME left blur panel as story 1 — theirs is a backdrop-blur of their
 * own photo, so the copy always sits on frosted calm, never on a busy
 * photo (design feedback 2026-08-31).
 *
 * ASSETS: story 2's photo landed 2026-08-31 (service advisor + tablet,
 * public/landing/story-health.png) and carries a floating service-history
 * chip stack on its right side — newest entry brightest at the bottom,
 * older ones fading above (per the user's mock). Story 3 still wants
 *   public/landing/story-booking.png  (hand + phone, NYC map + Select Services)
 * Until it exists the dash photo stands in (onError fallback) so nothing
 * renders broken.
 */

const EASE = [0.22, 1, 0.36, 1] as const;

/** Entrance beats for story 1's composite (one local clock from `shown`). */
const BEAT = {
  photo: 0,
  card: 0.12,
  panel: 0.26,
  ticks: 0.38,
  title: 0.46,
  bar: 0.5,
  body: 0.6,
  ask: 0.8,
  answer: 1.25,
} as const;

/** How long each story holds before handing off. Story 1 runs longer — its
 *  bubble conversation needs time to land. Cut from 9/7/7s (design feedback
 *  2026-09-03: "speed up the time for each"). */
const STORY_HOLD_MS = [6000, 4500, 4500] as const;

const STORIES = [
  {
    id: "listens",
    title: "Oto Listens.",
    body: "Describe the problem out loud. Oto understands symptoms, context, and your specific car — not just keywords.",
    img: null, // story 1 renders the layered composite, not a single photo
    alt: "",
    shift: null,
  },
  {
    id: "health",
    title: "Your car's health, live.",
    body: "A running health score for your exact car — what's strong, what's wearing, and what's due next.",
    img: "/landing/story-health.png",
    alt: "A service advisor checking a car's live health score on a tablet",
    shift: null,
  },
  {
    id: "booking",
    title: "Booked in 90 seconds.",
    body: "Real shops on a live map, prices locked before you tap confirm.",
    img: "/landing/story-booking.png",
    alt: "A phone showing nearby shops on a map, ready to book",
    // The phone sits at this photo's center — on desktop the frame nudges
    // right so the phone clears the blur panel (design feedback 2026-08-31).
    shift: "10%",
  },
] as const;

type Beat = { shown: boolean; reduce: boolean };

/** Fade + rise, `at` seconds into the section's entrance. */
function Rise({
  at,
  y = 16,
  blur = 0,
  className,
  children,
  shown,
  reduce,
}: Beat & { at: number; y?: number; blur?: number; className?: string; children: React.ReactNode }) {
  return (
    <motion.div
      className={className}
      initial={reduce ? { opacity: 0 } : { opacity: 0, y, filter: blur ? `blur(${blur}px)` : undefined }}
      animate={shown ? (reduce ? { opacity: 1 } : { opacity: 1, y: 0, filter: "blur(0px)" }) : undefined}
      transition={{ delay: reduce ? 0 : at, duration: reduce ? 0.4 : 0.7, ease: EASE }}
    >
      {children}
    </motion.div>
  );
}

/** The rotation indicator (tall bright bar = active). Each tick is a
 *  button — clicking jumps to that story and retires the auto-advance. */
function StoryTicks({ active, onPick }: { active: number; onPick: (i: number) => void }) {
  return (
    <div className="flex items-end gap-[4px]" role="tablist" aria-label="Stories">
      {STORIES.map((s, i) => (
        <button
          key={s.id}
          type="button"
          role="tab"
          aria-selected={i === active}
          aria-label={s.title}
          onClick={() => onPick(i)}
          className="flex h-[22px] items-end px-[2px]"
        >
          <motion.span
            className="block w-[2.5px] rounded-full"
            initial={false}
            animate={{
              height: i === active ? 18 : 8,
              backgroundColor: i === active ? "rgba(255,255,255,0.95)" : "rgba(255,255,255,0.45)",
            }}
            transition={{ duration: 0.35, ease: EASE }}
          />
        </button>
      ))}
    </div>
  );
}

/** One full bar along the very bottom of the box. While the reel
 *  auto-advances it fills linearly over the active story's hold, restarting
 *  on each hand-off — the fill length is the time to the next story. Once
 *  the visitor takes over (or motion is reduced) it just sits lit. Purely
 *  decorative; the ticks above the title carry the tab semantics. */
function ProgressBar({ active, playing }: { active: number; playing: boolean }) {
  return (
    <div className="h-[5px] overflow-hidden bg-white/20" aria-hidden>
      {playing ? (
        <motion.div
          key={active}
          className="h-full origin-left bg-[#5299fe]"
          initial={{ scaleX: 0 }}
          animate={{ scaleX: 1 }}
          transition={{ duration: STORY_HOLD_MS[active] / 1000, ease: "linear" }}
        />
      ) : (
        <div className="h-full bg-[#5299fe]" />
      )}
    </div>
  );
}

/** The copy block: ticks, title, body — swaps with the active story. (The
 *  time-to-next-story bar lives separately, along the bottom of the box.)
 *
 *  `phone` is the Figma mobile frame's cut (node 390:3625): title 30/41 in
 *  the serif's bold, body 14/23 book with 0.7px tracking on a 275px measure.
 *  Only the phone card (below sm) passes it; the desktop stage and the
 *  tablet card keep the original sizes. */
function CopyPanel({
  shown,
  reduce,
  active,
  onPick,
  phone = false,
  swap = false,
}: Beat & {
  active: number;
  onPick: (i: number) => void;
  phone?: boolean;
  /** True once the reel has moved past its first story. The staged title →
   *  body beats are the section's ENTRANCE choreography; replayed on every
   *  hand-off they left the block empty for ~0.5s and the body landing
   *  ~1.7s after the photo (design feedback 2026-09-03: stories 1 and 3
   *  "not as smooth as 2"). On a swap the copy simply crossfades with the
   *  photo — the leaving block is popped out of layout so both overlap. */
  swap?: boolean;
}) {
  const story = STORIES[active];
  return (
    <Rise at={BEAT.panel} y={22} blur={8} shown={shown} reduce={reduce} className="max-w-[398px]">
      <Rise at={BEAT.ticks} y={8} shown={shown} reduce={reduce}>
        <StoryTicks active={active} onPick={onPick} />
      </Rise>
      {/* On a swap the leaving copy drops out in 0.2s and the next one fades
          straight in (no beat delays), so the block is never empty longer
          than a blink and the two texts never double-expose. */}
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={story.id}
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          exit={
            reduce
              ? { opacity: 0, transition: { duration: 0.2 } }
              : { opacity: 0, y: -10, transition: { duration: swap ? 0.2 : 0.45, ease: EASE } }
          }
          transition={{ duration: reduce ? 0.3 : 0.45, ease: EASE }}
        >
          <Rise at={swap ? 0 : BEAT.title} y={18} shown={shown} reduce={reduce}>
            <h2
              className={
                phone
                  ? "mt-[15px] text-[30px] leading-[41px] text-white"
                  : "mt-5 text-[28px] leading-[1.15] text-white sm:text-[36px] sm:leading-[41px]"
              }
              style={
                phone
                  ? { fontFamily: "var(--font-Petrona)", fontWeight: 700, letterSpacing: "0.374px" }
                  : { ...serif, letterSpacing: "0.37px" }
              }
            >
              {story.title}
            </h2>
          </Rise>
          <Rise at={swap ? 0 : BEAT.body} y={14} shown={shown} reduce={reduce}>
            <p
              className={
                phone
                  ? // 284, not the frame's 275: Inter sets ~3% wider than
                    // Suisse, and 9px is what keeps the frame's three lines.
                    "mt-4 max-w-[284px] text-[14px] font-normal leading-[23px] tracking-[0.7px] text-white"
                  : "mt-4 max-w-[300px] text-[14px] font-medium leading-[1.5] text-white/90 sm:text-[15px]"
              }
            >
              {story.body}
            </p>
          </Rise>
        </motion.div>
      </AnimatePresence>
    </Rise>
  );
}

/** A chat bubble: springs in, then holds.
 *
 *  These used to drift on an infinite `y: [0, -5, 0]` loop, but the bubble is
 *  `backdrop-blur`-ed over the photo, and Chrome re-samples a backdrop-filter's
 *  source at whole device pixels — the frosted content stepped pixel by pixel
 *  instead of gliding (design feedback 2026-08-30). Frost wins over a drift. */
function Bubble({
  at,
  tone,
  className,
  children,
  shown,
  reduce,
}: Beat & {
  at: number;
  tone: "ask" | "answer";
  className: string;
  children: React.ReactNode;
}) {
  return (
    <motion.div
      className={className}
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 16, scale: 0.94 }}
      animate={shown ? { opacity: 1, y: 0, scale: 1 } : undefined}
      transition={
        reduce
          ? { delay: 0, duration: 0.4 }
          : { delay: at, type: "spring", stiffness: 250, damping: 22 }
      }
    >
      {/* Figma's bubbles are flat and glassy: radius 10, wide padding. */}
      <div
        className={`rounded-[10px] px-6 py-4 text-[12px] leading-snug text-[#1a1a1a] shadow-[0_10px_30px_rgba(0,0,0,0.10)] backdrop-blur-md sm:px-9 sm:py-5 sm:text-[13.5px] ${
          tone === "ask" ? "bg-white/45" : "bg-white/40"
        }`}
      >
        {children}
      </div>
    </motion.div>
  );
}

function Bubbles({ shown, reduce }: Beat) {
  return (
    <>
      <Bubble
        at={BEAT.ask}
        tone="ask"
        shown={shown}
        reduce={reduce}
        className="absolute right-[4%] top-[26%] max-w-[52%]"
      >
        &ldquo;My brakes squeal in the cold. Can you check?&rdquo;
      </Bubble>
      <Bubble
        at={BEAT.answer}
        tone="answer"
        shown={shown}
        reduce={reduce}
        className="absolute left-[52%] top-[38%] max-w-[46%]"
      >
        Classic glazed pads. Found 3 shops.
      </Bubble>
    </>
  );
}

/** Story 2's floating service-history feed — the car's own records drifting
 *  over the photo, matched to the Figma stack (design feedback 2026-08-31):
 *  the newest entry is the BIGGEST and most solid, at the bottom; older
 *  entries shrink, fade, and step up-right. Backgrounds run near-opaque —
 *  the earlier equal-size translucent chips let the photo bleed through
 *  (a red caliper tinted the text). Labels are the Figma's verbatim.
 *  They cascade in oldest-first on each visit, like a history loading. */
const HEALTH_LOG = [
  {
    label: "Maintenance · Annadale · 2 hrs ago",
    pos: { right: "3.5%", top: "16.5%" },
    dim: 0.55,
    chip: "gap-2 px-4 py-2 text-[11px] text-[#6b7280] bg-white/65",
    dot: "h-1 w-1",
    at: 0.35,
  },
  {
    label: "Tire Rotation · Stapleton · 1.5 hrs ago",
    pos: { right: "5.5%", top: "23.5%" },
    dim: 0.9,
    chip: "gap-2.5 px-5 py-3 text-[13px] text-[#1a1a1a] bg-white/85",
    dot: "h-1.5 w-1.5",
    at: 0.55,
  },
  {
    label: "Oil Change · Stapleton · 1.5 hrs ago",
    pos: { right: "8%", top: "31%" },
    dim: 1,
    chip: "gap-3 px-7 py-3.5 text-[15px] text-[#1a1a1a] bg-white/95",
    dot: "h-2 w-2",
    at: 0.75,
  },
] as const;

function HealthChips({ reduce }: { reduce: boolean }) {
  return (
    <>
      {HEALTH_LOG.map((c) => (
        <motion.div
          key={c.label}
          className="absolute"
          style={{ ...c.pos, opacity: c.dim }}
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: 14, scale: 0.94 }}
          animate={reduce ? { opacity: c.dim } : { opacity: c.dim, y: 0, scale: 1 }}
          transition={
            reduce
              ? { duration: 0.4 }
              : { delay: c.at, type: "spring", stiffness: 250, damping: 22 }
          }
        >
          <div
            className={`flex items-center rounded-full leading-none shadow-[0_10px_30px_rgba(0,0,0,0.10)] backdrop-blur-md ${c.chip}`}
          >
            <span className={`rounded-full bg-[#6b7280]/50 ${c.dot}`} aria-hidden />
            {c.label}
          </div>
        </motion.div>
      ))}
    </>
  );
}

/** Full-bleed story photo with a slow Ken Burns; falls back to the dash
 *  export while a story's own Figma photo hasn't been dropped in yet. */
function StoryPhoto({
  src,
  alt,
  shown,
  reduce,
  shift = null,
  still = false,
}: Beat & {
  src: string;
  alt: string;
  /** Horizontal nudge of the whole frame (e.g. "10%") — used when a photo's
   *  subject sits at its center and would land under the blur panel. The
   *  frame slides right; the stage's overflow clips the excess. */
  shift?: string | null;
  /** No Ken Burns — the phone card lays a frost over this photo, and a
   *  moving image under a blur shimmers (2026-09-03). */
  still?: boolean;
}) {
  const [actualSrc, setActualSrc] = useState(src);
  return (
    <motion.div
      className="absolute inset-y-0"
      style={shift ? { left: shift, right: `-${shift.replace("-", "")}` } : { left: 0, right: 0 }}
      animate={reduce || !shown || still ? undefined : { scale: [1, 1.035, 1] }}
      transition={{ duration: 24, repeat: Infinity, ease: "easeInOut" }}
    >
      <Image
        src={actualSrc}
        alt={alt}
        fill
        sizes="(min-width: 1024px) 1288px, 100vw"
        className="object-cover"
        onError={() => setActualSrc("/landing/oto-listens-dash.png")}
      />
    </motion.div>
  );
}

/** Story 1 — the original layered composite: dash photo, chat bubbles, and
 *  the driver close-up card over the left half. */
function ListensComposite({ shown, reduce, entrance }: Beat & { entrance: boolean }) {
  return (
    <>
      <motion.div
        className="absolute inset-0"
        initial={entrance && !reduce ? { opacity: 0, scale: 1.08 } : { opacity: 0 }}
        animate={shown ? { opacity: 1, scale: 1 } : undefined}
        transition={{ delay: BEAT.photo, duration: reduce || !entrance ? 0.5 : 1.5, ease: EASE }}
      >
        <StoryPhoto
          src="/landing/oto-listens-dash.png"
          alt="A driver holding a phone running Oto while parked"
          shown={shown}
          reduce={reduce}
        />
      </motion.div>
      <Bubbles shown={shown} reduce={reduce} />
      <motion.div
        className="absolute inset-y-0 left-0 w-[48.5%] overflow-hidden rounded-l-[40px]"
        initial={
          entrance && !reduce
            ? { opacity: 0, x: -40, clipPath: "inset(0 100% 0 0)" }
            : { opacity: 0 }
        }
        animate={shown ? { opacity: 1, x: 0, clipPath: "inset(0 0% 0 0)" } : undefined}
        transition={{ delay: entrance && !reduce ? BEAT.card : 0, duration: reduce || !entrance ? 0.5 : 1.0, ease: EASE }}
      >
        <Image
          src="/landing/oto-listens-driver.png"
          alt=""
          fill
          sizes="(min-width: 1024px) 625px, 100vw"
          className="object-cover"
        />
        {/* The frame runs moodier than the raw export — a quiet dark wash
            keeps the white copy legible. */}
        <div className="absolute inset-0 bg-[#141e29]/25" aria-hidden />
      </motion.div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Phone (below sm) — the Figma mobile frame's single tall card       */
/* ------------------------------------------------------------------ */

/** Card geometry from the mobile frame (node 390:3176): 733 tall, the top
 *  345 carry the frosted copy block, the rest is the crisp dash photo. */
const PHONE = {
  height: 733,
  split: 345,
} as const;

/** The frame's chat bubbles (node 390:3619) — same spring-in as the desktop
 *  pair, then they hold. Sizes are the frame's exact px: ASK 254x51 with the
 *  bottom-right corner square, ANSWER 254x50 with the bottom-left square.
 *  ASK is anchored to the card's right edge and ANSWER to its left so the
 *  pair keeps the frame's stagger on 360–430 wide phones instead of drifting
 *  past the card. No drift loop — the bubbles are frosted (see Bubble). */
function PhoneBubble({
  at,
  tone,
  className,
  children,
  shown,
  reduce,
}: Beat & {
  at: number;
  tone: "ask" | "answer";
  className: string;
  children: React.ReactNode;
}) {
  return (
    <motion.div
      className={className}
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 16, scale: 0.94 }}
      animate={shown ? { opacity: 1, y: 0, scale: 1 } : undefined}
      transition={
        reduce
          ? { delay: 0, duration: 0.4 }
          : { delay: at, type: "spring", stiffness: 250, damping: 22 }
      }
    >
      {tone === "ask" ? (
        <div className="rounded-[8px] rounded-br-none bg-white/85 pb-[14.5px] pl-[11.5px] pr-[5px] pt-[17px]">
          <p className="whitespace-nowrap text-[10px] leading-[20px] tracking-[0.5px] text-[#1a1a1a]">
            {children}
          </p>
        </div>
      ) : (
        <div className="rounded-[8px] rounded-bl-none bg-[#f9f9f8]/75 pb-[14px] pl-[22px] pr-[8px] pt-[16px]">
          <p className="whitespace-nowrap text-[11px] leading-[20px] tracking-[0.55px] text-[#1a1a1a]">
            {children}
          </p>
        </div>
      )}
    </motion.div>
  );
}

/** `entrance`: the staged ask → answer springs are first-visit choreography;
 *  when story 1 rotates back in, the bubbles land with the photo instead of a
 *  second later (2026-09-03). */
function PhoneBubbles({ shown, reduce, entrance }: Beat & { entrance: boolean }) {
  return (
    <>
      <PhoneBubble
        at={entrance ? BEAT.ask : 0.05}
        tone="ask"
        shown={shown}
        reduce={reduce}
        className="absolute right-[12.5px] top-[485px] w-max min-w-[254px] max-w-[calc(100%-20px)]"
      >
        &ldquo;My brakes squeal in the cold. Can you check?&rdquo;
      </PhoneBubble>
      <PhoneBubble
        at={entrance ? BEAT.answer : 0.2}
        tone="answer"
        shown={shown}
        reduce={reduce}
        className="absolute left-[20px] top-[548px] w-[254px] max-w-[calc(100%-32px)]"
      >
        Classic glazed pads. Found 3 shops.
      </PhoneBubble>
    </>
  );
}

/** The frosted copy block (node 390:3625 reads as one dark, soft band over
 *  the card's top 345px). NOT a backdrop-filter: Chrome re-samples a
 *  backdrop every frame, and over the crossfading, Ken-Burns'd photo it
 *  shimmered and tore along its bottom edge on phones (design feedback
 *  2026-09-03, "blur bugs out"). Instead this is a second copy of the
 *  story photo, blurred once with a plain CSS filter, clipped to the block,
 *  under the wash that runs near-clear at the card's top edge and near-
 *  black where the copy sits. Nothing here animates a transform. */
function PhoneFrost({ src }: { src: string }) {
  return (
    <div
      className="absolute inset-x-0 top-0 overflow-hidden"
      style={{ height: PHONE.split }}
      aria-hidden
    >
      {/* Oversized so the blur's soft edge never shows inside the block. */}
      <div className="absolute -inset-[24px]">
        <Image src={src} alt="" fill sizes="450px" className="object-cover blur-[22px]" />
      </div>
      <div
        className="absolute inset-0"
        style={{
          background:
            "linear-gradient(180deg, rgba(20,30,41,0.10) 0%, rgba(8,12,18,0.60) 32%, rgba(8,12,18,0.74) 100%)",
        }}
      />
    </div>
  );
}

/** Story 1 on the phone. The frame's photo card (390:3177) is one still of
 *  the desktop composition — 1649x883, parked at card-relative (-728, 0) —
 *  frosted across the top 345px and crisp below, with the two bubbles over
 *  the phone. That is what this builds: the dash photo at the very same
 *  size, anchored to the card's RIGHT edge so the phone in the driver's
 *  hand keeps the frame's place on every phone width (the wheel gives way
 *  on narrower ones), frosted where the copy sits. The photo fades in and
 *  then holds still — no push-in, no Ken Burns — because the frost above it
 *  is a blurred copy of the DRIVER photo (the frame's top block shows the
 *  driver, not the dash) and nothing under a blur may move. */
function PhoneListensComposite({ shown, reduce, entrance }: Beat & { entrance: boolean }) {
  return (
    <>
      <motion.div
        className="absolute inset-0"
        initial={{ opacity: 0 }}
        animate={shown ? { opacity: 1 } : undefined}
        transition={{ delay: BEAT.photo, duration: reduce || !entrance ? 0.5 : 1.2, ease: EASE }}
      >
        <div
          className="absolute h-[883px] w-[1649px]"
          style={{ top: 0, right: -(1649 - 728 - 349) }}
        >
          <Image
            src="/landing/oto-listens-dash.png"
            alt="A driver holding a phone running Oto while parked"
            fill
            sizes="1649px"
            className="object-cover"
          />
        </div>
      </motion.div>

      <motion.div
        className="absolute inset-x-0 top-0"
        style={{ height: PHONE.split }}
        initial={{ opacity: 0 }}
        animate={shown ? { opacity: 1 } : undefined}
        transition={{ delay: entrance ? BEAT.card : 0, duration: reduce || !entrance ? 0.5 : 1.0, ease: EASE }}
        aria-hidden
      >
        <PhoneFrost src="/landing/oto-listens-driver.png" />
      </motion.div>

      {/* The frame's soft sky tint rising from the card's foot. */}
      <div
        className="absolute inset-0 bg-gradient-to-t from-[rgba(134,201,231,0.25)] to-transparent"
        aria-hidden
      />
      <PhoneBubbles shown={shown} reduce={reduce} entrance={entrance} />
    </>
  );
}

export default function ListensSection() {
  const reduce = useReducedMotionSafe();
  const ref = useRef<HTMLElement>(null);
  // One trigger for the whole section — story 1's entrance counts from here.
  const shown = useInView(ref, { once: true, margin: "0px 0px -12% 0px" });
  const beat = { shown, reduce };

  const [active, setActive] = useState(0);
  // First rotation pass only: story 1 gets its full entrance choreography;
  // revisits come back with a plain crossfade.
  const [visited, setVisited] = useState(false);
  // Clicking a segment retires the auto-advance — the visitor is driving now.
  // State, not a ref: the progress bar re-renders from "filling" to "sitting
  // lit" on this switch.
  const [engaged, setEngaged] = useState(false);

  useEffect(() => {
    if (!shown || reduce || engaged) return;
    const t = window.setTimeout(() => {
      setVisited(true);
      setActive((a) => (a + 1) % STORIES.length);
    }, STORY_HOLD_MS[active]);
    return () => window.clearTimeout(t);
  }, [shown, reduce, engaged, active]);

  const pick = (i: number) => {
    setEngaged(true);
    setVisited(true);
    setActive(i);
  };

  // The bar fills only while the reel is actually going to advance.
  const playing = shown && !reduce && !engaged;
  const story = STORIES[active];

  return (
    <section
      ref={ref}
      // Below sm: the mobile frame's 27px side inset and 45px gap under the
      // coverage card. sm and up are unchanged.
      className="mx-auto w-full max-w-[1440px] px-[27px] pt-[45px] sm:px-10 sm:pt-28 lg:px-[78px]"
    >
      <div>
        <div>
          {/* ---- Phone (<sm): the mobile frame's one tall card (390:3176) —
              frosted copy block over the top 345px, crisp photo below. ---- */}
          <div
            className="relative w-full overflow-hidden rounded-[20px] bg-[#141e29] sm:hidden"
            style={{ height: PHONE.height }}
          >
            <AnimatePresence initial={false}>
              <motion.div
                key={story.id}
                className="absolute inset-0"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: reduce ? 0.3 : 0.6, ease: EASE }}
              >
                {story.id === "listens" ? (
                  <PhoneListensComposite {...beat} entrance={!visited} />
                ) : (
                  <>
                    <StoryPhoto src={story.img!} alt={story.alt} still {...beat} />
                    <div className="absolute inset-0 bg-[#141e29]/25" aria-hidden />
                    {/* The same frosted top block as story 1 — a blurred copy
                        of the story's own photo (see PhoneFrost). */}
                    <PhoneFrost src={story.img!} />
                  </>
                )}
              </motion.div>
            </AnimatePresence>
            <div className="absolute left-[32px] right-[16px] top-[79px] z-20">
              <CopyPanel {...beat} active={active} onPick={pick} phone swap={visited} />
            </div>
            <div className="absolute inset-x-0 bottom-0 z-20">
              <Rise at={BEAT.bar} y={0} shown={shown} reduce={reduce}>
                <ProgressBar active={active} playing={playing} />
              </Rise>
            </div>
          </div>

          {/* ---- Desktop: the rotating stage, at the design's 1287:690 ---- */}
          <div className="relative hidden aspect-[1287/690] w-full overflow-hidden rounded-[40px] bg-[#141e29] lg:block">
            <AnimatePresence initial={false}>
              <motion.div
                key={story.id}
                className="absolute inset-0"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: reduce ? 0.3 : 0.7, ease: EASE }}
              >
                {story.id === "listens" ? (
                  <ListensComposite {...beat} entrance={!visited} />
                ) : (
                  <>
                    <StoryPhoto src={story.img!} alt={story.alt} shift={story.shift} {...beat} />
                    <div className="absolute inset-0 bg-[#141e29]/25" aria-hidden />
                    {/* The same left panel as story 1's driver card — here a
                        frost of the story's own photo, so every story sets
                        its copy on the identical blurred strip. The frosted
                        element itself never moves (only the photo behind it
                        does), so the backdrop-blur judder rule above doesn't
                        bite. */}
                    <div
                      className="absolute inset-y-0 left-0 w-[48.5%] overflow-hidden rounded-l-[40px] bg-[#141e29]/25 backdrop-blur-[22px]"
                      aria-hidden
                    />
                    {story.id === "health" && <HealthChips reduce={reduce} />}
                  </>
                )}
              </motion.div>
            </AnimatePresence>

            {/* Copy + ticks sit above the rotation, fixed mid-left — only the
                story behind them swaps. */}
            <div className="absolute left-[5%] right-[8%] top-1/2 z-20 w-[38%] -translate-y-1/2">
              <CopyPanel {...beat} active={active} onPick={pick} swap={visited} />
            </div>

            {/* The time-to-next-story bar: one full run along the box's very
                bottom, stopping at the end of the blur panel. */}
            <div className="absolute bottom-0 left-0 z-20 w-[48.5%]">
              <Rise at={BEAT.bar} y={0} shown={shown} reduce={reduce}>
                <ProgressBar active={active} playing={playing} />
              </Rise>
            </div>
          </div>

          {/* ---- Tablet (sm to lg): same rotation as a single tall card ---- */}
          <div className="relative hidden aspect-[624/690] max-h-[560px] w-full overflow-hidden rounded-[24px] bg-[#141e29] sm:block lg:hidden">
            <AnimatePresence initial={false}>
              <motion.div
                key={story.id}
                className="absolute inset-0"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: reduce ? 0.3 : 0.6, ease: EASE }}
              >
                <StoryPhoto
                  src={story.id === "listens" ? "/landing/oto-listens-driver.png" : story.img!}
                  alt={story.alt || "A driver describing a problem to Oto out loud"}
                  {...beat}
                />
                <div className="absolute inset-0 bg-[#141e29]/30" aria-hidden />
              </motion.div>
            </AnimatePresence>
            <div className="absolute bottom-7 left-6 right-5 z-20">
              <CopyPanel {...beat} active={active} onPick={pick} swap={visited} />
            </div>
            {/* No split panel below lg — the bar runs the card's full width. */}
            <div className="absolute inset-x-0 bottom-0 z-20">
              <Rise at={BEAT.bar} y={0} shown={shown} reduce={reduce}>
                <ProgressBar active={active} playing={playing} />
              </Rise>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
