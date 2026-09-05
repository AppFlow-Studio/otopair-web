import type { Metadata } from "next";
import { CarDataClient } from "./car-data-client";

// Public car-data teaser — anonymous vehicle lookup over the Otopair
// vehicle-data asset. Serves the layer-gated teaser subset only
// (convex/dataPublic.teaserLookup); the full dataset is the product.

export const metadata: Metadata = {
  title: { absolute: "Car Data — Otopair" },
  description:
    "Look up any car by VIN or year, make and model: maintenance specs, OEM service intervals, parts and real-world labor times — built from verified shop data.",
  alternates: { canonical: "/car-data" },
  openGraph: {
    title: "Car Data — Otopair",
    description:
      "Maintenance specs, OEM intervals, parts and real-world labor times for your exact car.",
    // A page-level openGraph object replaces the root's, which would drop the
    // file-based og:image — re-point at it explicitly.
    images: ["/opengraph-image"],
  },
};

export default function CarDataPage() {
  return <CarDataClient />;
}
