import type { Metadata } from "next";
import Link from "next/link";
import PageShell, { Card, Section } from "@/components/flagship/page-shell";
import { FaqSection, type FaqItem } from "@/components/seo/faq";
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
 * /help — audit Tier 4, "long-tail question capture". A search-less hub:
 * one block per category, each article as a card whose summary already
 * answers the question, so a reader who never clicks through still leaves
 * with the answer. The four most-asked questions are repeated at the bottom
 * as FAQPage schema so search engines get the same answers.
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

function CategoryBlock({ category }: { category: HelpCategory }) {
  const items = helpByCategory(category);
  if (!items.length) return null;
  const meta = HELP_CATEGORY_META[category];
  return (
    <section
      id={meta.id}
      className="scroll-mt-28 border-t border-[#1a1a1a]/10 py-9 first:border-t-0 first:pt-0 tab:py-11"
    >
      <h2 className="text-[24px] leading-[1.15] text-[#1a1a1a] tab:text-[28px]" style={serif}>
        {category}
      </h2>
      <p className="mt-3 max-w-[64ch] text-[17px] leading-[1.65] text-[#4c5661]">{meta.blurb}</p>
      <ul className="mt-6 grid list-none gap-4 p-0 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((a) => (
          <li key={a.slug} className="min-w-0">
            <Link
              href={`/help/${a.slug}`}
              className="block h-full rounded-[20px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4B82A5]"
            >
              <Card title={a.title}>
                <p className="mt-3 flex-1 text-[15px] leading-[1.6] text-[#6b655d]">{a.summary}</p>
                <span className="mt-4 text-[14px] text-[#4B82A5] underline decoration-[#4B82A5]/40 underline-offset-[3px]">
                  Read the full answer
                </span>
              </Card>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function HelpPage() {
  return (
    <PageShell
      eyebrow="HELP"
      title="Answers, before you have to ask"
      lede="Every question here is answered in its first few lines, written against what the app actually enforces: the $20 hold, the price you lock, what needs your approval, when cancelling is free, and how to reach a person when something goes wrong."
      crumbs={[
        { name: "Home", href: "/" },
        { name: "Help", href: "/help" },
      ]}
      width="wide"
    >
      {HELP_CATEGORIES.map((c) => (
        <CategoryBlock key={c} category={c} />
      ))}

      <div className="mx-auto mt-6 max-w-[720px]">
        <Section id="still-stuck" title="Still stuck?">
          <p>
            Email <a href={`mailto:${SUPPORT_EMAIL}?subject=Driver%20support`}>{SUPPORT_EMAIL}</a>{" "}
            with the booking and what happened, and a person will reply. For anything about a
            specific job, the fastest route is the message thread on the booking in the app, where
            the shop answers with your car in front of them. The <Link href="/contact">contact page</Link>{" "}
            lists the right address for shops, the car-data API and press.
          </p>
        </Section>
        <FaqSection items={FAQ} />
      </div>
    </PageShell>
  );
}
