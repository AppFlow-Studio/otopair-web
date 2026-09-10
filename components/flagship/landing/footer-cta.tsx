"use client";

import Link from "next/link";
import { APP_STORE_URL, PLAY_STORE_URL, storeIsLive, usePlatform } from "../download-app";
import { Reveal, serif, serifDisplay } from "./reveal";
import PlatformPill from "./platform-pill";
import {
  LEGAL_NAME,
  LOCALITY,
  PHONE_E164,
  POSTAL_ADDRESS,
  SITE_NAME,
  SUPPORT_EMAIL,
  formatPhone,
} from "@/lib/site";

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
export default function FooterCta({
  title = "Available whenever you need it",
  action,
  anchorId = "get-oto",
  className = "mt-[92px] tab:mt-36",
}: {
  /** Closing line. The home page keeps the default; shop-facing pages pass
   *  their own so the band, NAP block and links stay one component. */
  title?: string;
  /** Replaces the store pill + caption (e.g. the partner page's Apply CTA). */
  action?: React.ReactNode;
  anchorId?: string;
  /** Outer top margin. The home page keeps the Figma run-in; the page shell
   *  passes a shorter one because its pages end on a rule, not a section. */
  className?: string;
} = {}) {
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
    <footer className={`w-full ${className}`}>
      {/* id="get-oto" — the PillNav CTA and hero store buttons anchor here. */}
      <div
        id={anchorId}
        className="relative flex w-full flex-col overflow-hidden bg-[linear-gradient(to_bottom,#FFFFFF_0%,#95C7E7_94%)] px-[27px] pt-[56px] tab:bg-[linear-gradient(to_bottom,#FFFFFF_0%,#95C7E7_100%)] tab:px-10 tab:pt-24 lg:min-h-[432px] lg:pt-[110px]"
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
            className="mx-auto max-w-[895px] text-center leading-[28px] text-[#4B82A5] [--fs:min(24px,calc((100vw-54px)/13.7))] [--fsa:none] [--fw:500] tab:leading-[1.08] tab:[--fs:46px] tab:[--fsa:cap-height_0.72] tab:[--fw:250] lg:leading-[65px] lg:[--fs:60px]"
            style={{
              ...serifDisplay,
              fontSize: "var(--fs)",
              fontWeight: "var(--fw)",
              fontSizeAdjust: "var(--fsa)",
            }}
          >
            {title}
          </h2>
        </Reveal>

        <Reveal delay={0.12}>
          {/* Content-sized below sm with an even rhythm — title → 32 → pill →
              12 → caption → 40 → links → 12 → rule → 8 → copyright → 24. The
              frame's literal offsets (+122 / +242) left the caption hugging the
              pill under a 59px hole (design feedback 2026-09-03). */}
          <div className="mt-[32px] flex flex-col items-center gap-[12px] tab:mt-9 tab:gap-3 lg:mt-10">
            {action ?? (
              <>
                <PlatformPill size="sm" className="tab:hidden" />
                <PlatformPill className="max-tab:hidden" />
                {comingSoon && (
                  <p className="text-[13px] tracking-[0.04em] text-[#4B82A5] max-tab:text-[11px] max-tab:leading-[16px]">
                    {comingSoon}
                  </p>
                )}
              </>
            )}
          </div>
        </Reveal>

        {/* NAP line — Name / Address / Phone, the local-SEO identity Google
            keys the entity to (site audit 2026-08-31, Phase 1). Every value
            comes from lib/site.ts so it can never disagree with the schema
            or the business listings. Sits above the links row as a quiet
            white/85 line; the street and phone appear only once they're
            real (POSTAL_ADDRESS / PHONE_E164 are null until then). */}
        <address className="mx-auto mt-[40px] flex w-full max-w-[1440px] flex-col items-center text-center text-[12px] not-italic leading-[20px] text-white/85 tab:mt-16 tab:text-[14px] tab:leading-[24px] lg:px-[26px]">
          <p>
            <span style={serif}>{SITE_NAME}</span>
            <span aria-hidden> · </span>
            <span>{LEGAL_NAME}</span>
          </p>
          <p>
            {POSTAL_ADDRESS
              ? `${POSTAL_ADDRESS.streetAddress}, ${POSTAL_ADDRESS.addressLocality}, ${POSTAL_ADDRESS.addressRegion} ${POSTAL_ADDRESS.postalCode}`
              : `${LOCALITY.city}, ${LOCALITY.region}`}
            {PHONE_E164 && (
              <>
                <span aria-hidden> · </span>
                <a href={`tel:${PHONE_E164}`} className="transition-opacity hover:opacity-70">
                  {formatPhone(PHONE_E164)}
                </a>
              </>
            )}
            <span aria-hidden> · </span>
            <a href={`mailto:${SUPPORT_EMAIL}`} className="transition-opacity hover:opacity-70">
              {SUPPORT_EMAIL}
            </a>
          </p>
        </address>

        {/* Footer row — white text directly on the gradient's blue foot. Below
            sm it stacks links → hairline → copyright; from sm up it is the
            single copyright | links row. */}
        <div className="mx-auto flex w-full max-w-[1440px] flex-col items-center pb-[24px] text-[14px] text-white max-tab:mt-[16px] tab:mt-6 tab:flex-row tab:justify-between tab:gap-5 tab:pb-9 tab:text-[15px] lg:mt-6 lg:px-[26px] lg:pb-[38px] lg:text-[16px]">
          <p className="leading-[28px] max-tab:order-3 max-tab:mt-[8px] max-tab:text-[11px]">
            © 2026 {LEGAL_NAME} All rights reserved
          </p>
          <span aria-hidden className="order-2 mt-3 h-px w-full bg-white/50 tab:hidden" />
          <nav className="flex items-center gap-8 max-tab:order-1 max-tab:grid max-tab:w-full max-tab:grid-cols-3 max-tab:gap-0 tab:gap-10 lg:gap-[46px]">
            {FOOTER_LINKS.map(({ href, label }) => (
              <Link
                key={href}
                href={href}
                className="leading-[28px] transition-opacity hover:opacity-70 max-tab:text-center"
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
