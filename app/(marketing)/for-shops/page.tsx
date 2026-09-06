import type { Metadata } from "next";
import PageShell from "@/components/flagship/page-shell";
import { PillLink, TextLink } from "@/components/flagship/pill-button";
import { Reveal } from "@/components/flagship/landing/reveal";
import { ForShopsSections } from "./sections";
import { FaqList, type FaqItem } from "@/components/seo/faq";
import { JsonLd } from "@/components/seo/json-ld";

export const metadata: Metadata = {
  title: { absolute: "Otopair for repair shops: booked, pre-diagnosed customers at your price" },
  description:
    "Otopair sends independent repair shops booked, pre-diagnosed customers at a price the shop set, handles the $20 hold and in-app approvals, and pays through Stripe Connect on Stripe's payout schedule. No subscription, no setup fee.",
  alternates: { canonical: "/for-shops" },
};

/**
 * /for-shops: the explainer (design pass 2026-09-05, stage cut). Where
 * /partner-with-us tells the shop's story, this page answers the questions
 * a shop owner has before applying, with three stages drawn from the shop
 * dashboard: rates by vehicle tier and flat prices, the rules that protect
 * the shop (no-show fee, unanswered estimates), and the dashboard's six
 * areas. Every answer in full sits in one editorial list at the foot.
 *
 * Product facts: labor rates by tier and flat prices
 * (convex/lib/vehicleTiers.ts, convex/shopServiceFixedPrices.ts), in-range
 * auto-approve + 24h SLA + deposit forfeit (convex/booking_approvals.ts),
 * Stripe Connect Express payouts (app/api/stripe/connect/start/route.ts),
 * verification = manual director approval (convex/director.ts
 * setShopVerified) and the bookable gate (lib/bookableShop.ts), one-way
 * reviews on completed bookings (convex/reviews.ts).
 */
const NAV_CTA = { label: "Apply", href: "/apply" };


const FAQ: FaqItem[] = [
  {
    q: "Does it cost anything to join Otopair?",
    a: "No subscription, no setup fee, no monthly. You set your rates and keep your rate. Otopair's service fee is part of the total the driver confirms in the app; you earn, then Otopair earns.",
  },
  {
    q: "Do I have to accept every booking?",
    a: "No. A booking request waits for your acceptance. If it goes unanswered it expires on its own, after 48 hours or 2 hours past the requested time, whichever comes first; the driver's hold is released and nothing is charged to anyone. You get reminders before that happens.",
  },
  {
    q: "What happens if the driver does not show up?",
    a: "After the appointment time passes with no arrival, the app reminds the driver and then asks your front desk to decide. If you mark the booking a no-show, the $20 deposit is kept as the no-show fee. If nobody at the desk decides, the booking is marked a no-show automatically and the driver's hold is released without a fee. A driver who cancels inside 24 hours forfeits the same deposit.",
  },
  {
    q: "Can I change my rates later?",
    a: "Yes. Labor rates by vehicle tier, the tiers you take, flat prices per service and the services you offer are all edited from your shop dashboard.",
  },
  {
    q: "What do drivers see about my shop?",
    a: "Your name, location and hours, the services you offer, the price you set for their specific job, photos you add, and reviews from drivers whose bookings with you were completed. The app never shows drivers your payout or Stripe details.",
  },
];

const H2 = "serif-display max-w-[14ch] text-[32px] leading-[1.04] tracking-[-0.01em] text-[#1a1a1a] [text-wrap:balance] tab:text-[40px]";

export default function ForShopsPage() {
  return (
    <PageShell
      title="Booked, pre-diagnosed customers, at your price."
      lede="Pre-diagnosed drivers, booked with a $20 hold, at your price. Inspect, confirm in the app, get paid through Stripe."
      crumbs={[
        { name: "Home", href: "/" },
        { name: "For shops", href: "/for-shops" },
      ]}
      hero={
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <PillLink href="/apply">Apply to partner</PillLink>
          <TextLink href="/partner-with-us#lands">How a booking reaches you</TextLink>
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

      <ForShopsSections />

      {/* ---------- The details, in full ---------- */}
      <section id="details" className="scroll-mt-28 border-t border-[#1a1a1a]/10 pt-14 tab:pt-20">
        <Reveal>
          <h2 className={H2}>Questions shops ask.</h2>
        </Reveal>
        <FaqList items={FAQ} className="mt-8 border-b border-[#1a1a1a]/10 [&_dd]:max-w-[60ch]" />
      </section>
    </PageShell>
  );
}
