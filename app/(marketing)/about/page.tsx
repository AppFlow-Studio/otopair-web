import type { Metadata } from "next";
import Link from "next/link";
import PageShell from "@/components/flagship/page-shell";
import { PillLink, TextLink } from "@/components/flagship/pill-button";
import { FaqList, type FaqItem } from "@/components/seo/faq";
import { JsonLd } from "@/components/seo/json-ld";
import { LEGAL_NAME, LOCALITY, SITE_NAME, SUPPORT_EMAIL } from "@/lib/site";
import { BOROUGHS } from "@/lib/coverage";

export const metadata: Metadata = {
  title: { absolute: "About Otopair: fixed-price car repair, built in Staten Island" },
  description:
    "Otopair is a trust-first car repair marketplace operated by AppFlow Creations Inc. in Staten Island, NY. Drivers see a shop's full price before they book, and that price is locked.",
  alternates: { canonical: "/about" },
};

/**
 * /about (design pass 2026-09-05): entity grounding, written entity-first
 * so a model or a crawler can lift any paragraph as a self-contained
 * statement of what Otopair is. Company facts come from lib/site.ts. No
 * decorative object in the hero: the company has no photograph of itself
 * yet, and a logo in a frame said nothing. One editorial list.
 */
/** Two questions the rows above do not already answer. The entity facts
 *  (what, who, where) live in the rows themselves, once. */
const FAQ: FaqItem[] = [
  {
    q: "How is Otopair different from calling around?",
    a: "The price is set by the shop, shown in full before you confirm, and locked when you book. Any extra work has to be approved by you in the app. There is no negotiating at the counter and no surprise at pickup.",
  },
  {
    q: "Is Otopair available outside New York City?",
    a: "No. Otopair operates in New York City only: Staten Island is live, and the other four boroughs open one at a time on the coverage timeline. Nothing beyond the five boroughs has been announced.",
  },
];

const H2 = "serif-display max-w-[16ch] text-[32px] leading-[1.04] tracking-[-0.01em] text-[#1a1a1a] [text-wrap:balance] tab:text-[38px]";
const ROW = "grid gap-2 py-6 tab:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] tab:gap-x-10 tab:py-7";
const TERM = "serif-text text-[21px] leading-[1.3] text-[#1a1a1a] [text-wrap:balance]";
const ANSWER =
  "max-w-[60ch] text-[16px] leading-[1.6] text-[#4c5661] [&_p+p]:mt-3 [&_a]:text-[#4B82A5] [&_a]:underline [&_a]:decoration-[#4B82A5]/40 [&_a]:underline-offset-[3px] [&_a:hover]:decoration-[#4B82A5] [&_ul]:mt-3 [&_ul]:flex [&_ul]:flex-col [&_ul]:gap-1.5 [&_ul]:pl-5 [&_li]:relative [&_li]:before:absolute [&_li]:before:-left-5 [&_li]:before:top-[0.8em] [&_li]:before:h-px [&_li]:before:w-2.5 [&_li]:before:bg-[#4B82A5]";

export default function AboutPage() {
  return (
    <PageShell
      title="The price you see is the price you pay."
      lede={`A trust-first car repair marketplace, operated by ${LEGAL_NAME} in ${LOCALITY.city}, ${LOCALITY.region}, built to end the counter surprise.`}
      crumbs={[
        { name: "Home", href: "/" },
        { name: "About", href: "/about" },
      ]}
      hero={
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <PillLink href="/how-it-works">How a booking runs</PillLink>
          <TextLink href="/press">Press kit</TextLink>
        </div>
      }
      heroAlign="start"
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

      <section id="details" className="scroll-mt-28">
        <h2 className={H2}>Otopair, in plain terms.</h2>
        <dl className="mt-8 flex flex-col divide-y divide-[#1a1a1a]/10 border-b border-[#1a1a1a]/10">
          <div className={ROW} id="what">
            <dt className={TERM}>What Otopair is</dt>
            <dd className={ANSWER}>
              <p>
                Otopair connects drivers with independent repair shops that Otopair has verified. A driver tells Oto,
                the in-app assistant, what the car is doing. Oto turns that into a job a shop can price, shows the
                verified shops nearby with the total each one set, and locks that total when the driver books. A
                deposit holds the appointment; the locked price is what the driver pays; extra work needs the
                driver&rsquo;s approval in the app before it happens.
              </p>
              <p>
                Otopair is a marketplace, not a garage. The shop does the repair, sets the price and owns the
                relationship. Otopair verifies the shop, locks the price, settles the payment through Stripe and keeps
                the record.
              </p>
            </dd>
          </div>
          <div className={ROW} id="why">
            <dt className={TERM}>Why it exists</dt>
            <dd className={ANSWER}>
              <p>
                Getting a car fixed usually means calling three shops, describing the noise three times, getting three
                different guesses and finding out the real number at pickup. Shops, for their part, spend the day on
                the phone with people who never show. Otopair replaces both halves of that with one scoped job, one
                price, one booking.
              </p>
            </dd>
          </div>
          <div className={ROW} id="where">
            <dt className={TERM}>Where it operates</dt>
            <dd className={ANSWER}>
              <p>
                Otopair went live in {LOCALITY.city} in 2026 and opens New York City one borough at a time, each
                borough only once it has verified shops to book from.
              </p>
              <ul>
                {BOROUGHS.map((b) => (
                  <li key={b.slug}>
                    <Link href={`/${b.slug}`}>{b.name}</Link>: {b.live ? "live now" : `planned ${b.date}`}
                  </li>
                ))}
              </ul>
            </dd>
          </div>
          <div className={ROW} id="company">
            <dt className={TERM}>The company</dt>
            <dd className={ANSWER}>
              <p>
                {SITE_NAME} is a product of {LEGAL_NAME}, based in {LOCALITY.city}, {LOCALITY.region}. The team builds
                the driver app for iOS and Android (store listings are on the way), the shop dashboard, Oto, and the
                vehicle-data asset behind them. Press and partnership inquiries go to{" "}
                <a href={`mailto:${SUPPORT_EMAIL}?subject=Press`}>{SUPPORT_EMAIL}</a>; brand assets are on the{" "}
                <Link href="/press">press page</Link>.
              </p>
            </dd>
          </div>
        </dl>
        <FaqList items={FAQ} className="[&>div:first-child]:pt-6 tab:[&>div:first-child]:pt-7 [&_dd]:max-w-[60ch]" />
      </section>
    </PageShell>
  );
}
