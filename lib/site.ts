/**
 * Single source of truth for the public site's identity — everything the SEO
 * layer (metadata, canonicals, sitemap, robots, JSON-LD, footer NAP) reads.
 *
 * Built for the Phase 1 foundation of the 2026-08-31 technical/local SEO
 * audit. Local ranking hinges on NAP (Name / Address / Phone) being identical
 * everywhere it appears — footer, schema, Google Business Profile, Apple
 * Business Connect, Bing, Yelp, LinkedIn, the store listings — so change it
 * HERE and nowhere else.
 *
 * Kept free of React so it can be imported from route handlers (robots.ts,
 * sitemap.ts) and server components alike.
 */

/** Production origin. Preview deploys still emit this as the canonical /
 *  og:url base on purpose — a preview should never advertise its own host. */
export const SITE_URL = "https://otopair.com";

export const SITE_NAME = "Otopair";

/** Legal operator, as it must appear on every citation (audit §3.2). */
export const LEGAL_NAME = "AppFlow Creations Inc.";

/**
 * Physical, staffable address for the Google Business Profile (a PO box or
 * virtual office gets the listing suspended — audit §3.1). Leave `null` until
 * a real one exists: the footer and JSON-LD then fall back to the
 * locality-only form ("Staten Island, NY") rather than publishing a fake
 * street line. Fill every field once it's known.
 */
export const POSTAL_ADDRESS: {
  streetAddress: string;
  addressLocality: string;
  addressRegion: string;
  postalCode: string;
  addressCountry: string;
} | null = null;

/** Public phone in E.164 (e.g. "+17185550123"). `null` hides the phone line. */
export const PHONE_E164: string | null = null;

/** Locality the business is registered to — the local-SEO anchor entity. */
export const LOCALITY = { city: "Staten Island", region: "NY", country: "US" } as const;

export const SUPPORT_EMAIL = "support@otopair.com";
export const DATA_EMAIL = "data@otopair.com";

/**
 * Corroborating profiles for entity grounding (audit §5.5). Add each URL as
 * the profile goes live — the Organization schema's `sameAs` array is built
 * from this list, so an empty entry is simply omitted. Order doesn't matter.
 */
export const SAME_AS: string[] = [
  // "https://www.linkedin.com/company/otopair",
  // "https://www.crunchbase.com/organization/otopair",
  // "https://apps.apple.com/app/…",
  // "https://play.google.com/store/apps/details?id=…",
];

/**
 * Every borough on the coverage ladder, in launch order. `live` boroughs feed
 * `areaServed` in the LocalBusiness schema; the rest are announced, not
 * served, so they stay out of it (schema must not claim service where none
 * exists). Mirrors components/flagship/landing/coverage-section.tsx.
 */
export const SERVICE_AREAS = [
  { name: "Staten Island", live: true },
  { name: "Brooklyn", live: false },
  { name: "Queens", live: false },
  { name: "The Bronx", live: false },
  { name: "Manhattan", live: false },
] as const;

/**
 * Public, indexable marketing routes. The sitemap is generated from this;
 * add a route here when it ships so it never has to be remembered twice.
 * `changeFrequency`/`priority` follow Google's own guidance loosely — they
 * are hints at best.
 */
export const PUBLIC_ROUTES: ReadonlyArray<{
  path: string;
  changeFrequency: "daily" | "weekly" | "monthly" | "yearly";
  priority: number;
}> = [
  { path: "/", changeFrequency: "weekly", priority: 1 },
  // Tier 1 — the landing's anchors as URLs
  { path: "/how-it-works", changeFrequency: "monthly", priority: 0.9 },
  { path: "/for-shops", changeFrequency: "monthly", priority: 0.8 },
  { path: "/coverage", changeFrequency: "monthly", priority: 0.8 },
  { path: "/download", changeFrequency: "monthly", priority: 0.7 },
  { path: "/pricing", changeFrequency: "monthly", priority: 0.8 },
  { path: "/oto", changeFrequency: "monthly", priority: 0.7 },
  { path: "/about", changeFrequency: "monthly", priority: 0.6 },
  { path: "/partner-with-us", changeFrequency: "monthly", priority: 0.8 },
  { path: "/apply", changeFrequency: "monthly", priority: 0.6 },
  // Tier 2 — local engine
  { path: "/staten-island", changeFrequency: "weekly", priority: 0.9 },
  { path: "/brooklyn", changeFrequency: "monthly", priority: 0.6 },
  { path: "/queens", changeFrequency: "monthly", priority: 0.6 },
  { path: "/bronx", changeFrequency: "monthly", priority: 0.6 },
  { path: "/manhattan", changeFrequency: "monthly", priority: 0.6 },
  { path: "/shops", changeFrequency: "weekly", priority: 0.8 },
  // Tier 3 — services index (per-service URLs are added in app/sitemap.ts)
  { path: "/services", changeFrequency: "monthly", priority: 0.8 },
  // Tier 4 — trust, conversion, compliance
  { path: "/trust-and-safety", changeFrequency: "monthly", priority: 0.6 },
  { path: "/how-shops-are-verified", changeFrequency: "monthly", priority: 0.6 },
  { path: "/vehicle-health-score", changeFrequency: "monthly", priority: 0.6 },
  { path: "/warranty", changeFrequency: "yearly", priority: 0.4 },
  { path: "/cancellation-policy", changeFrequency: "yearly", priority: 0.5 },
  { path: "/security", changeFrequency: "yearly", priority: 0.4 },
  { path: "/accessibility", changeFrequency: "yearly", priority: 0.3 },
  { path: "/careers", changeFrequency: "monthly", priority: 0.3 },
  { path: "/press", changeFrequency: "yearly", priority: 0.3 },
  { path: "/help", changeFrequency: "weekly", priority: 0.6 },
  // Tier 5 — authority (help articles are spread in app/sitemap.ts)
  { path: "/guides", changeFrequency: "monthly", priority: 0.4 },
  { path: "/guides/dealership-vs-independent-mechanic", changeFrequency: "yearly", priority: 0.5 },
  { path: "/car-data", changeFrequency: "monthly", priority: 0.5 },
  { path: "/developers", changeFrequency: "monthly", priority: 0.4 },
  { path: "/contact", changeFrequency: "yearly", priority: 0.5 },
  { path: "/privacy", changeFrequency: "yearly", priority: 0.2 },
  { path: "/terms", changeFrequency: "yearly", priority: 0.2 },
];

/** Absolute URL for a site path — the one place `SITE_URL` is joined. */
export function absoluteUrl(path: string): string {
  return new URL(path, SITE_URL).toString();
}

/** Human-readable phone for display, derived from the E.164 form so the two
 *  can never drift. US numbers only — that's the only market for now. */
export function formatPhone(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}
