"use client";

import Image from "next/image";
import { motion, useAnimationFrame, useMotionValue } from "motion/react";

interface OtoOrbProps {
  /** Pulse more energetically while Oto is speaking / thinking. */
  active?: boolean;
  /**
   * Optional live audio level sampler (0..1). When provided, the orb scales
   * with the conversation audio — ElevenLabs-style reactivity. Falls back to a
   * gentle idle breathe when it returns 0 / is omitted.
   */
  getLevel?: () => number;
  className?: string;
}

/** The soft blue gradient orb that anchors the hero (Figma asset). */
export default function OtoOrb({ active = false, getLevel, className }: OtoOrbProps) {
  const scale = useMotionValue(1);
  const glow = useMotionValue(0.3);

  useAnimationFrame((t) => {
    const level = getLevel ? Math.max(0, Math.min(1, getLevel())) : 0;
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
      className={className}
      style={{ scale }}
      animate={{ y: [0, -10, 0] }}
      transition={{ y: { duration: 7, repeat: Infinity, ease: "easeInOut" } }}
    >
      <div className="relative h-full w-full">
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
          style={{ opacity: glow }}
        />
      </div>
    </motion.div>
  );
}
