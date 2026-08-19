/**
 * devOnly/rockautoProbe.ts — is RockAuto's catalogue walkable server-side?
 *
 * rockauto.ts asserts it "cannot answer 'what pad fits a 2016 CR-V' through a
 * stable server-fetchable path", which is why it sits in PART_KEYED_ADAPTERS
 * and can only confirm numbers we already hold. That assertion dates from Jul
 * 2026 and is the single thing standing between us and a genuinely independent
 * second operator for parts AND prices — so it gets re-probed before anything
 * is built on it either way.
 *
 * Delete after the Aug 2026 validation.
 */
import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { adapterFetch, looksBlockedBody } from "../vehicleEnrichment/sourceAdapters/http";

export const walk = internalAction({
  args: { paths: v.array(v.string()) },
  handler: async (ctx, args): Promise<any> => {
    const out: any[] = [];
    for (const path of args.paths) {
      const url = path.startsWith("http") ? path : `https://www.rockauto.com${path}`;
      try {
        const r = await adapterFetch(url, { timeoutMs: 25_000 });
        const body = r.body ?? "";
        // What a walkable catalogue would have to expose: links onward to the
        // next level of the tree, and eventually part listings.
        const navLinks = [...body.matchAll(/href="([^"]*catalog\/[^"]+)"/gi)].map((m) => m[1]);
        const uniqNav = [...new Set(navLinks)];
        out.push({
          path,
          via: r.via,
          status: r.status,
          chars: body.length,
          looksBlocked: looksBlockedBody(body),
          title: (body.match(/<title[^>]*>([^<]{0,90})/i) ?? [])[1] ?? null,
          catalogLinks: uniqNav.length,
          sampleLinks: uniqNav.slice(0, 8),
          // RockAuto's own navigation payloads / markers.
          hasNavNode: /navnode_/i.test(body),
          hasCatalogApi: /catalogapi\.php/i.test(body),
          hasListing: /listing-final-partnumber|listing-container/i.test(body),
          listings: [...new Set(
            [...body.matchAll(/listing-final-manufacturer[^>]*>([^<]{1,40})<[\s\S]{0,400}?listing-final-partnumber[^>]*>([^<]{1,40})</gi)]
              .map((m) => `${m[1].trim()} ${m[2].trim()}`),
          )].slice(0, 12),
          positionHeaders: [...new Set(
            [...body.matchAll(/class="listing-border-top-line"[\s\S]{0,200}?>([^<]{0,40}(?:Front|Rear)[^<]{0,40})</gi)].map((m) => m[1].trim()),
          )].slice(0, 10),
          rawPositionish: [...new Set(
            [...body.matchAll(/>\s*((?:Front|Rear)[^<]{0,60})</gi)].map((m) => m[1].trim()),
          )].filter((t) => t.length < 70).slice(0, 14),
          prices: [...new Set(
            [...body.matchAll(/\$\s?(\d{1,4}\.\d{2})/g)].map((m) => m[1]),
          )].slice(0, 8),
          hasCarcode: /carcode=?\d{5,}/i.test(body),
          carcodeSample: (body.match(/carcode["'=: ]{1,4}(\d{5,})/i) ?? [])[1] ?? null,
          // How the next level of the tree is actually expressed. The plain
          // href regex above only catches breadcrumbs, so look for the shapes
          // RockAuto really uses for engine and category nodes.
          navHrefs: [...new Set(
            [...body.matchAll(/href=["']([^"']*(?:catalog|parts)[^"']*)["']/gi)]
              .map((m) => m[1])
              .filter((h) => (h.match(/,/g) || []).length >= 3),
          )].slice(0, 300),
          jsNavCalls: [...new Set(
            [...body.matchAll(/(?:navigateLocal|jsNavigate|loadCatalog)\(([^)]{0,120})\)/gi)].map((m) => m[1]),
          )].slice(0, 8),
          engineish: [...new Set(
            [...body.matchAll(/\b(\d\.\dL?\s*(?:V6|V8|L4|L6|I4|I6)[^<"']{0,20})/gi)].map((m) => m[1].trim()),
          )].slice(0, 10),
          allCarcodes: [...new Set(
            [...body.matchAll(/\b(\d{7})\b/g)].map((m) => m[1]),
          )].slice(0, 10),
        });
      } catch (e) {
        out.push({ path, error: String(e).slice(0, 200) });
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    return out;
  },
});
