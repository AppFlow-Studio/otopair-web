import type { Metadata } from "next";
import PageShell from "@/components/flagship/page-shell";
import { PillLink, TextLink } from "@/components/flagship/pill-button";
import { Reveal } from "@/components/flagship/landing/reveal";
import { OtoSections } from "./sections";
import { FaqList, type FaqItem } from "@/components/seo/faq";
import { JsonLd } from "@/components/seo/json-ld";

export const metadata: Metadata = {
  title: { absolute: "Meet Oto: the AI car assistant in the Otopair app" },
  description:
    "Oto is the AI assistant in the Otopair app. Describe what your car is doing and it scopes a job a Staten Island shop can quote. What Oto does, and never does.",
  alternates: { canonical: "/oto" },
};

/**
 * /oto (design pass 2026-09-05, stage cut). Three stages show Oto instead
 * of describing it: the greeting and the real prompt suggestions, an
 * answer with its sources and the thumbs, and the confirm cards that write
 * to the car's record. The capability and limit lists, safety, memory, the
 * website demo and the FAQ live in one editorial list at the foot. Every
 * capability and limit is lifted from the in-app assistant's own
 * capability-honesty and hard-rule sections (convex/oto/prompt/stable.ts)
 * and the pre-routing hazard classifier (convex/oto/safety.ts). Nothing
 * here names the model or speech vendor, states a fee rate, or publishes
 * question tiers.
 */



// The four chips on the home-page hero, answered visibly and with schema.
const FAQ: FaqItem[] = [
  {
    q: "What can Oto do?",
    a: "Oto explains the 22 services you can book, tells you what is due on your car and shows your Vehicle Health Score, looks up your bookings, pulls the specs for your car, logs your mileage and warning lights when you confirm, and sets up the booking flow with the right service prefilled. You choose the shop, the time and the payment yourself. Oto does not diagnose the car: it scopes what you describe into a job a mechanic can quote, and the mechanic confirms what you actually need before any work.",
  },
  {
    q: "How does pricing work?",
    a: "The shop sets the price, and Oto never quotes one. Before you confirm a booking you see the full total for your exact car, with parts, labor, tax and Otopair's service fee inside it, and a $20 hold is placed on your card. After inspecting the car the shop confirms the final price. It cannot go above what you approved without your in-app approval, and if the shop cancels or the request expires the hold is released in full.",
  },
  {
    q: "How do rewards work?",
    a: "Otopair pays real dollar credit, not points. You earn credit on every completed booking, and extra credit for leaving a review, uploading a service record, or referring a friend who completes their first booking. Credit applies to your next booking automatically, or you can convert your balance to a gift card. Oto can show your balance and history; the amounts, tiers and terms are shown in the app.",
  },
  {
    q: "Where is Oto available?",
    a: "The shops Oto can book are in Staten Island, NY today. Brooklyn is planned for Q4 2026, Queens for Q1 2027, The Bronx for Q2 2027 and Manhattan for Q3 2027. Oto lives in the Otopair app for iPhone and Android; the assistant on this website is a demo that creates no real booking.",
  },
];

const H2 = "serif-display max-w-[14ch] text-[32px] leading-[1.04] tracking-[-0.01em] text-[#1a1a1a] [text-wrap:balance] tab:text-[40px]";

export default function OtoPage() {
  return (
    <PageShell
      title="Oto is a guide for your car, not a diagnosis."
      lede="Tell Oto what your car is doing. It scopes a job a real shop can quote, and a mechanic confirms the work."
      crumbs={[
        { name: "Home", href: "/" },
        { name: "Oto", href: "/oto" },
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

      <OtoSections />

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
