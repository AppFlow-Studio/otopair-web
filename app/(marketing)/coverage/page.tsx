import type { Metadata } from "next";
import Link from "next/link";
import PageShell from "@/components/flagship/page-shell";
import NetworkMap from "@/components/flagship/landing/network-map";
import { CoverageSections } from "@/components/flagship/local-sections";
import { PillLink, TextLink } from "@/components/flagship/pill-button";
import { FaqList, type FaqItem } from "@/components/seo/faq";
import { JsonLd } from "@/components/seo/json-ld";
import { listPublicShops, onStatenIsland } from "@/lib/public-shops";

export const metadata: Metadata = {
  title: { absolute: "Where Otopair is available: Staten Island now, NYC boroughs next" },
  description:
    "Otopair is live in Staten Island, NY. Brooklyn opens Q4 2026, then Queens, The Bronx and Manhattan. See the live shop map and join a borough waitlist.",
  alternates: { canonical: "/coverage" },
};

// The live shop count on the rail refreshes every 5 minutes.
export const revalidate = 300;

/**
 * /coverage (design pass 2026-09-05, the app up close): the landing's
 * #coverage anchor as its own URL. The live network map is the hero
 * object; the five boroughs run as one rail with the live one carrying
 * the real verified-shop count and the first segment drawing itself in;
 * "shops first, drivers second" shows the shop dashboard's rates page,
 * the thing a shop sets up before its borough opens. The questions stay
 * in one editorial list.
 */
const FAQ: FaqItem[] = [
  {
    q: "Where is Otopair available right now?",
    a: "Staten Island, New York. Every shop you can book in the app today is an independent shop on Staten Island that the Otopair team has approved and that is taking bookings. Drivers from anywhere can book a Staten Island shop.",
  },
  {
    q: "When is Otopair coming to Brooklyn, Queens, The Bronx and Manhattan?",
    a: "Brooklyn is planned for Q4 2026, Queens for Q1 2027, The Bronx for Q2 2027 and Manhattan for Q3 2027. A borough opens once enough verified shops are on the network to book from; each borough page has a waitlist that emails you when the first shops go live.",
  },
  {
    q: "Does Otopair come to my location?",
    a: "No. Otopair is a marketplace for booking a shop, not a mobile mechanic. You bring the car to the shop you booked, at the time you booked, and the price is locked before you go.",
  },
  {
    q: "Which neighborhoods on Staten Island are covered?",
    a: "The whole island. Shops are concentrated along the North Shore, the Hylan corridor and the South Shore. The Staten Island page lists every verified shop with its nearest neighborhood, and the shop directory has each one's hours and services.",
  },
];

const H2 = "serif-display max-w-[16ch] text-[32px] leading-[1.04] tracking-[-0.01em] text-[#1a1a1a] [text-wrap:balance] tab:text-[38px]";

export default async function CoveragePage() {
  let liveCount: number | null = null;
  try {
    liveCount = (await listPublicShops()).filter(onStatenIsland).length;
  } catch {
    liveCount = null;
  }
  return (
    <PageShell
      title={
        <>
          Staten Island now.
          <br />
          Four boroughs next.
        </>
      }
      lede="One borough at a time, each opening once it has verified shops. Where the network is today, and where next."
      crumbs={[
        { name: "Home", href: "/" },
        { name: "Coverage", href: "/coverage" },
      ]}
      hero={
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <PillLink href="/staten-island">See the Staten Island shops</PillLink>
          <TextLink href="/brooklyn">Join the Brooklyn waitlist</TextLink>
        </div>
      }
      visual={<NetworkMap frame={false} className="aspect-[5/4]" />}
      width="wide"
    >
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "FAQPage",
          mainEntity: FAQ.map((it) => ({
            "@type": "Question",
            name: it.q,
            acceptedAnswer: { "@type": "Answer", text: it.a },
          })),
        }}
      />

      <CoverageSections liveCount={liveCount} />

      {/* ---------- The questions ---------- */}
      <section id="details" className="scroll-mt-28 border-t border-[#1a1a1a]/10 pt-14 tab:pt-20">
        <h2 className={H2}>Questions drivers ask.</h2>
        <FaqList items={FAQ} className="mt-8 border-b border-[#1a1a1a]/10 [&_dd]:max-w-[60ch]" />
        <p className="mt-8 text-[15px] text-[#4c5661]">
          The map above is the same live network map as the home page. The{" "}
          <Link href="/shops" className="text-[#4B82A5] underline decoration-[#4B82A5]/40 underline-offset-[3px] hover:decoration-[#4B82A5]">
            shop directory
          </Link>{" "}
          lists every verified shop with hours and services, and{" "}
          <Link href="/apply" className="text-[#4B82A5] underline decoration-[#4B82A5]/40 underline-offset-[3px] hover:decoration-[#4B82A5]">
            applications
          </Link>{" "}
          are open to shops anywhere in New York City.
        </p>
      </section>
    </PageShell>
  );
}
