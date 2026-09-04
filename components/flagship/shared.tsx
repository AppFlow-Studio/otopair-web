"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { motion, useInView, useReducedMotion } from "motion/react";

/**
 * SSR-safe reduced-motion. `useReducedMotion()` reads matchMedia synchronously
 * on the client, so it can return `true` on the first client render while the
 * server rendered `false` — a hydration mismatch. This returns `false` until
 * after mount (matching SSR), then the real preference once hydrated.
 */
export function useReducedMotionSafe(): boolean {
  const reduce = useReducedMotion();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted ? !!reduce : false;
}

/* ------------------------------------------------------------------ */
/* CountUp — animate a number from 0 → target once it enters view      */
/* ------------------------------------------------------------------ */
export function CountUp({
  to,
  decimals = 0,
  prefix = "",
  suffix = "",
  duration = 1.4,
  className,
}: {
  to: number;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  duration?: number;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: "0px 0px -10% 0px" });
  const reduce = useReducedMotionSafe();
  // The FINAL value is the initial render: the server markup (and any visitor
  // whose JS/observer never fires) must show the real stat, never a shipped 0
  // (site audit 2026-08-31). The count-up replaces it only once it actually
  // starts.
  const [val, setVal] = useState(to);

  useEffect(() => {
    if (!inView) return;
    if (reduce) {
      setVal(to);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / (duration * 1000));
      const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
      setVal(to * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
      else setVal(to);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [inView, to, duration, reduce]);

  return (
    <span ref={ref} className={className}>
      {prefix}
      {val.toFixed(decimals)}
      {suffix}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Step — a single beat in a card's multi-step "assemble in" entrance   */
/* (cards mount when Oto shows them, so this animates on mount).        */
/* ------------------------------------------------------------------ */
export function Step({
  delay = 0,
  y = 12,
  className,
  children,
}: {
  delay?: number;
  y?: number;
  className?: string;
  children: React.ReactNode;
}) {
  const reduce = useReducedMotionSafe();
  return (
    <motion.div
      className={className}
      initial={reduce ? { opacity: 0 } : { opacity: 0, y }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: reduce ? 0 : delay, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  );
}

/** Animated fill bar (0 → value/max) — used for meters/ratings. */
export function Bar({
  value,
  max = 5,
  delay = 0,
  trackClassName = "",
  fillClassName = "bg-[#1a1a1a]",
}: {
  value: number;
  max?: number;
  delay?: number;
  trackClassName?: string;
  fillClassName?: string;
}) {
  const reduce = useReducedMotionSafe();
  const pct = Math.max(0, Math.min(1, value / max)) * 100;
  return (
    <div className={`h-1.5 flex-1 overflow-hidden rounded-full bg-[#1a1a1a]/10 ${trackClassName}`}>
      <motion.div
        className={`h-full rounded-full ${fillClassName}`}
        initial={{ width: reduce ? `${pct}%` : "0%" }}
        animate={{ width: `${pct}%` }}
        transition={{ delay: reduce ? 0 : delay, duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* PlatformToggle — white iPhone | Android pill with sliding highlight */
/* ------------------------------------------------------------------ */
export function PlatformToggle({
  className = "",
  size = "md",
}: {
  className?: string;
  size?: "md" | "lg";
}) {
  const [platform, setPlatform] = useState<"iphone" | "android">("iphone");
  const h = size === "lg" ? "h-[58px]" : "h-[52px]";
  const w = size === "lg" ? "w-[300px]" : "w-[268px]";
  return (
    <div
      className={`relative flex ${h} ${w} items-center rounded-full bg-white p-1.5 shadow-[-8px_16px_24px_rgba(0,0,0,0.12)] ${className}`}
    >
      {(["iphone", "android"] as const).map((p) => {
        const active = platform === p;
        return (
          <button
            key={p}
            type="button"
            onClick={() => setPlatform(p)}
            className="relative z-10 flex h-full flex-1 items-center justify-center gap-2 rounded-full text-[15px]"
          >
            {active && (
              <motion.span
                layoutId="platform-pill"
                className="absolute inset-0 -z-10 rounded-full bg-[#1a1a1a]/[0.06]"
                transition={{ type: "spring", stiffness: 420, damping: 34 }}
              />
            )}
            <span className={`transition-colors duration-300 ${active ? "text-[#1a1a1a]" : "text-[#1a1a1a]/40"}`}>
              {p === "iphone" ? (
                <svg viewBox="0 0 24 24" className="h-[15px] w-[15px]" fill="currentColor" aria-hidden>
                  <path d="M16.365 1.43c0 1.14-.42 2.21-1.18 3.02-.81.86-2.13 1.52-3.21 1.43-.13-1.1.42-2.27 1.13-3.01.79-.84 2.18-1.46 3.26-1.44zM20.5 17.2c-.55 1.27-.82 1.83-1.53 2.95-.99 1.57-2.39 3.53-4.12 3.54-1.54.02-1.93-.99-4.02-.98-2.09.01-2.52.99-4.06.98-1.73-.02-3.05-1.78-4.04-3.35C-.07 16.1-.34 11.36 1.4 8.95c1.06-1.46 2.74-2.32 4.32-2.32 1.6 0 2.61 1 3.93 1 1.28 0 2.06-1 3.91-1 1.4 0 2.89.76 3.94 2.08-3.46 1.9-2.9 6.85.99 8.49z" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" className="h-[14px] w-[14px]" fill="currentColor" aria-hidden>
                  <path d="M4 2.5 13.5 12 4 21.5c-.3-.2-.5-.5-.5-.9V3.4c0-.4.2-.7.5-.9z" />
                </svg>
              )}
            </span>
            <span className={`transition-colors duration-300 ${active ? "text-[#1a1a1a]" : "text-[#1a1a1a]/40"}`}>
              {p === "iphone" ? "iPhone" : "Android"}
            </span>
          </button>
        );
      })}
      <span className="pointer-events-none absolute top-1/2 left-1/2 h-6 w-px -translate-x-1/2 -translate-y-1/2 bg-[#1a1a1a]/10" />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* UnderlineLink — nav link with a sliding underline on hover          */
/* ------------------------------------------------------------------ */
export function UnderlineLink({
  href,
  children,
  className = "",
}: {
  href: string;
  children: React.ReactNode;
  className?: string;
}) {
  const cls = `group relative inline-block ${className}`;
  const underline = (
    // Width, not scale-x: a transform transition on a child of the glass nav
    // makes it a composited layer over the rounded backdrop-blur, which
    // Chromium renders with the corner mask dropped (band artifact, 2026-09-03).
    <span className="absolute -bottom-0.5 left-0 h-px w-0 bg-current transition-[width] duration-300 ease-out group-hover:w-full" />
  );
  // In-page anchors stay plain <a> so Lenis's anchor handler owns the scroll
  // (next/link's own hash handling fights it).
  if (href.startsWith("#")) {
    return (
      <a href={href} className={cls}>
        {children}
        {underline}
      </a>
    );
  }
  return (
    <Link href={href} className={cls}>
      {children}
      {underline}
    </Link>
  );
}
