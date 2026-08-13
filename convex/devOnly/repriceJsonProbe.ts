/**
 * devOnly/repriceJsonProbe.ts — READ-ONLY before/after test for Firecrawl
 * schema-based price extraction. For a diverse sample of existing part_prices
 * rows, it re-reads each row's source_url via Firecrawl's `json` format
 * (sale_price / msrp / discount) and returns the stored price (BEFORE) next to
 * the structured extraction (AFTER). Writes NOTHING. Prototype for deciding
 * whether reprice should use Firecrawl structured extraction.
 *
 *   npx convex run devOnly/repriceJsonProbe:probe '{"perType":2}'
 */
import { internalAction, internalQuery } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";

const FIRECRAWL_BASE = "https://api.firecrawl.dev/v2";

const PRICE_SCHEMA = {
  type: "object",
  properties: {
    sale_price: { type: ["number", "null"], description: "current/discounted selling price in USD (what a buyer pays now)" },
    msrp: { type: ["number", "null"], description: "list price / MSRP before any discount, USD" },
    discount_amount: { type: ["number", "null"], description: "amount saved off MSRP, USD" },
    in_stock: { type: ["boolean", "null"] },
    oem_part_number: { type: ["string", "null"], description: "the OEM/part number shown on the page" },
  },
  required: ["sale_price"],
};

/** A diverse sample of part_prices joined with their OEM part — a few per
 *  price_type so the before/after spans the interesting cases. */
export const _sample = internalQuery({
  args: { perType: v.optional(v.number()) },
  handler: async (ctx, { perType }) => {
    const cap = perType ?? 2;
    const prices = (await ctx.db.query("part_prices").collect()) as any[];
    const byType = new Map<string, any[]>();
    for (const p of prices) {
      if (!p.source_url) continue;
      const t = p.price_type ?? "(none)";
      const arr = byType.get(t) ?? [];
      if (arr.length < cap) {
        arr.push(p);
        byType.set(t, arr);
      }
    }
    const picked = [...byType.values()].flat();
    const out: any[] = [];
    for (const p of picked) {
      const part = (await ctx.db.get(p.part_id)) as any;
      out.push({
        part_name: part?.name ?? null,
        oem: part?.oem_part_number ?? null,
        source_url: p.source_url,
        source_domain: p.source_domain ?? null,
        before_price: p.price,
        before_type: p.price_type ?? "(none)",
      });
    }
    return out;
  },
});

async function firecrawlJson(url: string, oem: string | null): Promise<any> {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) return { error: "FIRECRAWL_API_KEY unset" };
  try {
    const resp = await fetch(`${FIRECRAWL_BASE}/scrape`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        url,
        formats: [
          {
            type: "json",
            prompt: `Extract the pricing for the auto part${oem ? ` with OEM/part number "${oem}"` : ""}. Return the current sale/discounted price, the MSRP/list price, the discount amount, in-stock status, and the part number shown on the page.`,
            schema: PRICE_SCHEMA,
          },
        ],
        timeout: 45000,
      }),
      signal: AbortSignal.timeout(50000),
    });
    const raw = await resp.json();
    if (!resp.ok) return { error: `${resp.status} ${resp.statusText}`, raw: JSON.stringify(raw).slice(0, 300) };
    const d = raw.data ?? raw;
    const j = d.json ?? d.extract ?? raw.json ?? null;
    return j ? { json: j } : { error: "no json in response", raw: JSON.stringify(raw).slice(0, 300) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export const probe = internalAction({
  args: { perType: v.optional(v.number()) },
  handler: async (ctx, { perType }): Promise<any> => {
    const sample: any[] = await ctx.runQuery(internal.devOnly.repriceJsonProbe._sample, { perType });
    const results: any[] = [];
    for (const row of sample) {
      const fc = await firecrawlJson(row.source_url, row.oem);
      const after = fc.json ?? null;
      results.push({
        part: row.part_name,
        oem: row.oem,
        domain: row.source_domain,
        before: { price: row.before_price, type: row.before_type },
        after: after
          ? {
              sale_price: after.sale_price ?? null,
              msrp: after.msrp ?? null,
              discount: after.discount_amount ?? null,
              in_stock: after.in_stock ?? null,
              oem_seen: after.oem_part_number ?? null,
            }
          : { error: fc.error, raw: fc.raw },
        source_url: row.source_url,
      });
    }
    return { count: results.length, results };
  },
});
