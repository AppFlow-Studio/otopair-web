/**
 * devOnly/urlProbe — what does a URL answer FROM CONVEX'S EGRESS?
 *
 * Built Aug 11 2026 to settle a question a laptop cannot answer. Four
 * manual URLs that our pipeline logged as `dealereprocess:http_403`
 * (2019 Sierra, 2021 CX-30, 2020 Grand Cherokee, 2022 Palisade) all return
 * 206 + application/pdf when probed from a workstation. Either the CDN
 * blocks datacenter IP ranges, or our request shape differs — and the answer
 * decides whether expanding DEALEREPROCESS_MAKES is worth anything at all.
 *
 * Mirrors manualDirectSources.probeDirectCandidate exactly: ranged GET,
 * browser UA. `variant` flips one header at a time so a block can be
 * attributed to the header rather than the network.
 *
 *   npx convex run devOnly/urlProbe:probe '{"url":"https://…","variant":"probe"}'
 */
import { internalAction } from "../_generated/server";
import { v } from "convex/values";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

export const probe = internalAction({
  args: {
    url: v.string(),
    /** probe = ranged GET + UA (what the pipeline sends);
     *  bare = no UA; full = UA + Accept + Accept-Language + Referer. */
    variant: v.optional(v.string()),
  },
  handler: async (_ctx, args) => {
    const variant = args.variant ?? "probe";
    const headers: Record<string, string> =
      variant === "bare"
        ? {}
        : variant === "full"
          ? {
              "User-Agent": UA,
              Accept: "application/pdf,*/*",
              "Accept-Language": "en-US,en;q=0.9",
              Referer: new URL(args.url).origin + "/",
              Range: "bytes=0-2047",
            }
          : { "User-Agent": UA, Range: "bytes=0-2047" };

    try {
      const res = await fetch(args.url, {
        headers,
        signal: AbortSignal.timeout(15_000),
      });
      let firstBytes = "";
      try {
        const buf = new Uint8Array(await res.arrayBuffer());
        firstBytes = new TextDecoder().decode(buf.slice(0, 8));
      } catch {
        /* body unreadable — status is the answer we came for */
      }
      return {
        variant,
        status: res.status,
        contentType: res.headers.get("content-type"),
        contentLength: res.headers.get("content-length"),
        server: res.headers.get("server"),
        cfRay: res.headers.get("cf-ray"),
        firstBytes,
      };
    } catch (e) {
      return { variant, error: String(e).slice(0, 200) };
    }
  },
});
