"use client";

import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { motion, useMotionValueEvent, useScroll } from "motion/react";
import { UnderlineLink } from "./shared";

type PillLink = { label: string; href: string };
type PillCta = { label: string; href: string };

// motion-wrapped next/link so a route CTA keeps client navigation AND the same
// spring hover the anchor CTA has.
const MotionLink = motion.create(Link);

// Home defaults. The section-anchor labels are Figma V1's verbatim (node
// 302:886); "Partner with us" is the real entry point into the shops funnel and
// routes to the partner page rather than a section.
const HOME_LINKS: PillLink[] = [
  { label: "About", href: "#how-it-works" },
  { label: "Careers", href: "#for-shops" },
  { label: "Services", href: "#coverage" },
  { label: "Partner with us", href: "/partner-with-us" },
];
const HOME_CTA: PillCta = { label: "Get Oto", href: "#get-oto" };

/**
 * Floating glass pill nav — fixed, hides on scroll-down, reveals on scroll-up.
 *
 * Reused across the flagship pages: pass `links`/`cta` to retarget it (the
 * partner page carries its own sections + an "Apply" CTA); defaults render the
 * home nav.
 */
export default function PillNav({
  links = HOME_LINKS,
  cta = HOME_CTA,
}: {
  links?: PillLink[];
  cta?: PillCta;
}) {
  const { scrollY } = useScroll();
  const [hidden, setHidden] = useState(false);

  useMotionValueEvent(scrollY, "change", (y) => {
    const prev = scrollY.getPrevious() ?? 0;
    // Reveal near the top or when scrolling up; hide when scrolling down.
    if (y < 120 || y < prev) setHidden(false);
    else if (y > prev && y > 160) setHidden(true);
  });

  const ctaClass =
    "group relative flex h-9 min-w-[150px] shrink-0 items-center justify-center gap-2 rounded-[40px] border border-[#1a1a1a] bg-[#1a1a1a] px-5 pl-[46px] text-[15px] leading-[22px] text-white shadow-[-5px_10px_20px_rgba(70,127,237,0.17)]";
  const ctaInner = (
    <>
      {/* V1 floats the pin over the button rather than putting it in flow, so
          the label stays centred within the button. */}
      <Image
        src="/logo.png"
        alt=""
        width={21}
        height={21}
        aria-hidden
        className="absolute left-[20px] top-1/2 h-[21px] w-[21px] -translate-y-1/2 object-contain transition-transform duration-300 group-hover:-rotate-6"
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
      animate={{ y: hidden ? -120 : 0, opacity: 1 }}
      transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      className="fixed inset-x-0 top-0 z-50 flex justify-center px-4 pt-4"
    >
      {/* Values are Figma V1's declared layer props (node 302:1212): r100, white
          @ 20%, 0.5px white @ 50% edge, 35px backdrop blur, no shadow on the
          pill. Width relaxes to fit the extra "Partner with us" destination. */}
      <nav
        className="flex h-[69px] w-full max-w-[680px] items-center justify-between gap-4 rounded-[100px] border-[0.5px] border-white/50 bg-white/20 backdrop-blur-[35px]"
        style={{ paddingLeft: 26.5, paddingRight: 17 }}
      >
        <Link href="/" className="flex items-center" aria-label="Otopair home">
          {/* The layout box is V1's true mark size (24x30). logo.png carries
              transparent padding, so the image is scaled to 46px and centred
              inside that box. */}
          <motion.span
            whileHover={{ rotate: -8, scale: 1.08 }}
            transition={{ type: "spring", stiffness: 400, damping: 15 }}
            className="relative block h-[30px] w-[24px] shrink-0"
          >
            <Image
              src="/logo.png"
              alt="Otopair"
              width={46}
              height={46}
              priority
              className="absolute left-1/2 top-1/2 h-[46px] w-[46px] max-w-none -translate-x-1/2 -translate-y-1/2 object-contain"
            />
          </motion.span>
        </Link>

        <ul className="hidden items-center gap-6 sm:flex">
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

        {cta.href.startsWith("#") ? (
          <motion.a href={cta.href} {...ctaMotion} className={ctaClass}>
            {ctaInner}
          </motion.a>
        ) : (
          <MotionLink href={cta.href} {...ctaMotion} className={ctaClass}>
            {ctaInner}
          </MotionLink>
        )}
      </nav>
    </motion.header>
  );
}
