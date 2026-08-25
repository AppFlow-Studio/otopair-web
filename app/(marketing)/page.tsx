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
    </main>
  );
}
