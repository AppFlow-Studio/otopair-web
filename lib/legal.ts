import type { Metadata } from "next";
import { SITE_URL, SUPPORT_EMAIL } from "./site";

/**
 * The facts Otopair's legal documents depend on — the one place the policy
 * pages read them from.
 *
 * content/legal/*.md holds counsel's text: the Privacy Policy v6.1 and Shop
 * Portal Terms of Use v1.1 (received 2026-09-14; they replace v5 and v1), and
 * the Site Policy Pages v1 (/cancellation, /warranties, /trust,
 * /accessibility). Every fact those documents name, or leave as a bracketed
 * placeholder, became a {{TOKEN}} resolved here. A `null` value is still a
 * placeholder: `next dev` shows it highlighted, and a production build fails
 * rather than publish a legal page with a blank in it (lib/legal-content.ts).
 */
export type LegalFacts = {
  /** Operating company, as the drafts name it. The site footer and JSON-LD still name LEGAL_NAME ("AppFlow Creations Inc.") — see lib/site.ts. */
  entityName: string | null;
  /** State of incorporation. */
  entityState: string | null;
  /** ISO dates (YYYY-MM-DD). The drafts leave "[MONTH] [DAY], 2026" blank. */
  privacyEffectiveDate: string | null;
  portalTermsEffectiveDate: string | null;
  /** The address line in both documents' Contact sections. Not the footer's POSTAL_ADDRESS (lib/site.ts), which is the listing address. */
  mailingAddress: string | null;
  /** The Privacy Policy promises both of these pages exist (otopair.com/privacy-choices, otopair.com/delete-account). */
  privacyChoicesPath: string | null;
  deleteAccountPath: string | null;
  /** New York State DMV's public lookup for registered repair shops — /trust's "DMV repair shop lookup" link. */
  dmvRepairShopLookupUrl: string | null;
};

export const LEGAL_FACTS: LegalFacts = {
  // As Privacy Policy v6.1 and Shop Portal Terms v1.1 state them. The owner,
  // 2026-09-15: both drafts take effect today. Every contact line in both
  // now reads support@otopair.com ({{SUPPORT_EMAIL}}); the privacy@ and
  // legal@ inboxes v5 and v1 used are gone from the text.
  entityName: "Otopair Inc.",
  entityState: "Delaware",
  privacyEffectiveDate: "2026-09-15",
  portalTermsEffectiveDate: "2026-09-15",
  mailingAddress: "200 Vesey Street, 24th Floor, New York, NY 10281",
  // The two pages v6.1 §6 sends people to (built 2026-09-15). Each is a
  // form that records the request in Convex and emails support.
  privacyChoicesPath: "/privacy-choices",
  deleteAccountPath: "/delete-account",
  // DMV's own consumer guide (dmv.ny.gov/brochure/know-your-rights-auto-repair)
  // says "Use the Find a DMV-regulated Business service to find a registered
  // repair shop in your area" and links this page, which opens the search.
  dmvRepairShopLookupUrl: "https://dmv.ny.gov/business/find-a-dmv-regulated-business",
};

const SITE_DOMAIN = new URL(SITE_URL).host;

export function formatLegalDate(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Counsel's two agreements, each its own file with its own effective date. */
export type LegalDocKind = "privacy" | "portal-terms";

/** Counsel's Site Policy Pages — one file (content/legal/site-policy-pages.md), one route each. */
export type SitePolicyKind = "cancellation" | "warranties" | "trust" | "accessibility";

/** Token → value for one document or page. `null` means still a placeholder. */
export function legalTokens(kind: LegalDocKind | SitePolicyKind, facts: LegalFacts = LEGAL_FACTS): Record<string, string | null> {
  const effective =
    kind === "privacy" ? facts.privacyEffectiveDate : kind === "portal-terms" ? facts.portalTermsEffectiveDate : null;
  const path = (p: string | null) => (p ? `${SITE_DOMAIN}${p}` : null);
  return {
    ENTITY_NAME: facts.entityName,
    ENTITY_STATE: facts.entityState,
    EFFECTIVE_DATE: effective ? formatLegalDate(effective) : null,
    SUPPORT_EMAIL,
    MAILING_ADDRESS: facts.mailingAddress,
    SITE_DOMAIN,
    PRIVACY_URL: `${SITE_DOMAIN}/privacy`,
    PRIVACY_CHOICES_URL: path(facts.privacyChoicesPath),
    DELETE_ACCOUNT_URL: path(facts.deleteAccountPath),
    DMV_REPAIR_SHOP_LOOKUP_URL: facts.dmvRepairShopLookupUrl,
  };
}

/** Tokens a document uses that have no value yet. */
export function pendingTokens(text: string, tokens: Record<string, string | null>): string[] {
  const used = [...new Set([...text.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1]))];
  return used.filter((t) => tokens[t] == null);
}

/**
 * The page chrome around each site policy page. The body is counsel's text,
 * untouched; `description` is ours (metadata and the hero line), so it only
 * names what the page covers — no amounts, windows or promises of its own,
 * which live on the page itself.
 */
export const SITE_POLICY_PAGES: Record<
  SitePolicyKind,
  {
    path: string;
    /** Metadata title and breadcrumb, sentence case like the other pages. The H1 is counsel's. */
    name: string;
    description: string;
    /** Words counsel's implementation note keeps off the page. The loader refuses to render a page that uses one. */
    bannedWords: string[];
  }
> = {
  cancellation: {
    path: "/cancellation",
    name: "Cancellations and no-shows",
    description: "What happens when you cancel a booking, when you don’t show up, and when the shop cancels.",
    bannedWords: [],
  },
  warranties: {
    path: "/warranties",
    name: "Warranties and service issues",
    description: "Who stands behind the work on a booking, what Otopair provides, and what to do if something’s wrong.",
    // "Otopair offers no guarantee; the Angi litigation (Dotson v. Angi) turns
    // on a page that promised more than the terms delivered."
    bannedWords: ["guarantee", "covered", "make it right"],
  },
  trust: {
    path: "/trust",
    name: "How we choose shops",
    description: "The checks every shop passes before it goes live on Otopair, and what they do and don’t mean.",
    // "Say only what Exhibit B of the Shop Partner Agreement verifies." Otopair
    // runs no background checks on technicians.
    bannedWords: ["background-checked", "certified", "vetted"],
  },
  accessibility: {
    path: "/accessibility",
    name: "Accessibility",
    description:
      "The accessibility standard Otopair is working toward across the app and the website, and how to tell us when something doesn’t work for you.",
    bannedWords: [],
  },
};

/** Banned words (as whole words, any case, "guarantee" also catching "guaranteed") found in `text`. */
export function bannedWordsIn(kind: SitePolicyKind, text: string): string[] {
  return SITE_POLICY_PAGES[kind].bannedWords.filter((w) =>
    new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")}`, "i").test(text)
  );
}

export function sitePolicyMetadata(kind: SitePolicyKind): Metadata {
  const { path, name, description } = SITE_POLICY_PAGES[kind];
  return { title: name, description, alternates: { canonical: path } };
}
