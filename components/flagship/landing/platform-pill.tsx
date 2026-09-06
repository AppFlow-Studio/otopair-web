"use client";

import { motion } from "motion/react";
import { APP_STORE_URL, PLAY_STORE_URL, storeIsLive, usePlatform } from "../download-app";
import { useWaitlist } from "../waitlist-modal";

/** One half of the platform pill. While its store URL is the "#" placeholder it
 *  is a button that opens the waitlist — never an href="#", which scroll-jumped
 *  visitors back to the top of the page (site audit 2026-08-31). On launch the
 *  URLs go live and it becomes the real store link. */
function PillHalf({
  href,
  label,
  platform,
  className,
  children,
}: {
  href: string;
  label: string;
  platform: "ios" | "android";
  className: string;
  children: React.ReactNode;
}) {
  const { open } = useWaitlist();
  if (!storeIsLive(href)) {
    return (
      <motion.button
        type="button"
        whileTap={{ scale: 0.97 }}
        onClick={() => open({ platform })}
        aria-label={`${label} — join the launch list`}
        className={className}
      >
        {children}
      </motion.button>
    );
  }
  return (
    <motion.a whileTap={{ scale: 0.97 }} href={href} aria-label={label} className={className}>
      {children}
    </motion.a>
  );
}

const APPLE_PATH =
  "M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z";

/**
 * The platform control from the Figma V2 footer (node 354:756
 * `_ActionSheet-action`) and the mobile frame's hero/footer (390:3183 /
 * 390:4522): one white pill split "iPhone | Android", each half its own store
 * link (or a non-link span while the URL is still the "#" placeholder).
 *
 * The visitor never picks a platform (design review 2026-08-15, W1): on an
 * iPhone only the iPhone half renders, on Android only the Android half, and
 * desktop (or any agent we can't read) shows the split pair as the frames
 * draw it. Detection runs after hydration, so the server always sends the
 * pair and a phone collapses it on first client render — same rule as the
 * store badges (2026-09-03).
 *
 *  - `md` (default): the desktop footer size — 15/16px labels, r-full.
 *  - `sm`: the mobile frame's 198×37 pill — 12px labels, 10×12 marks,
 *    r-[30px]. Figma declares a heavy `-10px 19px 10px` 25% drop under it;
 *    that read as a smear on screen, so it carries the soft footer shadow
 *    instead (design feedback 2026-09-03).
 */
export default function PlatformPill({
  size = "md",
  className = "",
}: {
  size?: "md" | "sm";
  className?: string;
}) {
  const platform = usePlatform();
  const showApple = platform !== "android";
  const showAndroid = platform !== "ios";
  const single = !(showApple && showAndroid);

  const sm = size === "sm";
  const half = sm
    ? "flex items-center justify-center gap-[6px] text-[12px] leading-[22px] text-[#1a1a1a] transition-colors hover:bg-black/[0.04]"
    : "flex items-center gap-2 text-[15px] font-medium text-[#1a1a1a] transition-colors hover:bg-black/[0.04] tab:text-[16px]";
  const mark = sm ? "h-[12px] w-[10px]" : "h-[15px] w-[15px]";
  // Split pair: each half fills its side. Single: symmetric padding, the pill
  // shrinks to the one label.
  const applePad = sm
    ? single ? "px-7" : "flex-1 pl-1"
    : single ? "py-3.5 px-9 tab:py-4 tab:px-11" : "py-3.5 pl-7 pr-6 tab:py-4 tab:pl-9 tab:pr-7";
  const androidPad = sm
    ? single ? "px-7" : "flex-1 pr-1"
    : single ? "py-3.5 px-9 tab:py-4 tab:px-11" : "py-3.5 pl-6 pr-7 tab:py-4 tab:pl-7 tab:pr-9";

  return (
    <div
      className={`flex items-stretch overflow-hidden bg-white ${
        sm
          ? `h-[37px] rounded-[30px] shadow-[0_8px_20px_rgba(43,84,120,0.16)] ${single ? "w-auto" : "w-[198px]"}`
          : "rounded-full shadow-[0_14px_34px_rgba(43,84,120,0.18)]"
      } ${className}`}
    >
      {showApple && (
        <PillHalf
          href={APP_STORE_URL}
          platform="ios"
          label="Download Otopair for iPhone on the App Store"
          className={`${half} ${applePad}`}
        >
          <svg viewBox="0 0 384 512" className={`${mark} fill-current`} aria-hidden>
            <path d={APPLE_PATH} />
          </svg>
          iPhone
        </PillHalf>
      )}
      {!single && <span className={`${sm ? "my-[6px]" : "my-2"} w-px bg-[#1a1a1a]/10`} aria-hidden />}
      {showAndroid && (
        <PillHalf
          href={PLAY_STORE_URL}
          platform="android"
          label="Get Otopair for Android on Google Play"
          className={`${half} ${androidPad}`}
        >
          <svg viewBox="0 0 512 512" className={mark} aria-hidden>
            <path fill="#32bbff" d="M104 63.5 335.2 194 271 258.2 84.6 71.8c4.9-6 11.7-9.4 19.4-8.3z" />
            <path fill="#32bbff" d="M76 84.9 262.5 271.5 76 458.1c-3.2-4.5-5-10.2-5-16.9V101.8c0-6.7 1.8-12.4 5-16.9z" />
            <path fill="#ffd400" d="m412.9 237.9-64.7-36.5-70.7 70.1 70.7 70.1 64.9-36.6c19.4-11 19.4-56.1-.2-67.1z" />
            <path fill="#f43249" d="M84.6 471.2 271 284.8l64.2 64.2L104 479.5c-7.7 1.1-14.5-2.3-19.4-8.3z" />
          </svg>
          Android
        </PillHalf>
      )}
    </div>
  );
}
