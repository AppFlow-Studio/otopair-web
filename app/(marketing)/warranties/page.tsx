import type { Metadata } from "next";
import { SitePolicyDocument } from "@/components/legal/legal-document";
import { sitePolicyMetadata } from "@/lib/legal";

export const metadata: Metadata = sitePolicyMetadata("warranties");

/**
 * Warranties and Service Issues, from counsel's Site Policy Pages v1
 * (prepared 2026-09-14); wording in content/legal/site-policy-pages.md. It
 * replaces /warranty, which now redirects here (next.config.ts). Counsel:
 * never "guarantee", "covered" or "make it right" on this page or in support
 * macros — readSitePolicyPage refuses to render it if one appears.
 */
export default function WarrantiesPage() {
  return <SitePolicyDocument kind="warranties" />;
}
