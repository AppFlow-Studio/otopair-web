import type { Metadata } from "next";
import { SitePolicyDocument } from "@/components/legal/legal-document";
import { sitePolicyMetadata } from "@/lib/legal";

export const metadata: Metadata = sitePolicyMetadata("accessibility");

/**
 * Accessibility, from counsel's Site Policy Pages v1 (prepared 2026-09-14);
 * wording in content/legal/site-policy-pages.md. Counsel: cite WCAG 2.1 AA,
 * not 2.2, unless the app has been tested against 2.2, and never claim
 * conformance — "working toward" is deliberate.
 */
export default function AccessibilityPage() {
  return <SitePolicyDocument kind="accessibility" />;
}
