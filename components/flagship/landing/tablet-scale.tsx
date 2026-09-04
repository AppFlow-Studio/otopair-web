"use client";

import { useEffect, useRef, type ReactNode } from "react";

/** The Figma phone frame's width — the layout every scale is measured from. */
const PHONE_FRAME = 402;
/** Tablets run from `tab`'s floor (640) up to, not including, lg (1024). */
const TABLET_MIN = 640;
const TABLET_MAX = 1024;
/** Damping + cap: full-width zoom (viewport/402) is 1.9× at 768 and 2.5× at
 *  1023 — "too big" — while no zoom stretches the phone layout across the
 *  tablet — "too stretched". The 0.7 power splits the difference: the phone
 *  composition grows to ~1.57× at 768 and lays out ~490 CSS px wide (22%
 *  wider than the frame), 1.75× at most (design feedback 2026-09-03). */
const DAMPING = 0.7;
const MAX_ZOOM = 1.75;

export function tabletZoom(width: number) {
  if (width < TABLET_MIN || width >= TABLET_MAX) return 1;
  return Math.min(MAX_ZOOM, Math.pow(width / PHONE_FRAME, DAMPING));
}

/**
 * Wraps the landing page in `<main>` and, on tablet widths, zooms it so the
 * phone layout renders proportionately larger instead of stretching (phones
 * keep the fluid phone layout at 1×, desktop is untouched). CSS `zoom` makes
 * the wrapper lay out at viewport/zoom CSS px and paint at viewport size, so
 * full-bleed bands stay full-bleed and media queries still see the real
 * viewport. The stepped fallback in globals.css (.landing-tablet-scale)
 * covers the first paint; this refines it continuously and on resize.
 */
export default function TabletScale({
  className = "",
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = () => {
      const z = tabletZoom(window.innerWidth);
      // Inline style beats the stepped class rule; clear it outside tablets
      // so desktop/phone never carry a stale zoom.
      el.style.zoom = z === 1 ? "" : z.toFixed(3);
    };
    apply();
    window.addEventListener("resize", apply);
    return () => window.removeEventListener("resize", apply);
  }, []);
  return (
    <main ref={ref} className={`landing-tablet-scale ${className}`}>
      {children}
    </main>
  );
}
