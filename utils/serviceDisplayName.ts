/**
 * Catalog naming: customers see "Drive Belt", never "Timing Belt".
 *
 * Per Yassin (Sept 15): the job we sell under the `timing_belt` slug is a
 * drive-belt job, and the work described is already right — only the name is
 * wrong. Web shipped this on Sept 15; this is the mobile half.
 *
 * WHY A DISPLAY HELPER AND NOT A DATA FIX: the slug is the binding key
 * between the app, the catalog, the parts and labor references and the DB,
 * so it stays `timing_belt`. And the `services` rows themselves still read
 * "Timing Belt" on all three deployments (dev, preview and production —
 * checked), so anything that renders a name straight off a Convex document
 * would still show the old word. Web solved it the same way, with
 * `formatServiceDisplayName` in `lib/service-catalog.ts`.
 *
 * This is a byte-for-byte port of that function. Keep it that way: if the
 * two implementations drift, the same booking reads differently on the web
 * dashboard and in the app.
 *
 * Apply it wherever a service name or description arrives from the server.
 * Names that come from `constants/serviceTaxonomy.ts` are already correct and
 * do not need it.
 */
export function formatServiceDisplayName(name: string | null | undefined): string {
  if (!name) return "";
  return name
    .replace(/\btiming_belt(s?)\b/gi, (_match, plural) => `Drive Belt${plural ? "s" : ""}`)
    .replace(/\btiming belt(s?)\b/gi, (match, plural) => {
      const p = plural ? "s" : "";
      if (match.toLowerCase() === "timing belt" + p) {
        if (match.startsWith("T")) {
          return match.includes("Belt") ? `Drive Belt${p}` : `Drive belt${p}`;
        }
        return `drive belt${p}`;
      }
      return `Drive Belt${p}`;
    });
}

/** `formatServiceDisplayName` for a list, keeping the order. */
export function formatServiceDisplayNames(names: readonly string[] | null | undefined): string[] {
  if (!names) return [];
  return names.map((n) => formatServiceDisplayName(n));
}
