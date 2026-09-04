"use client";

import { useSyncExternalStore } from "react";
import { motion } from "motion/react";

/**
 * Store destinations. Both are placeholders until the real listings exist —
 * swapping them is the only change needed to make every badge surface fully
 * live (this component and the footer's PlatformPill both read these).
 */
export const APP_STORE_URL = "#";
export const PLAY_STORE_URL = "#";

/** A "#" placeholder must never render as a link — a dead badge that jumps to
 *  the top of the page reads as broken software (site audit 2026-08-31). */
export const storeIsLive = (url: string) => url !== "#";

export type Platform = "ios" | "android" | "other";

/** Reads the platform once on the client. SSR always renders the neutral state. */
const subscribeNoop = () => () => {};
const getServerPlatform = (): Platform => "other";

function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "other";
  const ua = navigator.userAgent;
  // iPadOS 13+ reports as a Mac, so the touch-point count disambiguates it.
  const iPadOS = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  if (/iPhone|iPad|iPod/i.test(ua) || iPadOS) return "ios";
  if (/Android/i.test(ua)) return "android";
  return "other";
}

/** The visitor's platform — "other" on the server, during hydration, and on
 *  desktop. Shared by every store control (badges here, PlatformPill) so
 *  they all agree on which store to show (design review 2026-08-15, W1). */
export function usePlatform(): Platform {
  return useSyncExternalStore(subscribeNoop, detectPlatform, getServerPlatform);
}

/**
 * Official store badges at Figma V1's declared geometry (nodes 302:1101/1102):
 * 180x47 / 189x47 dark plates, rounded-[8px], 8px apart, with the standard
 * badge artwork the repo already ships. While the store URL is still the "#"
 * placeholder the badge renders as a plain (non-link) plate — the caption in
 * DownloadApp carries the "coming soon" message.
 */
function StoreBadge({ store, size = "md" }: { store: "apple" | "google"; size?: "sm" | "md" | "lg" }) {
  // sm = the mobile frame's 145×38 / 152×38 plates (node 390:3247), i.e. 0.8×.
  const scale = size === "lg" ? 1.18 : size === "sm" ? 0.8 : 1;
  const w = Math.round((store === "apple" ? 180 : 189) * scale);
  const h = Math.round(47 * scale);
  const href = store === "apple" ? APP_STORE_URL : PLAY_STORE_URL;
  const label =
    store === "apple" ? "Download Otopair on the App Store" : "Get Otopair on Google Play";
  const art = (
    <img
      src={store === "apple" ? "/images/landing/badge-app-store.svg" : "/images/landing/badge-google-play.svg"}
      alt=""
      width={Math.round((store === "apple" ? 96 : 100) * scale)}
      height={Math.round((store === "apple" ? 25 : 24) * scale)}
    />
  );

  if (!storeIsLive(href)) {
    return (
      <span
        title="Coming soon"
        aria-label={`${label} — coming soon`}
        className="flex items-center justify-center rounded-[8px] bg-[#1a1a1a]"
        style={{ width: w, height: h }}
      >
        {art}
      </span>
    );
  }
  return (
    <motion.a
      whileTap={{ scale: 0.97 }}
      href={href}
      aria-label={label}
      className="flex items-center justify-center rounded-[8px] bg-[#1a1a1a] transition-transform duration-300 hover:scale-[1.03]"
      style={{ width: w, height: h }}
    >
      {art}
    </motion.a>
  );
}

/**
 * Download CTA. The visitor never picks a platform (design review 2026-08-15,
 * W1): on iOS only the App Store badge renders, on Android only Google Play,
 * and desktop (or any agent we can't read) shows the official pair exactly as
 * the Figma V1 layout does. Placeholder-URL badges get one shared muted
 * "coming soon" caption instead of dead links.
 */
export default function DownloadApp({
  className = "",
  size = "md",
}: {
  className?: string;
  size?: "sm" | "md" | "lg";
  /** Kept for call-site compatibility; badges are always the official dark plates. */
  tone?: "dark" | "light";
}) {
  const platform = usePlatform();

  if (platform === "other") {
    const comingSoon = !storeIsLive(APP_STORE_URL) || !storeIsLive(PLAY_STORE_URL);
    return (
      <div className={`flex flex-col items-center gap-2.5 ${className}`}>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <StoreBadge store="apple" size={size} />
          <StoreBadge store="google" size={size} />
        </div>
        {comingSoon && (
          <p className="text-[12px] tracking-[0.05em] text-[#777169]">
            Coming soon to the App Store &amp; Google Play
          </p>
        )}
      </div>
    );
  }
  const url = platform === "ios" ? APP_STORE_URL : PLAY_STORE_URL;
  return (
    <div className={`flex flex-col items-center gap-2.5 ${className}`}>
      <StoreBadge store={platform === "ios" ? "apple" : "google"} size={size} />
      {!storeIsLive(url) && (
        <p className="text-[12px] tracking-[0.05em] text-[#777169]">
          {platform === "ios" ? "Coming soon to the App Store" : "Coming soon on Google Play"}
        </p>
      )}
    </div>
  );
}
