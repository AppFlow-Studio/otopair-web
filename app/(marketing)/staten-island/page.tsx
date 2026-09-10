import type { Metadata } from "next";
import Link from "next/link";
import PageShell from "@/components/flagship/page-shell";
import NetworkMap from "@/components/flagship/landing/network-map";
import { Reveal } from "@/components/flagship/landing/reveal";
import { Bezel } from "@/components/flagship/bezel";
import { HeroPhone, HubServices } from "@/components/flagship/local-sections";
import { PillLink, TextLink } from "@/components/flagship/pill-button";
import { DirectoryGrid } from "@/components/flagship/product/local";
import { SelectServicesScreen } from "@/components/flagship/product/screens/browse";
import { FaqList, type FaqItem } from "@/components/seo/faq";
import { JsonLd } from "@/components/seo/json-ld";
import { STATEN_ISLAND_NEIGHBORHOODS, UPCOMING_BOROUGHS } from "@/lib/coverage";
import { listPublicShops, onStatenIsland } from "@/lib/public-shops";
import { BOOKABLE_SERVICE_COUNT, topLocalServices } from "@/lib/service-catalog";
import { STATEN_ISLAND_PHONE, phonePins, staticMapSrc } from "@/lib/static-map";

export const metadata: Metadata = {
  title: { absolute: "Car repair on Staten Island: verified shops at a locked price, booked through Otopair" },
  description:
    "Staten Island is Otopair's live market. Tell Oto what your car is doing, pick a verified independent shop on the island, and book at a price you see in full before you confirm, locked before the car goes in.",
  alternates: { canonical: "/staten-island" },
};

/**
 * /staten-island (design pass 2026-09-05, the app up close): the live
 * borough's hub. The hero is the app's Select Services screen over the
 * island, with the CLOSEST SHOP card carrying a real verified shop when
 * one exists (its own loading state otherwise); the verified shops are
 * the directory's cards, fed only by lib/public-shops.ts; the live map is
 * framed once; the ten local service pages sit beside one phone that
 * cycles through the four category lists; the neighborhoods and the
 * questions stay editorial. Stand-in shop names from the landing never
 * appear here.
 */

// Shop list refreshes every 5 minutes.
export const revalidate = 300;

const FAQ: FaqItem[] = [
  {
    q: "Is Otopair live on Staten Island?",
    a: "Yes. Staten Island is Otopair's first and, today, only live borough. Every shop you can book in the app is a verified independent shop on the island, and the price is locked before the car goes in. Drivers from anywhere can book a Staten Island shop.",
  },
  {
    q: "Where are the shops?",
    a: "Across the island. The map on this page shows the network's real locations, and the shop cards name the neighborhood each verified shop sits in. A shop appears here once it has been reviewed and approved by Otopair and is bookable in the app.",
  },
  {
    q: "Do you come to me?",
    a: "No. Otopair is a marketplace for booking a shop, not a mobile mechanic. You bring the car to the shop you booked, at the time you booked, and the price you locked is what you pay. Any extra work has to be approved by you in the app first.",
  },
  {
    q: "What about the other boroughs?",
    a: "Brooklyn is planned for Q4 2026, Queens for Q1 2027, The Bronx for Q2 2027 and Manhattan for Q3 2027. A borough opens once enough verified shops are on the network to book from; each borough page has a waitlist that emails you when its first shops go live.",
  },
];

const H2 = "serif-display max-w-[16ch] text-[32px] leading-[1.04] tracking-[-0.01em] text-[#1a1a1a] [text-wrap:balance] tab:text-[38px]";
const PROSE =
  "max-w-[62ch] text-[17px] leading-[1.65] text-[#4c5661] [text-wrap:pretty] [&_p+p]:mt-4 [&_a]:text-[#4B82A5] [&_a]:underline [&_a]:decoration-[#4B82A5]/40 [&_a]:underline-offset-[3px] [&_a:hover]:decoration-[#4B82A5]";
const ROW = "grid gap-2 py-6 tab:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] tab:gap-x-10 tab:py-7";
const TERM = "serif-text text-[21px] leading-[1.3] text-[#1a1a1a] [text-wrap:balance]";
const ANSWER =
  "max-w-[60ch] text-[16px] leading-[1.6] text-[#4c5661] [&_p+p]:mt-3 [&_a]:text-[#4B82A5] [&_a]:underline [&_a]:decoration-[#4B82A5]/40 [&_a]:underline-offset-[3px] [&_a:hover]:decoration-[#4B82A5]";

export default async function StatenIslandPage() {
  const shops = (await listPublicShops()).filter(onStatenIsland);
  const served = new Set(shops.map((s) => s.neighborhood).filter((n): n is string => !!n));
  // Neighborhoods split by whether a verified shop actually sits in them, in
  // the roster's own north-to-south order. The first shop found is the one
  // named; a second shop in the same neighborhood is reachable from its page.
  const withShop = STATEN_ISLAND_NEIGHBORHOODS.filter((n) => served.has(n)).map((name) => ({
    name,
    shop: shops.find((sh) => sh.neighborhood === name)!,
  }));
  const rest = STATEN_ISLAND_NEIGHBORHOODS.filter((n) => !served.has(n));
  const local = topLocalServices();
  const mapSrc = staticMapSrc(STATEN_ISLAND_PHONE, 390, 844);

  return (
    <PageShell
      title="Car repair on Staten Island, at a locked price."
      lede="Tell Oto what the car is doing, pick a verified Staten Island shop, and the price is locked before drop-off."
      crumbs={[
        { name: "Home", href: "/" },
        { name: "Coverage", href: "/coverage" },
        { name: "Staten Island", href: "/staten-island" },
      ]}
      hero={
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <PillLink href="/download">Get notified at launch</PillLink>
          <TextLink href="/how-it-works">How a booking runs</TextLink>
        </div>
      }
      visual={
        <HeroPhone>
          <SelectServicesScreen closest={shops[0] ? { name: shops[0].name } : null} pins={phonePins(shops)} mapSrc={mapSrc} />
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

      {/* ---------- The shops ---------- */}
      <section id="shops" className="scroll-mt-28">
        {/* Heading and the sentence that answers it are one block. The cards
            below already stagger themselves — DirectoryWithMap runs them
            through Stagger (components/flagship/product/local.tsx). */}
        <Reveal>
          <h2 className={H2}>Which Staten Island shops can I book?</h2>
          <div className={`mt-6 ${PROSE}`}>
            {shops.length > 0 ? (
              <p>
                {shops.length} verified {shops.length === 1 ? "shop is" : "shops are"} bookable on Staten Island today. Each one
                has been reviewed and approved by Otopair, sets its own prices, and lists the services it offers on its
                profile. The list is live.
              </p>
            ) : (
              <p>
                No verified shop is listed on this page yet. A shop appears here the day it has been reviewed and approved
                by Otopair and is bookable in the app; until then, Oto is the fastest way to see who can take your car.{" "}
                <Link href="/shops">Browse every verified shop</Link> as they come online.
              </p>
            )}
          </div>
        </Reveal>
        {shops.length > 0 && (
          <div className="mt-8">
            <DirectoryGrid shops={shops} />
          </div>
        )}
      </section>

      {/* ---------- The live map, framed once ---------- */}
      <section id="map" className="scroll-mt-28 pt-16 tab:pt-20">
        {/* The map is one heavy object: the framed plate and its caption
            settle together, and nothing inside it is animated. */}
        <Reveal>
          <figure>
            <Bezel>
              <NetworkMap frame={false} className="aspect-[16/10] w-full lg:aspect-[21/9]" />
            </Bezel>
            <figcaption className="mt-3 text-center text-[13.5px] tracking-[0.03em] text-[#1a1a1a]">
              The network map, live. Zoom in on the island for the shops.
            </figcaption>
          </figure>
        </Reveal>
      </section>

      {/* ---------- The ten local service pages, beside the app's four lists ---------- */}
      <HubServices local={local.map((s) => ({ slug: s.slug, name: s.name, description: s.description }))} />

      {/* ---------- Neighborhoods ----------
          Was a 56-name list in four columns with the served ones bolded: the
          only signal was font weight, which reads as an accident rather than
          as data, and the whole block sat on bare white with nothing holding
          it (design feedback 2026-09-05). It is now one object on a paper
          plate, and the two states are labelled instead of implied — the
          neighborhoods with a shop name that shop and link to it, the rest
          are the quiet roster underneath. The count is computed, never
          typed. Deliberately NOT grouped by shore: the north/mid/east/south
          lines are contested at the margins (Todt Hill, Richmondtown) and a
          local page is read by people who would notice us guessing. */}
      <section id="neighborhoods" className="scroll-mt-28">
        <Reveal>
          <h2 className={H2}>Which neighborhoods does Otopair cover?</h2>
          <p className={`mt-6 ${PROSE}`}>
            The whole island, from St. George to Tottenville. A shop&rsquo;s profile names the neighborhood it sits in,
            and every other neighborhood books the nearest shop on the map. Neighborhood pages will open as verified
            shops come online in each one.
          </p>
        </Reveal>
        <Reveal delay={0.08} className="mt-8">
          <div className="rounded-[28px] bg-[#f7f6f3] p-6 shadow-[inset_0_0_0_1px_rgba(26,26,26,0.06)] tab:rounded-[40px] tab:p-10">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="serif-text text-[34px] leading-none text-[#1a1a1a] [font-variant-numeric:tabular-nums] tab:text-[42px]">
                {withShop.length}
              </span>
              <span className="text-[15px] leading-[1.5] text-[#4c5661]">
                of {STATEN_ISLAND_NEIGHBORHOODS.length} neighborhoods have a verified shop in them today.
              </span>
            </div>

            {withShop.length > 0 && (
              <ul className="mt-7 grid gap-x-10 gap-y-0 sm:grid-cols-2 lg:grid-cols-3">
                {withShop.map(({ name, shop }) => (
                  <li key={name} className="min-w-0 border-t border-[#1a1a1a]/10 py-4">
                    <span className="flex items-center gap-2">
                      <span aria-hidden className="h-[7px] w-[7px] shrink-0 rounded-full bg-[#4B82A5]" />
                      <span className="truncate text-[16px] font-medium text-[#1a1a1a]">{name}</span>
                    </span>
                    <Link
                      href={`/shops/${shop.slug}`}
                      className="mt-1 block truncate pl-[15px] text-[14px] text-[#4B82A5] underline decoration-[#4B82A5]/40 underline-offset-[3px] hover:decoration-[#4B82A5]"
                    >
                      {shop.name}
                    </Link>
                  </li>
                ))}
              </ul>
            )}

            <p className="mt-9 text-[12px] uppercase tracking-[0.14em] text-[#777169]">
              Served by the nearest shop
            </p>
            {/* The roster settles as one block: these are place names in CSS
                columns, not a rank, and a wrapper between the <ul> and its
                <li>s would break the columns anyway. */}
            <ul
              className="mt-4 columns-2 gap-x-10 text-[14.5px] leading-[1.95] text-[#6b655d] sm:columns-3 lg:columns-4"
              aria-label="Staten Island neighborhoods served by the nearest shop"
            >
              {rest.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </div>
        </Reveal>
      </section>

      {/* ---------- The details and the questions: one editorial list ---------- */}
      <section id="details" className="mt-16 scroll-mt-28 border-t border-[#1a1a1a]/10 pt-16 lg:mt-24 lg:pt-24">
        <Reveal>
          <h2 className={H2}>The details, in plain terms.</h2>
        </Reveal>
        {/* The definition rows are a <dl> of prose: one block, never term by
            term. The FaqList below is NOT wrapped with them — it runs its own
            Sequence and Seq's each row (components/seo/faq.tsx), so a Reveal
            over it would compound a 26px rise onto the rows' own 14px one. */}
        <Reveal delay={0.08}>
          <dl className="mt-8 flex flex-col divide-y divide-[#1a1a1a]/10 border-b border-[#1a1a1a]/10">
            <div className={ROW} id="all-services">
              <dt className={TERM}>How many services can I book here?</dt>
              <dd className={ANSWER}>
                <p>
                  All {BOOKABLE_SERVICE_COUNT}, in four categories: Routine, Tires &amp; Brakes, Scheduled Service and
                  Inspections. Each shop chooses which of them it offers, and Oto shows you only the services that apply
                  to your car. The <Link href="/services">full catalog</Link> has every one in detail.
                </p>
              </dd>
            </div>
            <div className={ROW} id="next">
              <dt className={TERM}>Where is Otopair going next?</dt>
              <dd className={ANSWER}>
                <p>
                  Borough by borough:{" "}
                  {UPCOMING_BOROUGHS.map((b, i) => (
                    <span key={b.slug}>
                      <Link href={`/${b.slug}`}>{b.name}</Link> ({b.date})
                      {i < UPCOMING_BOROUGHS.length - 1 ? ", " : "."}
                    </span>
                  ))}{" "}
                  Brooklyn is next on the <Link href="/coverage">coverage ladder</Link>. Run a shop anywhere in New
                  York City? <Link href="/apply">Apply now</Link>; verified shops are what opens a borough.
                </p>
              </dd>
            </div>
          </dl>
        </Reveal>
        <FaqList items={FAQ} className="[&>div:first-child]:pt-6 tab:[&>div:first-child]:pt-7 [&_dd]:max-w-[60ch]" />
      </section>
    </PageShell>
  );
}
