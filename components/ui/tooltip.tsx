"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Lightweight tooltip. Appears instantly on hover (and on keyboard focus).
 *
 * The panel is rendered in a portal on `document.body` with fixed positioning,
 * so it can never be clipped by an ancestor's `overflow-hidden` / scroll
 * container — the reason a plain absolutely-positioned tooltip gets cut off
 * inside cards and scroll areas. Position is measured from the trigger and
 * kept in sync while open (scroll/resize).
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
  const triggerRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);

  const measure = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const gap = 8;
    const top = side === "top" ? r.top - gap : r.bottom + gap;
    const left =
      align === "start" ? r.left : align === "center" ? r.left + r.width / 2 : r.right;
    setCoords({ top, left });
  }, [side, align]);

  const show = useCallback(() => {
    measure();
    setOpen(true);
  }, [measure]);
  const hide = useCallback(() => setOpen(false), []);

  // Keep the panel glued to the trigger while it's open (e.g. scrolling a list).
  useEffect(() => {
    if (!open) return;
    const onMove = () => measure();
    document.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      document.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open, measure]);

  const tx = align === "start" ? "0" : align === "center" ? "-50%" : "-100%";
  const ty = side === "top" ? "-100%" : "0";

  return (
    <span
      ref={triggerRef}
      className={`inline-flex ${className ?? ""}`}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {open && coords && typeof document !== "undefined"
        ? createPortal(
            <span
              role="tooltip"
              style={{
                position: "fixed",
                top: coords.top,
                left: coords.left,
                transform: `translate(${tx}, ${ty})`,
              }}
              className="pointer-events-none z-[100] w-64 rounded-lg bg-gray-900 px-3 py-2 text-left text-xs font-normal leading-relaxed text-white shadow-lg"
            >
              {content}
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}
