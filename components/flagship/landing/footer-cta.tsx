"use client";

import Link from "next/link";
import { APP_STORE_URL, PLAY_STORE_URL, storeIsLive, usePlatform } from "../download-app";
import { Reveal, serifDisplay } from "./reveal";
import PlatformPill from "./platform-pill";

const FOOTER_LINKS = [
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
  { href: "/contact", label: "Contact" },
] as const;

/**
 * Closing CTA band, rebuilt to Figma V2 (node 354:756, 1440x432): a soft
 * white → #95C7E7 vertical gradient carrying everything — steel-blue serif
 * headline, the white iPhone/Android pill, and the footer row (copyright +
 * legal links) sitting directly on the gradient. The old saturated blob and
 * separate dark strip are gone (design feedback 2026-08-24, item 7). The
 * gradient starts at pure white so it continues seamlessly from the white
 * section above it.
 *
 * Below `sm` it follows the mobile frame (node 390:4448, 402x345): the band
 * starts 92px under the last path caption; title Romie Medium 24/28 at +56,
 * the 198x37 pill at +122, the links row Privacy / Terms / Contact as three
 * equal columns at +242, a white/50 hairline across the 348 content width at
 * +286, and the copyright *below* the line at +292 (the reverse of the
 * desktop row's order). The gradient there ends at 94% and the offsets are
 * exact, so the band lands on the frame's 345px. Nothing at ≥sm changes.
 */
export default function FooterCta() {
  // The caption under the pill names only the store the visitor will use
  // (phones show a single half — design feedback 2026-09-03).
  const platform = usePlatform();
  const comingSoon =
    platform === "ios"
      ? !storeIsLive(APP_STORE_URL) && "Coming soon to the App Store"
      : platform === "android"
        ? !storeIsLive(PLAY_STORE_URL) && "Coming soon on Google Play"
        : (!storeIsLive(APP_STORE_URL) || !storeIsLive(PLAY_STORE_URL)) &&
          "Coming soon to the App Store & Google Play";
  return (
    <footer className="mt-[92px] w-full sm:mt-36">
      {/* id="get-oto" — the PillNav CTA and hero store buttons anchor here. */}
      <div
        id="get-oto"
        className="relative flex w-full flex-col overflow-hidden bg-[linear-gradient(to_bottom,#FFFFFF_0%,#95C7E7_94%)] px-[27px] pt-[56px] sm:bg-[linear-gradient(to_bottom,#FFFFFF_0%,#95C7E7_100%)] sm:px-10 sm:pt-24 lg:min-h-[432px] lg:pt-[110px]"
      >
        <Reveal>
          {/* Mobile sets the title in Romie *Medium* 24/28 (Petrona 500) on one
              line, where the desktop frames use the light display cut — size,
              weight and the cap normalisation ride custom properties so one
              element serves both. Below sm the normalisation is off: at matched
              cap height Petrona runs 366px here against Romie's 345, which
              wraps even at the frame's own 348 content width; un-normalised it
              sets 326px and fits the frame's single line from 384px up. Under
              that the size eases down fluidly (23.4px at 375, 22.3px at 360)
              so narrow phones keep the one-line title and the 345px band. */}
          <h2
            className="mx-auto max-w-[895px] text-center leading-[28px] text-[#4B82A5] [--fs:min(24px,calc((100vw-54px)/13.7))] [--fsa:none] [--fw:500] sm:leading-[1.08] sm:[--fs:46px] sm:[--fsa:cap-height_0.72] sm:[--fw:250] lg:leading-[65px] lg:[--fs:60px]"
            style={{
              ...serifDisplay,
              fontSize: "var(--fs)",
              fontWeight: "var(--fw)",
              fontSizeAdjust: "var(--fsa)",
            }}
          >
            Available whenever you need it
          </h2>
        </Reveal>

        <Reveal delay={0.12}>
          {/* Content-sized below sm with an even rhythm — title → 32 → pill →
              12 → caption → 40 → links → 12 → rule → 8 → copyright → 24. The
              frame's literal offsets (+122 / +242) left the caption hugging the
              pill under a 59px hole (design feedback 2026-09-03). */}
          <div className="mt-[32px] flex flex-col items-center gap-[12px] sm:mt-9 sm:gap-3 lg:mt-10">
            <PlatformPill size="sm" className="sm:hidden" />
            <PlatformPill className="max-sm:hidden" />
            {comingSoon && (
              <p className="text-[13px] tracking-[0.04em] text-[#4B82A5] max-sm:text-[11px] max-sm:leading-[16px]">
                {comingSoon}
              </p>
            )}
          </div>
        </Reveal>

        {/* Footer row — white text directly on the gradient's blue foot. Below
            sm it stacks links → hairline → copyright; from sm up it is the
            single copyright | links row. */}
        <div className="mx-auto flex w-full max-w-[1440px] flex-col items-center pb-[24px] text-[14px] text-white max-sm:mt-[40px] sm:mt-20 sm:flex-row sm:justify-between sm:gap-5 sm:pb-9 sm:text-[15px] lg:mt-auto lg:px-[26px] lg:pb-[38px] lg:text-[16px]">
          <p className="leading-[28px] max-sm:order-3 max-sm:mt-[8px] max-sm:text-[11px]">
            © 2026 Otopair. All rights reserved
          </p>
          <span aria-hidden className="order-2 mt-3 h-px w-full bg-white/50 sm:hidden" />
          <nav className="flex items-center gap-8 max-sm:order-1 max-sm:grid max-sm:w-full max-sm:grid-cols-3 max-sm:gap-0 sm:gap-10 lg:gap-[46px]">
            {FOOTER_LINKS.map(({ href, label }) => (
              <Link
                key={href}
                href={href}
                className="leading-[28px] transition-opacity hover:opacity-70 max-sm:text-center"
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
