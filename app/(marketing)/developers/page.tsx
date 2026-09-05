import type { Metadata } from "next";
import PageShell from "@/components/flagship/page-shell";
import { DevelopersClient } from "./developers-client";

// Self-serve developer portal — Clerk sign-up → mint your own Data-API key →
// dashboard with usage + full endpoint reference. Backed by convex/devPortal
// (every function ctx.auth-gated; free tier: one key, 60 req/min).

export const metadata: Metadata = {
  title: { absolute: "Developers — Otopair Car Data API" },
  description:
    "Self-serve API access to Otopair's vehicle-data asset: maintenance specs, OEM service intervals, exact-fit parts, real-world labor times and vehicle images — by VIN, year/make/model, or config key.",
  alternates: { canonical: "/developers" },
};

/**
 * Design pass 2026-09-05: the portal on the page shell (nav, hero, closing
 * band), the beige canvas and the app's blue gone. Sign-up, key minting and
 * the Reference are untouched; the signed-out hero copy moved up here.
 */
export default function DevelopersPage() {
  return (
    <PageShell
      title="Build on real car data."
      lede="Maintenance specs, OEM service intervals, exact-fit parts, real-world labor times and vehicle images, by VIN, year, make and model, or config key. Every value carries tracked provenance. Sign up and mint your key in under a minute."
      crumbs={[
        { name: "Home", href: "/" },
        { name: "Developers", href: "/developers" },
      ]}
      heroAlign="start"
      width="wide"
    >
      <DevelopersClient />
    </PageShell>
  );
}
