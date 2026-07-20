import type { Metadata } from "next";
import { DevelopersClient } from "./developers-client";

// Self-serve developer portal — Clerk sign-up → mint your own Data-API key →
// dashboard with usage + full endpoint reference. Backed by convex/devPortal
// (every function ctx.auth-gated; free tier: one key, 60 req/min).

export const metadata: Metadata = {
  title: "Developers — Otopair Car Data API",
  description:
    "Self-serve API access to Otopair's vehicle-data asset: maintenance specs, OEM service intervals, exact-fit parts, real-world labor times and vehicle images — by VIN, year/make/model, or config key.",
};

export default function DevelopersPage() {
  return <DevelopersClient />;
}
