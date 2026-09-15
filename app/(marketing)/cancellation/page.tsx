import type { Metadata } from "next";
import { SitePolicyDocument } from "@/components/legal/legal-document";
import { sitePolicyMetadata } from "@/lib/legal";

export const metadata: Metadata = sitePolicyMetadata("cancellation");

/**
 * Cancellations and No-Shows, from counsel's Site Policy Pages v1 (prepared
 * 2026-09-14). The wording lives in content/legal/site-policy-pages.md with
 * the other three pages — replace that file with counsel's next version
 * rather than editing text here. It replaces /cancellation-policy, which now
 * redirects here (next.config.ts).
 *
 * Counsel's implementation note for this page is app work, not site work:
 * the table must also render on the booking confirmation screen, before the
 * member pays, because Terms of Use §6 promises it.
 */
export default function CancellationPage() {
  return <SitePolicyDocument kind="cancellation" />;
}
