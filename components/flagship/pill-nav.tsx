"use client";

import Link from "next/link";
import Image from "next/image";
import { motion } from "motion/react";
import { UnderlineLink } from "./shared";

type PillLink = { label: string; href: string };
type PillCta = { label: string; href: string };

// motion-wrapped next/link so a route CTA keeps client navigation AND the same
// spring hover the anchor CTA has.
const MotionLink = motion.create(Link);

// Home defaults. Labels must name the section they land on — V1's verbatim
// About/Careers/Services labels pointed at unrelated anchors ("Careers" landed
// on the shop pitch; site audit 2026-08-31). "Partner with us" is the real
// entry point into the shops funnel and routes to the partner page rather
// than a section.
const HOME_LINKS: PillLink[] = [
  { label: "How it works", href: "#how-it-works" },
  { label: "For shops", href: "#for-shops" },
  { label: "Coverage", href: "#coverage" },
  { label: "Partner with us", href: "/partner-with-us" },
];
const HOME_CTA: PillCta = { label: "Get Oto", href: "#get-oto" };

// Returning shop owners/staff sign in here. `/shop` is role-gated, so middleware
// funnels signed-out visitors through Clerk sign-in first, then into the portal.
const HOME_SHOP_SIGN_IN: PillLink = { label: "Shop sign-in", href: "/shop" };

/**
 * Floating glass pill nav — fixed and always visible (2026-08-31; it used to
 * hide on scroll-down and reveal on scroll-up).
 *
 * Reused across the flagship pages: pass `links`/`cta` to retarget it (the
 * partner page carries its own sections + an "Apply" CTA); defaults render the
 * home nav. `shopSignIn` renders a secondary text link beside the CTA; pass
 * `null` to omit it (e.g. the partner funnel).
 */
export default function PillNav({
  links = HOME_LINKS,
  cta = HOME_CTA,
  shopSignIn = HOME_SHOP_SIGN_IN,
}: {
  links?: PillLink[];
  cta?: PillCta;
  shopSignIn?: PillLink | null;
}) {
  const ctaClass =
    "group relative flex h-9 min-w-[150px] shrink-0 items-center justify-center gap-2 rounded-[40px] border border-[#1a1a1a] bg-[#1a1a1a] px-5 text-[15px] leading-[22px] text-white shadow-[-5px_10px_20px_rgba(70,127,237,0.17)]";
  const ctaInner = (
    <>
      {/* V1 floats the pin over the button rather than putting it in flow, so
          the label stays centred within the button. */}
      {/* pin-logo-3d (500px) over logo.png (200px, soft edges) — the small
          flat export read as a blurry blob at button size (2026-08-30). */}
      <Image
        src="/pin-logo-3d.png"
        alt=""
        width={22}
        height={22}
        aria-hidden
        className="absolute left-[20px] top-1/2 h-[22px] w-[22px] -translate-y-1/2 object-contain transition-transform duration-300 group-hover:-rotate-6"
      />
      {cta.label}
    </>
  );
  const ctaMotion = {
    whileHover: { scale: 1.04 },
    whileTap: { scale: 0.95 },
    transition: { type: "spring", stiffness: 400, damping: 20 },
  } as const;

  return (
    <motion.header
      initial={{ y: -24, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      className="fixed inset-x-0 top-0 z-50 flex justify-center px-4 pt-4"
    >
      {/* Values are Figma V1's declared layer props (node 302:1212): r100, white
          @ 20%, 0.5px white @ 50% edge, 35px backdrop blur, no shadow on the
          pill. The V1 pill holds 3 destinations with wide air between them; we
          carry 5, so the pill widens to 800px and the link gap grows to keep
          V1's breathing room instead of packing 6 items into V1's 680px
          (design feedback 2026-08-30). */}
      <nav
        className="flex h-[69px] w-full max-w-[800px] items-center justify-between gap-4 rounded-[100px] border-[0.5px] border-white/50 bg-white/20 backdrop-blur-[35px]"
        style={{ paddingLeft: 30, paddingRight: 17 }}
      >
        <Link href="/" className="flex items-center" aria-label="Otopair home">
          {/* Layout box sized to the V1 mark's presence in the pill (28x34 —
              the 24x30 box undersold it next to the wider spacing).
              pin-logo-3d.png (500px source — the old 200px logo.png read as a
              blurry blob at this size, 2026-08-30) carries transparent
              padding, so the image is scaled to 48px and centred. */}
          <motion.span
            whileHover={{ rotate: -8, scale: 1.08 }}
            transition={{ type: "spring", stiffness: 400, damping: 15 }}
            className="relative block h-[34px] w-[28px] shrink-0"
          >
            <Image
              src="/pin-logo-3d.png"
              alt="Otopair"
              width={48}
              height={48}
              priority
              className="absolute left-1/2 top-1/2 h-[48px] w-[48px] max-w-none -translate-x-1/2 -translate-y-1/2 object-contain"
            />
          </motion.span>
        </Link>

        <ul className="hidden items-center gap-9 sm:flex">
          {links.map((l) => (
            <li key={l.label} className="whitespace-nowrap">
              <UnderlineLink
                href={l.href}
                className="text-[15px] leading-[28px] text-[#1a1a1a] transition-colors hover:text-[#1a1a1a]/70"
              >
                {l.label}
              </UnderlineLink>
            </li>
          ))}
        </ul>

        <div className="flex items-center gap-4">
          {shopSignIn && (
            /* Hide via a wrapper: UnderlineLink's base class ends in
               `inline-block`, which ties with `hidden` at equal specificity
               and wins on stylesheet order — so the link itself can't be
               responsive-hidden reliably (audit P2, 2026-08-30). */
            <span className="hidden sm:block">
              <UnderlineLink
                href={shopSignIn.href}
                className="whitespace-nowrap text-[15px] leading-[28px] text-[#1a1a1a] transition-colors hover:text-[#1a1a1a]/70"
              >
                {shopSignIn.label}
              </UnderlineLink>
            </span>
          )}
          {cta.href.startsWith("#") ? (
            <motion.a href={cta.href} {...ctaMotion} className={ctaClass}>
              {ctaInner}
            </motion.a>
          ) : (
            <MotionLink href={cta.href} {...ctaMotion} className={ctaClass}>
              {ctaInner}
            </MotionLink>
          )}
        </div>
      </nav>
    </motion.header>
  );
}
