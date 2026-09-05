import type { Metadata } from "next";
import PageShell from "@/components/flagship/page-shell";
import { PillLink, TextLink } from "@/components/flagship/pill-button";
import { HealthSections } from "./sections";
import { FaqList, type FaqItem } from "@/components/seo/faq";
import { JsonLd } from "@/components/seo/json-ld";

export const metadata: Metadata = {
  title: { absolute: "Vehicle Health Score: a 0 to 100 score for your exact car" },
  description:
    "Otopair's Vehicle Health Score is a 0 to 100 number for your exact car, built from service records, check-ins, warning lights and shop inspections. What it tracks and what moves it.",
  alternates: { canonical: "/vehicle-health-score" },
};

/**
 * /vehicle-health-score (design pass 2026-09-05, stage cut): "own the
 * term". Three stages show the ring and what affects it, the Maintenance
 * Tracker's five items, and what moves the number (the app's what-if and
 * the quarterly check-in). The boundary, the formula, the inspection, the
 * check-in, the passport and the FAQ live in one editorial list at the
 * foot. Plain language on the displayed score (utils/healthScore.ts:
 * upkeep up to 85, no-warning-lights reserve up to 15, open-recommendation
 * deduction up to 15) and its boundary (convex/oto/vehicleHealth.ts: oil,
 * brakes, tires, 12V battery, state inspection when on file, nothing else).
 * Mechanic findings land via the 2-hour deferred write
 * (inspectionHealthDeferred.ts), so the copy says "shortly after the visit
 * closes", never "instantly". No Health Points, no rewards, no telematics
 * feed the number shown.
 */




const FAQ: FaqItem[] = [
  {
    q: "Is the Vehicle Health Score a safety rating?",
    a: "No. It grades the upkeep of four systems, oil, brakes, tires and the 12-volt battery, plus your state inspection when a record is on file. It does not test crashworthiness, it does not inspect anything it does not track, and a high score is not a statement that the car is safe to drive. A lit warning light or a stop-driving instruction from Oto always outranks it.",
  },
  {
    q: "Does it use my car's telematics or connected-car data?",
    a: "No. The score is built from service records, your quarterly check-in answers, the warning lights you report and what a mechanic measures during an inspection. Nothing is read from the car's computer or from any connected-car service, so the score cannot see a fault the car has not shown you and you have not reported.",
  },
  {
    q: "Can I raise my score by paying?",
    a: "No. Only real upkeep moves it: completing a service that is due, clearing a warning light, or a shop inspection that measures the car and finds it in good shape. Nothing you buy in the app changes the number, and there is no way to purchase a higher score.",
  },
];

const H2 = "serif-display max-w-[14ch] text-[32px] leading-[1.04] tracking-[-0.01em] text-[#1a1a1a] [text-wrap:balance] tab:text-[40px]";

export default function VehicleHealthScorePage() {
  return (
    <PageShell
      title="Vehicle Health Score, explained."
      lede="A 0 to 100 number for your exact car, built from service records, check-ins and shop inspections, and what moves it."
      crumbs={[
        { name: "Home", href: "/" },
        { name: "Vehicle Health Score", href: "/vehicle-health-score" },
      ]}
      hero={
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <PillLink href="/download">Get notified at launch</PillLink>
          <TextLink href="/oto">Meet Oto</TextLink>
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

      <HealthSections />

      {/* ---------- The details and the questions: one editorial list ---------- */}
      <section id="details" className="scroll-mt-28 border-t border-[#1a1a1a]/10 pt-14 tab:pt-20">
        <h2 className={H2}>Questions drivers ask.</h2>
        
        <FaqList items={FAQ} className="mt-8 border-b border-[#1a1a1a]/10 [&_dd]:max-w-[60ch]" />
      </section>
    </PageShell>
  );
}
