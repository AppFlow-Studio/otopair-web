"use client";

import ReactLenis from "lenis/react";
import { useReducedMotionSafe } from "./shared";

/**
 * Lenis smooth scrolling for the marketing routes, gated on the visitor's
 * reduce-motion preference (accessibility review 2026-09-04: the layout
 * wrapped every page in Lenis with no reduced-motion check, so the one
 * setting that is supposed to turn animation off left the scroll itself
 * animated). With reduced motion on, children render with native scrolling
 * and hash links still work — the browser handles them.
 */
export default function SmoothScroll({ children }: { children: React.ReactNode }) {
  const reduce = useReducedMotionSafe();
  if (reduce) return <>{children}</>;
  return (
    // anchors: smooth-scroll nav hash links, offset clears the fixed pill nav
    <ReactLenis root options={{ anchors: { offset: -90 } }}>
      {children}
    </ReactLenis>
  );
}
