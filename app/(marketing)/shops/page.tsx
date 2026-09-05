import type { Metadata } from "next";
import Link from "next/link";
import PageShell from "@/components/flagship/page-shell";
import { PillLink, TextLink } from "@/components/flagship/pill-button";
import NetworkMap from "@/components/flagship/landing/network-map";
import { Reveal } from "@/components/flagship/landing/reveal";
import { FaqList, type FaqItem } from "@/components/seo/faq";
import { JsonLd } from "@/components/seo/json-ld";
import { STATEN_ISLAND_NEIGHBORHOODS } from "@/lib/coverage";
import { listPublicShops, neighborhoodSlug, onStatenIsland, type PublicShopSummary } from "@/lib/public-shops";
import { absoluteUrl } from "@/lib/site";

export const metadata: Metadata = {
  title: { absolute: "Verified auto repair shops on Otopair: Staten Island, NY" },
  description:
    "Every shop in this directory was reviewed and approved by Otopair and can be booked in the app at a price you see in full before you confirm. Hours, services and location for each.",
  alternates: { canonical: "/shops" },
};

// The directory reads the live shop list; refresh every 5 minutes.
export const revalidate = 300;

/**
 * /shops (design pass 2026-09-05): the public directory of verified,
 * bookable shops, fed only by lib/public-shops.ts (verified + active +
 * bookable + on the island, projected fields). The live network map is the
 * hero object; the shops are peer cards (a directory is the one place cards
 * earn their keep); the verification standard and the booking path share
 * one editorial list with the FAQ. Stand-in shop names from the landing
 * never appear here.
 *
 * Grouping: past six shops the grid is bucketed by nearest Staten Island
 * neighborhood (north to south, lib/coverage.ts order) with a jump list;
 * shops without a neighborhood label fall into a city bucket at the end.
 */

// Same face/weight as reveal.tsx's `serif`, inlined: this is a server
// component and reveal.tsx is a client module.
const serif = { fontFamily: "var(--font-Petrona)", fontWeight: 400 } as const;

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
  "max-w-[60ch] text-[16px] leading-[1.6] text-[#4c5661] [&_p+p]:mt-3 [&_a]:text-[#4B82A5] [&_a]:underline [&_a]:decoration-[#4B82A5]/40 [&_a]:underline-offset-[3px] [&_a:hover]:decoration-[#4B82A5] [&_ul]:mt-3 [&_ul]:flex [&_ul]:flex-col [&_ul]:gap-1.5 [&_ul]:pl-5 [&_li]:relative [&_li]:before:absolute [&_li]:before:-left-5 [&_li]:before:top-[0.8em] [&_li]:before:h-px [&_li]:before:w-2.5 [&_li]:before:bg-[#4B82A5] [&_strong]:font-medium [&_strong]:text-[#1a1a1a]";

function placeLine(s: PublicShopSummary): string {
  return s.neighborhood ? `${s.neighborhood} · ${s.city}, ${s.state}` : `${s.city}, ${s.state}`;
}

function ShopCard({ shop, index }: { shop: PublicShopSummary; index: number }) {
  const href = `/shops/${shop.slug}`;
  return (
    <Reveal delay={Math.min(index, 8) * 0.04}>
      <article className="flex h-full flex-col rounded-[22px] bg-white p-6 ring-1 ring-[#1a1a1a]/[0.08] shadow-[0_1px_2px_rgba(26,26,26,0.04)] transition-[transform,box-shadow] duration-500 ease-expo hover:-translate-y-0.5 hover:shadow-lift">
        <div className="flex items-start gap-4">
          {shop.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={shop.logoUrl}
              alt=""
              width={48}
              height={48}
              loading="lazy"
              className="h-12 w-12 shrink-0 rounded-[12px] border border-[#1a1a1a]/10 object-cover"
            />
          ) : (
            <span
              aria-hidden
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[12px] bg-[#98C9E8]/35 text-[20px] text-[#4B82A5]"
              style={serif}
            >
              {shop.name.trim().charAt(0).toUpperCase()}
            </span>
          )}
          <div className="min-w-0">
            <p className="text-[12px] tracking-[0.12em] text-[#777169]">{placeLine(shop).toUpperCase()}</p>
            <h3 className="mt-1 text-[22px] leading-tight text-[#1a1a1a]" style={serif}>
              <Link
                href={href}
                className="rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4B82A5]"
              >
                {shop.name}
              </Link>
            </h3>
          </div>
        </div>
        <p className="mt-4 flex-1 text-[15px] leading-[1.6] text-[#6b655d]">
          {shop.serviceCount === 1 ? "1 service" : `${shop.serviceCount} services`} bookable on Otopair
          {shop.address ? ` · ${shop.address}` : ""}
        </p>
        <div className="mt-4 flex items-center justify-between gap-3">
          <span className="text-[12px] tracking-[0.05em] text-[#4B82A5]">Verified by Otopair</span>
          <Link
            href={href}
            className="text-[14px] text-[#4B82A5] underline decoration-[#4B82A5]/40 underline-offset-[3px] hover:decoration-[#4B82A5]"
          >
            Hours and services
          </Link>
        </div>
      </article>
    </Reveal>
  );
}

function ShopGrid({ shops, offset = 0 }: { shops: PublicShopSummary[]; offset?: number }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {shops.map((s, i) => (
        <ShopCard key={s.slug} shop={s} index={offset + i} />
      ))}
    </div>
  );
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
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <PillLink href="/download">Get notified at launch</PillLink>
          <TextLink href="/how-shops-are-verified">How shops are verified</TextLink>
        </div>
      }
      visual={<NetworkMap frame={false} className="aspect-[5/4]" />}
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

      {/* ---------- The directory ---------- */}
      <section id="directory" className="scroll-mt-28">
        <h2 className={H2}>
          {count === 0
            ? "Verified shops are being onboarded now."
            : count === 1
              ? "One verified shop, bookable today."
              : `${count} verified shops, bookable today.`}
        </h2>
        {count === 0 ? (
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
        ) : (
          <p className={`mt-6 ${PROSE}`}>
            Each card leads to the shop&rsquo;s own page: the services it has switched on, its hours for all seven
            days, and where it is. The list is live.
          </p>
        )}

        {count > 0 && !grouped && (
          <div className="mt-10">
            <ShopGrid shops={shops} />
          </div>
        )}

        {grouped && (
          <div className="mt-10">
            <nav aria-label="Neighborhoods" className="mb-8">
              <ul className="flex flex-wrap gap-2">
                {grouped.map((g) => (
                  <li key={g.id}>
                    <a
                      href={`#${g.id}`}
                      className="inline-flex h-9 items-center gap-2 rounded-full border border-[#1a1a1a]/10 bg-white px-4 text-[14px] text-[#1a1a1a] transition-colors hover:border-[#4B82A5]/50"
                    >
                      {g.label}
                      <span className="text-[12px] text-[#777169]">{g.shops.length}</span>
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
            {grouped.map((g) => (
              <section
                key={g.id}
                id={g.id}
                className="scroll-mt-28 border-t border-[#1a1a1a]/10 py-9 first:border-t-0 first:pt-0"
              >
                <h3 className="text-[24px] leading-[1.15] text-[#1a1a1a] tab:text-[28px]" style={serif}>
                  {g.label}
                </h3>
                <p className="mt-2 text-[15px] text-[#6b655d]">
                  {g.shops.length === 1 ? "1 verified shop" : `${g.shops.length} verified shops`}
                </p>
                <div className="mt-6">
                  <ShopGrid shops={g.shops} offset={g.offset} />
                </div>
              </section>
            ))}
          </div>
        )}
      </section>

      {/* ---------- The details and the questions: one editorial list ---------- */}
      <section id="details" className="mt-16 scroll-mt-28 border-t border-[#1a1a1a]/10 pt-16 lg:mt-24 lg:pt-24">
        <h2 className={H2}>The details, in plain terms.</h2>
        <dl className="mt-8 flex flex-col divide-y divide-[#1a1a1a]/10 border-b border-[#1a1a1a]/10">
          <div className={ROW} id="verified">
            <dt className={TERM}>What does verified mean?</dt>
            <dd className={ANSWER}>
              <p>
                A verified shop is one Otopair has reviewed and approved by hand. Before a shop appears on this page it
                has to clear four things: the first is a decision by the Otopair team, and the other three are read
                from the shop&rsquo;s live account, not from a form.
              </p>
              <ul>
                <li>
                  <strong>Otopair&rsquo;s review and approval.</strong> The Otopair team approves the shop for the
                  network. It is a manual decision, not an automated check.
                </li>
                <li>
                  <strong>Payment through Stripe.</strong> The shop has a connected Stripe account with charges and
                  payouts enabled, so the $20 hold at booking and the final charge on completion run through Otopair.
                </li>
                <li>
                  <strong>Real opening hours.</strong> Hours for all seven days are published, and the app books
                  against them.
                </li>
                <li>
                  <strong>Someone to do the work.</strong> At least one working mechanic and at least one service
                  switched on.
                </li>
              </ul>
              <p>
                Verification is Otopair&rsquo;s own approval. It does not certify licences or insurance, so if you need
                those, ask the shop directly. <Link href="/how-shops-are-verified">The full standard</Link>.
              </p>
            </dd>
          </div>
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
                · <Link href="/staten-island">Car repair in Staten Island</Link>
              </p>
            </dd>
          </div>
        </dl>
        <FaqList items={FAQ} className="[&>div:first-child]:pt-6 tab:[&>div:first-child]:pt-7 [&_dd]:max-w-[60ch]" />
      </section>
    </PageShell>
  );
}
