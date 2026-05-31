"use client";

import Link from "next/link";
import Image from "next/image";

const LINKS = [
  { label: "About", href: "/about" },
  { label: "Careers", href: "/careers" },
  { label: "Services", href: "/services" },
];

/** Floating glass pill nav from the flagship Figma. */
export default function PillNav() {
  return (
    <header className="absolute inset-x-0 top-0 z-50 flex justify-center px-4 pt-4">
      <nav className="flex h-[60px] w-full max-w-[600px] items-center justify-between gap-2 rounded-[14px] border border-white/60 bg-white/55 px-4 backdrop-blur-2xl shadow-[0_8px_30px_rgba(0,0,0,0.06)]">
        <Link href="/" className="flex items-center gap-2 pl-1" aria-label="Otopair home">
          <Image
            src="/logo.png"
            alt="Otopair"
            width={30}
            height={30}
            priority
            className="h-[26px] w-[26px] object-contain"
          />
        </Link>

        <ul className="hidden items-center gap-7 sm:flex">
          {LINKS.map((l) => (
            <li key={l.label}>
              <Link
                href={l.href}
                className="text-[15px] text-[#1a1a1a]/85 transition-colors hover:text-[#1a1a1a]"
              >
                {l.label}
              </Link>
            </li>
          ))}
        </ul>

        <Link
          href="#get-oto"
          className="flex h-9 items-center justify-center rounded-lg bg-[#1a1a1a] px-5 text-[15px] font-medium text-white shadow-[-6px_12px_18px_rgba(43,9,120,0.22)] transition-transform hover:scale-[1.02] active:scale-95"
        >
          Get Oto
        </Link>
      </nav>
    </header>
  );
}
