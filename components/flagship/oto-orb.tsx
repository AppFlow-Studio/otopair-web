"use client";

import Image from "next/image";
import {
  AnimatePresence,
  motion,
  useAnimationFrame,
  useMotionValue,
} from "motion/react";
import { useReducedMotionSafe } from "./shared";

interface OtoOrbProps {
  /** Pulse more energetically while Oto is speaking / thinking. */
  active?: boolean;
  /**
   * Optional live audio level sampler (0..1). When provided, the orb scales
   * with the conversation audio — ElevenLabs-style reactivity. Falls back to a
   * gentle idle breathe when it returns 0 / is omitted.
   */
  getLevel?: () => number;
  /** Pause the rAF work (e.g. when the hero is scrolled off-screen). */
  paused?: boolean;
  className?: string;
}

/** The soft blue gradient orb that anchors the hero (Figma asset). */
export default function OtoOrb({ active = false, getLevel, paused = false, className }: OtoOrbProps) {
  const reduce = useReducedMotionSafe();
  const scale = useMotionValue(1);
  const glow = useMotionValue(0.3);

  useAnimationFrame((t) => {
    if (reduce) return;
    const level = getLevel ? Math.max(0, Math.min(1, getLevel())) : 0;
    // When idle, off-screen, and already settled, skip the per-frame work.
    if (paused || (!active && level < 0.01 && Math.abs(scale.get() - 1) < 0.002)) {
      return;
    }
    const breatheAmp = active ? 0.03 : 0.018;
    const breathePeriod = active ? 900 : 2600;
    const breathe = Math.sin(t / breathePeriod) * breatheAmp;

    const targetScale = 1 + breathe + level * 0.22;
    scale.set(scale.get() + (targetScale - scale.get()) * 0.2);

    const targetGlow = (active ? 0.45 : 0.25) + level * 0.45;
    glow.set(glow.get() + (targetGlow - glow.get()) * 0.2);
  });

  return (
    <motion.div
      className={`relative ${className ?? ""}`}
      animate={reduce ? undefined : { y: [0, -10, 0] }}
      transition={{ y: { duration: 7, repeat: Infinity, ease: "easeInOut" } }}
    >
      {/* Expanding ripple rings while Oto is actively speaking/thinking. */}
      <AnimatePresence>
        {active && !reduce && (
          <>
            {[0, 1].map((i) => (
              <motion.span
                key={i}
                aria-hidden
                className="pointer-events-none absolute inset-[14%] rounded-full border border-[#5aa0ff]/40"
                initial={{ opacity: 0.5, scale: 0.85 }}
                animate={{ opacity: 0, scale: 1.6 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 2.4, repeat: Infinity, ease: "easeOut", delay: i * 1.2 }}
              />
            ))}
          </>
        )}
      </AnimatePresence>

      <motion.div className="relative h-full w-full" style={reduce ? undefined : { scale }}>
        <Image
          src="/oto-orb.png"
          alt=""
          fill
          priority
          sizes="(max-width: 768px) 70vw, 444px"
          className="select-none object-contain"
          draggable={false}
        />
        {/* Breathing glow underneath to make it feel alive. */}
        <motion.div
          aria-hidden
          className="absolute inset-[12%] -z-10 rounded-full bg-[#5aa0ff] blur-3xl"
          style={{ opacity: reduce ? 0.32 : glow }}
        />
      </motion.div>
    </motion.div>
  );
}
