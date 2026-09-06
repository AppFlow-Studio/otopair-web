"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useDragControls } from "motion/react";
import { X } from "lucide-react";

interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** Optional title rendered next to the drag handle with a close button. */
  title?: ReactNode;
  /** Extra classes on the scrollable content wrapper (e.g. "schedule-scope"). */
  contentClassName?: string;
  /** Pin the sheet to (nearly) full height — for tall drawers like create-booking. */
  fullHeight?: boolean;
  ariaLabel?: string;
}

/**
 * Mobile / iPad slide-up sheet. Portals to <body>, fades a backdrop, and slides
 * up from the bottom. Drag-to-dismiss is wired to the grab handle / header only
 * (via useDragControls + dragListener={false}) so it never fights the sheet's
 * own inner scroll. Locks body scroll while open and respects the iOS safe area.
 */
export function BottomSheet({
  open,
  onClose,
  children,
  title,
  contentClassName = "",
  fullHeight = false,
  ariaLabel,
}: BottomSheetProps) {
  const dragControls = useDragControls();
  // Guards against the "ghost click": a sheet opened from a pointerup handler
  // (e.g. tapping a booking on the day lane) gets a trailing click that retargets
  // onto the just-mounted backdrop. We only dismiss when the press actually
  // started on the backdrop, so that stray click is ignored.
  const pressStartedOnBackdrop = useRef(false);

  // Lock body scroll while the sheet is open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        // z-[55]: above the page + portal sidebar (z-40/50) but below the app's
        // confirmation dialogs/toasts (z-[60]/z-[70]) the drawers can trigger.
        <div className="fixed inset-0 z-[55] xl:hidden" role="dialog" aria-modal="true" aria-label={ariaLabel}>
          {/* Backdrop */}
          <motion.div
            className="absolute inset-0 bg-black/40"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onPointerDown={() => {
              pressStartedOnBackdrop.current = true;
            }}
            onClick={() => {
              if (pressStartedOnBackdrop.current) onClose();
              pressStartedOnBackdrop.current = false;
            }}
          />

          {/* Sheet */}
          <motion.div
            className={`absolute inset-x-0 bottom-0 flex ${
              fullHeight ? "h-[92dvh]" : "max-h-[92dvh]"
            } flex-col rounded-t-2xl border-t border-border bg-card shadow-2xl`}
            style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", damping: 34, stiffness: 340 }}
            drag="y"
            dragControls={dragControls}
            dragListener={false}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.4 }}
            onDragEnd={(_, info) => {
              if (info.offset.y > 120 || info.velocity.y > 500) onClose();
            }}
          >
            {/* Grab handle + optional header — the only drag surface */}
            <div
              className="shrink-0 cursor-grab touch-none select-none active:cursor-grabbing"
              onPointerDown={(e) => dragControls.start(e)}
            >
              <div className="flex justify-center pt-2.5 pb-1">
                <div className="h-1.5 w-10 rounded-full bg-border" />
              </div>
              {title != null && (
                <div className="flex items-center justify-between px-5 pb-3 pt-1">
                  <div className="text-base font-semibold text-foreground">{title}</div>
                  <button
                    type="button"
                    onClick={onClose}
                    aria-label="Close"
                    className="-mr-1 rounded-lg p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    <X className="h-5 w-5" />
                  </button>
                </div>
              )}
            </div>

            {/* Scrollable content */}
            <div className={`min-h-0 flex-1 overflow-y-auto overscroll-contain ${contentClassName}`}>
              {children}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

export default BottomSheet;
