import type { Metadata } from "next";
import Link from "next/link";
import PageShell from "@/components/flagship/page-shell";
import { TextLink } from "@/components/flagship/pill-button";
import { HeroPhone, ShopsVerified } from "@/components/flagship/local-sections";
import { Reveal, Seq, Sequence } from "@/components/flagship/landing/reveal";
import { ShopDirectory, ShopSearch } from "@/components/flagship/shop-finder";
import { SelectServicesScreen } from "@/components/flagship/product/screens/browse";
import { FaqList, type FaqItem } from "@/components/seo/faq";
import { JsonLd } from "@/components/seo/json-ld";
import { STATEN_ISLAND_NEIGHBORHOODS } from "@/lib/coverage";
import { listPublicShops, neighborhoodSlug, onStatenIsland, type PublicShopSummary } from "@/lib/public-shops";
import { absoluteUrl } from "@/lib/site";
import { STATEN_ISLAND_PHONE, phonePins, staticMapSrc } from "@/lib/static-map";

export const metadata: Metadata = {
  title: { absolute: "Verified auto repair shops on Otopair: Staten Island, NY" },
  description:
    "Every shop in this directory was reviewed and approved by Otopair and can be booked in the app at a price you see in full before you confirm. Hours, services and location for each.",
  alternates: { canonical: "/shops" },
};

// The directory reads the live shop list; refresh every 5 minutes.
export const revalidate = 300;

/**
 * /shops (design pass 2026-09-05, the app up close): the public directory
 * of verified, bookable shops, fed only by lib/public-shops.ts (verified +
 * active + bookable + on the island, projected fields). The hero carries
 * the search bar (name, neighborhood, address or service; the query lives
 * in ?q= so a filtered view is a link) beside the app browsing shops on
 * the island map, with the shops as pins and the first one's browse card.
 * The directory is the list beside a sticky map with numbered pins,
 * filtered live by the search; "what verified means" lifts the four
 * checks out beside the dashboard page they are read from. Stand-in shop
 * names from the landing never appear here.
 *
 * Grouping: past six shops the list is bucketed by nearest Staten Island
 * neighborhood (north to south, lib/coverage.ts order) with a jump list;
 * shops without a neighborhood label fall into a city bucket at the end.
 */

const GROUP_THRESHOLD = 6;

const FAQ: FaqItem[] = [
  {
    q: "Can I book a shop from this page?",
    a: "Booking happens in the Otopair app for iPhone and Android. Each shop page here tells you what the shop offers, when it is open and where it is. In the app you describe the problem to Oto, pick the shop, see the full price for your exact car before you confirm, and reserve the slot with a $20 hold.",
  },
  {
    q: "How is the price set?",
    a: "By the shop. Each shop sets its own labor rates and can set a flat price for a service. The total you see before you confirm includes parts, labor, tax and Otopair's service fee. After inspecting the car the shop confirms the final price, and it cannot go above what you approved without your OK in the app. Otopair does not publish price lists or averages.",
  },
  {
    q: "Why isn't my local shop listed?",
    a: "Either it has not applied yet or it is still in review. The directory only shows shops that have completed Otopair's review and can take a booking. Staten Island is the live market; Brooklyn is next, planned for Q4 2026. Shops anywhere in New York City can apply now.",
  },
];

const H2 = "serif-display max-w-[16ch] text-[32px] leading-[1.04] tracking-[-0.01em] text-[#1a1a1a] [text-wrap:balance] tab:text-[38px]";
const PROSE =
  "max-w-[62ch] text-[17px] leading-[1.65] text-[#4c5661] [text-wrap:pretty] [&_p+p]:mt-4 [&_a]:text-[#4B82A5] [&_a]:underline [&_a]:decoration-[#4B82A5]/40 [&_a]:underline-offset-[3px] [&_a:hover]:decoration-[#4B82A5]";
const ROW = "grid gap-2 py-6 tab:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] tab:gap-x-10 tab:py-7";
const TERM = "serif-text text-[21px] leading-[1.3] text-[#1a1a1a] [text-wrap:balance]";
const ANSWER =
  "max-w-[60ch] text-[16px] leading-[1.6] text-[#4c5661] [&_p+p]:mt-3 [&_a]:text-[#4B82A5] [&_a]:underline [&_a]:decoration-[#4B82A5]/40 [&_a]:underline-offset-[3px] [&_a:hover]:decoration-[#4B82A5]";

/** Is the shop open at this minute, New York time, per its published hours? */
function openNow(s: PublicShopSummary): boolean {
  if (!s.openToday) return false;
  const now = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "America/New_York" }).format(new Date());
  return now >= s.openToday.open && now < s.openToday.close;
}

/** Bucket by nearest neighborhood in the island's north→south order; shops
 *  with no neighborhood label go under their city, last. */
function groupByNeighborhood(
  shops: PublicShopSummary[],
): { label: string; id: string; shops: PublicShopSummary[]; offset: number }[] {
  const order = new Map<string, number>(STATEN_ISLAND_NEIGHBORHOODS.map((n, i) => [n, i]));
  const buckets = new Map<string, PublicShopSummary[]>();
  for (const s of shops) {
    const key = s.neighborhood ?? `${s.city}, ${s.state}`;
    buckets.set(key, [...(buckets.get(key) ?? []), s]);
  }
  let offset = 0;
  return [...buckets.entries()]
    .sort(([a], [b]) => (order.get(a) ?? 1e6) - (order.get(b) ?? 1e6) || a.localeCompare(b))
    .map(([label, list]) => {
      const g = { label, id: neighborhoodSlug(label), shops: list, offset };
      offset += list.length;
      return g;
    });
}

export default async function ShopsDirectoryPage() {
  const shops = (await listPublicShops()).filter(onStatenIsland);
  const count = shops.length;
  const grouped = count > GROUP_THRESHOLD ? groupByNeighborhood(shops) : null;
  const first = shops[0];
  const mapSrc = staticMapSrc(STATEN_ISLAND_PHONE, 390, 844);

  const itemList =
    count > 0
      ? {
          "@context": "https://schema.org",
          "@type": "ItemList",
          name: "Verified auto repair shops on Otopair",
          numberOfItems: count,
          itemListElement: shops.map((s, i) => ({
            "@type": "ListItem",
            position: i + 1,
            name: s.name,
            url: absoluteUrl(`/shops/${s.slug}`),
          })),
        }
      : null;

  return (
    <PageShell
      title="Shops you can book on Otopair."
      lede="Every shop here was reviewed and approved by Otopair and can be booked in the app at a price you see before you confirm. Staten Island is the live market; the directory grows as shops pass review."
      crumbs={[
        { name: "Home", href: "/" },
        { name: "Shops", href: "/shops" },
      ]}
      hero={
        <div className="flex w-full flex-col items-start gap-4">
          <ShopSearch count={count} />
          <TextLink href="/how-shops-are-verified">How shops are verified</TextLink>
        </div>
      }
      visual={
        <HeroPhone>
          <SelectServicesScreen
            mode="peek"
            pins={phonePins(shops)}
            browse={first ? { name: first.name, rating: null, open: openNow(first), logoUrl: first.logoUrl } : null}
            mapSrc={mapSrc}
          />
        </HeroPhone>
      }
      visualFrame={false}
      width="wide"
    >
      {itemList && <JsonLd data={itemList} />}
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

      {/* ---------- The directory, filtered by the search ---------- */}
      <section id="directory" className="scroll-mt-28">
        {count === 0 ? (
          // Empty state: a heading and the prose that answers it are one
          // thought, so they arrive as one block (motion.md — never a
          // paragraph at a time).
          <Reveal>
            <h2 className={H2}>Verified shops are being onboarded now.</h2>
            <div className={`mt-6 ${PROSE}`}>
              <p>
                No shop is listed until it has passed Otopair&rsquo;s review and can take a booking, so this page stays
                empty rather than showing names that are not ready. Check back soon, or leave your email on the{" "}
                <Link href="/download">download page</Link> and Oto will show you the first shops the day they go live.
              </p>
              <p>
                Run a repair shop in New York City? <Link href="/partner-with-us">See how the network works for shops</Link>{" "}
                or <Link href="/apply">apply in two minutes</Link>.
              </p>
            </div>
          </Reveal>
        ) : (
          // Static on purpose. ShopDirectory choreographs itself: a Reveal on
          // the heading block that outlives the query, a Stagger per group of
          // cards, and a Reveal on the sticky map (shop-finder.tsx,
          // product/local.tsx). A Reveal here would fade an already-fading
          // subtree — and put a transformed ancestor over the map column's
          // `lg:sticky`.
          <ShopDirectory shops={shops} groups={grouped} />
        )}
      </section>

      {/* ---------- What verified means: the four checks, and where they are read from ---------- */}
      <ShopsVerified />

      {/* ---------- Booking, and the questions ---------- */}
      <section id="details" className="scroll-mt-28 border-t border-[#1a1a1a]/10 pt-14 tab:pt-20">
        {/* One clock for the heading and the booking row. The Seq sits AROUND
            the whole <dl>; a wrapper between a <dl> and its rows would hand
            `divide-y` the wrong children. FaqList below runs its own clock —
            see the note there. */}
        <Sequence>
          <Seq>
            <h2 className={H2}>The details, in plain terms.</h2>
          </Seq>
          <Seq at={0.08}>
            <dl className="mt-8 flex flex-col divide-y divide-[#1a1a1a]/10 border-b border-[#1a1a1a]/10">
              <div className={ROW} id="book">
                <dt className={TERM}>How do I book one of these shops?</dt>
                <dd className={ANSWER}>
                  <p>
                    In the Otopair app. Tell Oto what your car is doing, pick a verified shop, and see the full total for
                    your exact car before you confirm. A $20 hold reserves the slot; the shop confirms the final price after
                    inspecting the car, and it cannot go above what you approved without your OK. Every shop page here lists
                    the services that shop has switched on, with its hours and location.
                  </p>
                  <p>
                    <Link href="/download">Get notified at launch</Link> · <Link href="/services">Every service you can book</Link>{" "}
                    · <Link href="/staten-island">Car repair in Staten Island</Link> ·{" "}
                    <Link href="/how-shops-are-verified">The full verification standard</Link>
                  </p>
                </dd>
              </div>
            </dl>
          </Seq>
        </Sequence>
        {/* Not wrapped: FaqList is already a Sequence, one Seq per Q&A row
            (components/seo/faq.tsx). A wrapper here would fade the sheet in
            on top of its own cascade. The two <dl>s still read as one ruled
            sheet — neither wrapper carries a margin, so the rules meet. */}
        <FaqList items={FAQ} className="[&>div:first-child]:pt-6 tab:[&>div:first-child]:pt-7 [&_dd]:max-w-[60ch]" />
      </section>
    </PageShell>
  );
}
