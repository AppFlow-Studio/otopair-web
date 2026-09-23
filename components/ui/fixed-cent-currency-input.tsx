"use client";

import {
  type ClipboardEvent,
  type FormEvent,
  type InputHTMLAttributes,
  type KeyboardEvent,
} from "react";
import {
  appendFixedCentDigit,
  backspaceFixedCentCurrency,
  fixedCentCurrencyCents,
  formatFixedCentCurrency,
  syncFixedCentCurrencyInput,
} from "@/lib/fixed-cent-currency";

type FixedCentCurrencyInputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type" | "value" | "onChange" | "inputMode"
> & {
  value: string;
  onValueChange: (value: string) => void;
  allowEmpty?: boolean;
  /**
   * Optional hard ceiling (in cents). When set, digits that would push the
   * value over it are ignored (the field becomes un-typable past the cap) and
   * pastes/edits are clamped to it. Omit for no cap.
   */
  maxCents?: number;
};

function placeCurrencyCaretAtEnd(input: HTMLInputElement) {
  requestAnimationFrame(() => {
    const end = input.value.length;
    input.setSelectionRange(end, end);
  });
}

export default function FixedCentCurrencyInput({
  value,
  onValueChange,
  onKeyDown,
  onBeforeInput,
  onPaste,
  onFocus,
  onClick,
  allowEmpty = false,
  maxCents,
  ...props
}: FixedCentCurrencyInputProps) {
  const formatValue = (next: string) =>
    allowEmpty && fixedCentCurrencyCents(next) === 0 ? "" : next;

  const clampToMax = (next: string) => {
    if (maxCents == null) return next;
    return fixedCentCurrencyCents(next) > maxCents
      ? formatFixedCentCurrency(maxCents / 100)
      : next;
  };

  const pushDigit = (digit: string) => {
    const candidate = appendFixedCentDigit(value, digit);
    // Over the cap: ignore the keystroke entirely so the field is un-typable
    // past the ceiling (rather than snapping to the max mid-type).
    if (maxCents != null && fixedCentCurrencyCents(candidate) > maxCents) return;
    onValueChange(formatValue(candidate));
  };

  const popDigit = () => {
    onValueChange(formatValue(backspaceFixedCentCurrency(value)));
  };

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;

    if (/^\d$/.test(event.key)) {
      event.preventDefault();
      pushDigit(event.key);
      placeCurrencyCaretAtEnd(event.currentTarget);
      return;
    }

    if (event.key === "Backspace" || event.key === "Delete") {
      event.preventDefault();
      popDigit();
      placeCurrencyCaretAtEnd(event.currentTarget);
      return;
    }

    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      placeCurrencyCaretAtEnd(event.currentTarget);
      return;
    }

    if (
      event.key === "Tab" ||
      event.key === "Enter" ||
      event.key === "Escape" ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey
    ) {
      return;
    }

    event.preventDefault();
  }

  function handleBeforeInput(event: FormEvent<HTMLInputElement>) {
    onBeforeInput?.(event);
    if (event.defaultPrevented) return;

    const inputEvent = event.nativeEvent as InputEvent;
    if (inputEvent.inputType === "insertText" && inputEvent.data) {
      event.preventDefault();
      if (/^\d$/.test(inputEvent.data)) {
        pushDigit(inputEvent.data);
      }
      placeCurrencyCaretAtEnd(event.currentTarget);
      return;
    }

    if (
      inputEvent.inputType === "deleteContentBackward" ||
      inputEvent.inputType === "deleteContentForward"
    ) {
      event.preventDefault();
      popDigit();
      placeCurrencyCaretAtEnd(event.currentTarget);
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLInputElement>) {
    onPaste?.(event);
    if (event.defaultPrevented) return;

    event.preventDefault();
    const digits = event.clipboardData.getData("text").replace(/\D/g, "");
    const next = digits
      .split("")
      .reduce((currentValue, digit) => appendFixedCentDigit(currentValue, digit), value);
    onValueChange(formatValue(clampToMax(formatFixedCentCurrency(next))));
    placeCurrencyCaretAtEnd(event.currentTarget);
  }

  return (
    <input
      {...props}
      type="text"
      inputMode="numeric"
      value={formatFixedCentCurrency(value, { emptyWhenBlank: allowEmpty })}
      onBeforeInput={handleBeforeInput}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      onChange={(event) =>
        onValueChange(
          formatValue(clampToMax(syncFixedCentCurrencyInput(value, event.target.value))),
        )
      }
      onFocus={(event) => {
        onFocus?.(event);
        if (!event.defaultPrevented) {
          placeCurrencyCaretAtEnd(event.currentTarget);
        }
      }}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) {
          placeCurrencyCaretAtEnd(event.currentTarget);
        }
      }}
    />
  );
}
