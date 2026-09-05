import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import PageShell from "@/components/flagship/page-shell";
import { FaqList, type FaqItem } from "@/components/seo/faq";
import { JsonLd } from "@/components/seo/json-ld";
import { serviceIcon } from "@/components/flagship/hero-visual";
import { HeroPhone } from "@/components/flagship/local-sections";
import { PillLink, TextLink } from "@/components/flagship/pill-button";
import { DirectoryGrid } from "@/components/flagship/product/local";
import { ServiceInfoScreen } from "@/components/flagship/product/screens/browse";
import {
  CarApplicability,
  HowPriceIsSet,
  NoShopsYet,
  ServiceJsonLd,
} from "@/components/flagship/service-page-bits";
import {
  SERVICE_SLUGS,
  isTopLocalService,
  serviceBySlug,
  warningLightsFor,
  type CatalogService,
} from "@/lib/service-catalog";
import { shopsOfferingService } from "@/lib/public-shops";
import { STATEN_ISLAND_PHONE, staticMapSrc } from "@/lib/static-map";

/**
 * /services/<slug> (design pass 2026-09-05, the app up close): one page per
 * bookable service. The hero is the app's own info sheet for the service
 * (the ⓘ on its row): the Service Guide's quick look, what it is, why it
 * matters, the signs, the time and "Shows for", in the app's words
 * (lib/service-copy.ts). Below it, static copy from lib/service-catalog.ts
 * (the seed's name, description and applicability flags; nothing invented
 * beyond them) plus the live list of verified Staten Island shops that
 * offer it, as the directory's cards. Prices are never printed.
 */

// Live shop list refreshes every 5 minutes; the copy is static.
export const revalidate = 300;

export function generateStaticParams() {
  return SERVICE_SLUGS.map((slug) => ({ slug }));
}

type Params = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const s = serviceBySlug(slug);
  if (!s) return {};
  return {
    title: { absolute: `${s.name} in Staten Island: book at a locked price` },
    description: `${s.description}. Book ${s.name} at a verified Staten Island shop through Otopair: the full total shown before you confirm, a $20 hold, and a price locked before the car goes in.`,
    alternates: { canonical: `/services/${slug}` },
  };
}

/** "When do I need it?": the first sentence answers the question.
 *  Warning-light cues come from lib/service-catalog WARNING_LIGHT_CUES (the
 *  app's own light-to-service map); everything else is schedule framing
 *  with no invented intervals or mileage. */
const WHEN_NEEDED: Record<string, string> = {
  diagnostic_scan:
    "When a warning light is on and you want to know what the car is reporting before committing to a repair. The scan reads the codes your car has stored, and clears them, so the next step is a decision, not a guess.",
  check_engine_light:
    "When the check engine light comes on. The diagnosis goes past the code to the root cause, so you know what to book next instead of paying to replace parts on a hunch.",
  state_inspection:
    "Once a year. New York's safety inspection is an annual certification, so the cue is the expiry month on your current sticker; book it before that month ends.",
  emissions_test:
    "When New York requires it for your registration. The emissions test is a state compliance check, and it applies only to cars with a gas or hybrid engine.",
  oil_change:
    "When the oil-pressure light comes on, or when your car's service schedule calls for it. It is the most routine job on the list, and Oto checks where your car stands against its own records before you book.",
  filter_replacement:
    "When your car's maintenance schedule calls for it. Engine and cabin air filters are interval items rather than symptom items; if you are not sure where your car stands, tell Oto and it checks against your car's records.",
  spark_plugs:
    "When your car's service schedule calls for it. Spark plugs are an interval item on gas and hybrid engines, and the replacement uses OEM-spec plugs for your exact engine.",
  timing_belt:
    "When your car's service schedule calls for it. A timing belt is an interval item, not a symptom item: the kit (belt, tensioner and idler pulleys) is replaced on schedule, and only belt-driven engines have one.",
  coolant_flush:
    "When the temperature warning comes on, or when your car's schedule calls for a cooling-system service. The full flush and refill uses the OEM coolant specified for your car.",
  transmission_service:
    "When the transmission warning comes on, or when your car's schedule calls for a fluid service. This is a drain-and-fill with OEM-spec fluid, booked by the interval your car's records show.",
  tire_rotation:
    "When your car's schedule calls for it, and it is the service Oto ties to a tire-pressure (TPMS) warning. Rotating on schedule promotes even wear and extends tire life; it is shown only where your tire setup allows rotation.",
  tire_balance:
    "When you feel vibration through the wheel or seat at speed, or with new tires. Balancing all four wheels is the fix for that vibration, and it is one of the services Oto ties to a tire-pressure (TPMS) warning.",
  wheel_alignment:
    "When the car pulls to one side or the steering wheel sits off-center, and on schedule. Alignment sets the wheel angles back to the manufacturer's specification; Oto also ties it to a tire-pressure (TPMS) warning.",
  tire_replacement:
    "When a tire is worn or damaged. New tires are mounted and balanced to your car's OEM size specification, and the shop prices the tires for your exact car before you confirm.",
  brake_pad_replacement:
    "When the ABS or brake warning light comes on, or when the brakes squeal or grind. Pads are replaced front and/or rear with OEM parts; the shop confirms which axle after inspection.",
  rotor_replacement:
    "When the ABS or brake warning light comes on, or when braking pulses or the pads have worn into the rotors. Rotors and pads are replaced together on the front and/or rear axle.",
  brake_fluid_flush:
    "When the ABS or brake warning light comes on, when the pedal feels soft, or when your car's schedule calls for it. The flush and bleed covers all four corners.",
  battery_test:
    "When the battery light comes on, when the car is slow to start, or when you want to know the battery's health before paying to replace it. The test loads the battery and checks the charging system.",
  battery_replacement:
    "When the battery light comes on or a Battery Test says the battery is done. The replacement is matched to your car's group size and CCA rating.",
  power_steering_flush:
    "When your car's schedule calls for it, and only on cars with hydraulic power steering. Most modern cars use electric steering with no fluid to flush, which is why Oto shows this service only where there is evidence your car's steering is hydraulic.",
  differential_service:
    "When your car's schedule calls for it, on AWD and RWD cars with a separate differential. A front-wheel-drive car's final drive shares the transmission fluid, so there is nothing separate to service and Oto does not show it.",
  fuel_system_cleaning:
    "When your car's schedule calls for it, or when performance has fallen off, on gas and hybrid engines. The service cleans the injectors and intake valves to restore performance.",
};

function includesCopy(s: CatalogService): string {
  if (s.is_labor_only) {
    return "This is a labor-only service: no parts are sold with it, so the price is the shop's time at the labor rate it set for your car.";
  }
  if (s.requires_parts && s.requires_fluids) {
    return "The parts and fluids the job needs are priced for your exact car and included in the total you see before you confirm.";
  }
  if (s.requires_parts) {
    return "The parts are priced for your exact car and included in the total you see before you confirm.";
  }
  return "The fluid is priced for your exact car and included in the total you see before you confirm.";
}

function joinLights(labels: string[]): string {
  if (labels.length <= 1) return labels.join("");
  return `${labels.slice(0, -1).join(", ")} or ${labels[labels.length - 1]}`;
}

const H2 = "serif-display max-w-[16ch] text-[32px] leading-[1.04] tracking-[-0.01em] text-[#1a1a1a] [text-wrap:balance] tab:text-[38px]";
const ROW = "grid gap-2 py-6 tab:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] tab:gap-x-10 tab:py-7";
const TERM = "serif-text text-[21px] leading-[1.3] text-[#1a1a1a] [text-wrap:balance]";
const ANSWER =
  "max-w-[60ch] text-[16px] leading-[1.6] text-[#4c5661] [&_p+p]:mt-3 [&_a]:text-[#4B82A5] [&_a]:underline [&_a]:decoration-[#4B82A5]/40 [&_a]:underline-offset-[3px] [&_a:hover]:decoration-[#4B82A5] [&_ul]:mt-3 [&_ul]:flex [&_ul]:flex-col [&_ul]:gap-1.5 [&_ul]:pl-5 [&_ul>li]:relative [&_ul>li]:before:absolute [&_ul>li]:before:-left-5 [&_ul>li]:before:top-[0.8em] [&_ul>li]:before:h-px [&_ul>li]:before:w-2.5 [&_ul>li]:before:bg-[#4B82A5]";

export default async function ServicePage({ params }: Params) {
  const { slug } = await params;
  const service = serviceBySlug(slug);
  if (!service) notFound();

  const icon = serviceIcon(slug);
  const mapSrc = staticMapSrc(STATEN_ISLAND_PHONE, 390, 844);
  const shops = await shopsOfferingService(slug);
  const lights = warningLightsFor(slug).map((l) => l.label);
  const local = isTopLocalService(slug);
  const path = `/services/${slug}`;

  const faq: FaqItem[] = [
    {
      q: `Is ${service.name} available on Otopair right now?`,
      a:
        shops.length > 0
          ? `Yes, on Staten Island. ${shops.length} verified Staten Island ${shops.length === 1 ? "shop lists" : "shops list"} ${service.name} today, and the list on this page is live. Oto shows you the ones that can take your car and the price each one set.`
          : `It is in the catalog, but no verified Staten Island shop lists ${service.name} yet. Shops choose which of the 22 services they offer, and this page updates as soon as one adds it. Every verified shop is at otopair.com/shops.`,
    },
    {
      q: `How much does ${service.name} cost?`,
      a: `The shop sets it, for your exact car. Otopair does not publish an average or a starting price for ${service.name}. In the app you see the full total, parts, labor, tax and Otopair's service fee, before you confirm, and it is locked before the car goes in. A $20 hold reserves the slot; the shop confirms the final price after inspection, and it cannot go above what you approved without your OK.`,
    },
    {
      q: "Can the price change after I book?",
      a: "Not above what you approved. The shop confirms the final price after inspecting the car. If the job needs more than you approved, you get an approval request in the app and nothing extra is charged until you say yes; added work you decline is not done and not charged. An inspection estimate left unanswered for 24 hours forfeits the $20 deposit, so answer it when it arrives.",
    },
  ];

  return (
    <PageShell
      mark={
        <span className="flex size-16 items-center justify-center rounded-[18px] bg-white/60 p-2.5 ring-1 ring-white/70 sm:size-20 sm:p-3">
          <Image src={icon.src} alt="" width={icon.w} height={icon.h} sizes="80px" className="h-auto w-full object-contain" priority />
        </span>
      }
      title={`${service.name}.`}
      lede={`${service.description}. Book it at a verified Staten Island shop, with the full total shown before you confirm.`}
      crumbs={[
        { name: "Home", href: "/" },
        { name: "Services", href: "/services" },
        { name: service.name, href: path },
      ]}
      hero={
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <PillLink href="/download">Get notified at launch</PillLink>
          <TextLink href="/services">All 22 services</TextLink>
        </div>
      }
      visual={
        <HeroPhone>
          <ServiceInfoScreen slug={slug} mapSrc={mapSrc} />
        </HeroPhone>
      }
      visualFrame={false}
      width="wide"
    >
      <ServiceJsonLd service={service} path={path} />
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

      {/* ---------- Everything about the service, in one list ---------- */}
      <section id="details" className="scroll-mt-28">
        <h2 className={H2}>{service.name}, in plain terms.</h2>
        <dl className="mt-8 flex flex-col divide-y divide-[#1a1a1a]/10 border-b border-[#1a1a1a]/10">
          <div className={ROW} id="includes">
            <dt className={TERM}>What does it include?</dt>
            <dd className={ANSWER}>
              <p>
                {service.description}. {includesCopy(service)}
              </p>
              <p>
                It is one of 22 bookable services on Otopair, and the name you see here is the name the shop sees on
                its board. Oto uses the catalog&rsquo;s names and nothing else, so what you book is what the shop does.
              </p>
            </dd>
          </div>
          <div className={ROW} id="when">
            <dt className={TERM}>When do I need it?</dt>
            <dd className={ANSWER}>
              <p>{WHEN_NEEDED[slug] ?? `When your car's service schedule calls for it. Tell Oto and it checks against your car's records.`}</p>
              {lights.length > 0 && (
                <p>
                  Dashboard cue: the {joinLights(lights)}. Oto maps that light to {service.name}, and once the job is
                  recorded done it clears the light in your car&rsquo;s record.
                </p>
              )}
            </dd>
          </div>
          <div className={ROW} id="cars">
            <dt className={TERM}>Which cars is it available for?</dt>
            <dd className={ANSWER}>
              <CarApplicability service={service} />
            </dd>
          </div>
          <div className={ROW} id="price">
            <dt className={TERM}>How is the price set?</dt>
            <dd className={ANSWER}>
              <HowPriceIsSet serviceName={service.name} />
            </dd>
          </div>
          <div className={ROW} id="shops">
            <dt className={TERM}>Which Staten Island shops offer it?</dt>
            <dd className={ANSWER}>
              {shops.length > 0 ? (
                <p>
                  {shops.length} verified {shops.length === 1 ? "shop" : "shops"} on Staten Island{" "}
                  {shops.length === 1 ? "lists" : "list"} {service.name} today: {shops.map((s) => s.name).join(", ")}.
                  Each one set its own price for it; Oto shows you the number for your car. The list is live and updates
                  as shops add or drop the service.
                </p>
              ) : (
                <NoShopsYet serviceName={service.name} />
              )}
              {local && (
                <p>
                  The Staten Island page for this service has the same live shop list, the booking steps and the local
                  questions in one place: <Link href={`/staten-island/${slug}`}>{service.name} in Staten Island</Link>.
                </p>
              )}
            </dd>
          </div>
        </dl>
        {shops.length > 0 && (
          <div className="mt-8">
            <DirectoryGrid shops={shops} />
          </div>
        )}
      </section>

      {/* ---------- Questions ---------- */}
      <section id="faq" className="scroll-mt-28 pt-12 lg:pt-16">
        <FaqList items={faq} className="border-b border-[#1a1a1a]/10 [&>div:first-child]:pt-0 [&_dd]:max-w-[60ch]" />
        <p className="mt-8 text-[15px] text-[#4c5661]">
          <Link href="/services" className="text-[#4B82A5] underline decoration-[#4B82A5]/40 underline-offset-[3px] hover:decoration-[#4B82A5]">
            All 22 services
          </Link>{" "}
          ·{" "}
          <Link href="/staten-island" className="text-[#4B82A5] underline decoration-[#4B82A5]/40 underline-offset-[3px] hover:decoration-[#4B82A5]">
            Staten Island
          </Link>{" "}
          ·{" "}
          <Link href="/shops" className="text-[#4B82A5] underline decoration-[#4B82A5]/40 underline-offset-[3px] hover:decoration-[#4B82A5]">
            Verified shops
          </Link>
        </p>
      </section>
    </PageShell>
  );
}
