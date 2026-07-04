/**
 * vdbProbe.ts — DEV-ONLY feasibility probe: can our VEHICLE_DATABASES_API_KEY
 * reach the YMM Specifications endpoint (year/make/model/trim → engine), and is
 * it in our plan? Used to decide the RP engine-sibling decode source. Throwaway.
 *   npx convex run devOnly/vdbProbe:probeYmm
 */
import { internalAction } from "../_generated/server";
import { v } from "convex/values";

export const probeYmm = internalAction({
  args: { paths: v.optional(v.array(v.string())) },
  handler: async (_ctx, args): Promise<any> => {
    const key = process.env.VEHICLE_DATABASES_API_KEY;
    if (!key) return { error: "VEHICLE_DATABASES_API_KEY not set on this deployment" };
    const base = "https://api.vehicledatabases.com";
    const paths = args.paths ?? [
      "/ymm-specs/v3/2020/BMW/745e/xDrive iPerformance", // doc example (known-good shape)
      "/ymm-specs/v3/2020/BMW/750i/xDrive",
      "/ymm-specs/v3/2020/BMW/750i xDrive/Base",
      "/ymm-specs/v3/2020/BMW/M850i/xDrive",
      "/ymm-specs/v3/2018/Mercedes-Benz/C63 AMG S/Base",
      "/ymm-specs/v3/2018/Porsche/911/Turbo S",
    ];
    const out: any[] = [];
    for (const p of paths) {
      try {
        const r = await fetch(base + encodeURI(p), { headers: { "x-authkey": key } });
        let body: any = null;
        const text = await r.text();
        try { body = JSON.parse(text); } catch { body = text.slice(0, 400); }
        out.push({
          path: p,
          httpStatus: r.status,
          apiStatus: body?.status ?? null,
          message: body?.message ?? null,
          dataKeys: body?.data && typeof body.data === "object" ? Object.keys(body.data) : null,
          // try to surface engine-ish content regardless of exact shape
          snippet: typeof body === "string" ? body : JSON.stringify(body).slice(0, 900),
        });
      } catch (e) {
        out.push({ path: p, error: String((e as Error)?.message ?? e) });
      }
    }
    return out;
  },
});
