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
 * advance on their own clock; the tick bars above the title show which is
 * active and are clickable to jump (clicking retires the auto-advance).
 *
 * Story 1 keeps the original layered composite (dash photo + driver
 * close-up card + chat bubbles). Stories 2–3 are single full-bleed photos.
 *
 * ASSETS: stories 2–3 want their own Figma exports —
 *   public/landing/story-health.png   (hand + phone, vehicle health screen)
 *   public/landing/story-booking.png  (hand + phone, NYC map + Select Services)
 * Until those exist the dash photo stands in (onError fallback) so nothing
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
  body: 0.6,
  ask: 0.8,
  answer: 1.25,
} as const;

/** How long each story holds before handing off. Story 1 runs longer — its
 *  bubble conversation needs time to land. */
const STORY_HOLD_MS = [9000, 7000, 7000] as const;

const STORIES = [
  {
    id: "listens",
    title: "Oto Listens.",
    body: "Describe the problem out loud. Oto understands symptoms, context, and your specific car — not just keywords.",
    img: null, // story 1 renders the layered composite, not a single photo
    alt: "",
  },
  {
    id: "health",
    title: "Your car's health, live.",
    body: "A running health score for your exact car — what's strong, what's wearing, and what's due next.",
    img: "/landing/story-health.png",
    alt: "A phone showing a live vehicle health score",
  },
  {
    id: "booking",
    title: "Booked in 90 seconds.",
    body: "Real shops on a live map, prices locked before you tap confirm.",
    img: "/landing/story-booking.png",
    alt: "A phone showing nearby shops on a map, ready to book",
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

/** The copy block: ticks, title, body — swaps with the active story. */
function CopyPanel({
  shown,
  reduce,
  active,
  onPick,
}: Beat & { active: number; onPick: (i: number) => void }) {
  const story = STORIES[active];
  return (
    <Rise at={BEAT.panel} y={22} blur={8} shown={shown} reduce={reduce} className="max-w-[398px]">
      <Rise at={BEAT.ticks} y={8} shown={shown} reduce={reduce}>
        <StoryTicks active={active} onPick={onPick} />
      </Rise>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={story.id}
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, y: -10 }}
          transition={{ duration: reduce ? 0.3 : 0.45, ease: EASE }}
        >
          <Rise at={BEAT.title} y={18} shown={shown} reduce={reduce}>
            <h2
              className="mt-5 text-[28px] leading-[1.15] text-white sm:text-[36px] sm:leading-[41px]"
              style={{ ...serif, letterSpacing: "0.37px" }}
            >
              {story.title}
            </h2>
          </Rise>
          <Rise at={BEAT.body} y={14} shown={shown} reduce={reduce}>
            <p className="mt-4 max-w-[300px] text-[14px] font-medium leading-[1.5] text-white/90 sm:text-[15px]">
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

/** Full-bleed story photo with a slow Ken Burns; falls back to the dash
 *  export while a story's own Figma photo hasn't been dropped in yet. */
function StoryPhoto({
  src,
  alt,
  shown,
  reduce,
}: Beat & { src: string; alt: string }) {
  const [actualSrc, setActualSrc] = useState(src);
  return (
    <motion.div
      className="absolute inset-0"
      animate={reduce || !shown ? undefined : { scale: [1, 1.035, 1] }}
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
  // Clicking a tick retires the auto-advance — the visitor is driving now.
  const engaged = useRef(false);

  useEffect(() => {
    if (!shown || reduce || engaged.current) return;
    const t = window.setTimeout(() => {
      if (!engaged.current) {
        setVisited(true);
        setActive((a) => (a + 1) % STORIES.length);
      }
    }, STORY_HOLD_MS[active]);
    return () => window.clearTimeout(t);
  }, [shown, reduce, active]);

  const pick = (i: number) => {
    engaged.current = true;
    setVisited(true);
    setActive(i);
  };

  const story = STORIES[active];

  return (
    <section
      ref={ref}
      className="mx-auto w-full max-w-[1440px] px-4 pt-20 sm:px-10 sm:pt-28 lg:px-[78px]"
    >
      <div>
        <div>
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
                    <StoryPhoto src={story.img!} alt={story.alt} {...beat} />
                    <div className="absolute inset-0 bg-[#141e29]/30" aria-hidden />
                  </>
                )}
              </motion.div>
            </AnimatePresence>

            {/* Copy + ticks sit above the rotation, fixed mid-left — only the
                story behind them swaps. */}
            <div className="absolute left-[5%] right-[8%] top-1/2 z-20 w-[38%] -translate-y-1/2">
              <CopyPanel {...beat} active={active} onPick={pick} />
            </div>
          </div>

          {/* ---- Mobile/tablet: same rotation as a single tall card ---- */}
          <div className="relative aspect-[624/690] max-h-[560px] w-full overflow-hidden rounded-[24px] bg-[#141e29] lg:hidden">
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
              <CopyPanel {...beat} active={active} onPick={pick} />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
