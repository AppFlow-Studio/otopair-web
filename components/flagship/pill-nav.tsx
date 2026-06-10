"use client";

import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { motion, useMotionValueEvent, useScroll } from "motion/react";
import { ArrowUpRight } from "lucide-react";
import { UnderlineLink } from "./shared";

const LINKS = [
  { label: "About", href: "/about" },
  { label: "Careers", href: "/careers" },
  { label: "Services", href: "/services" },
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
      <nav className="flex h-[60px] w-full max-w-[600px] items-center justify-between gap-2 rounded-[14px] border border-white/60 bg-white/55 px-4 backdrop-blur-2xl shadow-[0_8px_30px_rgba(0,0,0,0.06)]">
        <Link href="/" className="flex items-center gap-2 pl-1" aria-label="Otopair home">
          <motion.span whileHover={{ rotate: -8, scale: 1.08 }} transition={{ type: "spring", stiffness: 400, damping: 15 }}>
            <Image
              src="/logo.png"
              alt="Otopair"
              width={30}
              height={30}
              priority
              className="h-[26px] w-[26px] object-contain"
            />
          </motion.span>
        </Link>

        <ul className="hidden items-center gap-7 sm:flex">
          {LINKS.map((l) => (
            <li key={l.label}>
              <UnderlineLink
                href={l.href}
                className="text-[15px] text-[#1a1a1a]/85 transition-colors hover:text-[#1a1a1a]"
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
          className="group flex h-9 items-center justify-center gap-1 rounded-lg bg-[#1a1a1a] px-5 text-[15px] font-medium text-white shadow-[-6px_12px_18px_rgba(43,9,120,0.22)]"
        >
          Get Oto
          <ArrowUpRight
            className="h-4 w-4 transition-transform duration-300 group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
            strokeWidth={1.8}
          />
        </motion.a>
      </nav>
    </motion.header>
  );
}
