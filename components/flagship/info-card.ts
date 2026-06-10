/**
 * Generic agent-driven "info card" — data contract + validation.
 *
 * The 14 show_demo cards are hand-built for known topics. The info card is the
 * long-tail fallback: the agent supplies the content (from its knowledge base)
 * and the frontend owns layout, styling, animation, and — critically —
 * validation. The schema is FLAT on purpose; voice models fill flat schemas far
 * more reliably than nested ones.
 *
 * This module is intentionally React-free so the validation can be unit-tested
 * (and imported by the .ts agent hook) without pulling in the DOM.
 */

export const INFO_LAYOUTS = ["list", "rows", "stats", "steps", "compare"] as const;
export type InfoLayout = (typeof INFO_LAYOUTS)[number];

export type InfoCardPayload = {
  title: string;
  summary?: string;
  layout: InfoLayout;
  items?: string[];
  rows?: { label: string; value: string }[];
  stats?: { value: string; label: string }[];
  pros?: string[];
  cons?: string[];
  footnote?: string;
};

/** Coerce to a single-line, length-capped string (empty if not a string). */
const str = (v: unknown, max: number): string =>
  typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";

/** Coerce to a capped array of non-empty short strings, or undefined. */
const strList = (v: unknown, cap: number, max: number): string[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const out = v.map((x) => str(x, max)).filter(Boolean).slice(0, cap);
  return out.length ? out : undefined;
};

/**
 * Validate + clamp a raw agent payload into a safe InfoCardPayload, or null if
 * there's nothing renderable. NEVER trusts the agent: the layout is
 * allowlisted, arrays are capped, strings are length-limited, and any
 * unexpected fields are simply ignored (we only read known keys). All values
 * render as plain text downstream — React escapes them, so there's no injection
 * surface.
 */
export function sanitizeInfoCard(raw: unknown): InfoCardPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const title = str(r.title, 80);
  if (!title) return null;

  const items = strList(r.items, 6, 90);
  const rows = Array.isArray(r.rows)
    ? r.rows
        .map((x) => {
          const o = (x ?? {}) as Record<string, unknown>;
          return { label: str(o.label, 48), value: str(o.value, 48) };
        })
        .filter((o) => o.label || o.value)
        .slice(0, 6)
    : [];
  const stats = Array.isArray(r.stats)
    ? r.stats
        .map((x) => {
          const o = (x ?? {}) as Record<string, unknown>;
          return { value: str(o.value, 16), label: str(o.label, 40) };
        })
        .filter((o) => o.value || o.label)
        .slice(0, 4)
    : [];
  const pros = strList(r.pros, 6, 90);
  const cons = strList(r.cons, 6, 90);

  // Honor the requested layout when its data is present; otherwise fall back to
  // whichever data the agent actually supplied so the card is never empty.
  let layout: InfoLayout = INFO_LAYOUTS.includes(r.layout as InfoLayout)
    ? (r.layout as InfoLayout)
    : "list";
  const hasFor = (l: InfoLayout): boolean =>
    l === "rows"
      ? rows.length > 0
      : l === "stats"
        ? stats.length > 0
        : l === "compare"
          ? Boolean(pros?.length || cons?.length)
          : Boolean(items?.length); // list | steps
  if (!hasFor(layout)) {
    if (items?.length) layout = layout === "steps" ? "steps" : "list";
    else if (rows.length) layout = "rows";
    else if (stats.length) layout = "stats";
    else if (pros?.length || cons?.length) layout = "compare";
  }

  return {
    title,
    summary: str(r.summary, 160) || undefined,
    layout,
    items,
    rows: rows.length ? rows : undefined,
    stats: stats.length ? stats : undefined,
    pros,
    cons,
    footnote: str(r.footnote, 200) || undefined,
  };
}
