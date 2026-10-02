"use client";

import { useSyncExternalStore } from "react";
import { motion } from "motion/react";
import { PillButton } from "./pill-button";
import { useWaitlist } from "./waitlist-modal";

/**
 * Store destinations — the launch flag. Both stay the "#" placeholder until the
 * real listings exist; setting NEXT_PUBLIC_APP_STORE_URL / NEXT_PUBLIC_PLAY_STORE_URL
 * (in Vercel, at launch) is the only change needed to make every badge surface go
 * live. Until then no store artwork renders at all — every store control is
 * replaced by a "Join the waitlist" button. This component, the footer's
 * PlatformPill and the Oto booking card all read these, so one env flip flips
 * the whole site — badges vs. waitlist — with no code change.
 */
export const APP_STORE_URL = process.env.NEXT_PUBLIC_APP_STORE_URL || "#";
export const PLAY_STORE_URL = process.env.NEXT_PUBLIC_PLAY_STORE_URL || "#";

/** A "#" placeholder must never render as a link — a dead badge that jumps to
 *  the top of the page reads as broken software (site audit 2026-08-31). While
 *  not-live the badge isn't rendered; a waitlist button stands in for it. */
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
 * badge artwork the repo already ships. Only rendered once that store's URL is
 * live — before launch DownloadApp shows the waitlist button instead.
 */
function StoreBadge({ store, size = "md" }: { store: "apple" | "google"; size?: "sm" | "md" | "lg" }) {
  // sm = the mobile frame's 145×38 / 152×38 plates (node 390:3247), i.e. 0.8×.
  const scale = size === "lg" ? 1.18 : size === "sm" ? 0.8 : 1;
  const w = Math.round((store === "apple" ? 180 : 189) * scale);
  const h = Math.round(47 * scale);
  return (
    <motion.a
      whileTap={{ scale: 0.97 }}
      href={store === "apple" ? APP_STORE_URL : PLAY_STORE_URL}
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

/** Pre-launch stand-in for the store badges: one pill that opens the waitlist
 *  modal. A store badge that can't download anything reads as broken, so until
 *  the listing exists the visitor gets this instead (2026-10-02). */
export function WaitlistButton({
  size = "md",
  tone = "ink",
  className = "",
}: {
  size?: "sm" | "md" | "lg";
  tone?: "ink" | "light";
  className?: string;
}) {
  const { open } = useWaitlist();
  const platform = usePlatform();
  const sizing = size === "sm" ? "h-10 pl-5 text-[14px]" : size === "lg" ? "h-14 pl-7 text-[16px]" : "";
  return (
    <PillButton type="button" tone={tone} onClick={() => open({ platform })} className={`${sizing} ${className}`}>
      Join the waitlist
    </PillButton>
  );
}

/**
 * Download CTA. The visitor never picks a platform (design review 2026-08-15,
 * W1): on iOS only the App Store badge renders, on Android only Google Play,
 * and desktop (or any agent we can't read) shows every live store's badge.
 * When none of the visitor's stores is live yet, the badges give way to a
 * single "Join the waitlist" button (or nothing, with `waitlist={false}`, for
 * pages that already carry an inline waitlist form).
 */
export default function DownloadApp({
  className = "",
  size = "md",
  align = "center",
  waitlist = true,
}: {
  className?: string;
  size?: "sm" | "md" | "lg";
  /** `start` for a left-aligned hero; the landing keeps the centred pair. */
  align?: "center" | "start";
  /** Kept for call-site compatibility; badges are always the official dark plates. */
  tone?: "dark" | "light";
  /** `false` renders nothing pre-launch instead of the waitlist button. */
  waitlist?: boolean;
}) {
  const platform = usePlatform();
  const box = align === "start" ? "items-start" : "items-center";
  const row = align === "start" ? "justify-start" : "justify-center";

  const wanted: ("apple" | "google")[] =
    platform === "ios" ? ["apple"] : platform === "android" ? ["google"] : ["apple", "google"];
  const live = wanted.filter((s) => storeIsLive(s === "apple" ? APP_STORE_URL : PLAY_STORE_URL));
  const pending = wanted.filter((s) => !live.includes(s));
  const comingSoon =
    pending.length === 2
      ? "Coming soon to the App Store & Google Play"
      : pending[0] === "apple"
        ? "Coming soon to the App Store"
        : pending[0] === "google"
          ? "Coming soon on Google Play"
          : null;

  if (live.length === 0 && !waitlist) return null;
  return (
    <div className={`flex flex-col ${box} gap-2.5 ${className}`}>
      {live.length === 0 ? (
        <WaitlistButton size={size} />
      ) : (
        <div className={`flex flex-wrap items-center gap-2 ${row}`}>
          {live.map((s) => (
            <StoreBadge key={s} store={s} size={size} />
          ))}
        </div>
      )}
      {comingSoon && <p className="text-[12px] tracking-[0.05em] text-[#777169]">{comingSoon}</p>}
    </div>
  );
}
