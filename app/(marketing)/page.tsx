import PillNav from "@/components/flagship/pill-nav";
import FlagshipHero from "@/components/flagship/flagship-hero";
import WhyOtoSection from "@/components/flagship/landing/why-oto-section";
import PriceLockSection from "@/components/flagship/landing/price-lock-section";
import PayoutSection from "@/components/flagship/landing/payout-section";
import CoverageSection from "@/components/flagship/landing/coverage-section";
import ListensSection from "@/components/flagship/landing/listens-section";
import PathSection from "@/components/flagship/landing/path-section";
import FooterCta from "@/components/flagship/landing/footer-cta";

export default function Home() {
  return (
    <main className="min-h-screen w-full bg-white">
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
    </main>
  );
}
