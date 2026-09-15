import { SITE_URL, SUPPORT_EMAIL } from "./site";

/**
 * The facts Otopair's legal documents depend on — the one place the policy
 * pages read them from.
 *
 * content/legal/*.md holds counsel's text: the Privacy Policy v6.1 and Shop
 * Portal Terms of Use v1.1 (received 2026-09-14; they replace v5 and v1).
 * Every fact those documents name, or leave as a bracketed placeholder,
 * became a {{TOKEN}} resolved here. A `null` value is still a placeholder:
 * `next dev` shows it highlighted, and a production build fails rather than
 * publish a legal page with a blank in it.
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
  // Still open (the owner is raising both with counsel): v6.1 sends people
  // to otopair.com/privacy-choices and otopair.com/delete-account, and
  // neither page exists yet. Set each path once its page ships; until then
  // /privacy will not deploy to production.
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
