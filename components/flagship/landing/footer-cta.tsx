"use client";

import Link from "next/link";
import { motion } from "motion/react";
import { APP_STORE_URL, PLAY_STORE_URL } from "../download-app";
import { Reveal, serifDisplay } from "./reveal";

const FOOTER_LINKS = [
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
  { href: "/contact", label: "Contact" },
] as const;

/** The V2 footer's platform control (node 354:756 `_ActionSheet-action`): one
 *  white pill, split "iPhone | Android", each half its own store link. */
function PlatformPill() {
  return (
    <div className="flex items-stretch overflow-hidden rounded-full bg-white shadow-[0_14px_34px_rgba(43,84,120,0.18)]">
      <motion.a
        whileTap={{ scale: 0.97 }}
        href={APP_STORE_URL}
        aria-label="Download Otopair for iPhone on the App Store"
        className="flex items-center gap-2 py-3.5 pl-7 pr-6 text-[15px] font-medium text-[#1a1a1a] transition-colors hover:bg-black/[0.04] sm:py-4 sm:pl-9 sm:pr-7 sm:text-[16px]"
      >
        <svg viewBox="0 0 384 512" className="h-[15px] w-[15px] fill-current" aria-hidden>
          <path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z" />
        </svg>
        iPhone
      </motion.a>
      <span className="my-2 w-px bg-[#1a1a1a]/10" aria-hidden />
      <motion.a
        whileTap={{ scale: 0.97 }}
        href={PLAY_STORE_URL}
        aria-label="Get Otopair for Android on Google Play"
        className="flex items-center gap-2 py-3.5 pl-6 pr-7 text-[15px] font-medium text-[#1a1a1a] transition-colors hover:bg-black/[0.04] sm:py-4 sm:pl-7 sm:pr-9 sm:text-[16px]"
      >
        <svg viewBox="0 0 512 512" className="h-[15px] w-[15px]" aria-hidden>
          <path
            fill="#32bbff"
            d="M104 63.5 335.2 194 271 258.2 84.6 71.8c4.9-6 11.7-9.4 19.4-8.3z"
          />
          <path fill="#32bbff" d="M76 84.9 262.5 271.5 76 458.1c-3.2-4.5-5-10.2-5-16.9V101.8c0-6.7 1.8-12.4 5-16.9z" />
          <path
            fill="#ffd400"
            d="m412.9 237.9-64.7-36.5-70.7 70.1 70.7 70.1 64.9-36.6c19.4-11 19.4-56.1-.2-67.1z"
          />
          <path fill="#f43249" d="M84.6 471.2 271 284.8l64.2 64.2L104 479.5c-7.7 1.1-14.5-2.3-19.4-8.3z" />
        </svg>
        Android
      </motion.a>
    </div>
  );
}

/**
 * Closing CTA band, rebuilt to Figma V2 (node 354:756, 1440x432): a soft
 * white → #95C7E7 vertical gradient carrying everything — steel-blue serif
 * headline, the white iPhone/Android pill, and the footer row (copyright +
 * legal links) sitting directly on the gradient. The old saturated blob and
 * separate dark strip are gone (design feedback 2026-08-24, item 7). The
 * gradient starts at pure white so it continues seamlessly from the white
 * section above it.
 */
export default function FooterCta() {
  return (
    <footer className="mt-28 w-full sm:mt-36">
      {/* id="get-oto" — the PillNav CTA and hero store buttons anchor here. */}
      <div
        id="get-oto"
        className="relative flex w-full flex-col overflow-hidden px-6 pt-24 sm:px-10 lg:min-h-[432px] lg:pt-[110px]"
        style={{ background: "linear-gradient(to bottom, #FFFFFF 0%, #95C7E7 100%)" }}
      >
        <Reveal>
          <h2
            className="mx-auto max-w-[895px] text-center leading-[1.08] text-[#4B82A5] text-[34px] sm:text-[46px] lg:text-[60px] lg:leading-[65px]"
            style={serifDisplay}
          >
            Available whenever you need it
          </h2>
        </Reveal>

        <Reveal delay={0.12}>
          <div className="mt-9 flex justify-center lg:mt-10">
            <PlatformPill />
          </div>
        </Reveal>

        {/* Footer row — white text directly on the gradient's blue foot. */}
        <div className="mx-auto mt-20 flex w-full max-w-[1440px] flex-col items-center gap-5 pb-9 text-[14px] text-white sm:flex-row sm:justify-between sm:text-[15px] lg:mt-auto lg:px-[26px] lg:pb-[38px] lg:text-[16px]">
          <p className="leading-[28px]">© 2026 Otopair. All rights reserved</p>
          <nav className="flex items-center gap-8 sm:gap-10 lg:gap-[46px]">
            {FOOTER_LINKS.map(({ href, label }) => (
              <Link
                key={href}
                href={href}
                className="leading-[28px] transition-opacity hover:opacity-70"
              >
                {label}
              </Link>
            ))}
          </nav>
        </div>
      </div>
    </footer>
  );
}
