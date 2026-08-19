"use client";

import { useSyncExternalStore } from "react";
import { motion } from "motion/react";

/**
 * Store destinations. Both are placeholders until the real listings exist —
 * swapping them is the only change needed to make this CTA fully live.
 */
export const APP_STORE_URL = "#";
export const PLAY_STORE_URL = "#";

type Platform = "ios" | "android" | "other";

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

/**
 * Official store badges at Figma V1's declared geometry (nodes 302:1101/1102):
 * 180x47 / 189x47 dark plates, rounded-[8px], 8px apart, with the standard
 * badge artwork the repo already ships.
 */
function StoreBadge({ store, size = "md" }: { store: "apple" | "google"; size?: "md" | "lg" }) {
  const scale = size === "lg" ? 1.18 : 1;
  const w = Math.round((store === "apple" ? 180 : 189) * scale);
  const h = Math.round(47 * scale);
  const href = store === "apple" ? APP_STORE_URL : PLAY_STORE_URL;
  return (
    <motion.a
      whileTap={{ scale: 0.97 }}
      href={href}
      aria-label={store === "apple" ? "Download Otopair on the App Store" : "Get Otopair on Google Play"}
      className="flex items-center justify-center rounded-[8px] bg-[#1a1a1a] transition-transform duration-300 hover:scale-[1.03]"
      style={{ width: w, height: h }}
    >
      <img
        src={store === "apple" ? "/images/landing/badge-app-store.svg" : "/images/landing/badge-google-play.svg"}
        alt=""
        width={Math.round((store === "apple" ? 96 : 100) * scale)}
        height={Math.round((store === "apple" ? 25 : 24) * scale)}
      />
    </motion.a>
  );
}

/**
 * Download CTA. The visitor never picks a platform (design review 2026-08-15,
 * W1): on iOS only the App Store badge renders, on Android only Google Play,
 * and desktop (or any agent we can't read) shows the official pair exactly as
 * the Figma V1 layout does.
 */
export default function DownloadApp({
  className = "",
  size = "md",
}: {
  className?: string;
  size?: "md" | "lg";
  /** Kept for call-site compatibility; badges are always the official dark plates. */
  tone?: "dark" | "light";
}) {
  const platform = useSyncExternalStore(subscribeNoop, detectPlatform, getServerPlatform);

  if (platform === "other") {
    return (
      <div className={`flex flex-wrap items-center justify-center gap-2 ${className}`}>
        <StoreBadge store="apple" size={size} />
        <StoreBadge store="google" size={size} />
      </div>
    );
  }
  return (
    <div className={`flex items-center justify-center ${className}`}>
      <StoreBadge store={platform === "ios" ? "apple" : "google"} size={size} />
    </div>
  );
}
