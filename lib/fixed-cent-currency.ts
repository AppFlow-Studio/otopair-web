function formatCents(cents: number): string {
  return (Math.max(0, cents) / 100).toFixed(2);
}

export function fixedCentCurrencyCents(value: string | number | null | undefined): number {
  if (value == null) return 0;

  const normalized = String(value).replace(/[^\d.]/g, "");
  if (normalized.trim() === "") return 0;

  const amount = Number(normalized);
  if (!Number.isFinite(amount) || amount <= 0) return 0;

  return Math.round(amount * 100);
}

export function formatFixedCentCurrency(value: string | number | null | undefined): string {
  return formatCents(fixedCentCurrencyCents(value));
}

export function appendFixedCentDigit(value: string, digit: string): string {
  if (!/^\d$/.test(digit)) return formatFixedCentCurrency(value);

  return formatCents(fixedCentCurrencyCents(value) * 10 + Number(digit));
}

export function backspaceFixedCentCurrency(value: string): string {
  return formatCents(Math.floor(fixedCentCurrencyCents(value) / 10));
}

export function syncFixedCentCurrencyInput(previousValue: string, rawInputValue: string): string {
  const previousDigits = formatFixedCentCurrency(previousValue).replace(/\D/g, "");
  const nextDigits = rawInputValue.replace(/\D/g, "");

  if (nextDigits.length > previousDigits.length && nextDigits.startsWith(previousDigits)) {
    return nextDigits
      .slice(previousDigits.length)
      .split("")
      .reduce((value, digit) => appendFixedCentDigit(value, digit), previousValue);
  }

  if (nextDigits.length < previousDigits.length && previousDigits.startsWith(nextDigits)) {
    let next = previousValue;
    for (let i = 0; i < previousDigits.length - nextDigits.length; i += 1) {
      next = backspaceFixedCentCurrency(next);
    }
    return next;
  }

  return formatFixedCentCurrency(rawInputValue);
}
