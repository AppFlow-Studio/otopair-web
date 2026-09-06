import {
  LEGAL_NAME,
  LOCALITY,
  PHONE_E164,
  POSTAL_ADDRESS,
  SAME_AS,
  SERVICE_AREAS,
  SITE_NAME,
  SITE_URL,
  SUPPORT_EMAIL,
  absoluteUrl,
} from "@/lib/site";

/**
 * Structured data for the marketing site — audit Tier 0 / Phase 1
 * (2026-08-31): "Schema is how both Google's local pack and LLM retrieval
 * layers identify what an entity is. Its absence is the highest-leverage
 * fix on this list."
 *
 * One `@graph` with three nodes, cross-referenced by `@id` so a consumer can
 * see they are the same entity:
 *   - Organization  — the operator (sitewide, every page)
 *   - WebSite       — the property, publisher → Organization
 *   - LocalBusiness — the Staten Island service entity. Emitted with the
 *     full postal address only when lib/site.ts has one; until then it
 *     carries the locality-level `areaServed` so it is truthful rather
 *     than rich. A fabricated street line would be worse than none.
 *
 * Deliberately absent, per the audit's own constraints:
 *   - AggregateRating — never until there is genuine review volume.
 *   - SearchAction   — the site has no search results page to point at.
 * `@id`s are stable URLs; Tier 2 shop pages will reference the
 * Organization `@id` from their own LocalBusiness nodes.
 */
const ORG_ID = `${SITE_URL}/#organization`;
const SITE_ID = `${SITE_URL}/#website`;
const LOCAL_ID = `${SITE_URL}/#local`;

function organization() {
  return {
    "@type": "Organization",
    "@id": ORG_ID,
    name: SITE_NAME,
    legalName: LEGAL_NAME,
    url: SITE_URL,
    logo: {
      "@type": "ImageObject",
      url: absoluteUrl("/logo.png"),
    },
    email: SUPPORT_EMAIL,
    ...(PHONE_E164 ? { telephone: PHONE_E164 } : {}),
    ...(SAME_AS.length ? { sameAs: SAME_AS } : {}),
    contactPoint: [
      {
        "@type": "ContactPoint",
        contactType: "customer support",
        email: SUPPORT_EMAIL,
        ...(PHONE_E164 ? { telephone: PHONE_E164 } : {}),
        areaServed: "US",
        availableLanguage: ["en"],
      },
    ],
  };
}

function website() {
  return {
    "@type": "WebSite",
    "@id": SITE_ID,
    url: SITE_URL,
    name: SITE_NAME,
    publisher: { "@id": ORG_ID },
    inLanguage: "en-US",
  };
}

function localBusiness() {
  const address = POSTAL_ADDRESS ?? {
    addressLocality: LOCALITY.city,
    addressRegion: LOCALITY.region,
    addressCountry: LOCALITY.country,
  };
  return {
    "@type": "LocalBusiness",
    "@id": LOCAL_ID,
    name: SITE_NAME,
    parentOrganization: { "@id": ORG_ID },
    url: SITE_URL,
    image: absoluteUrl("/logo.png"),
    email: SUPPORT_EMAIL,
    ...(PHONE_E164 ? { telephone: PHONE_E164 } : {}),
    address: { "@type": "PostalAddress", ...address },
    areaServed: SERVICE_AREAS.filter((a) => a.live).map((a) => ({
      "@type": "City",
      name: `${a.name}, ${LOCALITY.region}`,
    })),
    // Marketplace, not a garage: the audit is explicit that "Auto repair
    // shop" is the wrong category for an operator that doesn't turn wrenches.
    description:
      "Marketplace for booking verified independent mechanic shops in Staten Island, NY at a price locked before the car goes in.",
  };
}

/** Sitewide graph: Organization + WebSite + LocalBusiness. Render once, in
 *  the root layout. */
export function SiteJsonLd() {
  const graph = {
    "@context": "https://schema.org",
    "@graph": [organization(), website(), localBusiness()],
  };
  return <JsonLd data={graph} />;
}

/** Generic emitter for page-level nodes (FAQPage, BreadcrumbList, a shop's
 *  own LocalBusiness…). `<` is escaped so untrusted strings can never close
 *  the script tag. */
export function JsonLd({ data }: { data: Record<string, unknown> }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, "\\u003c") }}
    />
  );
}
