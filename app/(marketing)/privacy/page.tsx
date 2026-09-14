import type { Metadata } from "next";
import PageShell from "@/components/flagship/page-shell";
import { LegalDocumentBody, loadLegalDocument } from "@/components/legal/legal-document";
import { LEGAL_FACTS } from "@/lib/legal";

export const metadata: Metadata = {
  title: "Privacy policy",
  description:
    "How Otopair collects, uses, shares and protects information across the Otopair app, otopair.com and the shop portal, and the choices you have.",
  alternates: { canonical: "/privacy" },
};

/**
 * Otopair Privacy Policy v5, from counsel (received 2026-09-14). The wording
 * lives in content/legal/privacy-policy.md — replace that file with counsel's
 * next version rather than editing the text here. Placeholders resolve from
 * lib/legal.ts; the page will not build for a production deploy while any are
 * unset.
 */
export default function PrivacyPage() {
  const { doc, toc, pending } = loadLegalDocument("privacy");
  return (
    <PageShell
      title="Privacy Policy"
      lede="How Otopair collects, uses, shares and protects information when you use the Otopair app, otopair.com and the shop portal, and the choices you have."
      updated={LEGAL_FACTS.privacyEffectiveDate ?? undefined}
      crumbs={[
        { name: "Home", href: "/" },
        { name: "Privacy policy", href: "/privacy" },
      ]}
      toc={toc}
    >
      <LegalDocumentBody
        doc={doc}
        pending={pending}
        crossLinks={{ "Shop Portal Terms of Use": "/shop-portal-terms", "Terms of Use": "/terms" }}
      />
    </PageShell>
  );
}
