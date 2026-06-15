/**
 * Pure helpers for the RepairPal catalog crawler (tests/repairpal/catalog-crawl.manual.spec.ts).
 * NO fs / NO Playwright imports — kept edge-runtime-safe so Vitest can unit-test them.
 */

/** CSV-escape one value: quote + double-up quotes only when it contains , " CR or LF. */
export function csvEscape(v: string | number): string {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** One CSV record (no trailing newline). */
export function toCsvRow(values: (string | number)[]): string {
  return values.map(csvEscape).join(",");
}

/** Full CSV: header row + data rows + trailing newline. */
export function toCsv(headers: string[], rows: (string | number)[][]): string {
  return [toCsvRow(headers), ...rows.map(toCsvRow)].join("\n") + "\n";
}
