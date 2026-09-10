import { fetchQuery } from "convex/nextjs";
import { getFunctionName } from "convex/server";
import type { FunctionReference, FunctionReturnType, OptionalRestArgs } from "convex/server";

/**
 * Server-side Convex reads for the public marketing pages (shop profiles,
 * services, directory). Wraps `fetchQuery` so that a backend hiccup degrades
 * to `null` instead of a 500 — a crawler hitting /shops/<slug> during a
 * deploy should see a page that renders its static copy, not an error.
 *
 * Only ever pass PUBLIC queries here (no auth, curated fields). Everything
 * the marketing site reads must be safe to show to an anonymous visitor —
 * the query itself is the boundary, not this helper.
 *
 * `revalidate` on the calling page controls caching; these reads are
 * un-cached by themselves.
 */
export async function publicQuery<Q extends FunctionReference<"query", "public">>(
  ref: Q,
  ...args: OptionalRestArgs<Q>
): Promise<FunctionReturnType<Q> | null> {
  let name = "query";
  try {
    // A FunctionReference is a proxy; reading ad-hoc properties off it (or
    // template-stringifying it) throws "Cannot convert object to primitive
    // value" — which is exactly what masked the real error in the first
    // production build (2026-09-05). getFunctionName is the supported way.
    name = getFunctionName(ref);
  } catch {
    /* keep the fallback label */
  }
  try {
    return await fetchQuery(ref, ...args);
  } catch (err) {
    // fetchQuery uses a no-store fetch, so during static prerender Next throws
    // DynamicServerError to say "render this route on demand instead". That
    // is control flow, not a failure — it must propagate or the prerender
    // gets an empty page (seen in the 2026-09-05 build log as "[publicQuery]
    // shops:list failed: Dynamic server usage").
    const digest = (err as { digest?: string } | null)?.digest;
    if (digest === "DYNAMIC_SERVER_USAGE" || (err instanceof Error && /Dynamic server usage/.test(err.message))) {
      throw err;
    }
    console.error(`[publicQuery] ${name} failed:`, err instanceof Error ? err.message : err);
    return null;
  }
}
