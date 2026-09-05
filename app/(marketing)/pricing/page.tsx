import type { Metadata } from "next";
import PageShell from "@/components/flagship/page-shell";
import { PillLink, TextLink } from "@/components/flagship/pill-button";
import { Reveal } from "@/components/flagship/landing/reveal";
import { PricingSections } from "./sections";
import { FaqList, type FaqItem } from "@/components/seo/faq";
import { JsonLd } from "@/components/seo/json-ld";

export const metadata: Metadata = {
  title: { absolute: "Otopair pricing: the price you approve is the most you pay" },
  description:
    "Shops set their own prices. You see the full total for your exact car before you confirm, a $20 hold reserves the slot, and the final price cannot go above what you approved without your OK in the app.",
  alternates: { canonical: "/pricing" },
};

/**
 * /pricing (design pass 2026-09-05, stage cut). Three stages carry the
 * mechanism: the Review & Pay breakdown (the shop's total, shown whole),
 * the $20 hold and the payment timeline, and the ceiling with the approval
 * screen. Each has a headline and one sentence; the six explainers and the
 * FAQ live in one editorial list at the foot. The only numbers stated as
 * fact are the product's: the $20 hold (convex/lib/payment_constants.ts)
 * and the 24-hour approval window (convex/booking_approvals.ts SLA_MS). No
 * fee rate, no price ranges, no "from $X". The "never" list is the
 * landing's own trust card (oto-flow.ts TRUST_DEMO) so the two cannot drift.
 */

const FAQ: FaqItem[] = [
  {
    q: "Is there a booking fee for drivers?",
    a: "Nothing is charged to download the app, talk to Oto or get prices from shops. When you book, the total you confirm already includes everything: parts, labor, tax and Otopair's service fee. Nothing is added on top after you confirm, and the only thing placed on your card at booking is the $20 hold.",
  },
  {
    q: "Why does the app show a range for my car?",
    a: "Because the shop has not seen the car yet. Before inspection, the app shows a disclosed range built for your exact car; what you approve when you book is the top of it. After inspection the shop confirms the final price, and it cannot go above that range without your explicit approval in the app.",
  },
  {
    q: "Do shops pay to be on Otopair?",
    a: "There is no subscription and no setup fee for shops. Shops set their own rates and keep their rate; Otopair's service fee is part of the total the driver confirms.",
  },
  {
    q: "Can the shop charge me more at pickup?",
    a: "No. The final price cannot go above what you approved without your OK in the app. If the shop finds something extra, it sends the added work and its price in the app; if you decline it, it is never charged and the shop completes what you booked.",
  },
  {
    q: "Do prices differ between shops?",
    a: "Yes. Each shop sets its own labor rates and may set flat prices for some services, so the same job can cost different amounts at different shops. The app shows each shop's full total for your car side by side, and you choose.",
  },
];

const H2 = "serif-display max-w-[14ch] text-[32px] leading-[1.04] tracking-[-0.01em] text-[#1a1a1a] [text-wrap:balance] tab:text-[40px]";

export default function PricingPage() {
  return (
    <PageShell
      title="The price you approve is the most you pay."
      lede="Shops set the price. You see the full total before you confirm, and it cannot rise without your OK in the app."
      crumbs={[
        { name: "Home", href: "/" },
        { name: "Pricing", href: "/pricing" },
      ]}
      hero={
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <PillLink href="/download">Get notified at launch</PillLink>
          <TextLink href="/how-it-works">How a booking runs</TextLink>
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

      <PricingSections />

      {/* ---------- The details and the questions: one editorial list ---------- */}
      <section id="details" className="scroll-mt-28 border-t border-[#1a1a1a]/10 pt-14 tab:pt-20">
        <Reveal>
          <h2 className={H2}>Questions drivers ask.</h2>
        </Reveal>
        <FaqList items={FAQ} className="mt-8 border-b border-[#1a1a1a]/10 [&_dd]:max-w-[60ch]" />
      </section>
    </PageShell>
  );
}
