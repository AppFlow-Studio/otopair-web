import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import PageShell from "@/components/flagship/page-shell";
import { FaqList, type FaqItem } from "@/components/seo/faq";
import { JsonLd } from "@/components/seo/json-ld";
import { serviceIcon } from "@/components/flagship/hero-visual";
import { Reveal } from "@/components/flagship/landing/reveal";
import { HeroPhone, ServiceBooking } from "@/components/flagship/local-sections";
import { PillLink, TextLink } from "@/components/flagship/pill-button";
import { DirectoryGrid } from "@/components/flagship/product/local";
import { CategoryScreen } from "@/components/flagship/product/screens/browse";
import { BookingSteps, CarApplicability, NoShopsYet, ServiceJsonLd } from "@/components/flagship/service-page-bits";
import { TOP_LOCAL_SERVICES, isTopLocalService, serviceBySlug } from "@/lib/service-catalog";
import { shopsOfferingService } from "@/lib/public-shops";
import { STATEN_ISLAND_PHONE, staticMapSrc } from "@/lib/static-map";

/**
 * /staten-island/<service> (design pass 2026-09-05, the app up close):
 * local-intent pages for the ten TOP_LOCAL_SERVICES. The hero is the
 * app's category list with this service selected, in the app's own
 * words for it; the shops that list it are the directory's cards (live,
 * lib/public-shops.ts); "how do I book it" is Oto's in-chat wizard open
 * on the service beside the steps as the app runs them. The cost answer
 * carries no number, because prices are per shop, per car, and never
 * published.
 */

export const revalidate = 300;

export function generateStaticParams() {
  return TOP_LOCAL_SERVICES.map((service) => ({ service }));
}

type Params = { params: Promise<{ service: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { service: slug } = await params;
  const s = serviceBySlug(slug);
  if (!s || !isTopLocalService(slug)) return {};
  return {
    title: { absolute: `${s.name} in Staten Island: book a verified shop at a locked price` },
    description: `${s.description}. See which verified Staten Island shops offer ${s.name}, how the price is set, and how to book it through Otopair with the full total shown before you confirm.`,
    alternates: { canonical: `/staten-island/${slug}` },
  };
}

const H2 = "serif-display max-w-[16ch] text-[32px] leading-[1.04] tracking-[-0.01em] text-[#1a1a1a] [text-wrap:balance] tab:text-[38px]";
const PROSE =
  "max-w-[62ch] text-[17px] leading-[1.65] text-[#4c5661] [text-wrap:pretty] [&_p+p]:mt-4 [&_a]:text-[#4B82A5] [&_a]:underline [&_a]:decoration-[#4B82A5]/40 [&_a]:underline-offset-[3px] [&_a:hover]:decoration-[#4B82A5]";
const ROW = "grid gap-2 py-6 tab:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] tab:gap-x-10 tab:py-7";
const TERM = "serif-text text-[21px] leading-[1.3] text-[#1a1a1a] [text-wrap:balance]";
const ANSWER =
  "max-w-[60ch] text-[16px] leading-[1.6] text-[#4c5661] [&_p+p]:mt-3 [&_a]:text-[#4B82A5] [&_a]:underline [&_a]:decoration-[#4B82A5]/40 [&_a]:underline-offset-[3px] [&_a:hover]:decoration-[#4B82A5] [&_ul]:mt-3 [&_ul]:flex [&_ul]:flex-col [&_ul]:gap-1.5 [&_ul]:pl-5 [&_ul>li]:relative [&_ul>li]:before:absolute [&_ul>li]:before:-left-5 [&_ul>li]:before:top-[0.8em] [&_ul>li]:before:h-px [&_ul>li]:before:w-2.5 [&_ul>li]:before:bg-[#4B82A5] [&_strong]:font-medium [&_strong]:text-[#1a1a1a]";

export default async function LocalServicePage({ params }: Params) {
  const { service: slug } = await params;
  const service = serviceBySlug(slug);
  if (!service || !isTopLocalService(slug)) notFound();

  const icon = serviceIcon(slug);
  const shops = await shopsOfferingService(slug);
  const path = `/staten-island/${slug}`;
  const n = shops.length;
  const mapSrc = staticMapSrc(STATEN_ISLAND_PHONE, 390, 844);

  const faq: FaqItem[] = [
    {
      q: `Can I book ${service.name} on Staten Island today?`,
      a:
        n > 0
          ? `Yes. ${n} verified Staten Island ${n === 1 ? "shop lists" : "shops list"} ${service.name} right now, and the list on this page is live. Tell Oto in the app and it shows you the ones that can take your car, with the price each one set.`
          : `Not from a listed shop yet. ${service.name} is in the catalog, but no verified Staten Island shop lists it at the moment. Shops choose which of the 22 services they offer, and this page updates as soon as one adds it; every verified shop is at otopair.com/shops.`,
    },
    {
      q: `Do you publish a Staten Island price for ${service.name}?`,
      a: `No. There is no Otopair average, range or starting price for ${service.name} on Staten Island or anywhere else. Each shop sets its own price, and the app builds the total for your exact car, parts, labor, tax and Otopair's service fee, and shows it in full before you confirm. That total is locked before the car goes in.`,
    },
    {
      q: "What happens if the shop finds something else?",
      a: "You decide, in the app. The shop confirms the final price after inspecting the car; it cannot go above what you approved without your OK. If more work is needed you get an approval request, nothing extra is charged until you say yes, and added work you decline is not done and not charged. An estimate left unanswered for 24 hours forfeits the $20 deposit.",
    },
    {
      q: "Do you come to me?",
      a: "No. Otopair is a marketplace for booking a shop, not a mobile mechanic. You bring the car to the Staten Island shop you booked, at the time you booked, and the locked price is what you pay.",
    },
  ];

  return (
    <PageShell
      mark={
        <span className="flex size-16 items-center justify-center rounded-[18px] bg-white/60 p-2.5 ring-1 ring-white/70 sm:size-20 sm:p-3">
          <Image src={icon.src} alt="" width={icon.w} height={icon.h} sizes="80px" className="h-auto w-full object-contain" priority />
        </span>
      }
      title={`${service.name} in Staten Island.`}
      lede={`${service.description}. Book it at a verified Staten Island shop, with the full total shown before you confirm.`}
      crumbs={[
        { name: "Home", href: "/" },
        { name: "Coverage", href: "/coverage" },
        { name: "Staten Island", href: "/staten-island" },
        { name: service.name, href: path },
      ]}
      hero={
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <PillLink href="/download">Get notified at launch</PillLink>
          <TextLink href={`/services/${slug}`}>{service.name}, in detail</TextLink>
        </div>
      }
      visual={
        <HeroPhone>
          <CategoryScreen forSlug={slug} selected={[slug]} mapSrc={mapSrc} />
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

      {/* ---------- The shops that offer it ---------- */}
      <section id="shops" className="scroll-mt-28">
        {/* Heading and the sentence that answers it are one block. The cards
            below already stagger themselves — DirectoryWithMap runs them
            through Stagger (components/flagship/product/local.tsx). */}
        <Reveal>
          <h2 className={H2}>Which Staten Island shops offer {service.name}?</h2>
          <div className={`mt-6 ${PROSE}`}>
            {n > 0 ? (
              <p>
                {n} verified {n === 1 ? "shop" : "shops"} on Staten Island {n === 1 ? "lists" : "list"} {service.name}{" "}
                today. Each one has been reviewed and approved by Otopair and set its own price for the job; Oto shows
                you the number for your car. This list is live and updates as shops add or drop the service.
              </p>
            ) : (
              <NoShopsYet serviceName={service.name} />
            )}
          </div>
        </Reveal>
        {n > 0 && (
          <div className="mt-8">
            <DirectoryGrid shops={shops} />
          </div>
        )}
      </section>

      {/* ---------- How to book it: Oto's wizard, and the steps ---------- */}
      {/* No wrapper here: ServiceBooking's own text column is already a
          Reveal (components/flagship/local-sections.tsx), and it is the
          element that carries the grid's order-* and col-span-*. The <ol>
          keeps its numerals — nothing goes between it and its <li>s. */}
      <ServiceBooking slug={slug} name={service.name}>
        <BookingSteps serviceName={service.name} />
      </ServiceBooking>

      {/* ---------- Cost, cars, questions: one list ---------- */}
      <section id="details" className="scroll-mt-28 border-t border-[#1a1a1a]/10 pt-14 tab:pt-20">
        <Reveal>
          <h2 className={H2}>The details, in plain terms.</h2>
        </Reveal>
        {/* The definition rows are a <dl> of prose: one block, never term by
            term. The FaqList below is NOT wrapped with them — it runs its own
            Sequence and Seq's each row (components/seo/faq.tsx), so a Reveal
            over it would compound a 26px rise onto the rows' own 14px one. */}
        <Reveal delay={0.08}>
          <dl className="mt-8 flex flex-col divide-y divide-[#1a1a1a]/10 border-b border-[#1a1a1a]/10">
            <div className={ROW} id="cost">
              <dt className={TERM}>How much does {service.name} cost on Staten Island?</dt>
              <dd className={ANSWER}>
                <p>
                  Whatever the shop you pick set for your exact car, and you see that number in full before you confirm.
                  Each Staten Island shop on Otopair sets its own labor rate and can set a flat price for {service.name};
                  the app builds the total for your car from that, with parts, labor, tax and Otopair&rsquo;s service fee
                  included, and locks it before the car goes in.
                </p>
                <p>
                  Otopair does not publish an average, a range or a starting price for {service.name} on Staten Island,
                  because none of those would be the price you pay. A $20 hold reserves the slot; the shop confirms the
                  final price after inspecting the car, and it cannot go above what you approved without your OK in the
                  app.
                </p>
              </dd>
            </div>
            <div className={ROW} id="cars">
              <dt className={TERM}>Which cars is {service.name} available for?</dt>
              <dd className={ANSWER}>
                <CarApplicability service={service} />
              </dd>
            </div>
          </dl>
        </Reveal>
        <FaqList items={faq} className="[&>div:first-child]:pt-6 tab:[&>div:first-child]:pt-7 [&_dd]:max-w-[60ch]" />
        <Reveal>
          <p className="mt-8 text-[15px] text-[#4c5661]">
            What the service includes, when you need it and the dashboard cues:{" "}
            <Link href={`/services/${slug}`} className="text-[#4B82A5] underline decoration-[#4B82A5]/40 underline-offset-[3px] hover:decoration-[#4B82A5]">
              {service.name} on Otopair
            </Link>
            . Everything else bookable on the island:{" "}
            <Link href="/staten-island" className="text-[#4B82A5] underline decoration-[#4B82A5]/40 underline-offset-[3px] hover:decoration-[#4B82A5]">
              Staten Island
            </Link>{" "}
            ·{" "}
            <Link href="/services" className="text-[#4B82A5] underline decoration-[#4B82A5]/40 underline-offset-[3px] hover:decoration-[#4B82A5]">
              All 22 services
            </Link>{" "}
            ·{" "}
            <Link href="/shops" className="text-[#4B82A5] underline decoration-[#4B82A5]/40 underline-offset-[3px] hover:decoration-[#4B82A5]">
              Verified shops
            </Link>
            .
          </p>
        </Reveal>
      </section>
    </PageShell>
  );
}
