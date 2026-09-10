"use client";

import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { ArrowRight, ArrowUpRight } from "lucide-react";

/**
 * The site's primary control: an ink pill with the trailing icon seated in
 * its own circle (the "button-in-button" pattern), a physical press, and
 * the icon nudging diagonally on hover. One primary per view; the secondary
 * action is an underlined text link, never a second pill.
 *
 * `tone="light"` is the white pill for use on the sky wash or the closing
 * band. `icon="external"` swaps the arrow for the up-right glyph.
 */
type Common = {
  children: ReactNode;
  tone?: "ink" | "light";
  icon?: "arrow" | "external" | "none";
  className?: string;
};

const BASE =
  "group inline-flex h-12 items-center gap-3 rounded-full pl-6 pr-1.5 text-[15px] font-medium tracking-[-0.005em] transition-[transform,box-shadow,background-color] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] active:scale-[0.97] active:duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4B82A5]/50 focus-visible:ring-offset-2";
const TONES = {
  ink: "bg-[#1a1a1a] text-white shadow-[0_10px_30px_-14px_rgba(26,26,26,0.5)] hover:shadow-[0_16px_36px_-14px_rgba(26,26,26,0.55)] hover:-translate-y-px",
  light: "bg-white text-[#1a1a1a] shadow-[0_10px_30px_-14px_rgba(75,130,165,0.45)] hover:shadow-[0_16px_36px_-14px_rgba(75,130,165,0.5)] hover:-translate-y-px",
};
const ORB = {
  ink: "bg-white/12 text-white",
  light: "bg-[#1a1a1a]/[0.06] text-[#1a1a1a]",
};

function Inner({ children, tone = "ink", icon = "arrow" }: Common) {
  const Icon = icon === "external" ? ArrowUpRight : ArrowRight;
  return (
    <>
      <span>{children}</span>
      {icon !== "none" && (
        <span
          className={`flex size-9 items-center justify-center rounded-full transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] group-hover:translate-x-0.5 group-hover:-translate-y-px group-hover:scale-105 ${ORB[tone]}`}
          aria-hidden
        >
          <Icon className="size-4" strokeWidth={1.75} />
        </span>
      )}
    </>
  );
}

export function PillLink({ href, children, tone = "ink", icon = "arrow", className = "", ...rest }: Common & Omit<ComponentProps<typeof Link>, "children" | "className">) {
  const cls = `${BASE} ${TONES[tone]} ${icon === "none" ? "pr-6" : ""} ${className}`;
  return (
    <Link href={href} className={cls} {...rest}>
      <Inner tone={tone} icon={icon}>
        {children}
      </Inner>
    </Link>
  );
}

export function PillAnchor({ href, children, tone = "ink", icon = "arrow", className = "", ...rest }: Common & Omit<ComponentProps<"a">, "children" | "className">) {
  const cls = `${BASE} ${TONES[tone]} ${icon === "none" ? "pr-6" : ""} ${className}`;
  return (
    <a href={href} className={cls} {...rest}>
      <Inner tone={tone} icon={icon}>
        {children}
      </Inner>
    </a>
  );
}

export function PillButton({ children, tone = "ink", icon = "arrow", className = "", ...rest }: Common & Omit<ComponentProps<"button">, "children" | "className">) {
  const cls = `${BASE} ${TONES[tone]} ${icon === "none" ? "pr-6" : ""} disabled:opacity-60 disabled:hover:translate-y-0 ${className}`;
  return (
    <button className={cls} {...rest}>
      <Inner tone={tone} icon={icon}>
        {children}
      </Inner>
    </button>
  );
}

/** The quiet secondary action that pairs with a pill. */
export function TextLink({ href, children, className = "" }: { href: string; children: ReactNode; className?: string }) {
  return (
    <Link
      href={href}
      className={`inline-flex items-center gap-1.5 text-[15px] text-[#1a1a1a] underline decoration-[#1a1a1a]/25 underline-offset-[5px] transition-colors duration-300 hover:decoration-[#1a1a1a] focus-visible:outline-none focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-[#4B82A5]/50 ${className}`}
    >
      {children}
    </Link>
  );
}
