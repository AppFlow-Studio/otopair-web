"use client";

import { useEffect, useState } from "react";

/**
 * SSR-safe media-query hook. Returns `false` on the server and on the first
 * client render (so hydration matches), then flips to the real value in an
 * effect and stays in sync via `matchMedia` change events.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia(query);
    const update = () => setMatches(mql.matches);
    update();
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, [query]);

  return matches;
}

/**
 * True on phones and iPads (both orientations) — anything below Tailwind's
 * `xl` breakpoint (1280px). The schedule page swaps its side panels for
 * slide-up bottom sheets when this is true. `≥xl` keeps the desktop split view.
 */
export function useIsCompact(): boolean {
  return useMediaQuery("(max-width: 1279px)");
}
