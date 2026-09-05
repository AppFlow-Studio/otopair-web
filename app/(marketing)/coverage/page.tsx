import type { Metadata } from "next";
import Link from "next/link";
import PageShell from "@/components/flagship/page-shell";
import NetworkMap from "@/components/flagship/landing/network-map";
import { Ladder } from "@/components/flagship/ladder";
import { PillLink, TextLink } from "@/components/flagship/pill-button";
import { FaqList, type FaqItem } from "@/components/seo/faq";
import { JsonLd } from "@/components/seo/json-ld";
import { BOROUGHS, LIVE_BOROUGHS } from "@/lib/coverage";

export const metadata: Metadata = {
  title: { absolute: "Where Otopair is available: Staten Island now, NYC boroughs next" },
  description:
    "Otopair is live in Staten Island, NY. Brooklyn opens Q4 2026, then Queens, The Bronx and Manhattan. See the live shop map and join a borough waitlist.",
  alternates: { canonical: "/coverage" },
};

/**
 * /coverage (design pass 2026-09-05): the landing's #coverage anchor as its
 * own URL. The live network map is the hero object, framed once; the
 * borough ladder is the one sequence on the page; the two explainers and
 * the FAQ share one editorial list. No city render: the map is the
 * subject, and it is real.
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
const PROSE =
  "max-w-[62ch] text-[17px] leading-[1.65] text-[#4c5661] [text-wrap:pretty] [&_p+p]:mt-4 [&_a]:text-[#4B82A5] [&_a]:underline [&_a]:decoration-[#4B82A5]/40 [&_a]:underline-offset-[3px] [&_a:hover]:decoration-[#4B82A5]";
const ROW = "grid gap-2 py-6 tab:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] tab:gap-x-10 tab:py-7";
const TERM = "serif-text text-[21px] leading-[1.3] text-[#1a1a1a] [text-wrap:balance]";
const ANSWER =
  "max-w-[60ch] text-[16px] leading-[1.6] text-[#4c5661] [&_p+p]:mt-3 [&_a]:text-[#4B82A5] [&_a]:underline [&_a]:decoration-[#4B82A5]/40 [&_a]:underline-offset-[3px] [&_a:hover]:decoration-[#4B82A5]";

export default function CoveragePage() {
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

      {/* ---------- The ladder: the one sequence on the page ---------- */}
      <section id="ladder" className="scroll-mt-28">
        <h2 className={H2}>Which borough is next.</h2>
        <p className={`mt-6 ${PROSE}`}>
          Brooklyn, then Queens, The Bronx and Manhattan. Each borough page takes waitlist signups now, so you get one
          email the day its first shops go live.
        </p>
        <Ladder
          direction="row"
          className="mt-10"
          steps={BOROUGHS.map((b) => ({
            title: b.name,
            body: (
              <>
                <span className="block text-[13px] tracking-[0.08em] text-[#4B82A5]">{b.live ? "LIVE NOW" : b.date.toUpperCase()}</span>
                <span className="mt-2 block">{b.blurb}</span>
                <Link
                  href={`/${b.slug}`}
                  className="mt-3 inline-block text-[14px] text-[#4B82A5] underline decoration-[#4B82A5]/40 underline-offset-[3px] hover:decoration-[#4B82A5]"
                >
                  {b.live ? `Shops in ${b.name}` : `Join the ${b.name} waitlist`}
                </Link>
              </>
            ),
          }))}
        />
      </section>

      {/* ---------- The details and the questions: one editorial list ---------- */}
      <section id="details" className="mt-16 scroll-mt-28 border-t border-[#1a1a1a]/10 pt-16 lg:mt-24 lg:pt-24">
        <h2 className={H2}>The details, in plain terms.</h2>
        <dl className="mt-8 flex flex-col divide-y divide-[#1a1a1a]/10 border-b border-[#1a1a1a]/10">
          <div className={ROW} id="how">
            <dt className={TERM}>How does a borough go live?</dt>
            <dd className={ANSWER}>
              <p>
                Shops first, drivers second. Otopair verifies shops in a borough before it opens booking there, so the
                first thing a driver sees is a real network, not an empty map. Shops anywhere in New York City can{" "}
                <Link href="/apply">apply now</Link>; the ones verified ahead of their borough&rsquo;s quarter are live
                on opening day. The map above is the same network map as the home page, and the{" "}
                <Link href="/shops">shop directory</Link> lists the verified shops with hours and services.
              </p>
              <p>
                Live today:{" "}
                {LIVE_BOROUGHS.map((b) => (
                  <Link key={b.slug} href={`/${b.slug}`}>
                    {b.name}
                  </Link>
                ))}
                .
              </p>
            </dd>
          </div>
        </dl>
        <FaqList items={FAQ} className="[&>div:first-child]:pt-6 tab:[&>div:first-child]:pt-7 [&_dd]:max-w-[60ch]" />
      </section>
    </PageShell>
  );
}
