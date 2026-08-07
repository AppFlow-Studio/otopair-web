"use client";

import type { ReactNode } from "react";

/**
 * Lightweight CSS-only tooltip. Appears instantly on hover (and on keyboard
 * focus) with no delay, styled to match the app rather than the native `title`
 * chrome. Wrap the trigger element as its child.
 */
export default function Tooltip({
  content,
  children,
  side = "top",
  align = "end",
  className,
}: {
  content: ReactNode;
  children: ReactNode;
  side?: "top" | "bottom";
  align?: "start" | "center" | "end";
  className?: string;
}) {
  const alignClass =
    align === "start"
      ? "left-0"
      : align === "center"
        ? "left-1/2 -translate-x-1/2"
        : "right-0";

  return (
    <span className={`group/tooltip relative inline-flex ${className ?? ""}`}>
      {children}
      <span
        role="tooltip"
        className={`pointer-events-none absolute z-50 w-64 rounded-lg bg-gray-900 px-3 py-2 text-left text-xs font-normal leading-relaxed text-white opacity-0 shadow-lg transition-opacity duration-100 group-hover/tooltip:opacity-100 group-focus-within/tooltip:opacity-100 ${
          side === "top" ? "bottom-full mb-2" : "top-full mt-2"
        } ${alignClass}`}
      >
        {content}
      </span>
    </span>
  );
}
