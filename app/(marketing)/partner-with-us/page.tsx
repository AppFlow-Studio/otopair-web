import type { Metadata } from "next";
import PageShell from "@/components/flagship/page-shell";
import { Ladder } from "@/components/flagship/ladder";
import { PillLink, TextLink } from "@/components/flagship/pill-button";
import { Reveal } from "@/components/flagship/landing/reveal";
import { PartnerSections } from "./sections";
import { FaqList, type FaqItem } from "@/components/seo/faq";
import { JsonLd } from "@/components/seo/json-ld";

export const metadata: Metadata = {
  // `absolute`: the root template would otherwise append a second "— Otopair".
  title: { absolute: "Partner with Otopair: booked, pre-diagnosed customers at your price" },
  description:
    "Join the Otopair network. Booked, pre-diagnosed drivers at a price you set, approvals in the app, and payouts through Stripe on Stripe's payout schedule. No subscription, no setup fee.",
  alternates: { canonical: "/partner-with-us" },
};

/**
 * /partner-with-us: the pitch (design pass 2026-09-05, stage cut). The
 * shop's story in three stages drawn from the shop dashboard's own
 * vocabulary (a booking landing on the board, the post-inspection estimate
 * and unforeseen scope, where the money lands), then what it takes to go
 * live, the questions shops ask, and one CTA. The explainer (rates, the
 * dashboard, the rules that protect the shop) lives on /for-shops so the
 * two pages do different jobs.
 *
 * Every product claim comes from the fact sheets behind /for-shops: rates
 * per vehicle tier + flat prices (convex/lib/vehicleTiers.ts,
 * shopServiceFixedPrices.ts), in-range auto-approve + 24h SLA
 * (convex/booking_approvals.ts), Stripe Connect Express payouts
 * (app/api/stripe/connect/start), manual verification + the bookable gate
 * (lib/bookableShop.ts), one-way reviews on completed bookings
 * (convex/reviews.ts). No fee rate, no "24-hour payouts".
 */
const NAV_CTA = { label: "Apply", href: "/apply" };


const GO_LIVE = [
  { title: "Apply", body: "Legal name, owner, business email, phone and street address. Two minutes." },
  { title: "Review", body: "A person on the Otopair team approves or declines every application by hand." },
  { title: "Invite", body: "A private, single-use link that expires in seven days." },
  {
    title: "Stripe",
    body: "Identity and payout bank details are verified by Stripe, not by Otopair. Charges and payouts must be enabled before you can take a booking.",
  },
  { title: "Set up", body: "Seven days of hours, a labor rate, the services you offer and at least one mechanic. Then you appear to drivers." },
];

const FAQ: FaqItem[] = [
  {
    q: "Does it cost anything to join Otopair?",
    a: "No subscription, no setup fee, no monthly. You set your rates and keep your rate. Otopair's service fee is part of the total the driver confirms in the app; you earn, then Otopair earns.",
  },
  {
    q: "Do I have to accept every booking?",
    a: "No. A booking request waits for your acceptance. If it goes unanswered it expires on its own, after 48 hours or 2 hours past the requested time, whichever comes first; the driver's hold is released and nothing is charged to anyone.",
  },
  {
    q: "What happens if the driver does not show up?",
    a: "After the appointment time passes with no arrival, the app reminds the driver and then asks your front desk to decide. If you mark the booking a no-show, the $20 deposit is kept as the no-show fee. If nobody decides, it is marked automatically and the hold is released without a fee.",
  },
  {
    q: "What does verification involve?",
    a: "Otopair's team reviews and approves each shop by hand. Separately, to take bookings a shop needs a Stripe Connect account with charges and payouts enabled, hours for all seven days, at least one mechanic, at least one offered service and a labor rate. Otopair does not check licences or insurance beyond the DMV inspection licence for shops offering State Inspection.",
  },
  {
    q: "What do drivers see about my shop?",
    a: "Your name, location and hours, the services you offer, the price you set for their specific job, photos you add, and reviews from drivers whose bookings with you were completed. The app never shows drivers your payout or Stripe details.",
  },
];

const H2 = "serif-display max-w-[14ch] text-[32px] leading-[1.04] tracking-[-0.01em] text-[#1a1a1a] [text-wrap:balance] tab:text-[40px]";

export default function PartnerWithUsPage() {
  return (
    <PageShell
      title={
        <>
          Fill your bays.
          <br />
          Skip the phone tag.
        </>
      }
      lede="Booked, pre-diagnosed drivers at the price you set. You inspect, confirm in the app, and get paid through Stripe."
      crumbs={[
        { name: "Home", href: "/" },
        { name: "Partner with us", href: "/partner-with-us" },
      ]}
      hero={
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <PillLink href="/apply">Apply to partner</PillLink>
          <TextLink href="/for-shops">Rates, approvals and the dashboard</TextLink>
        </div>
      }
      heroAlign="start"
      width="wide"
      navCta={NAV_CTA}
      footerTitle="Ready to grow your shop?"
      footerAnchorId="apply"
      footerAction={
        <>
          <PillLink href="/apply" tone="light">
            Apply to partner
          </PillLink>
          <p className="max-w-[46ch] text-center text-[13px] leading-[18px] tracking-[0.02em] text-[#4B82A5]">
            Two minutes to apply. We review your shop and send a private invite to set up.
          </p>
        </>
      }
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

      <PartnerSections />

      {/* ---------- What it takes to go live ---------- */}
      <section id="verification" className="scroll-mt-28 border-t border-[#1a1a1a]/10 py-14 tab:py-20">
        {/* Head and lede are one block; the Ladder brings its own Sequence. */}
        <Reveal>
          <div className="grid gap-3 tab:grid-cols-12 tab:items-end tab:gap-8">
            <h2 className={`${H2} tab:col-span-5`}>Five steps to your first booking.</h2>
            <p className="max-w-[46ch] text-[17px] leading-[1.55] text-[#4c5661] [text-wrap:pretty] tab:col-span-6 tab:col-start-7 tab:pb-1">
              A person reviews every application. Stripe verifies identity and payouts. You set hours, a rate, services
              and a team, and you are live.
            </p>
          </div>
        </Reveal>
        <Ladder direction="row" steps={GO_LIVE} className="mt-10" />
      </section>

      {/* ---------- The questions shops ask ---------- */}
      <section id="faq" className="scroll-mt-28 border-t border-[#1a1a1a]/10 pt-14 tab:pt-20">
        <Reveal>
          <h2 className={H2}>The questions shops ask.</h2>
        </Reveal>
        <FaqList items={FAQ} className="mt-8 border-b border-[#1a1a1a]/10 [&_dd]:max-w-[60ch]" />
      </section>
    </PageShell>
  );
}
