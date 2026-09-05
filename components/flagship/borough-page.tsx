import PageShell from "@/components/flagship/page-shell";
import WaitlistForm from "@/components/flagship/waitlist-form";
import { BoroughSections } from "@/components/flagship/local-sections";
import { FaqList, type FaqItem } from "@/components/seo/faq";
import { JsonLd } from "@/components/seo/json-ld";
import { listPublicShops, onStatenIsland } from "@/lib/public-shops";
import type { Borough } from "@/lib/coverage";

/**
 * Pre-launch borough page (/brooklyn, /queens, /bronx, /manhattan): the
 * audit's "publish before launch so the page can age" item. Everything on
 * it is true today: the ladder date from lib/coverage.ts, the waitlist
 * (emails the team, tagged with the borough), and the shop application,
 * which is open to any NYC shop now. It makes no claim about shops or
 * prices in the borough because there are none yet.
 *
 * Design pass 2026-09-05 (the app up close): the waitlist form is the
 * hero's object; "what opens on day one" shows the Oto conversation that
 * is live in Staten Island today (no shop names, none exist here yet)
 * beside the driver and shop columns; the boroughs run as one rail with
 * this borough marked. The two questions stay in one list.
 */
const H2 = "serif-display max-w-[16ch] text-[32px] leading-[1.04] tracking-[-0.01em] text-[#1a1a1a] [text-wrap:balance] tab:text-[38px]";

export default async function BoroughPage({ borough }: { borough: Borough }) {
  let liveCount: number | null = null;
  try {
    liveCount = (await listPublicShops()).filter(onStatenIsland).length;
  } catch {
    liveCount = null;
  }
  // Two questions, each answered once on the page: the launch date is the
  // query this page exists for, and "can I use it today" is the one a
  // driver who lands here actually has. The shop question is the shop column.
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

      <BoroughSections slug={borough.slug} name={borough.name} date={borough.date} liveCount={liveCount} />

      <section id="details" className="scroll-mt-28 border-t border-[#1a1a1a]/10 pt-14 tab:pt-20">
        <h2 className={H2}>Questions {borough.name} drivers ask.</h2>
        <FaqList items={faq} className="mt-8 border-b border-[#1a1a1a]/10 [&_dd]:max-w-[60ch]" />
      </section>
    </PageShell>
  );
}
