import type { Metadata } from "next";
import Link from "next/link";
import PageShell from "@/components/flagship/page-shell";
import { ComingSoonPlates } from "@/components/flagship/download-app";
import { HeroPhone } from "@/components/flagship/local-sections";
import { OtoListening, PhoneRow, WhereItWorks } from "@/components/flagship/editorial-sections";
import { BookShopsScreen } from "@/components/flagship/product/screens/book";
import { MyCarsScreen } from "@/components/flagship/product/screens/cars";
import { ReviewPayScreen } from "@/components/flagship/product/screens/pay";
import WaitlistForm from "@/components/flagship/waitlist-form";
import { FaqList, type FaqItem } from "@/components/seo/faq";
import { JsonLd } from "@/components/seo/json-ld";
import { listPublicShops, onStatenIsland } from "@/lib/public-shops";
import { SectionHead } from "../pricing/sections";

export const metadata: Metadata = {
  title: { absolute: "Get the Otopair app: iPhone and Android" },
  description:
    "Download Otopair for iOS or Android: talk to Oto about what your car is doing, get locked prices from verified Staten Island shops, and book in about 90 seconds.",
  alternates: { canonical: "/download" },
};

// The rail's live shop count refreshes every 5 minutes.
export const revalidate = 300;

/**
 * /download (design pass 2026-09-05, the app up close): the #get-oto anchor
 * as a URL for app-install intent. The hero is the app itself, Oto
 * listening, with the launch list and the store plates under the lede;
 * "what you get" is three real screens with one line each; "where it
 * works" is the borough rail. The store badges come from download-app.tsx,
 * which renders a "coming soon" plate while the listings are placeholders,
 * so the page is truthful before and after they go live.
 */
const FAQ: FaqItem[] = [
  {
    q: "Is the Otopair app free?",
    a: "Yes. Downloading the app, talking to Oto and getting prices from shops costs nothing. You pay only when you book a job, and the price you pay is the one the shop set and you confirmed.",
  },
  {
    q: "Which phones does Otopair support?",
    a: "iPhone (iOS) and Android. There is no web booking for drivers; the app is where Oto, the price lock and the booking live. Repair shops use a separate web dashboard.",
  },
  {
    q: "What does Oto do in the app?",
    a: "Oto is the assistant you talk to, by text or voice. It asks about the symptom, turns the problem into a job a shop can quote, and hands you to the booking flow, where you see verified shops and the full total before you confirm. Oto is a guide, not a mechanic: it never quotes a price itself and never walks you through a repair.",
  },
];

const H2 = "serif-display max-w-[14ch] text-[32px] leading-[1.04] tracking-[-0.01em] text-[#1a1a1a] [text-wrap:balance] tab:text-[40px]";

export default async function DownloadPage() {
  let liveCount: number | null = null;
  try {
    liveCount = (await listPublicShops()).filter(onStatenIsland).length;
  } catch {
    liveCount = null;
  }
  return (
    <PageShell
      title="Car repair, price locked, in your pocket."
      lede="Tell Oto what your car is doing, get fixed prices from verified shops nearby, and pay the price you saw. Leave your email for launch day."
      crumbs={[
        { name: "Home", href: "/" },
        { name: "Download", href: "/download" },
      ]}
      visual={
        <HeroPhone>
          <OtoListening />
        </HeroPhone>
      }
      visualFrame={false}
      hero={
        <div className="flex w-full flex-col items-start gap-4">
          <WaitlistForm list="app" />
          <ComingSoonPlates className="justify-start" />
        </div>
      }
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

      {/* ---------- What you get: three screens, one line each ---------- */}
      <section className="pb-16 tab:pb-24">
        <SectionHead id="what" title="What you get in the app." line="Prices from real shops, a total that is locked before the car goes in, and a record that stays with the car. Oto is the way in; the booking is the point." />
        <div className="mt-10 tab:mt-14">
          <PhoneRow
            items={[
              { caption: "Prices from real shops", sub: "Each verified shop sets its own price. You see the full amount each one would charge for this job on this car, side by side.", screen: <BookShopsScreen picked={0} /> },
              { caption: "A locked price", sub: "What you confirm is what you pay. A $20 hold reserves the slot; extra work needs your approval in the app first.", screen: <ReviewPayScreen compact /> },
              { caption: "Your car's record", sub: "Every job, receipt and inspection stays with the vehicle, and the health score reads from it.", screen: <MyCarsScreen /> },
            ]}
          />
        </div>
      </section>

      {/* ---------- Where it works ---------- */}
      <section className="py-16 tab:py-24">
        <SectionHead id="where" title="Where does it work?" line="Staten Island today; the rest of New York City borough by borough, each one once it has verified shops to book from." />
        <div className="mt-10 tab:mt-14">
          <WhereItWorks liveCount={liveCount} />
        </div>
        <p className="mt-6 text-[15px] text-[#4c5661]">
          The{" "}
          <Link href="/coverage" className="text-[#4B82A5] underline decoration-[#4B82A5]/40 underline-offset-[3px] hover:decoration-[#4B82A5]">
            coverage page
          </Link>{" "}
          has the ladder and the waitlists.
        </p>
      </section>

      <section id="faq" className="scroll-mt-28 border-t border-[#1a1a1a]/10 pt-14 tab:pt-20">
        <h2 className={H2}>Questions people ask.</h2>
        <FaqList items={FAQ} className="mt-8 border-b border-[#1a1a1a]/10 [&_dd]:max-w-[60ch]" />
      </section>
    </PageShell>
  );
}
