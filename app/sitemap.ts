import type { MetadataRoute } from "next";
import { PUBLIC_ROUTES, absoluteUrl } from "@/lib/site";
import { listPublicShopSlugs } from "@/lib/public-shops";
import { SERVICE_SLUGS, TOP_LOCAL_SERVICES } from "@/lib/service-catalog";
import { HELP_SLUGS } from "@/lib/help-articles";

/**
 * /sitemap.xml — audit Tier 0 (2026-08-31). Static routes come from
 * lib/site.ts PUBLIC_ROUTES (register a page there once). Dynamic tiers:
 *   - /shops/<slug>               live, from the verified-shop gate in
 *                                 lib/public-shops.ts (fails soft to none)
 *   - /services/<slug>            the 22 bookable services
 *   - /staten-island/<service>    the 10 local-intent service pages
 */
export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const lastModified = new Date();
  const statics: MetadataRoute.Sitemap = PUBLIC_ROUTES.map(({ path, changeFrequency, priority }) => ({
    url: absoluteUrl(path),
    lastModified,
    changeFrequency,
    priority,
  }));

  const services: MetadataRoute.Sitemap = SERVICE_SLUGS.map((slug) => ({
    url: absoluteUrl(`/services/${slug}`),
    lastModified,
    changeFrequency: "monthly",
    priority: 0.6,
  }));

  const local: MetadataRoute.Sitemap = TOP_LOCAL_SERVICES.map((slug) => ({
    url: absoluteUrl(`/staten-island/${slug}`),
    lastModified,
    changeFrequency: "weekly",
    priority: 0.7,
  }));

  const help: MetadataRoute.Sitemap = HELP_SLUGS.map((slug) => ({
    url: absoluteUrl(`/help/${slug}`),
    lastModified,
    changeFrequency: "monthly",
    priority: 0.5,
  }));

  let shops: MetadataRoute.Sitemap = [];
  try {
    shops = (await listPublicShopSlugs()).map((slug) => ({
      url: absoluteUrl(`/shops/${slug}`),
      lastModified,
      changeFrequency: "weekly",
      priority: 0.7,
    }));
  } catch (err) {
    console.error("[sitemap] shop slugs unavailable:", err);
  }

  return [...statics, ...services, ...local, ...help, ...shops];
}
