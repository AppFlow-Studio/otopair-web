import Link from "next/link";
import PageShell from "@/components/flagship/page-shell";
import { Ladder } from "@/components/flagship/ladder";
import WaitlistForm from "@/components/flagship/waitlist-form";
import { FaqList, type FaqItem } from "@/components/seo/faq";
import { JsonLd } from "@/components/seo/json-ld";
import { BOROUGHS, type Borough } from "@/lib/coverage";

/**
 * Pre-launch borough page (/brooklyn, /queens, /bronx, /manhattan): the
 * audit's "publish before launch so the page can age" item. Everything on
 * it is true today: the ladder date from lib/coverage.ts, the waitlist
 * (emails the team, tagged with the borough), and the shop application,
 * which is open to any NYC shop now. It makes no claim about shops or
 * prices in the borough because there are none yet.
 *
 * Design pass 2026-09-05: no city render in the hero (it was Manhattan for
 * every borough); the waitlist form is the hero's object, the explainers
 * and the FAQ share one editorial list, and the other boroughs run as the
 * same ladder the coverage page uses.
 */
const H2 = "serif-display max-w-[16ch] text-[32px] leading-[1.04] tracking-[-0.01em] text-[#1a1a1a] [text-wrap:balance] tab:text-[38px]";
const ROW = "grid gap-2 py-6 tab:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] tab:gap-x-10 tab:py-7";
const TERM = "serif-text text-[21px] leading-[1.3] text-[#1a1a1a] [text-wrap:balance]";
const ANSWER =
  "max-w-[60ch] text-[16px] leading-[1.6] text-[#4c5661] [&_p+p]:mt-3 [&_a]:text-[#4B82A5] [&_a]:underline [&_a]:decoration-[#4B82A5]/40 [&_a]:underline-offset-[3px] [&_a:hover]:decoration-[#4B82A5]";

export default function BoroughPage({ borough }: { borough: Borough }) {
  const others = BOROUGHS.filter((b) => b.slug !== borough.slug);
  // Two questions, each answered once on the page: the launch date is the
  // query this page exists for, and "can I use it today" is the one a
  // driver who lands here actually has. The shop question is the shop row.
  const faq: FaqItem[] = [
    {
      q: `When does Otopair launch in ${borough.name}?`,
      a: `${borough.date}, on the current plan. A borough opens to drivers once enough verified shops are on the network to book from, not on a marketing date. Leave your email on the waitlist and the team will write when the first ${borough.name} shops open.`,
    },
    {
      q: `Can I use Otopair in ${borough.name} today?`,
      a: `Not yet for booking. The app is live in Staten Island, and a ${borough.name} driver can book a Staten Island shop today. Booking in ${borough.name} itself opens with the first verified ${borough.name} shops.`,
    },
  ];
  return (
    <PageShell
      title={`Otopair is coming to ${borough.name}.`}
      lede={`Fixed-price repair from verified independent shops, booked from your phone. Staten Island is live; ${borough.name} opens ${borough.date}.`}
      crumbs={[
        { name: "Home", href: "/" },
        { name: "Coverage", href: "/coverage" },
        { name: borough.name, href: `/${borough.slug}` },
      ]}
      hero={<WaitlistForm borough={borough.name} />}
      heroAlign="start"
      width="wide"
    >
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "FAQPage",
          mainEntity: faq.map((it) => ({
            "@type": "Question",
            name: it.q,
            acceptedAnswer: { "@type": "Answer", text: it.a },
          })),
        }}
      />

      <section id="details" className="scroll-mt-28">
        <h2 className={H2}>What happens when {borough.name} opens.</h2>
        <dl className="mt-8 flex flex-col divide-y divide-[#1a1a1a]/10 border-b border-[#1a1a1a]/10">
          <div className={ROW} id="launch">
            <dt className={TERM}>For drivers</dt>
            <dd className={ANSWER}>
              <p>
                The same thing that is live in Staten Island today. You tell Oto, the in-app assistant, what your car
                is doing. Oto turns that into a scoped job, shows you verified shops nearby with the price each one set,
                and locks the price when you book. A deposit holds the slot; the locked price is what you pay at
                pickup, and any extra work has to be approved by you in the app first.
              </p>
            </dd>
          </div>
          <div className={ROW} id="shops">
            <dt className={TERM}>For {borough.name} repair shops</dt>
            <dd className={ANSWER}>
              <p>
                Applications are open now, and {borough.name} shops that join ahead of {borough.date} are the ones live
                on opening day. Otopair sends booked, pre-diagnosed customers at a price you set, runs payment through
                Stripe, and charges no subscription and no setup fee.
              </p>
              <p>
                <Link href="/partner-with-us">How the network works for shops</Link> ·{" "}
                <Link href="/apply">Apply in two minutes</Link>
              </p>
            </dd>
          </div>
        </dl>
        <FaqList items={faq} className="[&>div:first-child]:pt-6 tab:[&>div:first-child]:pt-7 [&_dd]:max-w-[60ch]" />
      </section>

      <section id="ladder" className="mt-16 scroll-mt-28 border-t border-[#1a1a1a]/10 pt-16 lg:mt-24 lg:pt-24">
        <h2 className={H2}>Where else Otopair is going.</h2>
        <Ladder
          direction="row"
          className="mt-10"
          steps={others.map((b) => ({
            title: b.name,
            body: (
              <>
                <span className="block text-[13px] tracking-[0.08em] text-[#4B82A5]">{b.live ? "LIVE NOW" : b.date.toUpperCase()}</span>
                <span className="mt-2 block">{b.blurb}</span>
                <Link
                  href={`/${b.slug}`}
                  className="mt-3 inline-block text-[14px] text-[#4B82A5] underline decoration-[#4B82A5]/40 underline-offset-[3px] hover:decoration-[#4B82A5]"
                >
                  {b.live ? `Shops in ${b.name}` : `${b.name} waitlist`}
                </Link>
              </>
            ),
          }))}
        />
      </section>
    </PageShell>
  );
}
