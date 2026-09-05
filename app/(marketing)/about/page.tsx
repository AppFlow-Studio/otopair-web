import type { Metadata } from "next";
import Link from "next/link";
import PageShell from "@/components/flagship/page-shell";
import { PillLink, TextLink } from "@/components/flagship/pill-button";
import { DataProvenance, TwoSides } from "@/components/flagship/editorial-sections";
import { Plate } from "@/components/flagship/product/device";
import { FaqList, type FaqItem } from "@/components/seo/faq";
import { JsonLd } from "@/components/seo/json-ld";
import { BOOKABLE_SERVICE_COUNT } from "@/lib/service-catalog";
import { LEGAL_NAME, LOCALITY, SITE_NAME, SUPPORT_EMAIL } from "@/lib/site";
import { BOROUGHS } from "@/lib/coverage";

export const metadata: Metadata = {
  title: { absolute: "About Otopair: fixed-price car repair, built in Staten Island" },
  description:
    "Otopair is a trust-first car repair marketplace operated by AppFlow Creations Inc. in Staten Island, NY. What it is, why it exists, the rules it holds itself to, what it builds, and what it deliberately is not.",
  alternates: { canonical: "/about" },
};

/**
 * /about (design pass 2026-09-05; expanded 2026-09-05 evening): entity
 * grounding, written entity-first so a model or a crawler can lift any
 * paragraph as a self-contained statement of what Otopair is. Company facts
 * come from lib/site.ts; every product claim is one the product enforces
 * and is stated the same way on the page that owns it (trust-and-safety,
 * how-shops-are-verified, the cancellation policy).
 *
 * Two product objects: the same booking as the driver and the shop see it,
 * and the provenance card for the vehicle-data asset. Everything else is
 * editorial, because this page's job is to be quotable, not to demo.
 */
const FAQ: FaqItem[] = [
  {
    q: "How is Otopair different from calling around?",
    a: "The price is set by the shop, shown in full before you confirm, and locked when you book. Any extra work has to be approved by you in the app. There is no negotiating at the counter and no surprise at pickup.",
  },
  {
    q: "Does Otopair employ the mechanics?",
    a: "No. Every shop on Otopair is an independent business that Otopair reviewed and approved. The shop hires its own mechanics, sets its own prices, does the work and stands behind it. Otopair verifies the shop, locks the price, settles the payment through Stripe and keeps the record of the job.",
  },
  {
    q: "How does Otopair make money?",
    a: "A service fee on each completed booking. It is already inside the total you see before you confirm, so it is not added at the counter, and shops pay no subscription and no setup fee to be on the network.",
  },
  {
    q: "Is Otopair available outside New York City?",
    a: "No. Otopair operates in New York City only: Staten Island is live, and the other four boroughs open one at a time on the coverage timeline. Nothing beyond the five boroughs has been announced.",
  },
  {
    q: "Who is behind Otopair?",
    a: "Otopair is a product of AppFlow Creations Inc., a small team based in Staten Island, NY. The team builds the driver app, the shop dashboard, Oto and the vehicle-data asset behind them. Press and partnership inquiries go to support@otopair.com.",
  },
];

/** The rules, and the thing in the product that enforces each one. Every
 *  line here is stated the same way on /trust-and-safety. */
const RULES: { rule: string; how: string }[] = [
  {
    rule: "The total you approve is a ceiling.",
    how: "Your approved total and the running ceiling are stripped on the server before a booking reaches any mechanic or shop screen, so an estimate cannot be anchored to your number. It is enforced in the data layer, not hidden in the interface.",
  },
  {
    rule: "Anything above it needs your yes.",
    how: "Added work arrives in the app as a request with the new total. You have 24 hours to approve or decline, and the shop cannot proceed above the ceiling while it waits.",
  },
  {
    rule: "Declined work is never charged.",
    how: "Decline, and those lines are removed from the booking. A mid-job request left unanswered leaves the job at the last approved price and the added work is not done.",
  },
  {
    rule: "A $20 hold is the most held before the shop sees the car.",
    how: "It is an authorization, not a charge. After inspection the hold is raised to the confirmed price, and nothing is captured until the shop marks the job complete.",
  },
  {
    rule: "Reviews come only from completed bookings.",
    how: "One way, once per booking. Shops do not review drivers and cannot edit or remove a review of themselves. Leaving one earns the same small credit whatever the rating, so the credit rewards writing a review, not writing a kind one.",
  },
  {
    rule: "No fee is hidden, and nothing is sold on urgency.",
    how: "The total includes parts, labor, tax and Otopair’s service fee. No upsells, no countdowns, no scarcity, no marketing blasts, and your data is never sold or rented.",
  },
];

/** What Otopair deliberately is not. Each line is the honest boundary the
 *  page that owns it also states. */
const NOT: { claim: string; body: string; href: string; label: string }[] = [
  {
    claim: "Not a garage.",
    body: "The shop does the repair, sets the price and owns the relationship with you. Otopair verifies the shop, locks the price and keeps the record.",
    href: "/how-shops-are-verified",
    label: "The verification standard",
  },
  {
    claim: "Not a mobile mechanic.",
    body: "You bring the car to the shop you booked, at the time you booked. Nobody is dispatched to your driveway.",
    href: "/how-it-works",
    label: "How a booking runs",
  },
  {
    claim: "Not a diagnosis.",
    body: "Oto is a guide that turns a symptom into a job a shop can price; the mechanic decides what the car needs. The Vehicle Health Score grades upkeep, and it is not a safety rating.",
    href: "/oto",
    label: "What Oto does",
  },
  {
    claim: "Not a licence or insurance check.",
    body: "Verified means Otopair reviewed and approved the shop. It does not certify licences, insurance or mechanic credentials, and the standard says so in full.",
    href: "/how-shops-are-verified",
    label: "What is not checked",
  },
  {
    claim: "Not a price list.",
    body: "Otopair publishes no averages, ranges or starting prices, because none of them would be the price you pay. The number is built for your exact car in the app.",
    href: "/pricing",
    label: "How pricing works",
  },
  {
    claim: "Not a dealership network.",
    body: "Warranty repairs and safety recalls belong at your manufacturer’s dealer. Otopair is independent shops, for the out-of-warranty work that is most of a car’s life.",
    href: "/guides/dealership-vs-independent-mechanic",
    label: "Dealership or independent",
  },
];

const H2 = "serif-display max-w-[16ch] text-[32px] leading-[1.04] tracking-[-0.01em] text-[#1a1a1a] [text-wrap:balance] tab:text-[38px]";
const LEAD = "max-w-[46ch] text-[17px] leading-[1.55] text-[#4c5661] [text-wrap:pretty]";
const PROSE =
  "max-w-[62ch] text-[17px] leading-[1.65] text-[#4c5661] [text-wrap:pretty] [&_p+p]:mt-4 [&_a]:text-[#4B82A5] [&_a]:underline [&_a]:decoration-[#4B82A5]/40 [&_a]:underline-offset-[3px] [&_a:hover]:decoration-[#4B82A5]";
const ROW = "grid gap-2 py-6 tab:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] tab:gap-x-10 tab:py-7";
const TERM = "serif-text text-[21px] leading-[1.3] text-[#1a1a1a] [text-wrap:balance]";
const ANSWER =
  "max-w-[60ch] text-[16px] leading-[1.6] text-[#4c5661] [&_p+p]:mt-3 [&_a]:text-[#4B82A5] [&_a]:underline [&_a]:decoration-[#4B82A5]/40 [&_a]:underline-offset-[3px] [&_a:hover]:decoration-[#4B82A5] [&_ul]:mt-3 [&_ul]:flex [&_ul]:flex-col [&_ul]:gap-1.5 [&_ul]:pl-5 [&_li]:relative [&_li]:before:absolute [&_li]:before:-left-5 [&_li]:before:top-[0.8em] [&_li]:before:h-px [&_li]:before:w-2.5 [&_li]:before:bg-[#4B82A5]";

/** A section head on the twelve-column grid: claim left, one line right. */
function Head({ id, title, line }: { id: string; title: string; line: string }) {
  return (
    <div id={id} className="grid scroll-mt-28 gap-3 tab:grid-cols-12 tab:items-end tab:gap-8">
      <h2 className={`${H2} tab:col-span-6`}>{title}</h2>
      <p className={`${LEAD} tab:col-span-5 tab:col-start-8 tab:pb-1`}>{line}</p>
    </div>
  );
}

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

      {/* ---------- Jump row: the page runs long, so give it a skip ---------- */}
      <nav aria-label="On this page" className="mb-14 tab:mb-16">
        <ul className="flex flex-wrap gap-2">
          {[
            ["what", "What it is"],
            ["why", "Why it exists"],
            ["rules", "The rules"],
            ["build", "What we build"],
            ["not", "What it is not"],
            ["where", "The details"],
          ].map(([id, label]) => (
            <li key={id}>
              <a
                href={`#${id}`}
                className="inline-flex h-9 items-center rounded-full border border-[#1a1a1a]/10 bg-white px-4 text-[14px] text-[#1a1a1a] transition-colors hover:border-[#4B82A5]/50"
              >
                {label}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      {/* ---------- What it is ---------- */}
      <section className="scroll-mt-28">
        <Head
          id="what"
          title="What Otopair is."
          line="A marketplace between drivers who need a repair and independent shops that have been reviewed and approved to take it."
        />
        <div className={`mt-8 ${PROSE}`}>
          <p>
            A driver tells Oto, the in-app assistant, what the car is doing. Oto turns that into a job a shop can
            price, shows the verified shops nearby with the total each one set for that exact car, and locks that
            total when the driver books. A $20 hold reserves the slot. The locked price is what the driver pays, and
            extra work needs the driver&rsquo;s approval in the app before it happens.
          </p>
          <p>
            Otopair is not a garage. The shop does the repair, sets its own labor rate, chooses which of the{" "}
            {BOOKABLE_SERVICE_COUNT} bookable services it offers, and owns the relationship with the driver. Otopair
            verifies the shop, scopes the job, locks the price, settles the payment through Stripe and keeps the
            record of what was done.
          </p>
        </div>
      </section>

      {/* ---------- Why it exists ---------- */}
      <section className="mt-16 scroll-mt-28 border-t border-[#1a1a1a]/10 pt-16 tab:mt-20 tab:pt-20">
        <Head
          id="why"
          title="Why it exists."
          line="Both sides of a repair are broken in the same place: nobody knows the number until it is too late to argue with it."
        />
        <div className="mt-10 grid gap-10 tab:grid-cols-2 tab:gap-14">
          <div>
            <h3 className="serif-text text-[22px] leading-[1.2] text-[#1a1a1a]">For the driver</h3>
            <div className={`mt-4 ${PROSE} max-w-[46ch]`}>
              <p>
                Getting a car fixed usually means calling three shops, describing the same noise three times, and
                getting three guesses that are not comparable because none of them is a price. You drop the car off
                without knowing what you are agreeing to, and you find out the real number when you come to collect
                it, standing at a counter with your keys behind it.
              </p>
              <p>
                The parts you cannot check are the parts that cost you: whether the job was needed, whether the rate
                is the rate, whether the extra line was ever discussed.
              </p>
            </div>
          </div>
          <div>
            <h3 className="serif-text text-[22px] leading-[1.2] text-[#1a1a1a]">For the shop</h3>
            <div className={`mt-4 ${PROSE} max-w-[46ch]`}>
              <p>
                The other half of that call is a mechanic wiping their hands to answer a phone, quoting a car they
                cannot see, for a person who may never arrive. Good shops lose the day to the phone and the schedule
                to no-shows, then get compared on a number they were pushed into guessing.
              </p>
              <p>
                Otopair replaces both halves with one scoped job, one price the shop set, and one booking that is
                already paid for at the price everyone agreed to.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ---------- One booking, two sides (product object) ---------- */}
      <div className="mt-16 tab:mt-20">
        <TwoSides />
      </div>

      {/* ---------- The rules ---------- */}
      <section className="scroll-mt-28">
        <Head
          id="rules"
          title="The rules we hold ourselves to."
          line="Each one is enforced by the product, not promised in a paragraph. This is the whole list."
        />
        <Plate tone="paper" className="mt-10 px-6 py-4 tab:mt-14 tab:px-10 tab:py-6">
          <ol className="flex flex-col divide-y divide-[#1a1a1a]/10">
            {RULES.map((r, i) => (
              <li key={r.rule} className="grid gap-2 py-6 tab:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] tab:gap-x-10 tab:py-7">
                <div className="flex gap-4">
                  <span className="serif shrink-0 pt-[3px] text-[15px] tabular-nums text-[#4B82A5]">0{i + 1}.</span>
                  <h3 className="serif-text text-[21px] leading-[1.3] text-[#1a1a1a] [text-wrap:balance]">{r.rule}</h3>
                </div>
                <p className="max-w-[60ch] text-[16px] leading-[1.6] text-[#4c5661]">{r.how}</p>
              </li>
            ))}
          </ol>
        </Plate>
        <p className={`mt-6 ${PROSE}`}>
          The long form of every one of these, including what happens when a shop or a driver breaks them, is on{" "}
          <Link href="/trust-and-safety">trust and safety</Link>.
        </p>
      </section>

      {/* ---------- What we build ---------- */}
      <section className="mt-16 scroll-mt-28 pt-4 tab:mt-24">
        <Head
          id="build"
          title="What we build."
          line="Three products and the data asset underneath them. Each one exists because the price could not be locked without it."
        />
        <div className="mt-10 grid items-start gap-10 tab:mt-14 tab:grid-cols-12 tab:gap-12">
          <ol className="flex flex-col gap-7 tab:col-span-7">
            {[
              [
                "Oto, the assistant",
                "Turns “it squeals when I brake” into a scoped job a shop can price, by reading the car’s service history, the manufacturer’s data for that exact car and any stored codes. It asks one narrowing question rather than twenty, and it never quotes a price itself.",
              ],
              [
                "The pricing and booking system",
                "Builds the total for one exact car from what the shop set, holds $20, locks the ceiling, carries approvals inside 24 hours, and settles through Stripe on Stripe’s payout schedule.",
              ],
              [
                "The shop dashboard",
                "Runs a real garage’s day on the web: the board, the job sheet, the estimate, the team, the payouts, and the rates and services the shop controls itself.",
              ],
              [
                "The vehicle-data asset",
                "Maintenance specs, service intervals, exact-fit parts and real-world labor times, built from official sources and from what verified shops actually measure on the job. It is what makes a price for your car possible, and it is a product in its own right.",
              ],
            ].map(([t, b], i) => (
              <li key={t} className="flex gap-4">
                <span className="serif shrink-0 pt-[5px] text-[15px] tabular-nums text-[#4B82A5]">0{i + 1}.</span>
                <div>
                  <h3 className="serif-text text-[21px] leading-[1.25] text-[#1a1a1a]">{t}</h3>
                  <p className="mt-2 max-w-[52ch] text-[16px] leading-[1.6] text-[#4c5661]">{b}</p>
                </div>
              </li>
            ))}
          </ol>
          <div className="tab:col-span-5">
            <DataProvenance />
            <p className="mt-5 max-w-[42ch] text-[15px] leading-[1.55] text-[#777169]">
              The catalogue is open to developers through an API.{" "}
              <Link href="/developers" className="text-[#4B82A5] underline decoration-[#4B82A5]/40 underline-offset-[3px] hover:decoration-[#4B82A5]">
                See the endpoints
              </Link>{" "}
              or{" "}
              <Link href="/car-data" className="text-[#4B82A5] underline decoration-[#4B82A5]/40 underline-offset-[3px] hover:decoration-[#4B82A5]">
                look up a car
              </Link>
              .
            </p>
          </div>
        </div>
      </section>

      {/* ---------- What Otopair is not ---------- */}
      <section className="mt-16 scroll-mt-28 border-t border-[#1a1a1a]/10 pt-16 tab:mt-24 tab:pt-20">
        <Head
          id="not"
          title="What Otopair is not."
          line="The boundaries matter as much as the promises, so they are written down and linked to the page that owns each one."
        />
        <ul className="mt-10 grid gap-x-12 gap-y-8 tab:grid-cols-2">
          {NOT.map((n) => (
            <li key={n.claim} className="border-t border-[#1a1a1a]/10 pt-5">
              <h3 className="serif-text text-[21px] leading-[1.25] text-[#1a1a1a]">{n.claim}</h3>
              <p className="mt-2 max-w-[46ch] text-[16px] leading-[1.6] text-[#4c5661]">{n.body}</p>
              <Link
                href={n.href}
                className="mt-3 inline-block text-[14.5px] text-[#4B82A5] underline decoration-[#4B82A5]/40 underline-offset-[3px] hover:decoration-[#4B82A5]"
              >
                {n.label}
              </Link>
            </li>
          ))}
        </ul>
      </section>

      {/* ---------- Where it operates, the company, and the questions ---------- */}
      <section className="mt-16 scroll-mt-28 border-t border-[#1a1a1a]/10 pt-16 tab:mt-24 tab:pt-20">
        <h2 className={H2}>The details, in plain terms.</h2>
        <dl className="mt-8 flex flex-col divide-y divide-[#1a1a1a]/10 border-b border-[#1a1a1a]/10">
          <div className={ROW} id="where">
            <dt className={TERM}>Where it operates</dt>
            <dd className={ANSWER}>
              <p>
                {SITE_NAME} went live in {LOCALITY.city} in 2026 and opens New York City one borough at a time, each
                borough only once it has verified shops to book from. A borough opens on readiness, not on a
                marketing date, and each borough page takes waitlist signups until then.
              </p>
              <ul>
                {BOROUGHS.map((b) => (
                  <li key={b.slug}>
                    <Link href={`/${b.slug}`}>{b.name}</Link>: {b.live ? "live now" : `planned ${b.date}`}
                  </li>
                ))}
              </ul>
              <p>
                Nothing beyond the five boroughs of New York City has been announced. Drivers from anywhere can book
                a shop in a live borough; <Link href="/coverage">the coverage ladder</Link> has the full picture.
              </p>
            </dd>
          </div>
          <div className={ROW} id="shops">
            <dt className={TERM}>How a shop gets on the network</dt>
            <dd className={ANSWER}>
              <p>
                By applying, and then by clearing a review the Otopair team does by hand. Approval is a decision, not
                an automated check, and three more things are read from the shop&rsquo;s own live account before a
                driver ever sees it: payments connected through Stripe with charges and payouts enabled, opening
                hours published for all seven days, and at least one working mechanic with at least one service
                switched on.
              </p>
              <p>
                Verification is Otopair&rsquo;s own approval and nothing more. It does not check licences beyond the
                New York DMV inspection-station licence, does not verify insurance or mechanic certifications, and
                does not include an in-person visit. <Link href="/how-shops-are-verified">The full standard</Link>{" "}
                says exactly what is and is not checked; shops apply at <Link href="/apply">otopair.com/apply</Link>{" "}
                with no subscription and no setup fee.
              </p>
            </dd>
          </div>
          <div className={ROW} id="company">
            <dt className={TERM}>The company</dt>
            <dd className={ANSWER}>
              <p>
                {SITE_NAME} is a product of {LEGAL_NAME}, based in {LOCALITY.city}, {LOCALITY.region}. It is a small
                team building the driver app for iOS and Android, the shop dashboard, Oto, and the vehicle-data asset
                behind them. Store listings are on the way; the app is what drivers book in, and shops work from the
                web dashboard.
              </p>
              <p>
                Press and partnership inquiries go to{" "}
                <a href={`mailto:${SUPPORT_EMAIL}?subject=Press`}>{SUPPORT_EMAIL}</a>. Brand assets, boilerplate and
                the key facts are on the <Link href="/press">press page</Link>; open roles, when there are any, are
                on <Link href="/careers">careers</Link>.
              </p>
            </dd>
          </div>
        </dl>
        <FaqList items={FAQ} className="[&>div:first-child]:pt-6 tab:[&>div:first-child]:pt-7 [&_dd]:max-w-[60ch]" />
      </section>
    </PageShell>
  );
}
