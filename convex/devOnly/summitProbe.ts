/**
 * devOnly/summitProbe.ts — can Scrapling get past Summit Racing's Imperva wall?
 *
 * summitCentric is the ONLY broad US-application rotor DISCARD source we have
 * (Brembo skews European/performance), and it has filed zero claims fleet-wide.
 * Two causes were found by inspection: claimGathering hardcodes the headless
 * rescue to `amsoil`, and the adapter still uses a bare `fetch()` rather than
 * the Scrapling-aware `adapterFetch`.
 *
 * Both are trivially fixable — but only worth fixing if the stealth tier
 * actually defeats the challenge. That is an empirical question and this
 * answers it before any code is changed.
 *
 * Delete after the Aug 2026 validation.
 */
import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import {
  looksBlockedBody,
  scraplingEnabled,
  scraplingFetchPage,
} from "../vehicleEnrichment/scrapling";

const CHALLENGE = /Pardon Our Interruption|reese84|_Incapsula_Resource|incapsula/i;

export const probe = internalAction({
  args: { url: v.string(), mode: v.optional(v.string()) },
  handler: async (ctx, args): Promise<any> => {
    const out: any = { scraplingConfigured: scraplingEnabled(), url: args.url };

    // Tier 0 — the bare fetch the adapter does today.
    try {
      const r = await fetch(args.url, {
        headers: {
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        },
        signal: AbortSignal.timeout(20_000),
      });
      const body = await r.text();
      out.bareFetch = {
        status: r.status,
        chars: body.length,
        isChallenge: CHALLENGE.test(body),
        looksBlocked: looksBlockedBody(body),
        titleish: (body.match(/<title[^>]*>([^<]{0,90})/i) ?? [])[1] ?? null,
      };
    } catch (e) {
      out.bareFetch = { error: String(e).slice(0, 160) };
    }

    // Tier 1 — Scrapling, in the mode asked for.
    try {
      const mode = (args.mode ?? "stealth") as any;
      const page = await scraplingFetchPage(args.url, { mode });
      const body = page?.body ?? null;
      out.scrapling = page
        ? {
            mode,
            status: page.status,
            chars: body?.length ?? 0,
            isChallenge: CHALLENGE.test(body ?? ""),
            looksBlocked: looksBlockedBody(body),
            titleish: ((body ?? "").match(/<title[^>]*>([^<]{0,90})/i) ?? [])[1] ?? null,
            // The two labels the adapter's parser keys on.
            hasNominalLabel: /Nominal Thickness/i.test(body ?? ""),
            hasDiscardLabel: /Discard Thickness/i.test(body ?? ""),
            sample: (body ?? "").replace(/\s+/g, " ").slice(0, 400),
          }
        : { mode, result: "null (miss)" };
    } catch (e) {
      out.scrapling = { error: String(e).slice(0, 200) };
    }
    return out;
  },
});
