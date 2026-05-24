"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Sparkles } from "lucide-react";
import type { LiveAlert } from "./notifications/use-live-alerts";

const ACCENT_DOT: Record<LiveAlert["accent"], string> = {
  emerald: "bg-emerald-500",
  yellow: "bg-yellow-500",
  orange: "bg-orange-500",
  cyan: "bg-cyan-500",
  red: "bg-red-500",
  amber: "bg-amber-500",
};

const CYCLE_MS = 4000;

interface DynamicAlertIslandProps {
  alerts: LiveAlert[];
  onClick: () => void;
}

export default function DynamicAlertIsland({
  alerts,
  onClick,
}: DynamicAlertIslandProps) {
  const [index, setIndex] = useState(0);
  const [hovered, setHovered] = useState(false);
  const reducedMotion = useReducedMotion();

  // Reset index when list shrinks below current index
  useEffect(() => {
    if (index >= alerts.length && alerts.length > 0) setIndex(0);
  }, [alerts.length, index]);

  useEffect(() => {
    if (alerts.length <= 1) return;
    if (hovered) return;
    if (reducedMotion) return;
    const timer = setInterval(() => {
      setIndex((i) => (i + 1) % alerts.length);
    }, CYCLE_MS);
    return () => clearInterval(timer);
  }, [alerts.length, hovered, reducedMotion]);

  if (alerts.length === 0) return null;

  const current = alerts[Math.min(index, alerts.length - 1)];

  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="group relative flex items-center gap-2 overflow-hidden rounded-full border border-gray-200 bg-white px-3 py-1 text-xs font-medium text-gray-700 shadow-sm transition-colors hover:bg-gray-50"
      aria-label={`${alerts.length} live alert${alerts.length === 1 ? "" : "s"}: ${current.summary}`}
    >
      <span className="relative flex h-2 w-2 shrink-0 items-center justify-center">
        <span
          className={`absolute inline-flex h-full w-full animate-ping rounded-full ${ACCENT_DOT[current.accent]} opacity-50`}
        />
        <span
          className={`relative inline-flex h-2 w-2 rounded-full ${ACCENT_DOT[current.accent]}`}
        />
      </span>
      <div className="relative h-4 min-w-[140px] max-w-[260px] overflow-hidden">
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={current.id}
            initial={reducedMotion ? false : { y: 12, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={reducedMotion ? undefined : { y: -12, opacity: 0 }}
            transition={{ duration: 0.25, ease: "easeOut" }}
            className="absolute inset-0 truncate text-left leading-4"
          >
            {current.summary}
          </motion.span>
        </AnimatePresence>
      </div>
      {alerts.length > 1 && (
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold text-gray-600">
          <Sparkles className="h-2.5 w-2.5" />
          {index + 1}/{alerts.length}
        </span>
      )}
    </button>
  );
}
