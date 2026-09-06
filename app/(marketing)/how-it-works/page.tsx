import type { Metadata } from "next";
import PageShell from "@/components/flagship/page-shell";
import { Reveal } from "@/components/flagship/landing/reveal";
import { PillLink, TextLink } from "@/components/flagship/pill-button";
import { FaqList, type FaqItem } from "@/components/seo/faq";
import { JsonLd } from "@/components/seo/json-ld";
import HowItWorksStory from "./story";

export const metadata: Metadata = {
  title: { absolute: "How Otopair works: tell Oto, book a verified shop, pay the confirmed price" },
  description:
    "Tell Oto what your car is doing, see verified Staten Island shops with the full total each one set, confirm with a $20 hold, and pay the confirmed price when the job is done. Seven steps, no phone tag.",
  alternates: { canonical: "/how-it-works" },
};

/**
 * /how-it-works (design pass 2026-09-05, fourth cut). The page is the app,
 * up close: seven steps scroll past a pinned phone whose screen changes to
 * the real screen of each step (Oto chat, shop totals, Review & Pay, the
 * booking card, the approval screen, the receipt). The screens are drawn
 * from otopair-1 at the app's own values (components/flagship/product),
 * so the page looks like the product, which is the point of the redesign
 * (design review 2026-08-15). Copy and FAQ carry the product's facts:
 * $20 hold (convex/lib/payment_constants.ts), in-range auto-confirm and
 * the 24-hour approval window (convex/booking_approvals.ts), capture on
 * completion (convex/bookings.ts), one-way reviews on completed bookings.
 */
const FAQ: FaqItem[] = [
  {
    q: "Do I need to know what is wrong with my car?",
    a: "No. Describe what you notice and Oto asks the rest. It turns the symptom into a scoped job so shops can price it, and the shop's inspection decides the actual work. Oto is a guide, not a diagnosis.",
  },
  {
    q: "Is the price really locked?",
    a: "The price you approve when you book is a ceiling. After inspecting the car the shop confirms the final price; if it is within what you approved it is confirmed automatically, and it cannot go above that without your explicit approval in the app. Nothing you decline is ever charged.",
  },
  {
    q: "What does the $20 hold do?",
    a: "It reserves your slot. It is an authorization on your card, not a charge, and the most placed on your card before the shop inspects the car. After the shop confirms the price the hold is raised to that amount, and it is captured when the shop marks the job complete; cancel in time and it is released. The cancellation policy lists every case.",
  },
  {
    q: "Can I book from a web browser?",
    a: "Drivers book in the Otopair app for iPhone and Android, where Oto, the price lock and the booking live. Store listings are on the way; the download page has the waitlist. Repair shops use a separate web dashboard.",
  },
  {
    q: "What if the shop finds something else once the car is on the lift?",
    a: "It sends the added work and its price in the app. You approve it or decline it there, with 24 hours to answer. Declined work is stripped from the job and never charged; the shop completes what you originally booked.",
  },
];

const H2 = "serif-display max-w-[14ch] text-[32px] leading-[1.04] tracking-[-0.01em] text-[#1a1a1a] [text-wrap:balance] tab:text-[40px]";

export default function HowItWorksPage() {
  return (
    <PageShell
      title="How Otopair works, in seven steps."
      lede="Everything happens in the app, and the only two numbers in it are a $20 hold and 24 hours to answer an estimate."
      crumbs={[
        { name: "Home", href: "/" },
        { name: "How it works", href: "/how-it-works" },
      ]}
      hero={
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <PillLink href="/download">Get notified at launch</PillLink>
          <TextLink href="/for-shops">I run a repair shop</TextLink>
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

      <HowItWorksStory />

      {/* The walkthrough above is already choreographed by its own component
          (the screen crossfade, the rail dot, the active step's body), so the
          only entrance this page adds is the heading here. FaqList carries
          its own Sequence and Seq'd rows (components/seo/faq.tsx) — wrapping
          it would double-animate it and compound the two rises, so it is
          left alone with its own top margin. */}
      <section id="questions" className="scroll-mt-28 border-t border-[#1a1a1a]/10 pt-14 tab:mt-10 tab:pt-20">
        <Reveal>
          <h2 className={H2}>Questions drivers ask.</h2>
        </Reveal>
        <FaqList items={FAQ} className="mt-8 border-b border-[#1a1a1a]/10 [&_dd]:max-w-[60ch]" />
      </section>
    </PageShell>
  );
}
