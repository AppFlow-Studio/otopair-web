"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ComboboxOption {
  value: string;
  label: string;
}

interface ComboboxProps {
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
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(value);
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();

  useEffect(() => {
    setQuery(value);
  }, [value]);

  useEffect(() => {
    if (!open) return;
    function onClickAway(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) {
        setOpen(false);
        if (allowCustomValue && query !== value) {
          onChange(query);
        } else if (!allowCustomValue) {
          setQuery(value);
        }
      }
    }
    document.addEventListener("mousedown", onClickAway);
    return () => document.removeEventListener("mousedown", onClickAway);
  }, [open, query, value, onChange, allowCustomValue]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [query, options]);

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
      setQuery(value);
    }
  }

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          role="combobox"
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
        <div className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1 text-muted-foreground">
          {loading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          <ChevronDown className="w-4 h-4 opacity-60" />
        </div>
      </div>

      {open && !disabled && (
        <ul
          id={listboxId}
          role="listbox"
          className="absolute z-50 mt-1 w-full max-h-64 overflow-auto rounded-md border border-border bg-popover shadow-lg p-1 text-sm"
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
        </ul>
      )}
    </div>
  );
}
