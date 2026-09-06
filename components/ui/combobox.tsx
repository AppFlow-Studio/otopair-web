"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Loader2, Plus } from "lucide-react";
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
  /**
   * When set (and `allowCustomValue` is on), a persistent, non-selectable footer
   * row is shown at the bottom of the open menu — an explicit "Other" cue so
   * users realize they can type a value not in the list (e.g. a part brand they
   * source externally). Purely discoverability; typing already works regardless.
   */
  customHint?: string;
  /**
   * Opt into explicit-add mode (mirrors the "Add custom service" flow). When set,
   * a typed value is NOT auto-committed on keystroke, Enter, or click-away — the
   * mechanic must click an explicit "Add … as custom" row, which calls this with
   * the trimmed text. Use this (instead of relying on `allowCustomValue`) when the
   * custom value should be a deliberate, persisted choice.
   */
  onAddCustom?: (value: string) => void;
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
  customHint,
  onAddCustom,
}: ComboboxProps) {
  // Explicit-add mode: no silent commits — the mechanic taps an "Add …" row.
  const explicitAdd = !!onAddCustom;
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
        if (!explicitAdd && allowCustomValue && query !== value) {
          onChange(query);
        } else if (explicitAdd || !allowCustomValue) {
          // Discard un-added text — a custom value only sticks via the Add row.
          setQuery(selectedLabel);
        }
      }
    }
    document.addEventListener("mousedown", onClickAway);
    return () => document.removeEventListener("mousedown", onClickAway);
  }, [open, query, value, selectedLabel, onChange, allowCustomValue, explicitAdd]);

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
      } else if (allowCustomValue && !explicitAdd) {
        onChange(query);
        setOpen(false);
      }
      // explicitAdd: a bare Enter never saves a custom value — the mechanic must
      // click the "Add … as custom" row (mirrors the custom-service Add button).
    } else if (e.key === "Escape") {
      setOpen(false);
      setQuery(selectedLabel);
    }
  }

  const trimmedQuery = query.trim();
  const queryMatchesOption =
    trimmedQuery !== "" &&
    options.some(
      (o) =>
        o.label.toLowerCase() === trimmedQuery.toLowerCase() ||
        o.value.toLowerCase() === trimmedQuery.toLowerCase(),
    );
  // In explicit-add mode, offer an "Add …" row once the typed text is non-empty
  // and isn't already an existing option (real or previously-saved custom).
  const showAddRow = explicitAdd && trimmedQuery !== "" && !queryMatchesOption;

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
            if (allowCustomValue && !explicitAdd) onChange(e.target.value);
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
          {filtered.length === 0 && !showAddRow ? (
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
          {showAddRow ? (
            <li
              role="option"
              aria-selected={false}
              onMouseDown={(e) => {
                e.preventDefault();
                onAddCustom?.(trimmedQuery);
                setQuery(trimmedQuery);
                setOpen(false);
                inputRef.current?.blur();
              }}
              className="mt-0.5 flex items-center gap-1.5 rounded border-t border-border px-3 py-2 font-medium text-primary cursor-pointer hover:bg-accent hover:text-accent-foreground"
            >
              <Plus className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">Add &ldquo;{trimmedQuery}&rdquo; as custom</span>
            </li>
          ) : null}
          {customHint && allowCustomValue ? (
            <li
              role="presentation"
              className="mt-1 border-t border-border px-3 pb-0.5 pt-2 text-[11px] italic text-muted-foreground"
            >
              {customHint}
            </li>
          ) : null}
        </ul>,
        document.body
      )}
    </div>
  );
}
