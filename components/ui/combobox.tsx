"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

const MENU_MAX_HEIGHT = 256; // matches max-h-64
const MENU_GAP = 4;

type MenuPosition = {
  left: number;
  width: number;
  /** Set when the menu opens downward (anchored to input bottom). */
  top?: number;
  /** Set when the menu opens upward (anchored to input top). */
  bottom?: number;
  maxHeight: number;
};

export interface ComboboxOption {
  value: string;
  label: string;
}

interface ComboboxProps {
  id?: string;
  ariaLabel?: string;
  ariaInvalid?: boolean;
  value: string;
  onChange: (value: string) => void;
  options: ComboboxOption[];
  placeholder?: string;
  disabled?: boolean;
  loading?: boolean;
  className?: string;
  inputClassName?: string;
  emptyText?: string;
  allowCustomValue?: boolean;
}

export function Combobox({
  id,
  ariaLabel,
  ariaInvalid,
  value,
  onChange,
  options,
  placeholder,
  disabled,
  loading,
  className,
  inputClassName,
  emptyText = "No matches",
  allowCustomValue = true,
}: ComboboxProps) {
  const selectedLabel =
    options.find((option) => option.value === value)?.label ?? value;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(selectedLabel);
  const [activeIndex, setActiveIndex] = useState(0);
  const [menuPos, setMenuPos] = useState<MenuPosition | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listboxId = useId();

  useEffect(() => {
    setQuery(selectedLabel);
  }, [selectedLabel]);

  // The menu renders in a portal on document.body to escape ancestor
  // `overflow` clipping (collapsible section cards, scrollable drawer body).
  // Position it with fixed coords derived from the input, flipping above when
  // there isn't room below.
  const updateMenuPosition = useCallback(() => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    const openUp = spaceBelow < MENU_MAX_HEIGHT && spaceAbove > spaceBelow;
    setMenuPos({
      left: rect.left,
      width: rect.width,
      ...(openUp
        ? {
            bottom: window.innerHeight - rect.top + MENU_GAP,
            maxHeight: Math.min(MENU_MAX_HEIGHT, spaceAbove - MENU_GAP * 2),
          }
        : {
            top: rect.bottom + MENU_GAP,
            maxHeight: Math.min(MENU_MAX_HEIGHT, spaceBelow - MENU_GAP * 2),
          }),
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    updateMenuPosition();
    // Keep the menu glued to the input while any ancestor scrolls/resizes
    // (capture=true catches scrolls on the inner drawer body, not just window).
    const onReposition = () => updateMenuPosition();
    window.addEventListener("scroll", onReposition, true);
    window.addEventListener("resize", onReposition);
    return () => {
      window.removeEventListener("scroll", onReposition, true);
      window.removeEventListener("resize", onReposition);
    };
  }, [open, updateMenuPosition]);

  useEffect(() => {
    if (!open) return;
    function onClickAway(e: MouseEvent) {
      const target = e.target as Node;
      if (
        !containerRef.current?.contains(target) &&
        !listRef.current?.contains(target)
      ) {
        setOpen(false);
        if (allowCustomValue && query !== value) {
          onChange(query);
        } else if (!allowCustomValue) {
          setQuery(selectedLabel);
        }
      }
    }
    document.addEventListener("mousedown", onClickAway);
    return () => document.removeEventListener("mousedown", onClickAway);
  }, [open, query, value, selectedLabel, onChange, allowCustomValue]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || query === selectedLabel) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [query, options, selectedLabel]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, open]);

  function commit(option: ComboboxOption) {
    onChange(option.value);
    setQuery(option.label);
    setOpen(false);
    inputRef.current?.blur();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActiveIndex((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const opt = filtered[activeIndex];
      if (opt) {
        commit(opt);
      } else if (allowCustomValue) {
        onChange(query);
        setOpen(false);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
      setQuery(selectedLabel);
    }
  }

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      <div className="relative">
        <input
          id={id}
          ref={inputRef}
          type="text"
          role="combobox"
          aria-label={ariaLabel}
          aria-invalid={ariaInvalid}
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          value={query}
          placeholder={placeholder}
          disabled={disabled}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            if (allowCustomValue) onChange(e.target.value);
          }}
          onKeyDown={handleKeyDown}
          className={cn(
            "w-full pr-9 disabled:cursor-not-allowed disabled:opacity-50",
            inputClassName
          )}
        />
        <button
          type="button"
          aria-label={`${open ? "Close" : "Open"} ${ariaLabel ?? "combobox"} options`}
          aria-controls={listboxId}
          aria-expanded={open}
          disabled={disabled}
          onClick={() => {
            const nextOpen = !open;
            setOpen(nextOpen);
            if (nextOpen) inputRef.current?.focus();
          }}
          className="absolute inset-y-0 right-0 flex w-9 cursor-pointer items-center justify-center gap-1 rounded-r-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 disabled:cursor-not-allowed"
        >
          {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          <ChevronDown className="w-4 h-4 opacity-60" />
        </button>
      </div>

      {open && !disabled && menuPos && typeof document !== "undefined" &&
        createPortal(
        <ul
          ref={listRef}
          id={listboxId}
          role="listbox"
          style={{
            position: "fixed",
            left: menuPos.left,
            width: menuPos.width,
            top: menuPos.top,
            bottom: menuPos.bottom,
            maxHeight: menuPos.maxHeight,
          }}
          className="z-[100] overflow-auto rounded-md border border-border bg-popover shadow-lg p-1 text-sm"
        >
          {filtered.length === 0 ? (
            <li className="px-3 py-2 text-muted-foreground">
              {loading ? "Loading…" : emptyText}
            </li>
          ) : (
            filtered.map((opt, i) => {
              const selected = opt.value === value;
              const active = i === activeIndex;
              return (
                <li
                  key={opt.value}
                  role="option"
                  aria-selected={selected}
                  onMouseEnter={() => setActiveIndex(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    commit(opt);
                  }}
                  className={cn(
                    "flex items-center justify-between px-3 py-1.5 rounded cursor-pointer",
                    active && "bg-accent text-accent-foreground"
                  )}
                >
                  <span>{opt.label}</span>
                  {selected && <Check className="w-3.5 h-3.5" />}
                </li>
              );
            })
          )}
        </ul>,
        document.body
      )}
    </div>
  );
}
