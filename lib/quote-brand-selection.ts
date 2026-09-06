export const OTHER_QUOTE_BRAND = "__other__";

export function nextQuoteBrandValue(key: string): string {
  return key === "none" ? "" : key;
}

export function isCustomQuoteBrand(value: string, optionValues: readonly string[]): boolean {
  return value === OTHER_QUOTE_BRAND || (!!value && !optionValues.includes(value));
}

export function customQuoteBrandInputValue(value: string): string {
  return value === OTHER_QUOTE_BRAND ? "" : value;
}

export function isQuoteBrandReady(value: string): boolean {
  return value.trim().length > 0 && value !== OTHER_QUOTE_BRAND;
}
