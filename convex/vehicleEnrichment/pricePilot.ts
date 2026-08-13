/**
 * vehicleEnrichment/pricePilot.ts — TEMPORARY price-probe for validation.
 *
 * Fetches a real parts page and runs the deterministic parser against it, while
 * ALSO surfacing the raw "trap" values (every JSON-LD price, the MSRP, the
 * "You Save" figure) so we can see that the parser returns the REAL price and
 * not the savings number that the old markdown path was grabbing.
 *
 * Throwaway — delete after the parts-pricing validation is signed off.
 *
 *   npx convex run vehicleEnrichment/pricePilot:probe '{"urls":["https://..."]}'
 */

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { parsePartPrices } from "./priceParser";
import { fetchUrlWithHtml } from "./firecrawl";

export const probe = internalAction({
  args: { urls: v.array(v.string()) },
  handler: async (_ctx, args) => {
    const out: any[] = [];
    for (const url of args.urls) {
      try {
        // Use the REAL pipeline fetch path: Firecrawl rawHtml primary (handles
        // anti-bot), so anti-bot sites (oempartsonline, rmeuropean) work too.
        const { html } = await fetchUrlWithHtml(url);
        const parsed = html ? parsePartPrices(html, url) : [];
        const jsonLdPrices = html
          ? [...html.matchAll(/"(?:price|lowPrice)"\s*:\s*"?([\d.]+)"?/gi)]
              .map((m) => parseFloat(m[1]))
              .filter((n) => n > 0)
              .slice(0, 10)
          : [];
        out.push({
          url,
          htmlLength: html?.length ?? 0,
          parsed: parsed.map((p) => ({ oem: p.oem_part_number, price: p.price, domain: p.source_domain })),
          jsonLdPrices,
        });
      } catch (e) {
        out.push({ url, error: String(e) });
      }
    }
    return out;
  },
});
