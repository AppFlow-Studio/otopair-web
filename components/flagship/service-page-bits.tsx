import Link from "next/link";
import { Card } from "@/components/flagship/page-shell";
import { Stagger } from "@/components/flagship/landing/reveal";
import { JsonLd } from "@/components/seo/json-ld";
import { absoluteUrl, LOCALITY, SITE_URL } from "@/lib/site";
import {
  applicabilityNotes,
  carApplicabilityNotes,
  requiresInspectionLicence,
  type CatalogService,
} from "@/lib/service-catalog";
import type { PublicShopSummary } from "@/lib/public-shops";

/**
 * Server-renderable pieces shared by the service catalog pages (/services,
 * /services/<slug>) and the Staten Island local pages (/staten-island,
 * /staten-island/<service>). Everything here is plain markup, so the copy is
 * crawlable and cannot drift between the four routes; the one piece of
 * client code is Stagger, the house entrance primitive, which a server
 * component may *render* — what it may not do is read a value out of that
 * module, which is why `serif` below is inlined.
 *
 * Motion (docs/design/motion.md): almost nothing in this file animates
 * itself, and that is the point. These are fragments, not sections. The
 * answers (CarApplicability, HowPriceIsSet, NoShopsYet) render inside a <dd>
 * of a divided <dl>, where the whole definition list is the block that
 * fades and animating a term at a time would turn a reference page into a
 * slideshow; BookingSteps is prose handed to a column that two layers of
 * call-site have each declined to animate (see its docblock — that gap is
 * theirs to close, not this file’s); a single Card is one item in a grid
 * the caller staggers. The exception is ShopCards, which *is* a grid of
 * peers, so it owns its own cascade.
 *
 * Copy rules baked in (locked decisions, site audit 2026-08-31 + Aug 2026
 * fee decision): no fee rate, no fee dollar amount, no price ranges or
 * averages, no vendor names; "verified" = reviewed and approved by Otopair.
 */

// Same face/weight as reveal.tsx's `serif`, inlined: these are server
// components and reveal.tsx is a client module.
export const serif = { fontFamily: "var(--font-Petrona)", fontWeight: 400 } as const;

export function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full border border-[#1a1a1a]/12 bg-[#f7f6f3] px-2.5 py-[3px] text-[12px] leading-none tracking-[0.02em] text-[#4c5661]">
      {children}
    </span>
  );
}

export function ApplicabilityChips({ service, includeLicence = true }: { service: CatalogService; includeLicence?: boolean }) {
  const notes = includeLicence ? applicabilityNotes(service) : carApplicabilityNotes(service);
  if (!notes.length) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-1.5">
      {notes.map((n) => (
        <Chip key={n}>{n}</Chip>
      ))}
    </div>
  );
}

/** Catalog card for the index and hub grids. `hrefBase` picks the route
 *  family (/services or /staten-island). */
export function ServiceCard({ service, href }: { service: CatalogService; href: string }) {
  return (
    <Card
      title={
        <Link href={href} className="hover:text-[#4B82A5]">
          {service.name}
        </Link>
      }
      eyebrow={service.is_labor_only ? "LABOR ONLY" : "PARTS INCLUDED"}
    >
      <p className="mt-3 flex-1 text-[15px] leading-[1.6] text-[#6b655d]">{service.description}.</p>
      <ApplicabilityChips service={service} />
    </Card>
  );
}

function addressLine(s: PublicShopSummary): string | null {
  const parts = [s.address, [s.city, s.state].filter(Boolean).join(", "), s.zip].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/** Live shop cards → /shops/<slug>. Only ever fed by lib/public-shops.ts,
 *  which gates on bookable + active + verified and projects safe fields.
 *
 *  A grid of peers, so it staggers. The grid's own classes stay on the
 *  Stagger container, which keeps each Card the direct grid item, and
 *  `itemClassName="min-w-0"` is on the generated wrapper because a grid
 *  item's default `min-width: auto` lets a long shop name push the column
 *  past the viewport. Card's Bezel is already `h-full`, so the wrapper
 *  stretching to the row height keeps the cards level. */
export function ShopCards({ shops }: { shops: PublicShopSummary[] }) {
  return (
    <Stagger className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" itemClassName="min-w-0">
      {shops.map((s) => (
        <Card
          key={s.slug}
          title={
            <Link href={`/shops/${s.slug}`} className="hover:text-[#4B82A5]">
              {s.name}
            </Link>
          }
          eyebrow={(s.neighborhood ?? s.city).toUpperCase()}
        >
          {addressLine(s) && <p className="mt-3 text-[15px] leading-[1.6] text-[#6b655d]">{addressLine(s)}</p>}
          <p className="mt-3 flex-1 text-[14px] leading-[1.6] text-[#777169]">
            Verified by Otopair · {s.serviceCount} {s.serviceCount === 1 ? "service" : "services"} listed
          </p>
          <Link
            href={`/shops/${s.slug}`}
            className="mt-4 text-[14px] text-[#4B82A5] underline decoration-[#4B82A5]/40 underline-offset-[3px] hover:decoration-[#4B82A5]"
          >
            Shop profile
          </Link>
        </Card>
      ))}
    </Stagger>
  );
}

/** Honest empty state for a service no verified shop lists yet. */
export function NoShopsYet({ serviceName }: { serviceName: string }) {
  return (
    <p>
      No verified shop lists {serviceName} yet. Shops choose which of the 22 services they offer, and this
      page updates as soon as one adds it. In the meantime, <Link href="/shops">browse every verified shop</Link>{" "}
      or tell Oto in the app what your car needs; it only shows shops that can take the job.
    </p>
  );
}

/** "Which cars is it available for?" — the answer paragraph(s). */
export function CarApplicability({ service }: { service: CatalogService }) {
  const notes = carApplicabilityNotes(service);
  const licence = requiresInspectionLicence(service);
  return (
    <>
      {notes.length === 0 ? (
        <p>
          Any car Otopair can identify. {service.name} carries no engine or drivetrain rule in the catalog,
          so Oto offers it for every car it can decode from a VIN or a year, make and model. Oto shows a
          service only when it applies to your car, so if it is in your list, it is meant for your car.
        </p>
      ) : (
        <>
          <p>
            Cars that fit these conditions: {notes.join("; ").toLowerCase()}. Oto checks them against your
            car&rsquo;s decoded specs and shows {service.name} only when it applies to your car, so you never
            have to work out the rule yourself.
          </p>
          <ul>
            {notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </>
      )}
      {licence && (
        <p>
          On the shop side, {service.name} can only be performed by a shop licensed by the New York DMV as an
          inspection station, so Oto lists it only at shops that hold that licence.
        </p>
      )}
    </>
  );
}

/** "How is the price set?" — shared answer, no numbers, no fee rate. */
export function HowPriceIsSet({ serviceName }: { serviceName?: string }) {
  const it = serviceName ?? "a service";
  return (
    <>
      <p>
        By the shop, for your exact car. Every shop on Otopair sets its own labor rate and can set a flat
        price for {it}. Oto builds the total for your car from what the shop set, parts, labor, tax and
        Otopair&rsquo;s service fee, and shows you that full total before you confirm. It is locked before the
        car goes in.
      </p>
      <p>
        A $20 hold reserves the slot when you book. The shop confirms the final price after inspecting the
        car, and it cannot go above what you approved without your approval in the app; any added work is
        a request you answer before it is done. Otopair does not publish averages, ranges or starting
        prices; the number that matters is the one built for your car.
      </p>
    </>
  );
}

/** The booking steps, as the app runs them.
 *
 *  No per-step motion, ever. The order is the content, but a Sequence
 *  would need a <div> between the <ol> and its <li>s, and the numerals
 *  here are `::marker`s on a `decimal-leading-zero` list (styled from
 *  ServiceBooking’s column in local-sections.tsx): a wrapper there deletes
 *  the numbers outright, and nesting one inside each <li> leaves the
 *  markers fully opaque while their text fades. The ladder can only ever
 *  arrive as one block.
 *
 *  OPEN (2026-09-05): right now it arrives with no entrance at all,
 *  because both layers above it defer to the other. /staten-island/
 *  [service]/page.tsx says “No wrapper here — ServiceBooking’s own text
 *  column is already a Reveal”, while that column in local-sections.tsx
 *  says “No entrance on this column — the caller already hands it in
 *  wrapped in its own Reveal”. Neither is true. One of those two has to
 *  take it (the column is the better owner: it is the element carrying
 *  the grid’s `order-*`/`col-span-*`, which this fragment cannot). Do not
 *  fix it by adding a third Reveal in here without deleting one of
 *  theirs. */
export function BookingSteps({ serviceName }: { serviceName: string }) {
  return (
    <ol>
      <li>
        <strong>Tell Oto.</strong> Say what the car is doing, or ask for {serviceName} by name. Oto reads your
        car from the VIN or year, make and model.
      </li>
      <li>
        <strong>Pick a shop.</strong> Oto shows verified Staten Island shops that offer it, with the price
        each one set for your car.
      </li>
      <li>
        <strong>Confirm the total.</strong> Parts, labor, tax and Otopair&rsquo;s service fee, in full, before
        you tap confirm.
      </li>
      <li>
        <strong>A $20 hold.</strong> That is all that is held at booking; the locked price is what you pay.
      </li>
      <li>
        <strong>Drop off the car.</strong> At the shop, at the time you booked. Otopair is not a mobile
        mechanic.
      </li>
      <li>
        <strong>Approve anything extra in the app.</strong> The shop confirms the final price after
        inspection. Above what you approved, nothing happens until you say yes.
      </li>
      <li>
        <strong>Pay the confirmed price.</strong> Funds are captured when the shop marks the job complete,
        and the receipt lands in the app.
      </li>
    </ol>
  );
}

/** schema.org Service node for a catalog service. Provider is the sitewide
 *  LocalBusiness (components/seo/json-ld.tsx). Deliberately no `offers` and
 *  no `priceRange` — prices are per shop, per car, and never published. */
export function ServiceJsonLd({ service, path }: { service: CatalogService; path: string }) {
  const url = absoluteUrl(path);
  return (
    <JsonLd
      data={{
        "@context": "https://schema.org",
        "@type": "Service",
        "@id": `${url}#service`,
        name: service.name,
        description: service.description,
        serviceType: service.name,
        category: service.category,
        url,
        areaServed: { "@type": "City", name: `${LOCALITY.city}, ${LOCALITY.region}` },
        provider: { "@id": `${SITE_URL}/#local` },
      }}
    />
  );
}
