"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

const SECTIONS = [
  {
    title: "Jobs table",
    rows: [
      { label: "Navigate up", keys: ["↑"] },
      { label: "Navigate down", keys: ["↓"] },
      { label: "Open / close job details", keys: ["Enter"] },
      { label: "Close job details", keys: ["Esc"] },
    ],
  },
  {
    title: "Job details",
    rows: [
      { label: "Accept  /  Mark completed", keys: ["A"] },
      { label: "Decline", keys: ["D"] },
      { label: "Cancel job", keys: ["C"] },
    ],
  },
  {
    title: "Decline dialog",
    rows: [
      { label: "Navigate reasons", keys: ["↑", "↓"] },
      { label: "Confirm decline", keys: ["D", "Enter"] },
      { label: "Cancel", keys: ["C"] },
      { label: "Unfocus text box", keys: ["Enter", "Esc"] },
    ],
  },
];

// Flat list of all rows for arrow-key navigation
const ALL_ROWS = SECTIONS.flatMap((s) => s.rows);

interface Props {
  open: boolean;
  onClose: () => void;
}

export function KeyboardShortcutsModal({ open, onClose }: Props) {
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);

  // Reset focus when modal opens
  useEffect(() => {
    if (open) setFocusedIndex(-1);
  }, [open]);

  // Keyboard handler
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") { onClose(); return; }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFocusedIndex((i) => Math.min(i + 1, ALL_ROWS.length - 1));
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setFocusedIndex((i) => Math.max(i - 1, 0));
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  let rowIndex = 0;

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/20 backdrop-blur-sm"
        onClick={onClose}
      />
      <div
        ref={containerRef}
        className="relative bg-card border border-border rounded-xl shadow-xl w-full max-w-sm overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-sm font-semibold text-foreground">Keyboard shortcuts</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Sections */}
        <div className="py-2">
          {SECTIONS.map((section) => (
            <div key={section.title}>
              <p className="px-5 pt-3 pb-1 text-xs font-medium text-muted-foreground">
                {section.title}
              </p>
              {section.rows.map((row) => {
                const idx = rowIndex++;
                const isFocused = focusedIndex === idx;
                return (
                  <div
                    key={row.label}
                    className={`flex items-center justify-between px-5 py-2 text-sm transition-colors ${
                      isFocused ? "bg-muted" : ""
                    }`}
                  >
                    <span className="text-foreground">{row.label}</span>
                    <div className="flex items-center gap-1">
                      {row.keys.map((key, i) => (
                        <span key={key} className="flex items-center gap-1">
                          {i > 0 && (
                            <span className="text-muted-foreground text-xs">or</span>
                          )}
                          <kbd className="inline-flex items-center justify-center min-w-[1.75rem] h-6 px-1.5 text-xs font-mono font-medium text-foreground bg-muted border border-border rounded">
                            {key}
                          </kbd>
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
