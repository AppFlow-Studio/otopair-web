import type { Metadata } from "next";
import { SitePolicyDocument } from "@/components/legal/legal-document";
import { sitePolicyMetadata } from "@/lib/legal";

export const metadata: Metadata = sitePolicyMetadata("trust");

/**
 * How we choose shops, from counsel's Site Policy Pages v1 (prepared
 * 2026-09-14); wording in content/legal/site-policy-pages.md. It replaces
 * /how-shops-are-verified, which now redirects here (next.config.ts).
 * Counsel: say only what Exhibit B of the Shop Partner Agreement verifies —
 * if a check is added, add it here; if one is dropped, remove it the same day.
 */
export default function TrustPage() {
  return <SitePolicyDocument kind="trust" />;
}
