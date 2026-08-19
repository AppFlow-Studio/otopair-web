/**
 * devOnly/rockautoSpecProbe.ts — does a RockAuto listing page carry the rotor
 * DISCARD MINIMUM?
 *
 * summit_centric exists to supply that number and is unreachable: Imperva
 * defeats every tier we have, residential proxy included. But RockAuto lists
 * the same aftermarket brands (Centric/Raybestos/DuraGo), we can already reach
 * it, and the walk is already built. If its spec block carries the discard
 * figure, the rotor gap closes on infrastructure that works today instead of on
 * an anti-bot arms race.
 *
 * Delete after the Aug 2026 validation.
 */
import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { adapterFetch } from "../vehicleEnrichment/sourceAdapters/http";
import { parseRotorThickness } from "../vehicleEnrichment/rotorThickness";
import { parsePositionedListings } from "../vehicleEnrichment/sourceAdapters/rockautoCatalog";

/** Fetch a PART-TYPE page, then inspect the first N listings' spec pages. */
export const fromPartType = internalAction({
  args: { url: v.string(), limit: v.optional(v.float64()) },
  handler: async (ctx, args): Promise<any> => {
    const page = await adapterFetch(args.url, { timeoutMs: 120_000 });
    const listings = parsePositionedListings(page.body);
    const out: any[] = [];
    for (const l of listings.slice(0, Math.max(1, Math.trunc(args.limit ?? 3)))) {
      const r = await adapterFetch(l.moreInfoUrl, { timeoutMs: 60_000 });
      const text = (r.body ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
      out.push({
        brand: l.manufacturer,
        part: l.partNumber,
        chars: (r.body ?? "").length,
        labels: ["Discard Thickness", "Minimum Thickness", "Nominal Thickness", "Thickness"]
          .filter((x) => new RegExp(x, "i").test(text)),
        parsed: parseRotorThickness(text).slice(0, 6).map(
          (x) => `${x.kind}=${x.valueMm}mm "${x.observedLabel}"`,
        ),
        snippet: (text.match(/.{0,60}Thickness.{0,90}/i) ?? [""])[0],
      });
      await new Promise((z) => setTimeout(z, 300));
    }
    return { listingsFound: listings.length, inspected: out };
  },
});

export const specs = internalAction({
  args: { url: v.string() },
  handler: async (ctx, args): Promise<any> => {
    const r = await adapterFetch(args.url, { timeoutMs: 30_000 });
    const body = r.body ?? "";
    const text = body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
    // The spec vocabulary Summit publishes, hunted in RockAuto's own page.
    const labels = [
      "Discard Thickness", "Minimum Thickness", "Nominal Thickness",
      "Thickness", "Discard", "Diameter", "Height", "Width",
    ].filter((l) => new RegExp(l, "i").test(text));
    return {
      status: r.status,
      via: r.via,
      chars: body.length,
      specLabelsPresent: labels,
      // What the REAL parser makes of it — the only answer that matters.
      parsed: parseRotorThickness(text).slice(0, 8).map(
        (x) => `${x.kind}=${x.valueMm}mm "${x.observedLabel}"`,
      ),
      sample: (text.match(/.{0,80}(?:Thickness|Discard).{0,120}/i) ?? [""])[0],
    };
  },
});
