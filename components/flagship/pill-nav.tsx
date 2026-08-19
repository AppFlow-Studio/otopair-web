"use client";

import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { motion, useMotionValueEvent, useScroll } from "motion/react";
import { UnderlineLink } from "./shared";

// Labels are Figma V1's verbatim (node 302:886) so the bar matches the design.
// The destinations stay as landing-page section anchors — /about, /careers and
// /services don't exist, and a 404 from the main nav is worse than a loose
// label. Swap the hrefs the day those pages ship.
const LINKS = [
  { label: "About", href: "#how-it-works" },
  { label: "Careers", href: "#for-shops" },
  { label: "Services", href: "#coverage" },
];

/** Floating glass pill nav — fixed, hides on scroll-down, reveals on scroll-up. */
export default function PillNav() {
  const { scrollY } = useScroll();
  const [hidden, setHidden] = useState(false);

  useMotionValueEvent(scrollY, "change", (y) => {
    const prev = scrollY.getPrevious() ?? 0;
    // Reveal near the top or when scrolling up; hide when scrolling down.
    if (y < 120 || y < prev) setHidden(false);
    else if (y > prev && y > 160) setHidden(true);
  });

  return (
    <motion.header
      initial={{ y: -24, opacity: 0 }}
      animate={{ y: hidden ? -120 : 0, opacity: 1 }}
      transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      className="fixed inset-x-0 top-0 z-50 flex justify-center px-4 pt-4"
    >
      {/* Values are Figma V1's declared layer props (node 302:1212), not
          eyeballed: 597x69, r100, white @ 20%, 0.5px white @ 50% edge, 35px
          backdrop blur, and no shadow on the pill itself. */}
      <nav className="flex h-[69px] w-full max-w-[597px] items-center justify-between gap-2 rounded-[100px] border-[0.5px] border-white/50 bg-white/20 backdrop-blur-[35px]" style={{ paddingLeft: 26.5, paddingRight: 17 }}>
        <Link href="/" className="flex items-center" aria-label="Otopair home">
          {/* The layout box is V1's true mark size (24x30). logo.png carries
              transparent padding, so the image itself is scaled to 46px and
              centred inside that box — otherwise the box would eat 22px of
              flex space the design doesn't allow for. */}
          <motion.span
            whileHover={{ rotate: -8, scale: 1.08 }}
            transition={{ type: "spring", stiffness: 400, damping: 15 }}
            className="relative block h-[30px] w-[24px]"
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

        {/* V1 centres each label in a 103px box on 108px centres (node
            302:1214-1216) — so the visible gaps differ per word length. */}
        <ul className="hidden items-center gap-[5px] sm:flex">
          {LINKS.map((l) => (
            <li key={l.label} className="w-[103px] text-center">
              <UnderlineLink
                href={l.href}
                className="text-[15px] leading-[28px] text-[#1a1a1a] transition-colors hover:text-[#1a1a1a]/70"
              >
                {l.label}
              </UnderlineLink>
            </li>
          ))}
        </ul>

        <motion.a
          href="#get-oto"
          whileHover={{ scale: 1.04 }}
          whileTap={{ scale: 0.95 }}
          transition={{ type: "spring", stiffness: 400, damping: 20 }}
          className="group relative flex h-9 w-[159px] items-center justify-center rounded-[40px] border border-[#1a1a1a] bg-[#1a1a1a] text-[15px] leading-[22px] text-white shadow-[-5px_10px_20px_rgba(70,127,237,0.17)]"
        >
          {/* V1 floats the pin over the button rather than putting it in flow,
              so the label stays centred on the full 159px. */}
          <Image
            src="/logo.png"
            alt=""
            width={21}
            height={21}
            aria-hidden
            className="absolute left-[20px] top-1/2 h-[21px] w-[21px] -translate-y-1/2 object-contain transition-transform duration-300 group-hover:-rotate-6"
          />
          Get Oto
        </motion.a>
      </nav>
    </motion.header>
  );
}
