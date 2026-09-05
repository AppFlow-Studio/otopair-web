import type { Metadata } from "next";
import Link from "next/link";
import PageShell from "@/components/flagship/page-shell";
import { Seq, Sequence } from "@/components/flagship/landing/reveal";
import { PillLink, TextLink } from "@/components/flagship/pill-button";
import { FaqList, type FaqItem } from "@/components/seo/faq";
import { JsonLd } from "@/components/seo/json-ld";
import { BOOKABLE_SERVICE_COUNT, applicabilityNotes, servicesByCategory, type ServiceCategoryName } from "@/lib/service-catalog";
import { listPublicShops, onStatenIsland } from "@/lib/public-shops";
import type { TabKey } from "@/components/flagship/product/screens/browse";
import { ServicesWalkthrough, type CatalogGroup } from "./sections";

export const metadata: Metadata = {
  title: { absolute: "Car services you can book on Otopair: 22 services, four categories, one locked price" },
  description:
    "Every service you can book through Oto: Routine, Tires & Brakes, Scheduled Service and Inspections. Shops set their own price; you see the full total before you confirm, and it is locked before the car goes in.",
  alternates: { canonical: "/services" },
};

// The nearest-shop card on the first step reads the live directory.
export const revalidate = 300;

/**
 * /services (design pass 2026-09-05, the app up close): the catalog as a
 * pinned walkthrough. The phone opens on the app's Select Services screen,
 * then shows each category's list as its step passes; each step carries
 * the crawlable rows (name, what it includes, which cars), every row
 * linking to /services/<slug>. No prices anywhere on the page by design.
 * The price answer and the where answer share one editorial list with the
 * FAQ.
 */
const CATEGORY_INTRO: Record<ServiceCategoryName, { tab: TabKey; title: string; body: string }> = {
  Routine: {
    tab: "routine_upkeep",
    title: "Which routine services can I book?",
    body: "Three: Oil Change, Filter Replacement and Battery Replacement, the jobs most cars need more than once a year. Each is priced by the shop for your exact car, with the parts included in the total you see before you confirm, so there is nothing to add at pickup.",
  },
  "Tires & Brakes": {
    tab: "tires_brakes",
    title: "Which tire and brake services can I book?",
    body: "Seven, from Tire Rotation to Rotor Replacement. Tire Rotation, Tire Balance and Wheel Alignment are labor-only; Tire Replacement, Brake Pad Replacement, Rotor Replacement and Brake Fluid Flush include the parts or fluid in the total. Tire Rotation is shown only where the tire setup allows it.",
  },
  "Scheduled Service": {
    tab: "major_service",
    title: "Which scheduled services can I book?",
    body: "Seven interval services: Spark Plugs, Timing Belt, Coolant Flush, Transmission Service, Power Steering Flush, Differential Service and Fuel System Cleaning. Several apply only to certain cars, a belt-driven engine, hydraulic steering, a separate differential, and Oto shows each one only when it applies to yours.",
  },
  Inspections: {
    tab: "inspections",
    title: "Which inspections and diagnostics can I book?",
    body: "Five: Diagnostic Scan, Check Engine Light Diagnosis, State Inspection, Emissions Test and Battery Test. All five are labor-only, so the price is the shop's time at the rate it set. State Inspection and Emissions Test are performed only by shops licensed by the New York DMV as inspection stations.",
  },
};

const FAQ: FaqItem[] = [
  {
    q: "How many services can I book on Otopair?",
    a: "22, in four categories: Routine, Tires & Brakes, Scheduled Service and Inspections. They run from an Oil Change and a Tire Rotation to a Timing Belt and a Rotor Replacement. Oto, the in-app assistant, shows you only the services that apply to your car, so your own list may be shorter.",
  },
  {
    q: "Does Otopair publish prices for these services?",
    a: "No. Prices are set by each shop and built for your exact car in the app, so there is no Otopair average or starting price. What you get instead is the full total, parts, labor, tax and Otopair's service fee, before you confirm, locked before the car goes in. A $20 hold reserves the slot; the shop confirms the final price after inspection, and it cannot go above what you approved without your OK.",
  },
  {
    q: "What if I don't know which service I need?",
    a: "Tell Oto what the car is doing. Oto asks about the symptom and your car and narrows it to the right service: a brake squeal points at the brake services, a warning light at the matching diagnosis or service. If the cause is not clear, Check Engine Light Diagnosis and Diagnostic Scan are both bookable on their own.",
  },
  {
    q: "Why doesn't Oto show me every service?",
    a: "Because some do not apply to your car. Oto hides an Oil Change or an Emissions Test on an electric car, a Timing Belt on a chain-driven engine, a Power Steering Flush where there is no evidence of hydraulic steering, and the OBD-II diagnostics on cars older than 1996. What is left is what your car can actually book.",
  },
];

const H2 = "serif-display max-w-[16ch] text-[32px] leading-[1.04] tracking-[-0.01em] text-[#1a1a1a] [text-wrap:balance] tab:text-[38px]";
const ROW = "grid gap-2 py-6 tab:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] tab:gap-x-10 tab:py-7";
const TERM = "serif-text text-[21px] leading-[1.3] text-[#1a1a1a] [text-wrap:balance]";
const ANSWER =
  "max-w-[60ch] text-[16px] leading-[1.6] text-[#4c5661] [&_p+p]:mt-3 [&_a]:text-[#4B82A5] [&_a]:underline [&_a]:decoration-[#4B82A5]/40 [&_a]:underline-offset-[3px] [&_a:hover]:decoration-[#4B82A5]";

export default async function ServicesIndexPage() {
  let closest: string | null = null;
  try {
    closest = (await listPublicShops()).filter(onStatenIsland)[0]?.name ?? null;
  } catch {
    closest = null;
  }
  const groups: CatalogGroup[] = servicesByCategory().map(({ category, services }) => {
    const intro = CATEGORY_INTRO[category.name];
    return {
      tab: intro.tab,
      title: intro.title,
      body: intro.body,
      services: services.map((s) => ({ slug: s.slug, name: s.name, description: s.description, laborOnly: s.is_labor_only, notes: applicabilityNotes(s) })),
    };
  });

  return (
    <PageShell
      title={`${BOOKABLE_SERVICE_COUNT} services, four categories, one locked price.`}
      lede="From an Oil Change to a Timing Belt. Shops set the price; you see the full total before you confirm."
      crumbs={[
        { name: "Home", href: "/" },
        { name: "Services", href: "/services" },
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

      {/* ---------- The catalog, as the app shows it ---------- */}
      <ServicesWalkthrough groups={groups} closest={closest} />

      {/* ---------- The details and the questions: one editorial list ---------- */}
      <section id="details" className="mt-16 scroll-mt-28 border-t border-[#1a1a1a]/10 pt-16 lg:mt-24 lg:pt-24">
        {/* Head and the definition list share one clock: the question lands,
            the answers settle a beat later. The <dl> moves as one block —
            never term by term, and never with a wrapper between it and its
            rows, where divide-y is doing the ruling. */}
        <Sequence>
          <Seq>
            <h2 className={H2}>The details, in plain terms.</h2>
          </Seq>
          <Seq at={0.1} className="mt-8">
            <dl className="flex flex-col divide-y divide-[#1a1a1a]/10 border-b border-[#1a1a1a]/10">
              <div className={ROW} id="price">
                <dt className={TERM}>How is the price set?</dt>
                <dd className={ANSWER}>
                  <p>
                    By the shop, for your exact car. Every shop on Otopair sets its own labor rate and can set a flat price
                    for a service. Oto builds the total for your car from what the shop set, parts, labor, tax and
                    Otopair&rsquo;s service fee, and shows you that full total before you confirm. It is locked before the
                    car goes in.
                  </p>
                  <p>
                    A $20 hold reserves the slot when you book. The shop confirms the final price after inspecting the
                    car, and it cannot go above what you approved without your approval in the app; any added work is a
                    request you answer before it is done. Otopair does not publish averages, ranges or starting prices;
                    the number that matters is the one built for your car.
                  </p>
                </dd>
              </div>
              <div className={ROW} id="where">
                <dt className={TERM}>Where can I book these?</dt>
                <dd className={ANSWER}>
                  <p>
                    <Link href="/staten-island">Staten Island, NY</Link>, today. Every shop you can book is a verified
                    independent shop on the island, and each service page lists the Staten Island shops that currently
                    offer it. Brooklyn is next on the <Link href="/coverage">coverage ladder</Link> for Q4 2026, then
                    Queens, The Bronx and Manhattan.
                  </p>
                  <p>
                    Want to start from the shop instead of the service? <Link href="/shops">Browse every verified shop</Link>{" "}
                    and see what each one lists.
                  </p>
                </dd>
              </div>
            </dl>
          </Seq>
        </Sequence>
        {/* FaqList carries its own Sequence and its rows are already Seq'd
            (components/seo/faq.tsx), so it is left unwrapped: a Reveal over it
            would compound a 26px rise onto the rows' own 14px one. Same call
            as /how-it-works. */}
        <FaqList items={FAQ} className="[&>div:first-child]:pt-6 tab:[&>div:first-child]:pt-7 [&_dd]:max-w-[60ch]" />
      </section>
    </PageShell>
  );
}
