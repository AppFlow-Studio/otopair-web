"use client";

import Link from "next/link";
import DownloadApp from "../download-app";
import { Reveal, serif, serifDisplay } from "./reveal";

const FOOTER_LINKS = [
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
  { href: "/contact", label: "Contact" },
] as const;

/**
 * Closing CTA band (blue blob background, white serif headline + platform
 * toggle) followed by a dark footer strip.
 */
export default function FooterCta() {
  return (
    <footer className="mt-28 w-full sm:mt-36">
      {/* ---- CTA band: full-bleed blue blob ---- */}
      {/* id="get-oto" — the PillNav CTA and hero store buttons anchor here. */}
      <div
        id="get-oto"
        className="relative flex w-full flex-col items-center justify-center overflow-hidden px-4 py-24 sm:px-10 lg:min-h-[440px] lg:py-28"
        style={{
          background:
            "radial-gradient(120% 130% at 50% 18%, #86bbf9 0%, #5093f3 52%, #3f82ec 100%)",
        }}
      >
        <Reveal>
          <h2
            className="max-w-[895px] text-center leading-[1.08] text-white text-[34px] sm:text-[46px] lg:text-[58px]"
            style={serifDisplay}
          >
            Available whenever you need it
          </h2>
        </Reveal>

        <Reveal delay={0.12}>
          <div className="mt-9 flex justify-center lg:mt-11">
            <DownloadApp size="lg" tone="light" />
          </div>
        </Reveal>
      </div>

      {/* ---- Dark footer strip ---- */}
      <div className="w-full bg-[#1a1a1a]">
        <div className="mx-auto flex w-full max-w-[1440px] flex-col items-center gap-6 px-6 py-8 text-[16px] text-[#eceae6] sm:px-10 sm:text-[18px] lg:grid lg:grid-cols-3 lg:items-center lg:gap-4 lg:px-[61px] lg:py-[54px] lg:text-[20px]">
          <span className="leading-[28px] lg:justify-self-start" style={serif}>
            Otopair
          </span>

          <p className="text-center leading-[28px]">
            © 2026 Otopair. All rights reserved.
          </p>

          <nav className="flex items-center gap-8 sm:gap-10 lg:justify-self-end lg:gap-[26px]">
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
