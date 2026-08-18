/**
 * devOnly/storePlatformProbe.ts — what PLATFORM is a candidate storefront on?
 *
 * The registry is 36/36 RevolutionParts (makeCoverage.auditOperatorDiversity,
 * severity `alarm`). The obvious fix — "add another OEM parts store" — mostly
 * does not work, because most of them are RP SKINS: a dealer group's brand on
 * the same backend, sharing the same catalogue and therefore the same gaps.
 * Adding one would look like diversity and buy none.
 *
 * `resolveOperator` can only know the domains someone has already mapped, so it
 * cannot answer this for a NEW candidate. This can: it fetches the store and
 * reads the platform's fingerprints out of the page itself.
 *
 * Delete after the Aug 2026 validation.
 */
import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { adapterFetch, looksBlockedBody } from "../vehicleEnrichment/sourceAdapters/http";
import { parsePartPrices } from "../vehicleEnrichment/priceParser";

/** Asset hosts and URL shapes unique to the RevolutionParts platform. */
const RP_MARKERS: Array<[string, RegExp]> = [
  ["cdn-static.revolutionparts", /cdn-static\.revolutionparts\.io/i],
  ["cdn-product-images.revolutionparts", /cdn-product-images\.revolutionparts\.io/i],
  ["cdn-illustrations.revolutionparts", /cdn-illustrations\.revolutionparts\.io/i],
  ["revolutionparts-any", /revolutionparts\.(?:io|com)/i],
  ["oem-parts-url-shape", /\/oem-parts\//i],
  ["v-slug-url-shape", /\/v-\d{4}-[a-z]/i],
];

/** Fingerprints of OTHER known ecommerce platforms, so "not RP" is positive
 *  rather than merely an absence. */
const OTHER_MARKERS: Array<[string, RegExp]> = [
  ["shopify", /cdn\.shopify\.com|Shopify\.theme/i],
  ["bigcommerce", /bigcommerce\.com\/s-/i],
  ["magento", /\/static\/version\d+\/frontend\/|Magento_/i],
  ["woocommerce", /woocommerce|wp-content\/plugins/i],
  ["salesforce-cc", /demandware\.static|\/on\/demandware/i],
  ["nexpart", /nexpart/i],
];

export const detect = internalAction({
  args: { urls: v.array(v.string()) },
  handler: async (ctx, args): Promise<any> => {
    const out: any[] = [];
    for (const url of args.urls) {
      try {
        const r = await adapterFetch(url, { timeoutMs: 25_000 });
        const body = r.body ?? "";
        const rp = RP_MARKERS.filter(([, re]) => re.test(body)).map(([n]) => n);
        const other = OTHER_MARKERS.filter(([, re]) => re.test(body)).map(([n]) => n);
        out.push({
          url,
          status: r.status,
          via: r.via,
          chars: body.length,
          blocked: looksBlockedBody(body),
          title: (body.match(/<title[^>]*>([^<]{0,80})/i) ?? [])[1]?.trim() ?? null,
          rpMarkers: rp,
          otherMarkers: other,
          verdict: rp.length > 0 ? "revolutionparts" : other.length > 0 ? other[0] : "unknown",
          // A store is only USABLE if the deterministic price parser can read
          // it — JSON-LD Product/offers is what parsePartPrices keys on, and a
          // store it cannot read contributes neither parts nor prices.
          parsedProducts: (() => {
            try {
              const ps = parsePartPrices(body, url);
              return {
                count: ps.length,
                sample: ps.slice(0, 4).map((x) => `${x.oem_part_number_raw} $${x.price} ${(x.name ?? "").slice(0, 40)}`),
              };
            } catch (e) {
              return { count: 0, error: String(e).slice(0, 80) };
            }
          })(),
          // The store's OWN internal link shapes, grouped by first path
          // segment. Guessing a catalogue URL cost two round-trips and both
          // 30x'd to the homepage; reading the shape off the page does not.
          linkShapes: (() => {
            const paths = [...body.matchAll(/href=["'](\/[^"'?#]{4,90})["']/gi)].map((m) => m[1]);
            const byHead = new Map<string, string[]>();
            for (const p of paths) {
              const head = p.split("/")[1] ?? "";
              if (!head || /\.(css|js|png|jpg|svg|ico|webp|gif)$/i.test(p)) continue;
              const list = byHead.get(head) ?? [];
              if (list.length < 3) list.push(p);
              byHead.set(head, list);
            }
            return [...byHead.entries()]
              .sort((a, b) => b[1].length - a[1].length)
              .slice(0, 12)
              .map(([head, samples]) => ({ head, samples }));
          })(),
          hasJsonLd: /application\/ld\+json/i.test(body),
          jsonLdTypes: [...new Set(
            [...body.matchAll(/"@type"\s*:\s*"([A-Za-z]+)"/g)].map((m) => m[1]),
          )].slice(0, 10),
        });
      } catch (e) {
        out.push({ url, error: String(e).slice(0, 160) });
      }
      await new Promise((x) => setTimeout(x, 400));
    }
    return out;
  },
});
