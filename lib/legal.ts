import { POSTAL_ADDRESS, SITE_URL, SUPPORT_EMAIL } from "./site";

/**
 * The facts Otopair's legal documents depend on — the one place the policy
 * pages read them from.
 *
 * content/legal/*.md holds counsel's text (Privacy Policy v5, Shop Portal
 * Terms of Use v1, received 2026-09-14). Every bracketed placeholder in those
 * drafts became a {{TOKEN}} resolved here. A `null` value is still a
 * placeholder: `next dev` shows it highlighted, and a production build fails
 * rather than publish a legal page with a blank in it.
 */
export type LegalFacts = {
  /** Operating company. The drafts said "[Otopair, Inc.]"; the site footer names LEGAL_NAME ("AppFlow Creations Inc."). Confirm before shipping. */
  entityName: string | null;
  /** State of incorporation. The drafts said "[Delaware]". */
  entityState: string | null;
  /** ISO dates (YYYY-MM-DD). */
  privacyEffectiveDate: string | null;
  portalTermsEffectiveDate: string | null;
  privacyEmail: string | null;
  legalEmail: string | null;
  /** Street + ZIP line for the Contact sections. Falls back to POSTAL_ADDRESS when that is set. */
  mailingAddress: string | null;
  /** The Privacy Policy promises both of these pages exist. */
  privacyChoicesPath: string | null;
  deleteAccountPath: string | null;
};

export const LEGAL_FACTS: LegalFacts = {
  // Confirmed by Waleed 2026-09-14: keep the drafts' entity and state, both
  // documents effective today, and the privacy@ / legal@ inboxes exist.
  entityName: "Otopair, Inc.",
  entityState: "Delaware",
  privacyEffectiveDate: "2026-09-14",
  portalTermsEffectiveDate: "2026-09-14",
  privacyEmail: "privacy@otopair.com",
  legalEmail: "legal@otopair.com",
  // Still open (Waleed is raising both with Ab and Yassin): the mailing
  // address, and whether to build the two pages v5 promises or change its text.
  mailingAddress: POSTAL_ADDRESS
    ? `${POSTAL_ADDRESS.streetAddress}, ${POSTAL_ADDRESS.addressLocality}, ${POSTAL_ADDRESS.addressRegion} ${POSTAL_ADDRESS.postalCode}`
    : null,
  privacyChoicesPath: null,
  deleteAccountPath: null,
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

export type LegalDocKind = "privacy" | "portal-terms";

/** Token → value for one document. `null` means still a placeholder. */
export function legalTokens(kind: LegalDocKind, facts: LegalFacts = LEGAL_FACTS): Record<string, string | null> {
  const effective = kind === "privacy" ? facts.privacyEffectiveDate : facts.portalTermsEffectiveDate;
  const path = (p: string | null) => (p ? `${SITE_DOMAIN}${p}` : null);
  return {
    ENTITY_NAME: facts.entityName,
    ENTITY_STATE: facts.entityState,
    EFFECTIVE_DATE: effective ? formatLegalDate(effective) : null,
    SUPPORT_EMAIL,
    PRIVACY_EMAIL: facts.privacyEmail,
    LEGAL_EMAIL: facts.legalEmail,
    MAILING_ADDRESS: facts.mailingAddress,
    SITE_DOMAIN,
    PRIVACY_URL: `${SITE_DOMAIN}/privacy`,
    PRIVACY_CHOICES_URL: path(facts.privacyChoicesPath),
    DELETE_ACCOUNT_URL: path(facts.deleteAccountPath),
  };
}

/** Tokens a document uses that have no value yet. */
export function pendingTokens(text: string, tokens: Record<string, string | null>): string[] {
  const used = [...new Set([...text.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1]))];
  return used.filter((t) => tokens[t] == null);
}
