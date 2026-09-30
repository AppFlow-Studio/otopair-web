"use client";

import {
  type ClipboardEvent,
  type FormEvent,
  type InputHTMLAttributes,
  type KeyboardEvent,
} from "react";
import {
  deleteFixedCentDigit,
  fixedCentCurrencyCents,
  formatFixedCentCurrency,
  parsePastedCurrencyCents,
  syncFixedCentCurrencyInput,
  typeFixedCentDigit,
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

/** True when text is selected in the field (select-all, a drag over the
 *  digits) — the next keystroke or paste then REPLACES the value (#419). */
function hasSelection(input: HTMLInputElement): boolean {
  const { selectionStart, selectionEnd } = input;
  return selectionStart != null && selectionEnd != null && selectionStart !== selectionEnd;
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

  const pushDigit = (digit: string, replacesSelection: boolean) => {
    const candidate = typeFixedCentDigit(value, digit, replacesSelection);
    // Over the cap: ignore the keystroke entirely so the field is un-typable
    // past the ceiling (rather than snapping to the max mid-type).
    if (maxCents != null && fixedCentCurrencyCents(candidate) > maxCents) return;
    onValueChange(formatValue(candidate));
  };

  const popDigit = (replacesSelection: boolean) => {
    onValueChange(formatValue(deleteFixedCentDigit(value, replacesSelection)));
  };

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;

    if (/^\d$/.test(event.key)) {
      event.preventDefault();
      pushDigit(event.key, hasSelection(event.currentTarget));
      placeCurrencyCaretAtEnd(event.currentTarget);
      return;
    }

    if (event.key === "Backspace" || event.key === "Delete") {
      event.preventDefault();
      popDigit(hasSelection(event.currentTarget));
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
        pushDigit(inputEvent.data, hasSelection(event.currentTarget));
      }
      placeCurrencyCaretAtEnd(event.currentTarget);
      return;
    }

    if (
      inputEvent.inputType === "deleteContentBackward" ||
      inputEvent.inputType === "deleteContentForward"
    ) {
      event.preventDefault();
      popDigit(hasSelection(event.currentTarget));
      placeCurrencyCaretAtEnd(event.currentTarget);
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLInputElement>) {
    onPaste?.(event);
    if (event.defaultPrevented) return;

    event.preventDefault();
    // A paste is a dollar amount and REPLACES the value — it used to append
    // each pasted digit to the existing cents (20.00 + "99999" → 2,000,999.99,
    // #419). Clamped to the cap like any other edit.
    const cents = parsePastedCurrencyCents(event.clipboardData.getData("text"));
    if (cents != null) {
      onValueChange(formatValue(clampToMax(formatFixedCentCurrency(cents / 100))));
    }
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
