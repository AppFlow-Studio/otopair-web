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

/** Decode a JSON string body (handles \uXXXX, \\, \" …). Falls back to a manual
 *  unescape if the captured fragment isn't a clean JSON string body. */
function decodeJsonString(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return raw
      .replace(/\\u([0-9a-fA-F]{4})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\(.)/g, "$1");
  }
}

/** Extract RepairPal service objects from a repair-services page's HTML.
 *  Anchors on the `emuOperationTaxonomyCategoryId` field that follows each service's
 *  name — categories (followed by `icon`) are NOT matched, avoiding the id collision. */
export function extractServices(html: string): Array<{ service_id: number; service_name: string }> {
  const re = /\\"id\\":(\d+),\\"name\\":\\"((?:[^\\]|\\(?!"))*?)\\",\\"emuOperationTaxonomyCategoryId\\"/g;
  const out: Array<{ service_id: number; service_name: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    out.push({ service_id: Number(m[1]), service_name: decodeJsonString(m[2]) });
  }
  return out;
}

/** Dedupe by a key field, keeping the first occurrence and preserving order. */
export function dedupById<T extends Record<string, any>>(items: T[], idKey: keyof T): T[] {
  const seen = new Map<any, T>();
  for (const it of items) {
    if (!seen.has(it[idKey])) seen.set(it[idKey], it);
  }
  return [...seen.values()];
}
