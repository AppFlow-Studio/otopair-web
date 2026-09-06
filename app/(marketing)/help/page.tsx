import type { Metadata } from "next";
import Link from "next/link";
import PageShell from "@/components/flagship/page-shell";
import { Reveal, Seq, Sequence } from "@/components/flagship/landing/reveal";
import { HeroPhone } from "@/components/flagship/local-sections";
import { PillLink, TextLink } from "@/components/flagship/pill-button";
import { BookingsScreen } from "@/components/flagship/product/screens/bookings";
import { FaqList, type FaqItem } from "@/components/seo/faq";
import { JsonLd } from "@/components/seo/json-ld";
import {
  HELP_CATEGORIES,
  HELP_CATEGORY_META,
  helpByCategory,
  helpBySlug,
  type HelpCategory,
} from "@/lib/help-articles";
import { SUPPORT_EMAIL } from "@/lib/site";

export const metadata: Metadata = {
  title: "Help",
  description:
    "Short answers to what drivers ask most: the $20 hold, what the locked price covers, approving extra work, cancelling, disputes, messaging your shop, the health score, warning lights, and how to reach a person.",
  alternates: { canonical: "/help" },
};

/**
 * /help (audit Tier 4, "long-tail question capture"; design pass
 * 2026-09-05): a search-less hub. The hero is the moment most questions
 * come from, the Bookings tab with an approval waiting. One block per
 * category, each question as a row whose summary already answers it, so
 * a reader who never clicks through still leaves with the answer. The four
 * most-asked questions repeat at the bottom as FAQPage schema.
 *
 * Articles live in lib/help-articles.tsx; this page renders whatever is
 * there and skips empty categories.
 */
const serif = { fontFamily: "var(--font-Petrona)", fontWeight: 400 } as const;

const TOP_QUESTIONS = [
  "how-the-20-dollar-hold-works",
  "what-locked-price-means",
  "cancelling-or-rescheduling",
  "disputes-and-refunds",
];

const FAQ: FaqItem[] = TOP_QUESTIONS.flatMap((slug) => {
  const a = helpBySlug(slug);
  return a ? [{ q: a.title, a: a.summary }] : [];
});

const H2 = "serif-display max-w-[16ch] text-[32px] leading-[1.04] tracking-[-0.01em] text-[#1a1a1a] [text-wrap:balance] tab:text-[38px]";

function CategoryBlock({ category }: { category: HelpCategory }) {
  const items = helpByCategory(category);
  if (!items.length) return null;
  const meta = HELP_CATEGORY_META[category];
  return (
    <section id={meta.id} className="scroll-mt-28 border-t border-[#1a1a1a]/10 py-10 first:border-t-0 first:pt-0 tab:py-14">
      <Reveal className="grid gap-3 tab:grid-cols-12 tab:items-end tab:gap-8">
        <h2 className={`${H2} tab:col-span-5`}>{category}</h2>
        <p className="max-w-[46ch] text-[17px] leading-[1.55] text-[#4c5661] tab:col-span-6 tab:col-start-7 tab:pb-1">{meta.blurb}</p>
      </Reveal>
      {/* The rows are peers, so they cascade. A wrapper may not sit between
          the <dl> and its rows (motion contract, hazard 2), so `Seq` *becomes*
          the row <div> and carries its classes — the same wiring
          components/seo/faq.tsx uses, so `divide-y` keeps matching. `mt-8`
          rides the Sequence root. */}
      <Sequence delay={0.08} className="mt-8">
        <dl className="flex flex-col divide-y divide-[#1a1a1a]/10 border-y border-[#1a1a1a]/10">
          {items.map((a, i) => (
            <Seq
              key={a.slug}
              at={Math.min(i, 8) * 0.06}
              className="grid gap-2 py-5 tab:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] tab:gap-x-10 tab:py-6"
            >
              <dt className="text-[20px] leading-[1.3] text-[#1a1a1a] [text-wrap:balance]" style={serif}>
                <Link href={`/help/${a.slug}`} className="transition-colors duration-300 hover:text-[#4B82A5] focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4B82A5]">
                  {a.title}
                </Link>
              </dt>
              <dd className="max-w-[60ch] text-[16px] leading-[1.6] text-[#4c5661]">
                {a.summary}{" "}
                <Link href={`/help/${a.slug}`} className="whitespace-nowrap text-[#4B82A5] underline decoration-[#4B82A5]/40 underline-offset-[3px] hover:decoration-[#4B82A5]">
                  The full answer
                </Link>
              </dd>
            </Seq>
          ))}
        </dl>
      </Sequence>
    </section>
  );
}

export default function HelpPage() {
  return (
    <PageShell
      title="Answers, before you have to ask."
      lede="Every question here is answered in its first few lines, written against what the app actually enforces: the $20 hold, the price you lock, what needs your approval, when cancelling is free, and how to reach a person when something goes wrong."
      crumbs={[
        { name: "Home", href: "/" },
        { name: "Help", href: "/help" },
      ]}
      hero={
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <PillLink href="/help/approving-extra-work">Approving extra work</PillLink>
          <TextLink href="/contact">Reach a person</TextLink>
        </div>
      }
      visual={
        <HeroPhone>
          <BookingsScreen stage={2} approval title="Marcus started at 10:05 AM" subtitle="Front pads off, rotors checked" />
        </HeroPhone>
      }
      visualFrame={false}
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

      {HELP_CATEGORIES.map((c) => (
        <CategoryBlock key={c} category={c} />
      ))}

      <section id="still-stuck" className="scroll-mt-28 border-t border-[#1a1a1a]/10 py-10 tab:py-14">
        <Reveal className="grid gap-3 tab:grid-cols-12 tab:gap-8">
          <h2 className={`${H2} tab:col-span-5`}>Still stuck?</h2>
          <p className="max-w-[56ch] text-[17px] leading-[1.6] text-[#4c5661] tab:col-span-6 tab:col-start-7 [&_a]:text-[#4B82A5] [&_a]:underline [&_a]:decoration-[#4B82A5]/40 [&_a]:underline-offset-[3px] [&_a:hover]:decoration-[#4B82A5]">
            Email <a href={`mailto:${SUPPORT_EMAIL}?subject=Driver%20support`}>{SUPPORT_EMAIL}</a> with the booking and
            what happened, and a person will reply. For anything about a specific job, the fastest route is the message
            thread on the booking in the app, where the shop answers with your car in front of them. The{" "}
            <Link href="/contact">contact page</Link> lists the right address for shops, the car-data API and press.
          </p>
        </Reveal>
      </section>

      <section id="faq" className="scroll-mt-28 border-t border-[#1a1a1a]/10 pt-10 tab:pt-14">
        <Reveal>
          <h2 className={H2}>The four most-asked questions.</h2>
        </Reveal>
        {/* FaqList carries its own Sequence/Seq cascade — no wrapper, or the
            block double-animates (motion contract, "what does not get
            animated"). Its own classes keep the spacing. */}
        <FaqList items={FAQ} className="mt-8 border-b border-[#1a1a1a]/10 [&_dd]:max-w-[60ch]" />
      </section>
    </PageShell>
  );
}
