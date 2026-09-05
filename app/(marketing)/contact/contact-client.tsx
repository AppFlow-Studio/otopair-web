"use client";

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { Reveal, serif, serifDisplay } from "@/components/flagship/landing/reveal";
import FooterCta from "@/components/flagship/landing/footer-cta";
import NetworkMap from "@/components/flagship/landing/network-map";
import PillNav from "@/components/flagship/pill-nav";
import ContactForm from "@/components/flagship/contact-form";
import { Bezel } from "@/components/flagship/bezel";
import { Breadcrumbs } from "@/components/seo/breadcrumbs";
import { FaqList, type FaqItem } from "@/components/seo/faq";
import { JsonLd } from "@/components/seo/json-ld";
import { DATA_EMAIL, LEGAL_NAME, LOCALITY, POSTAL_ADDRESS, SUPPORT_EMAIL } from "@/lib/site";

/**
 * /contact (design pass 2026-09-05). Read as: the contact page of a
 * trust-first local marketplace, soft-structural on the sky wash with the
 * light display serif; variance 6, motion 4, density 3.
 *
 * Four sections, four layout families: a split hero whose right half is the
 * working form seated in a glass bezel (the form is the call to action, so
 * the hero carries no pill); the four lanes as hairline rows; the company's
 * place with the live network map, real pins, in a bezel; and a two-column
 * FAQ. No eyebrows: the breadcrumb already names the page. The support
 * address appears once in the hero copy and once under the form's button,
 * nowhere else.
 */
const NAV_LINKS = [
  { label: "How it works", href: "/how-it-works" },
  { label: "For shops", href: "/for-shops" },
  { label: "Coverage", href: "/coverage" },
  { label: "Partner with us", href: "/partner-with-us" },
];
const NAV_CTA = { label: "Get Oto", href: "/download" };

const LANES = [
  {
    title: "Drivers",
    body: "A booking, a job that went wrong, or something Oto got wrong.",
    action: { label: "Use the form, or email support", href: `mailto:${SUPPORT_EMAIL}?subject=Driver%20support` },
  },
  {
    title: "Repair shops",
    body: "Not on the network yet? Apply. Already a partner? Sign in to your dashboard.",
    action: { label: "Apply to partner", href: "/apply" },
    secondary: { label: "Shop sign-in", href: "/shop" },
  },
  {
    title: "Car data & API",
    body: "Access to the vehicle-data asset, full reports, developer keys.",
    action: { label: `Email ${DATA_EMAIL}`, href: `mailto:${DATA_EMAIL}?subject=Data%20API%20access` },
  },
  {
    title: "Press & partnerships",
    body: "Boilerplate, facts and brand files are on the press page; anything else, write in.",
    action: { label: "Open the press kit", href: "/press" },
  },
];

const FAQ: FaqItem[] = [
  {
    q: "Where is Otopair based?",
    a: `Otopair is operated by ${LEGAL_NAME} from ${LOCALITY.city}, ${LOCALITY.region}, which is also the first market the network serves. Brooklyn, Queens, The Bronx and Manhattan follow on the coverage timeline, one borough at a time.`,
  },
  {
    q: "What if something goes wrong with a booking?",
    a: "Message the shop from the booking first, so there is a record. If that does not settle it, open a dispute in the app within 14 days of the final charge; Otopair reviews the job record, the approvals and the messages on both sides. Otopair holds the shop to the total you approved, and no added work is charged without your approval in the app.",
  },
  {
    q: "How fast does someone reply?",
    a: "Messages go to a person, not a queue, and the reply comes from a real inbox with your address as the reply-to. Booking problems are read first. There is no phone line yet; the form and the support address are the fastest routes.",
  },
];

const CONTAINER = "mx-auto w-full max-w-[1190px] px-6 sm:px-10";
const H2 = "max-w-[18ch] text-[30px] leading-[1.05] tracking-[-0.01em] text-[#1a1a1a] [text-wrap:balance] tab:text-[40px]";

export default function ContactClient() {
  return (
    <div className="min-h-screen w-full bg-white">
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
      <PillNav links={NAV_LINKS} cta={NAV_CTA} />
      <div className="isolate">
        {/* ---------- 1. Hero: the ask left, the working form right ---------- */}
        <header className="w-full bg-[linear-gradient(to_bottom,#98C9E8_0px,#FFFFFF_640px)] tab:bg-[linear-gradient(to_bottom,#98C9E8_0px,#FFFFFF_820px)]">
          <div className="mx-auto grid w-full max-w-[1190px] gap-12 px-6 pt-[128px] sm:px-10 lg:grid-cols-12 lg:items-center lg:gap-14 lg:pt-[150px]">
            <div className="lg:col-span-5">
              <Reveal>
                <Breadcrumbs
                  items={[
                    { name: "Home", href: "/" },
                    { name: "Contact", href: "/contact" },
                  ]}
                  className="[&_ol]:justify-start"
                />
              </Reveal>
              <Reveal delay={0.05}>
                <h1
                  className="mt-5 max-w-[16ch] text-[38px] leading-[1.02] tracking-[-0.01em] text-[#1a1a1a] [text-wrap:balance] tab:text-[52px] lg:text-[54px]"
                  style={serifDisplay}
                >
                  Talk to a person, not a phone tree.
                </h1>
              </Reveal>
              <Reveal delay={0.1}>
                <p className="mt-6 max-w-[36ch] text-[17px] leading-relaxed text-[#4c5661] [text-wrap:pretty] tab:text-[18px]">
                  Every message lands with the Otopair team, and the reply comes from a real inbox
                  with your address as the reply-to.
                </p>
              </Reveal>
            </div>

            <div className="relative lg:col-span-7">
              <div
                aria-hidden
                className="pointer-events-none absolute -inset-10 -z-10 rounded-full bg-[radial-gradient(closest-side,rgba(255,255,255,0.85),rgba(255,255,255,0))]"
              />
              <Reveal delay={0.12} y={18}>
                <Bezel tone="glass" clip={false} innerClassName="p-6 sm:p-8">
                  <p className="text-[22px] leading-none text-[#1a1a1a]" style={serif}>
                    Send a message
                  </p>
                  <ContactForm className="mt-6" />
                </Bezel>
              </Reveal>
            </div>
          </div>
        </header>

        <main id="main" tabIndex={-1} className="outline-none">
          {/* ---------- 2. Direct routes: rows, not cards. The form's own
            select already asks who is writing; this list is for people who
            want an address or a page instead of the form. ---------- */}
          <section className={`${CONTAINER} pt-20 tab:pt-28`}>
            <Reveal>
              <h2 className={H2} style={serifDisplay}>
                Direct routes.
              </h2>
            </Reveal>
            <ul className="mt-8 divide-y divide-[#1a1a1a]/10 border-y border-[#1a1a1a]/10">
              {LANES.map((l, i) => (
                <Reveal key={l.title} delay={0.04 * i}>
                  <li className="grid gap-3 py-6 sm:grid-cols-[180px_minmax(0,1fr)_auto] sm:items-center sm:gap-8 tab:grid-cols-[220px_minmax(0,1fr)_auto]">
                    <h3 className="text-[22px] leading-none text-[#1a1a1a]" style={serif}>
                      {l.title}
                    </h3>
                    <p className="text-[15px] leading-[1.6] text-[#4c5661]">{l.body}</p>
                    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 sm:justify-end">
                      <Link
                        href={l.action.href}
                        className="group inline-flex items-center gap-1.5 whitespace-nowrap text-[14px] text-[#1a1a1a] underline decoration-[#1a1a1a]/25 underline-offset-[4px] transition-colors duration-300 hover:decoration-[#1a1a1a]"
                      >
                        {l.action.label}
                        <ArrowUpRight
                          className="size-3.5 text-[#4B82A5] transition-transform duration-500 ease-expo group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
                          aria-hidden
                        />
                      </Link>
                      {"secondary" in l && l.secondary && (
                        <Link
                          href={l.secondary.href}
                          className="whitespace-nowrap text-[14px] text-[#777169] transition-colors duration-300 hover:text-[#1a1a1a]"
                        >
                          {l.secondary.label}
                        </Link>
                      )}
                    </div>
                  </li>
                </Reveal>
              ))}
            </ul>
          </section>

          {/* ---------- 3. Where: the company's place, with the live map ---------- */}
          <section className={`${CONTAINER} pt-24 tab:pt-32`}>
            <div className="grid gap-10 lg:grid-cols-12 lg:items-center lg:gap-16">
              <Reveal className="lg:col-span-5">
                <h2 className={H2} style={serifDisplay}>
                  Built on Staten Island
                </h2>
                <p className="mt-5 max-w-[42ch] text-[16px] leading-[1.65] text-[#4c5661] [text-wrap:pretty]">
                  The company and the first market are the same place. Every pin on the map is a shop
                  the team approved by hand; the rest of the city follows one borough at a time.
                </p>
                <address className="mt-7 text-[16px] not-italic leading-[1.65] text-[#1a1a1a]">
                  <strong className="font-medium">{LEGAL_NAME}</strong>
                  <br />
                  {POSTAL_ADDRESS ? (
                    <>
                      {POSTAL_ADDRESS.streetAddress}
                      <br />
                      {POSTAL_ADDRESS.addressLocality}, {POSTAL_ADDRESS.addressRegion} {POSTAL_ADDRESS.postalCode}
                    </>
                  ) : (
                    <>
                      {LOCALITY.city}, {LOCALITY.region}
                    </>
                  )}
                </address>
                <p className="mt-6 text-[15px]">
                  <Link
                    href="/staten-island"
                    className="text-[#4B82A5] underline decoration-[#4B82A5]/40 underline-offset-[3px] hover:decoration-[#4B82A5]"
                  >
                    See the verified shops on the island
                  </Link>
                </p>
              </Reveal>
              <Reveal delay={0.08} className="lg:col-span-7">
                <Bezel>
                  {/* The same live Mapbox map as the home page: real shop pins. */}
                  <NetworkMap frame={false} className="h-[380px] sm:h-[460px] lg:h-[520px]" />
                </Bezel>
              </Reveal>
            </div>
          </section>

          {/* ---------- 4. FAQ: two-column editorial list ---------- */}
          <section id="faq" className={`${CONTAINER} scroll-mt-28 pt-24 tab:pt-32`}>
            <Reveal>
              <h2 className={H2} style={serifDisplay}>
                Before you write
              </h2>
            </Reveal>
            <Reveal delay={0.06}>
              <FaqList items={FAQ} className="mt-10 max-w-[900px]" />
            </Reveal>
          </section>
        </main>

        <FooterCta />
      </div>
    </div>
  );
}
