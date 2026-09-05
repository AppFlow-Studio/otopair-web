import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import PageShell, { Section, type TocItem } from "@/components/flagship/page-shell";
import { PillLink } from "@/components/flagship/pill-button";
import { FaqSection } from "@/components/seo/faq";
import { JsonLd } from "@/components/seo/json-ld";
import { formatTime, getPublicShop, type PublicShopProfile, type PublicShopService } from "@/lib/public-shops";
import { SITE_URL, absoluteUrl } from "@/lib/site";

export const revalidate = 300;
export const dynamicParams = true;

/**
 * /shops/<slug> — one verified shop (site audit 2026-08-31, Tier 2). Every
 * field on this page comes from lib/public-shops.ts's projection, which is
 * the only thing that may touch the raw Convex documents: no contacts, no
 * payout state, no internals. The shop is on this URL only while it passes
 * the same gate as the directory (verified + active + bookable + on the
 * island), so a shop that drops off the network 404s here within the
 * revalidate window instead of advertising a booking it cannot take.
 *
 * What is deliberately NOT here: prices (set by the shop, built per vehicle
 * in the app — never published as numbers or ranges), the platform fee
 * rate, and any rating unless it is computed from at least three visible
 * reviews by drivers who completed a booking (public-shops.ts).
 */

// Same face/weight as reveal.tsx's `serif`, inlined for a server component.
const serif = { fontFamily: "var(--font-Petrona)", fontWeight: 400 } as const;

// Static map, same pattern as the landing's path-section: one Static Images
// request with the API logo/attribution off, so the © credit must be drawn
// by us. Skipped entirely when the token is absent.
const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? "";
function staticMapUrl(lat: number, lng: number): string {
  const at = `${lng.toFixed(5)},${lat.toFixed(5)}`;
  return `https://api.mapbox.com/styles/v1/mapbox/light-v11/static/pin-s+4b82a5(${at})/${at},14.2,0/720x360@2x?logo=false&attribution=false&access_token=${MAPBOX_TOKEN}`;
}

const load = cache((slug: string) => getPublicShop(slug));

type Params = Promise<{ slug: string }>;

function placeOf(shop: PublicShopProfile): string {
  return shop.neighborhood ?? shop.city;
}

function addressLine(shop: PublicShopProfile): string {
  const cityLine = `${shop.city}, ${shop.state}${shop.zip ? ` ${shop.zip}` : ""}`;
  return shop.address ? `${shop.address}, ${cityLine}` : cityLine;
}

function serviceHref(s: PublicShopService): string {
  return `/services/${s.slug}`;
}

/** Group offered services by catalog category, keeping catalog order. */
function groupServices(services: PublicShopService[]): { category: string; services: PublicShopService[] }[] {
  const groups: { category: string; services: PublicShopService[] }[] = [];
  for (const s of services) {
    const cat = s.category ?? "Other";
    const g = groups.find((x) => x.category === cat);
    if (g) g.services.push(s);
    else groups.push({ category: cat, services: [s] });
  }
  return groups;
}

function listNames(items: string[]): string {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function Stars({ rating }: { rating: number }) {
  const full = Math.max(0, Math.min(5, Math.round(rating)));
  return (
    <span aria-label={`${rating} out of 5`} className="tracking-[0.1em] text-[#4B82A5]">
      {"★".repeat(full)}
      <span className="text-[#1a1a1a]/20">{"★".repeat(5 - full)}</span>
    </span>
  );
}

/** Seven-day strip: open days on white plates, closed days on paper. */
function HoursStrip({ hours }: { hours: PublicShopProfile["hours"] }) {
  return (
    <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7" aria-label="Opening hours by day">
      {hours.map((h) => {
        const open = !!(h.open && h.close);
        return (
          <li
            key={h.day}
            className={`rounded-[18px] px-3 py-3 ring-1 ${open ? "bg-white ring-[#1a1a1a]/[0.08] shadow-[0_1px_2px_rgba(26,26,26,0.04)]" : "bg-[#f7f6f3] ring-transparent"}`}
          >
            <span className="block text-[11px] uppercase tracking-[0.12em] text-[#777169]">{h.dayName.slice(0, 3)}</span>
            {open ? (
              <time className="mt-1.5 block text-[14px] leading-[1.35] text-[#1a1a1a]">
                {formatTime(h.open!)}
                <br />
                {formatTime(h.close!)}
              </time>
            ) : (
              <span className="mt-1.5 block text-[14px] leading-[1.35] text-[#777169]">Closed</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** Gallery rhythm: two wide, then three, then two, on a six-column grid. */
function Gallery({ shop, photos }: { shop: PublicShopProfile; photos: PublicShopProfile["portfolio"] }) {
  return (
    <ul className="grid gap-3 sm:grid-cols-6">
      {photos.map((p, i) => (
        <li
          key={p.url}
          className={`overflow-hidden rounded-[22px] bg-[#f7f6f3] ring-1 ring-[#1a1a1a]/[0.08] ${i % 5 < 2 ? "sm:col-span-3" : "sm:col-span-2"}`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={p.url}
            alt={p.caption ?? `${shop.name}, photo ${i + 2}`}
            loading="lazy"
            className="aspect-[4/3] w-full object-cover"
          />
          {p.caption && <p className="px-4 py-3 text-[14px] text-[#6b655d]">{p.caption}</p>}
        </li>
      ))}
    </ul>
  );
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { slug } = await params;
  const shop = await load(slug);
  if (!shop) notFound();
  const place = placeOf(shop);
  const serviceNames = shop.services.slice(0, 3).map((s) => s.name);
  return {
    title: { absolute: `${shop.name}: verified auto repair ${shop.neighborhood ? "near" : "in"} ${place}, NY` },
    description: `${shop.name} is a verified independent repair shop ${shop.neighborhood ? `near ${place}, ` : "in "}${shop.city}, bookable in the Otopair app${
      serviceNames.length ? ` for ${listNames(serviceNames)}${shop.services.length > 3 ? " and more" : ""}` : ""
    }. Hours, services and location, with the full price shown in the app before you confirm.`,
    alternates: { canonical: `/shops/${shop.slug}` },
  };
}

export default async function ShopPage({ params }: { params: Params }) {
  const { slug } = await params;
  const shop = await load(slug);
  if (!shop) notFound();

  const place = placeOf(shop);
  const groups = groupServices(shop.services);
  const openDays = shop.hours.filter((h) => h.open && h.close);
  const sameHours =
    openDays.length > 0 && openDays.every((h) => h.open === openDays[0].open && h.close === openDays[0].close);
  const hasMechanics = shop.mechanics.length > 0;
  const hasPhotos = shop.portfolio.length > 0;
  const showMap = !!MAPBOX_TOKEN && shop.lat != null && shop.lng != null;
  // The hero object: the shop's first gallery photo when it has one, else
  // its own static map. The rest of the gallery goes below.
  const gallery = shop.portfolio.slice(1);
  const hasGallery = gallery.length > 0;
  const heroVisual = hasPhotos ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={shop.portfolio[0].url}
      alt={shop.portfolio[0].caption ?? `${shop.name}, from the shop's own gallery`}
      className="aspect-[5/4] w-full object-cover"
    />
  ) : showMap ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={staticMapUrl(shop.lat!, shop.lng!)}
      alt={`Map showing ${shop.name} at ${addressLine(shop)}`}
      width={720}
      height={360}
      className="aspect-[2/1] w-full object-cover"
    />
  ) : undefined;
  const shopUrl = absoluteUrl(`/shops/${shop.slug}`);

  const toc: TocItem[] = [
    { id: "services", title: "Services" },
    { id: "hours", title: "Hours" },
    ...(hasMechanics ? [{ id: "mechanics", title: "Mechanics" }] : []),
    ...(hasGallery ? [{ id: "photos", title: "Photos" }] : []),
    { id: "reviews", title: "What drivers say" },
    { id: "getting-there", title: "Getting there" },
    { id: "faq", title: "Questions" },
  ];

  // AutoRepair node for this shop. Standalone (an independent business, not
  // a branch of Otopair), so no parentOrganization; the site's Organization
  // node stays the operator of the directory, not of the shop.
  const jsonLd: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": ["AutoRepair", "LocalBusiness"],
    "@id": `${SITE_URL}/shops/${shop.slug}#shop`,
    name: shop.name,
    url: shopUrl,
    ...(shop.description ? { description: shop.description } : {}),
    address: {
      "@type": "PostalAddress",
      ...(shop.address ? { streetAddress: shop.address } : {}),
      addressLocality: shop.city,
      addressRegion: shop.state,
      ...(shop.zip ? { postalCode: shop.zip } : {}),
      addressCountry: "US",
    },
    ...(shop.lat != null && shop.lng != null
      ? { geo: { "@type": "GeoCoordinates", latitude: shop.lat, longitude: shop.lng } }
      : {}),
    ...(shop.logoUrl ? { image: shop.logoUrl, logo: shop.logoUrl } : {}),
    ...(shop.website ? { url: shop.website } : {}),
    mainEntityOfPage: shopUrl,
    ...(openDays.length
      ? {
          openingHoursSpecification: openDays.map((h) => ({
            "@type": "OpeningHoursSpecification",
            dayOfWeek: `https://schema.org/${h.dayName}`,
            opens: h.open,
            closes: h.close,
          })),
        }
      : {}),
    ...(shop.rating
      ? {
          aggregateRating: {
            "@type": "AggregateRating",
            ratingValue: shop.rating.average,
            reviewCount: shop.rating.count,
            bestRating: 5,
            worstRating: 1,
          },
          review: shop.reviews.map((r) => ({
            "@type": "Review",
            author: { "@type": "Person", name: r.reviewer },
            reviewRating: { "@type": "Rating", ratingValue: r.rating, bestRating: 5, worstRating: 1 },
            ...(r.comment ? { reviewBody: r.comment } : {}),
            ...(r.createdAt ? { datePublished: new Date(r.createdAt).toISOString().slice(0, 10) } : {}),
          })),
        }
      : {}),
  };

  const faq = [
    {
      q: `Can I book ${shop.name} today?`,
      a: `Yes, if it has an open slot. ${shop.name} is live on Otopair: open the app, tell Oto what your car needs, choose ${shop.name}, and pick a time from the shop's real schedule. A $20 hold reserves the slot; the final amount is captured only when the shop marks the job complete.`,
    },
    {
      q: `How is the price set at ${shop.name}?`,
      a: `${shop.name} sets its own prices: its labor rates and, for some services, a flat price. In the app you see the full total for your exact car before you confirm, and that total includes parts, labor, tax and Otopair's service fee. Otopair does not publish price lists or averages; the number in the app is the number.`,
    },
    {
      q: `What happens if ${shop.name} finds more work?`,
      a: `Nothing is added without your approval. After inspecting the car the shop confirms the final price. If it lands within what you approved at booking, the job proceeds. If the shop finds extra work, you get an approval request in the app and can approve or decline it; declined work is not done and not charged. A pre-job estimate left unanswered for 24 hours expires and forfeits the $20 deposit.`,
    },
    {
      q: `Can I cancel or reschedule a booking at ${shop.name}?`,
      a: `Yes. Cancel free up to 24 hours before the appointment; inside 24 hours the $20 deposit is kept. A no-show marked by the shop forfeits the deposit. Reschedule free up to 12 hours before, up to two times per booking. If the shop cancels, or a request expires unanswered, the hold is released in full.`,
    },
  ];

  return (
    <PageShell
      eyebrow={`VERIFIED SHOP · ${place.toUpperCase()}`}
      title={shop.name}
      lede={
        <>
          {shop.name} is a verified independent repair shop in {place}
          {shop.neighborhood ? `, ${shop.city}` : ""}, {shop.state}, bookable in the Otopair app.
          {shop.services.length > 0
            ? ` It offers ${shop.services.length === 1 ? "1 service" : `${shop.services.length} services`} on Otopair, and the price you see in the app before you confirm includes parts, labor, tax and Otopair's service fee.`
            : " The price you see in the app before you confirm includes parts, labor, tax and Otopair's service fee."}
          {shop.description ? ` ${shop.description}` : ""}
        </>
      }
      crumbs={[
        { name: "Home", href: "/" },
        { name: "Shops", href: "/shops" },
        { name: shop.name, href: `/shops/${shop.slug}` },
      ]}
      visual={heroVisual}
      hero={
        <>
          <PillLink href="/download">Book in the Otopair app</PillLink>
          <address className="text-[14px] not-italic tracking-[0.03em] text-[#4c5661]">{addressLine(shop)}</address>
        </>
      }
      toc={toc}
    >
      <JsonLd data={jsonLd} />

      {shop.logoUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={shop.logoUrl}
          alt={`${shop.name} logo`}
          width={96}
          height={96}
          className="mb-8 h-24 w-24 rounded-[16px] border border-[#1a1a1a]/10 object-cover"
        />
      )}

      <Section id="services" title={`What services does ${shop.name} offer on Otopair?`}>
        {shop.services.length === 0 ? (
          <p>
            {shop.name} has not listed its services here yet; the services it offers are shown in the
            app. Check back, or <Link href="/shops">browse other verified shops</Link>.
          </p>
        ) : (
          <>
            <p>
              {shop.services.length === 1 ? "One service" : `${shop.services.length} services`} across{" "}
              {listNames(groups.map((g) => g.category))}:{" "}
              {listNames(shop.services.slice(0, 4).map((s) => s.name))}
              {shop.services.length > 4 ? " and more" : ""}. Each one is bookable in the app for your
              exact car.
            </p>
            {groups.map((g) => (
              <div key={g.category}>
                <h3>{g.category}</h3>
                <ul className="mt-3">
                  {g.services.map((s) => (
                    <li key={s.slug}>
                      <Link href={serviceHref(s)}>{s.name}</Link>
                      {s.description ? (
                        <span className="text-[#6b655d]">: {s.description}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            <p>
              {shop.name} sets its own labor rates and can set a flat price for a service; the total is
              built for your exact car in the app. The total you see before you confirm includes parts, labor, tax and
              Otopair&rsquo;s service fee; the shop confirms the final price after inspecting the
              car, and it cannot exceed what you approved without your OK.
            </p>
          </>
        )}
      </Section>

      <Section id="hours" title={`When is ${shop.name} open?`} after={shop.hours.length ? <HoursStrip hours={shop.hours} /> : undefined}>
        {shop.hours.length === 0 ? (
          <p>Opening hours are shown in the app when you pick a time.</p>
        ) : (
          <>
            <p>
              {openDays.length === 0
                ? "Closed every day at the moment, so no slots are open in the app."
                : `Open ${openDays.length === 7 ? "every day" : `${openDays.length} days a week`}${
                    sameHours
                      ? `, ${formatTime(openDays[0].open!)} to ${formatTime(openDays[0].close!)}`
                      : "; hours vary by day"
                  }. The app books against these hours, so a slot you see is a slot the shop can take.`}
            </p>
          </>
        )}
      </Section>

      {hasMechanics && (
        <Section id="mechanics" title={`Who works on your car at ${shop.name}?`}>
          <p>
            {shop.mechanics.length === 1
              ? `One mechanic is on the schedule at ${shop.name}`
              : `${shop.mechanics.length} mechanics are on the schedule at ${shop.name}`}
            . The app schedules your booking against their calendars, so a slot you see is one that
            one of them actually has open.
          </p>
          <ul className="!pl-0 [&>li]:before:hidden">
            {shop.mechanics.map((m) => (
              <li key={m.name} className="flex items-center gap-4 py-1">
                {m.photoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={m.photoUrl}
                    alt=""
                    width={48}
                    height={48}
                    loading="lazy"
                    className="h-12 w-12 shrink-0 rounded-full border border-[#1a1a1a]/10 object-cover"
                  />
                ) : (
                  <span
                    aria-hidden
                    className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-[#98C9E8]/35 text-[18px] text-[#4B82A5]"
                    style={serif}
                  >
                    {m.name.charAt(0)}
                  </span>
                )}
                <span>
                  <span className="block text-[#1a1a1a]">{m.name}</span>
                  {m.title && <span className="block text-[14px] text-[#777169]">{m.title}</span>}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {hasGallery && (
        <Section id="photos" title={`Photos of ${shop.name}`} after={<Gallery shop={shop} photos={gallery} />}>
          <p>
            {gallery.length === 1 ? "One more photo" : `${gallery.length} more photos`} from the
            shop&rsquo;s own gallery; the first is at the top of the page.
          </p>
        </Section>
      )}

      <Section id="reviews" title={`What do drivers say about ${shop.name}?`}>
        {shop.rating ? (
          <>
            <p>
              <strong>{shop.rating.average.toFixed(1)} out of 5</strong> from{" "}
              {shop.rating.count === 1 ? "1 review" : `${shop.rating.count} reviews`} by drivers who
              completed a booking at {shop.name} through Otopair. Reviews can only be left after a
              completed booking, and a review is the driver&rsquo;s own words.
            </p>
            <ul className="!pl-0 [&>li]:before:hidden">
              {shop.reviews.map((r, i) => (
                <li key={`${r.reviewer}-${r.createdAt ?? i}`} className="border-t border-[#1a1a1a]/10 py-4 first:border-t-0">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[14px]">
                    <Stars rating={r.rating} />
                    <span className="text-[#1a1a1a]">{r.reviewer}</span>
                    {r.createdAt && (
                      <time dateTime={new Date(r.createdAt).toISOString()} className="text-[#777169]">
                        {new Date(r.createdAt).toLocaleDateString("en-US", {
                          month: "short",
                          year: "numeric",
                          timeZone: "America/New_York",
                        })}
                      </time>
                    )}
                  </div>
                  {r.comment && <p className="mt-2 text-[16px] leading-[1.6]">{r.comment}</p>}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p>
            No public reviews yet. Reviews on Otopair come only from drivers who completed a booking
            at the shop, so a shop new to the network starts with none.
          </p>
        )}
      </Section>

      <Section id="getting-there" title={`Where is ${shop.name}?`}>
        <p>
          {shop.address ? `${shop.address}, ` : ""}
          {shop.city}, {shop.state}
          {shop.zip ? ` ${shop.zip}` : ""}
          {shop.neighborhood ? `, near ${shop.neighborhood}` : ""}. You bring the car to the shop at the
          time you booked; Otopair does not send a mechanic to you.
        </p>
        {showMap && (
          <figure className="relative mt-5 overflow-hidden rounded-[16px] border border-[#1a1a1a]/10 bg-[#f7f6f3]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={staticMapUrl(shop.lat!, shop.lng!)}
              alt={`Map showing ${shop.name} at ${addressLine(shop)}`}
              width={720}
              height={360}
              loading="lazy"
              className="aspect-[2/1] w-full object-cover"
            />
            {/* Required credit when the API logo is off. */}
            <figcaption className="absolute bottom-1.5 right-2.5 text-[10px] tracking-wide text-[#3a556e]/70">
              © Mapbox © OpenStreetMap
            </figcaption>
          </figure>
        )}
        <p>
          <a
            href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${shop.name}, ${addressLine(shop)}`)}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Directions in Google Maps
          </a>
          {shop.website && (
            <>
              {" "}
              ·{" "}
              <a href={shop.website} target="_blank" rel="noopener noreferrer nofollow">
                Shop website
              </a>
            </>
          )}
        </p>
      </Section>

      <FaqSection items={faq} />

      <Section id="more" title="More verified shops">
        <p>
          <Link href="/shops">Every verified shop on Otopair</Link> ·{" "}
          <Link href="/staten-island">Car repair in Staten Island</Link> ·{" "}
          <Link href="/services">Every service you can book</Link>
        </p>
      </Section>
    </PageShell>
  );
}
