import PillNav from "@/components/flagship/pill-nav";
import TabletScale from "@/components/flagship/landing/tablet-scale";
import FlagshipHero from "@/components/flagship/flagship-hero";
import WhyOtoSection from "@/components/flagship/landing/why-oto-section";
import PriceLockSection from "@/components/flagship/landing/price-lock-section";
import PayoutSection from "@/components/flagship/landing/payout-section";
import CoverageSection from "@/components/flagship/landing/coverage-section";
import ListensSection from "@/components/flagship/landing/listens-section";
import PathSection from "@/components/flagship/landing/path-section";
import FooterCta from "@/components/flagship/landing/footer-cta";
import type { Metadata } from "next";

// Homepage metadata (site audit 2026-08-31, Phase 1). `absolute` bypasses the
// root "%s — Otopair" template so the brand isn't doubled. Title carries the
// service + market keywords the audit found missing; the H1 stays the brand
// line by design.
const HOME_TITLE = "Otopair — Car repair at a locked price, Staten Island NY";
const HOME_DESCRIPTION =
  "Tell Oto what your car is doing and book a verified Staten Island mechanic at a price locked before you pay — no phone tag, no surprises at pickup.";

// No `openGraph` block here on purpose: a page-level openGraph object
// replaces the root's wholesale, which drops the file-based og:image from
// app/opengraph-image.tsx (verified 2026-09-04). og:title / og:description
// fall back to title / description anyway.
export const metadata: Metadata = {
  title: { absolute: HOME_TITLE },
  description: HOME_DESCRIPTION,
  alternates: { canonical: "/" },
};

export default function Home() {
  return (
    <TabletScale className="min-h-screen w-full bg-white">
      {/* The fixed glass nav must NOT live inside the hero: the hero section
          is overflow-hidden, and Chromium drops a backdrop-filter's backdrop
          for a fixed element inside a scrolled overflow-clipped ancestor —
          the pill went crisp (no blur) as soon as the page scrolled
          (design feedback 2026-09-03). */}
      <PillNav />
      {/* `isolate`: Chromium does not fold OTHER backdrop-filter elements into
          a backdrop-filter's snapshot, so every glass card scrolling under the
          pill (chat card, voice bar, demo cards…) rendered crisp through it.
          An isolated wrapper flattens the whole page into one surface first,
          and the pill blurs that (design feedback 2026-09-03). */}
      <div className="isolate">
        <FlagshipHero />
        <div className="w-full bg-white">
          <WhyOtoSection />
          <PriceLockSection />
          <PayoutSection />
          <CoverageSection />
          <ListensSection />
          <PathSection />
          <FooterCta />
        </div>
      </div>
    </TabletScale>
  );
}
