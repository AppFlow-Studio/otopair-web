"use client";

import { useRef } from "react";
import Image from "next/image";
import { motion, useInView } from "motion/react";
import { Waveform } from "../voice-bar";
import { useReducedMotionSafe } from "../shared";
import { serif } from "./reveal";

/*
 * "Oto Listens." — the V2 photo section (Figma 354:738 "Frame 73", 1440x835).
 * One full-bleed rounded photo of the drive (dashboard, phone on "Oto
 * Scanning") with the conversation floating over it, and a darker driver
 * close-up overlaying the left half as its own card (624x690, 40px left
 * radius) carrying the copy on a frosted panel. Replaces the old "Built to
 * understand your car" three-up (design feedback 2026-08-24, item 5).
 *
 * Both photos are straight 2x exports of the Figma layers
 * (public/landing/oto-listens-{driver,dash}.png) — the bubbles and copy are
 * real elements here, nothing is baked into the images.
 *
 * Everything in the frame animates. One local clock (`shown`) drives the
 * whole entrance so the beats land in a fixed order rather than each element
 * racing its own scroll trigger:
 *
 *   0.00  dash photo fades up out of a 1.08 push-in
 *   0.12  driver card wipes in from the left edge
 *   0.26  frosted panel rises and unblurs
 *   0.38  waveform ticks in (then loops on its own)
 *   0.46  "Oto Listens." rises
 *   0.60  body copy rises
 *   0.80  the question bubble pops
 *   1.25  Oto's answer pops
 *
 * After the entrance settles, two ambient loops keep the frame alive: a very
 * slow Ken Burns on the photo and a small float under each bubble. Reduced
 * motion gets plain fades and no loops.
 */

const EASE = [0.22, 1, 0.36, 1] as const;

const BEAT = {
  photo: 0,
  card: 0.12,
  panel: 0.26,
  wave: 0.38,
  title: 0.46,
  body: 0.6,
  ask: 0.8,
  answer: 1.25,
} as const;

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

/** Frosted copy panel (Figma UI 354:746: 398x418, radius 20, bg-blur 70). */
function CopyPanel({ shown, reduce }: Beat) {
  return (
    <Rise
      at={BEAT.panel}
      y={22}
      blur={8}
      shown={shown}
      reduce={reduce}
      className="max-w-[398px] rounded-[20px] bg-white/5 p-7 backdrop-blur-[35px] sm:p-9"
    >
      <Rise at={BEAT.wave} y={8} shown={shown} reduce={reduce}>
        <Waveform active={!reduce} bars={4} className="h-[18px] text-white/80" />
      </Rise>
      <Rise at={BEAT.title} y={18} shown={shown} reduce={reduce}>
        <h2
          className="mt-5 text-[28px] leading-[1.15] text-white sm:text-[36px] sm:leading-[41px]"
          style={{ ...serif, letterSpacing: "0.37px" }}
        >
          Oto Listens.
        </h2>
      </Rise>
      <Rise at={BEAT.body} y={14} shown={shown} reduce={reduce}>
        <p className="mt-4 max-w-[300px] text-[14px] font-medium leading-[1.5] text-white/90 sm:text-[15px]">
          Describe the problem out loud. Oto understands symptoms, context, and your specific car
          — not just keywords.
        </p>
      </Rise>
    </Rise>
  );
}

/** A floating chat bubble: springs in, then drifts. `float` offsets the two
 *  loops so they never bob in lockstep. */
function Bubble({
  at,
  float,
  tone,
  className,
  children,
  shown,
  reduce,
}: Beat & {
  at: number;
  float: number;
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
      <motion.div
        animate={reduce || !shown ? undefined : { y: [0, -5, 0] }}
        transition={{ duration: 6.5, delay: float, repeat: Infinity, ease: "easeInOut" }}
      >
        <div
          className={`rounded-[14px] px-5 py-3.5 text-[12px] leading-snug text-[#1a1a1a] shadow-[0_10px_30px_rgba(0,0,0,0.10)] backdrop-blur-md sm:px-7 sm:py-4 sm:text-[14px] ${
            tone === "ask" ? "bg-white/60" : "bg-white/45"
          }`}
        >
          {children}
        </div>
      </motion.div>
    </motion.div>
  );
}

/** The dashboard photo: pushes in on entrance, then breathes. */
function DashPhoto({ shown, reduce, alt }: Beat & { alt: string }) {
  return (
    <motion.div
      className="absolute inset-0"
      initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 1.08 }}
      animate={shown ? { opacity: 1, scale: 1 } : undefined}
      transition={{ delay: BEAT.photo, duration: reduce ? 0.5 : 1.5, ease: EASE }}
    >
      <motion.div
        className="absolute inset-0"
        animate={reduce || !shown ? undefined : { scale: [1, 1.035, 1] }}
        transition={{ duration: 24, repeat: Infinity, ease: "easeInOut" }}
      >
        <Image
          src="/landing/oto-listens-dash.png"
          alt={alt}
          fill
          sizes="(min-width: 1024px) 1288px, 100vw"
          className="object-cover"
          priority={false}
        />
      </motion.div>
    </motion.div>
  );
}

function Bubbles({ shown, reduce, compact = false }: Beat & { compact?: boolean }) {
  return (
    <>
      <Bubble
        at={BEAT.ask}
        float={0}
        tone="ask"
        shown={shown}
        reduce={reduce}
        className={
          compact
            ? "absolute right-[4%] top-[10%] max-w-[78%]"
            : "absolute right-[5%] top-[15%] max-w-[46%]"
        }
      >
        &ldquo;My brakes squeal in the cold. Can you check?&rdquo;
      </Bubble>
      <Bubble
        at={BEAT.answer}
        float={2.6}
        tone="answer"
        shown={shown}
        reduce={reduce}
        className={
          compact
            ? "absolute left-[6%] top-[30%] max-w-[70%]"
            : "absolute left-[51%] top-[33%] max-w-[40%]"
        }
      >
        Classic glazed pads. Found 3 shops.
      </Bubble>
    </>
  );
}

export default function ListensSection() {
  const reduce = useReducedMotionSafe();
  const ref = useRef<HTMLElement>(null);
  // One trigger for the whole section — every beat above counts from here.
  const shown = useInView(ref, { once: true, margin: "0px 0px -12% 0px" });
  const beat = { shown, reduce };

  return (
    <section
      ref={ref}
      className="mx-auto w-full max-w-[1440px] px-4 pt-28 sm:px-10 sm:pt-36 lg:px-[76px]"
    >
      {/* ---- Desktop: the layered composite, at the design's 1287:690 ---- */}
      <div className="relative hidden aspect-[1287/690] w-full overflow-hidden rounded-[40px] lg:block">
        <DashPhoto {...beat} alt="A driver holding a phone running Oto while parked" />
        <Bubbles {...beat} />

        {/* Driver close-up overlays the left half as its own card — it wipes
            in from the left edge rather than just fading with the photo. */}
        <motion.div
          className="absolute inset-y-0 left-0 w-[48.5%] overflow-hidden rounded-l-[40px]"
          initial={reduce ? { opacity: 0 } : { opacity: 0, x: -40, clipPath: "inset(0 100% 0 0)" }}
          animate={shown ? { opacity: 1, x: 0, clipPath: "inset(0 0% 0 0)" } : undefined}
          transition={{ delay: reduce ? 0 : BEAT.card, duration: reduce ? 0.5 : 1.0, ease: EASE }}
        >
          <Image
            src="/landing/oto-listens-driver.png"
            alt=""
            fill
            sizes="(min-width: 1024px) 625px, 100vw"
            className="object-cover"
          />
          <div className="absolute bottom-[8%] left-[10%] right-[6%]">
            <CopyPanel {...beat} />
          </div>
        </motion.div>
      </div>

      {/* ---- Mobile/tablet: the two photos stack as sibling cards ---- */}
      <div className="flex flex-col gap-4 lg:hidden">
        <motion.div
          className="relative aspect-[624/690] max-h-[560px] w-full overflow-hidden rounded-[24px]"
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: 28, scale: 0.98 }}
          animate={shown ? { opacity: 1, y: 0, scale: 1 } : undefined}
          transition={{ duration: reduce ? 0.4 : 0.8, ease: EASE }}
        >
          <Image
            src="/landing/oto-listens-driver.png"
            alt="A driver describing a problem to Oto out loud"
            fill
            sizes="100vw"
            className="object-cover"
          />
          <div className="absolute bottom-5 left-5 right-5">
            <CopyPanel {...beat} />
          </div>
        </motion.div>

        <motion.div
          className="relative aspect-[1287/690] w-full overflow-hidden rounded-[24px]"
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: 28 }}
          animate={shown ? { opacity: 1, y: 0 } : undefined}
          transition={{ delay: reduce ? 0 : 0.1, duration: reduce ? 0.4 : 0.8, ease: EASE }}
        >
          <DashPhoto {...beat} alt="A phone running Oto's scan while parked" />
          <Bubbles {...beat} compact />
        </motion.div>
      </div>
    </section>
  );
}
