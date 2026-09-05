import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import PageShell from "@/components/flagship/page-shell";
import { PillLink, TextLink } from "@/components/flagship/pill-button";
import { serviceIcon } from "@/components/flagship/hero-visual";
import { ApplicabilityChips } from "@/components/flagship/service-page-bits";
import { FaqList, type FaqItem } from "@/components/seo/faq";
import { JsonLd } from "@/components/seo/json-ld";
import { BOOKABLE_SERVICE_COUNT, servicesByCategory, type ServiceCategoryName } from "@/lib/service-catalog";

export const metadata: Metadata = {
  title: { absolute: "Car services you can book on Otopair: 22 services, four categories, one locked price" },
  description:
    "Every service you can book through Oto: Routine, Tires & Brakes, Scheduled Service and Inspections. Shops set their own price; you see the full total before you confirm, and it is locked before the car goes in.",
  alternates: { canonical: "/services" },
};

/**
 * /services (design pass 2026-09-05): the catalog as a crawlable index.
 * Four category sections, each headed by its app icon, with the services
 * as rows (name, what it includes, which cars) rather than 22 identical
 * cards. Every row links to /services/<slug>. No prices anywhere on the
 * page by design. The price answer and the where answer share one
 * editorial list with the FAQ.
 */
const CATEGORY_INTRO: Record<ServiceCategoryName, { title: string; body: string; icon: string }> = {
  Routine: {
    title: "Which routine services can I book?",
    body: "Three: Oil Change, Filter Replacement and Battery Replacement, the jobs most cars need more than once a year. Each is priced by the shop for your exact car, with the parts included in the total you see before you confirm, so there is nothing to add at pickup.",
    icon: "oil_change",
  },
  "Tires & Brakes": {
    title: "Which tire and brake services can I book?",
    body: "Seven, from Tire Rotation to Rotor Replacement. Tire Rotation, Tire Balance and Wheel Alignment are labor-only; Tire Replacement, Brake Pad Replacement, Rotor Replacement and Brake Fluid Flush include the parts or fluid in the total. Tire Rotation is shown only where the tire setup allows it.",
    icon: "brake_pad_replacement",
  },
  "Scheduled Service": {
    title: "Which scheduled services can I book?",
    body: "Seven interval services: Spark Plugs, Timing Belt, Coolant Flush, Transmission Service, Power Steering Flush, Differential Service and Fuel System Cleaning. Several apply only to certain cars, a belt-driven engine, hydraulic steering, a separate differential, and Oto shows each one only when it applies to yours.",
    icon: "timing_belt",
  },
  Inspections: {
    title: "Which inspections and diagnostics can I book?",
    body: "Five: Diagnostic Scan, Check Engine Light Diagnosis, State Inspection, Emissions Test and Battery Test. All five are labor-only, so the price is the shop's time at the rate it set. State Inspection and Emissions Test are performed only by shops licensed by the New York DMV as inspection stations.",
    icon: "state_inspection",
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
const PROSE =
  "max-w-[62ch] text-[17px] leading-[1.65] text-[#4c5661] [text-wrap:pretty] [&_p+p]:mt-4 [&_a]:text-[#4B82A5] [&_a]:underline [&_a]:decoration-[#4B82A5]/40 [&_a]:underline-offset-[3px] [&_a:hover]:decoration-[#4B82A5]";
const ROW = "grid gap-2 py-6 tab:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] tab:gap-x-10 tab:py-7";
const TERM = "serif-text text-[21px] leading-[1.3] text-[#1a1a1a] [text-wrap:balance]";
const ANSWER =
  "max-w-[60ch] text-[16px] leading-[1.6] text-[#4c5661] [&_p+p]:mt-3 [&_a]:text-[#4B82A5] [&_a]:underline [&_a]:decoration-[#4B82A5]/40 [&_a]:underline-offset-[3px] [&_a:hover]:decoration-[#4B82A5]";

export default function ServicesIndexPage() {
  const groups = servicesByCategory();
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

      {/* ---------- Four categories, each headed by its icon, services as rows ---------- */}
      {groups.map(({ category, services }, gi) => {
        const intro = CATEGORY_INTRO[category.name];
        const icon = serviceIcon(intro.icon);
        return (
          <section key={category.id} id={category.id} className={`scroll-mt-28 ${gi === 0 ? "" : "pt-16 lg:pt-24"}`}>
            <div className="flex items-start gap-5">
              <span className="flex size-16 shrink-0 items-center justify-center rounded-[18px] bg-[#EBF5FB] p-2.5 sm:size-20 sm:p-3">
                <Image src={icon.src} alt="" width={icon.w} height={icon.h} sizes="80px" className="h-auto w-full object-contain" />
              </span>
              <div>
                <h2 className={H2}>{intro.title}</h2>
                <p className={`mt-4 ${PROSE}`}>{intro.body}</p>
              </div>
            </div>
            <ul className="mt-8 flex flex-col divide-y divide-[#1a1a1a]/10 border-y border-[#1a1a1a]/10">
              {services.map((s) => (
                <li key={s.slug} className={ROW}>
                  <div>
                    <Link
                      href={`/services/${s.slug}`}
                      className={`${TERM} transition-colors duration-300 hover:text-[#4B82A5]`}
                    >
                      {s.name}
                    </Link>
                    <p className="mt-1.5 text-[12px] tracking-[0.12em] text-[#777169]">
                      {s.is_labor_only ? "LABOR ONLY" : "PARTS INCLUDED"}
                    </p>
                  </div>
                  <div className={ANSWER}>
                    <p>{s.description}.</p>
                    <ApplicabilityChips service={s} />
                  </div>
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      {/* ---------- The details and the questions: one editorial list ---------- */}
      <section id="details" className="mt-16 scroll-mt-28 border-t border-[#1a1a1a]/10 pt-16 lg:mt-24 lg:pt-24">
        <h2 className={H2}>The details, in plain terms.</h2>
        <dl className="mt-8 flex flex-col divide-y divide-[#1a1a1a]/10 border-b border-[#1a1a1a]/10">
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
        <FaqList items={FAQ} className="[&>div:first-child]:pt-6 tab:[&>div:first-child]:pt-7 [&_dd]:max-w-[60ch]" />
      </section>
    </PageShell>
  );
}
