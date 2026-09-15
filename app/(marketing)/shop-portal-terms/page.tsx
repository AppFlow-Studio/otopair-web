import type { Metadata } from "next";
import PageShell from "@/components/flagship/page-shell";
import { LegalDocumentBody, loadLegalDocument } from "@/components/legal/legal-document";
import { LEGAL_FACTS } from "@/lib/legal";

export const metadata: Metadata = {
  title: "Shop portal terms of use",
  description:
    "The terms that govern individual use of the Otopair shop portal by owners, managers, service advisors and technicians at partner shops.",
  alternates: { canonical: "/shop-portal-terms" },
};

/**
 * Otopair Shop Portal Terms of Use v1.1, from counsel (received 2026-09-14;
 * replaces v1).
 * The wording lives in content/legal/shop-portal-terms.md; placeholders resolve
 * from lib/legal.ts. Shown to portal users at sign-in and sign-up
 * (components/legal/portal-terms-notice.tsx), because §2 makes signing in the
 * acceptance.
 */
export default function ShopPortalTermsPage() {
  const { doc, toc, pending } = loadLegalDocument("portal-terms");
  return (
    <PageShell
      title="Shop Portal Terms of Use"
      lede="For owners, managers, service advisors, technicians and anyone else who uses the Otopair shop portal on behalf of a partner shop."
      updated={LEGAL_FACTS.portalTermsEffectiveDate ?? undefined}
      crumbs={[
        { name: "Home", href: "/" },
        { name: "Shop portal terms of use", href: "/shop-portal-terms" },
      ]}
      toc={toc}
    >
      <LegalDocumentBody
        doc={doc}
        pending={pending}
        crossLinks={{ "Otopair Privacy Policy": "/privacy", "Otopair Terms of Use": "/terms" }}
      />
    </PageShell>
  );
}
