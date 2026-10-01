"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { motion, useDragControls } from "motion/react";

import { useIsCompact } from "@/lib/use-media-query";

interface ScheduleSidePanelProps {
  open: boolean;
  onClose: () => void;
  children?: ReactNode;
}

/**
 * One stable tree that CSS presents as either a desktop side panel or a compact
 * bottom sheet. Keeping the children under the same parents prevents form state
 * from being discarded when the viewport crosses the xl breakpoint.
 */
export function ScheduleSidePanel({ open, onClose, children }: ScheduleSidePanelProps) {
  const compact = useIsCompact();
  const dragControls = useDragControls();
  const pressStartedOnBackdrop = useRef(false);

  useEffect(() => {
    if (!open || !compact) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [compact, open]);

  useEffect(() => {
    if (!open || !compact) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [compact, onClose, open]);

  return (
    <div
      className={`max-xl:fixed max-xl:inset-0 max-xl:z-[55] xl:relative xl:flex-shrink-0 xl:overflow-hidden xl:transition-[width] xl:duration-200 xl:ease-out ${
        open ? "max-xl:pointer-events-auto xl:w-[552px]" : "max-xl:pointer-events-none xl:w-0"
      }`}
    >
      <div
        className={`absolute inset-0 bg-black/40 transition-opacity xl:hidden ${open ? "opacity-100" : "opacity-0"}`}
        onPointerDown={() => {
          pressStartedOnBackdrop.current = true;
        }}
        onClick={() => {
          if (pressStartedOnBackdrop.current) onClose();
          pressStartedOnBackdrop.current = false;
        }}
      />

      <motion.div
        role={compact ? "dialog" : undefined}
        aria-modal={compact ? true : undefined}
        className="schedule-scope flex flex-col overflow-hidden bg-card max-xl:absolute max-xl:inset-x-0 max-xl:bottom-0 max-xl:h-[92dvh] max-xl:rounded-t-2xl max-xl:border-t max-xl:border-border max-xl:shadow-2xl xl:ml-6 xl:h-[calc(100dvh-124px)] xl:min-h-[500px] xl:w-[528px] xl:rounded-2xl xl:border xl:border-border"
        style={compact ? { paddingBottom: "env(safe-area-inset-bottom)" } : undefined}
        initial={compact ? { y: "100%" } : false}
        animate={{ y: open ? 0 : compact ? "100%" : 0 }}
        transition={{ type: "spring", damping: 34, stiffness: 340 }}
        drag={compact ? "y" : false}
        dragControls={dragControls}
        dragListener={false}
        dragConstraints={{ top: 0, bottom: 0 }}
        dragElastic={{ top: 0, bottom: 0.4 }}
        onDragEnd={(_, info) => {
          if (info.offset.y > 120 || info.velocity.y > 500) onClose();
        }}
      >
        <div
          className="hidden shrink-0 cursor-grab touch-none select-none justify-center pb-1 pt-2.5 active:cursor-grabbing max-xl:flex"
          onPointerDown={(event) => dragControls.start(event)}
        >
          <div className="h-1.5 w-10 rounded-full bg-border" />
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      </motion.div>
    </div>
  );
}

