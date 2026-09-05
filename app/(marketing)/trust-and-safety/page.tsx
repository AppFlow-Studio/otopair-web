import type { Metadata } from "next";
import Link from "next/link";
import PageShell, { Section, Summary, type TocItem } from "@/components/flagship/page-shell";
import { FaqSection } from "@/components/seo/faq";
import { SITE_NAME, SUPPORT_EMAIL } from "@/lib/site";
import { Plate } from "@/components/flagship/product/device";
import { ApproveEstimateScreen } from "@/components/flagship/product/screens/bookings";
import { PhoneAt } from "../pricing/sections";

export const metadata: Metadata = {
  title: "Trust and safety",
  description:
    "How Otopair keeps a booking honest: hand-reviewed shops, a price that cannot rise without your approval, one-way reviews from completed bookings, and a 14-day dispute channel.",
  alternates: { canonical: "/trust-and-safety" },
};

/**
 * /trust-and-safety — audit Tier 4. Every claim is one the backend
 * enforces: the approved total as the contract with mechanic-side redaction
 * (convex/lib/booking_field_redaction.ts), in-app approval above it with a
 * 24h SLA and declined work stripped before charge
 * (convex/booking_approvals.ts), the $20 hold captured only on completion
 * (convex/lib/payment_constants.ts, convex/bookings.ts), receipts carrying
 * Stripe settlement facts (convex/invoices.ts), one-way reviews on completed
 * bookings that ops can hide but not delete (convex/reviews.ts, schema
 * reviews table), the 14-day dispute window and its reasons
 * (convex/booking_disputes.ts), the "never" list from
 * components/flagship/oto-flow.ts TRUST_DEMO, and Oto's hazard-first rule
 * (convex/oto/safety.ts) and 988 template (convex/oto/prompt/stable.ts).
 */
const UPDATED = "2026-09-04";

const TOC: TocItem[] = [
  { id: "shops", title: "How do shops get on Otopair?" },
  { id: "price", title: "How is the price protected?" },
  { id: "money", title: "How is my money protected?" },
  { id: "reviews", title: "How do reviews work?" },
  { id: "disputes", title: "What if something goes wrong?" },
  { id: "never", title: "What Otopair never does" },
  { id: "oto", title: "How does Oto handle safety?" },
  { id: "report", title: "How do I report a problem?" },
  { id: "faq", title: "Questions people ask" },
];

const FAQ = [
  {
    q: "Can the shop charge me more than the price I approved?",
    a: "Not without your approval in the app. The total you approve when you book is the contract. If the shop's confirmed price after inspection is within it, it is confirmed without another tap. If added work would take it above, you get a request in the app and 24 hours to approve or decline. Added work you decline is removed from the booking and never charged.",
  },
  {
    q: "Does the mechanic know how much I approved?",
    a: "No. The approved total and the running ceiling are removed on the server before any booking is shown to a mechanic or shop screen, so the shop prices the job on its own and cannot anchor its estimate to your number.",
  },
  {
    q: "When is my card actually charged?",
    a: "When the shop marks the job complete. At booking, Otopair places a $20 hold, which is the most that is ever blocked before the shop has inspected the car. The hold is raised to the confirmed price after inspection and captured when the booking is completed, or, under the cancellation policy, kept as the $20 fee if you cancel inside 24 hours, are marked a no-show by the shop, or leave the post-inspection estimate unanswered for 24 hours. Card details go straight to Stripe; Otopair never sees the card number.",
  },
  {
    q: "Can a shop review me back or edit my review?",
    a: "No. Reviews on Otopair go one way, from the driver to the shop and optionally to the mechanic, and only after a completed booking. A shop cannot review a driver and cannot edit or remove a review. Otopair's team can hide a review that breaks the rules; it does not delete them.",
  },
  {
    q: "How do I get a refund?",
    a: "Open a dispute in the app within 14 days of the final charge, choosing the reason: wrong part, overcharged, work not done, a quality concern, or something else. Otopair reviews the job record and messages on both sides and records the outcome: no refund, a partial refund or a full refund. A refund is then issued by the shop through Otopair to the card you paid with. Cash paid at a walk-in is refunded in person by the shop.",
  },
  {
    q: "Is the Oto on the website the same as the one in the app?",
    a: "No. Oto lives in the Otopair mobile app, where it can see your car, your bookings and your health score. The 'Talk to Oto' on the website is a demo of the conversation; it does not create a real booking and does not have access to any account.",
  },
];

export default function TrustAndSafetyPage() {
  return (
    <PageShell
      title="What keeps a booking honest"
      lede={`A price the shop cannot raise on its own, money that does not move until the job is done, reviews that only a real customer can leave, and a person at ${SITE_NAME} when something goes wrong. This page says exactly how each of those works.`}
      updated={UPDATED}
      crumbs={[
        { name: "Home", href: "/" },
        { name: "Trust and safety", href: "/trust-and-safety" },
      ]}
      toc={TOC}
      numbered
    >
      <Summary
        items={[
          "Every shop is reviewed by a person at Otopair and cleared by Stripe before it can take a booking.",
          "The total you approve before the car goes in is the contract. Mechanics never see it, and anything above it needs your OK in the app.",
          "A $20 hold at booking is the most ever blocked before inspection; the card is captured when the job is complete, or kept as the $20 fee under the cancellation policy.",
          "Reviews go one way, driver to shop, and only from completed bookings.",
          "A dispute channel open for 14 days after the final charge, reviewed by Otopair, with refunds issued by the shop through Otopair.",
        ]}
      />

      <Section id="shops" title="How do shops get on Otopair?">
        <p>
          By application, reviewed by hand. A shop applies with its legal name, owner, business email,
          phone and street address; a person at {SITE_NAME} approves or declines it; the owner claims
          a private invite; Stripe verifies the business&rsquo;s identity and payout account; and the
          shop sets its hours, labor rate, services and at least one mechanic before it appears to
          drivers. The Verified badge is granted by {SITE_NAME}&rsquo;s team after that, with a
          written reason, and can be removed.
        </p>
        <p>
          The full standard, including what {SITE_NAME} does not check today, is on{" "}
          <Link href="/how-shops-are-verified">how shops are verified</Link>.
        </p>
      </Section>

      <Section id="price" title="How is the price protected?" after={<Plate tone="pale" className="flex justify-center px-6 pt-8" clip><div className="-mb-[22%]"><PhoneAt w={300}><ApproveEstimateScreen /></PhoneAt></div></Plate>}>
        <p>
          The total you approve when you book is the contract. You see the full total for your exact
          car, with parts, labor, tax and {SITE_NAME}&rsquo;s service fee inside it, before you
          confirm. After inspecting the car the shop confirms its price: within what you approved, it
          is confirmed without another tap; above it, nothing happens until you say yes in the app.
        </p>
        <ul>
          <li>
            <strong>Mechanics never see your approved total.</strong> Your approved total and the running
            ceiling are stripped on the server before any booking is returned to a mechanic or shop
            screen, so an estimate cannot be anchored to your number. This is enforced in the data
            layer, not just hidden in the interface.
          </li>
          <li>
            <strong>Anything above needs your OK.</strong> A request to add work arrives in the app
            with the new total. You have 24 hours to approve or decline; the shop cannot proceed above
            your ceiling in the meantime, and it can withdraw the request.
          </li>
          <li>
            <strong>Declined work is never charged.</strong> If you decline added work mid-job, those
            lines are removed from the booking. If a mid-job request goes unanswered for 24 hours,
            the job continues at the last approved price and the added work is not charged.
          </li>
          <li>
            <strong>One exception to know about.</strong> If the shop&rsquo;s first estimate after
            inspection is above what you approved and you do not answer within 24 hours, the $20 hold
            is kept to pay the shop for the inspection. See the{" "}
            <Link href="/cancellation-policy">cancellation policy</Link>.
          </li>
        </ul>
      </Section>

      <Section id="money" title="How is my money protected?">
        <p>
          It stays with Stripe until the job is done. Booking places a $20 hold on your card, which is
          the most ever blocked before the shop has inspected the car. After inspection the hold is
          raised to the confirmed price. Nothing is captured until the shop marks the job complete;
          cancel before that under the policy and the hold is released or reduced to the stated fee.
        </p>
        <ul>
          <li>
            <strong>Your card number never reaches {SITE_NAME}.</strong> Cards are entered directly
            with Stripe. {SITE_NAME} keeps only the card brand and last four digits, for your receipt.
          </li>
          <li>
            <strong>An itemised receipt, from the actual charge.</strong> Once the payment settles you
            get a receipt with every line, and the settlement figures on it are read from the Stripe
            charge itself, not predicted.
          </li>
          <li>
            <strong>Refunds go back the way you paid.</strong> A refund is issued by the shop through{" "}
            {SITE_NAME} and returns to the card you used. Cash paid at a walk-in has nothing to
            reverse online and is refunded in person by the shop.
          </li>
          <li>
            <strong>Shops are paid through Stripe,</strong> on Stripe&rsquo;s payout schedule, after
            the job is complete. {SITE_NAME} does not hold shop money itself.
          </li>
        </ul>
      </Section>

      <Section id="reviews" title="How do reviews work?">
        <p>
          One way, from completed bookings only. A driver can review the shop, and optionally the
          mechanic, once the booking is marked complete, and at most once per booking. Shops do not
          review drivers, and a shop cannot edit or remove a review of itself. Every review on a shop
          page therefore comes from someone whose booking with that shop was completed through{" "}
          {SITE_NAME}.
        </p>
        <p>
          {SITE_NAME}&rsquo;s team can hide a review that breaks the rules, for example one that
          contains someone&rsquo;s personal details; it does not delete reviews. Leaving a review earns
          a small credit toward a future booking, the same amount for every review whatever the rating,
          so the credit rewards writing one, not writing a kind one.
        </p>
      </Section>

      <Section id="disputes" title="What if something goes wrong?">
        <p>
          Open a dispute in the app within 14 days of the final charge. You choose the reason: wrong
          part, overcharged, work not done, a quality concern, or something else, and add notes. A
          person at {SITE_NAME} reviews the job record, the approvals and the messages on both sides,
          and records an outcome: no refund, a partial refund or a full refund.
        </p>
        <p>
          A refund is then issued by the shop through {SITE_NAME}; it is not automatic on the decision,
          and one dispute can be open on a booking at a time. If you take the charge up with your card
          issuer instead, Stripe runs that process and the shop responds to it through Stripe. Before
          any of this, the fastest route is usually to message the shop from the booking; most
          problems are a conversation, not a case. What a shop stands behind after the work is done is
          the shop&rsquo;s own promise; see the <Link href="/warranty">warranty page</Link>.
        </p>
      </Section>

      <Section id="never" title="What Otopair never does">
        <p>
          These are product rules, not aspirations, and they are the same rules Oto is built to
          follow. {SITE_NAME} never:
        </p>
        <ul>
          <li>Hides fees. The total you approve is the total you pay.</li>
          <li>Uses upsells, scarcity or countdowns.</li>
          <li>Uses panic or guilt language.</li>
          <li>Sells or rents your data. See the <Link href="/privacy">privacy policy</Link>.</li>
          <li>Pushes services your car does not need.</li>
          <li>Sends marketing notification blasts.</li>
        </ul>
      </Section>

      <Section id="oto" title="How does Oto handle safety?">
        <p>
          Danger first, diagnosis second. Before Oto decides what a message is about, a server-side
          check reads it for hazards: smoke or fire, fumes, a brake or steering problem, overheating,
          poor visibility, a wheel coming loose, a warning light, or an injury. When one is found, Oto
          leads with the stop-driving or pull-over instruction and only then talks about the cause,
          whatever the tone of the message.
        </p>
        <ul>
          <li>
            <strong>Oto never pretends to be a person.</strong> There is no live human in the chat, and
            Oto will not answer as the shop or the mechanic. Messages from a shop arrive on the
            booking, from the shop.
          </li>
          <li>
            <strong>Oto is not a mechanic, a lawyer or a salesperson.</strong> It does not walk you
            through repair procedures, does not quote prices, labor hours or durations, and does not
            evaluate legal cases.
          </li>
          <li>
            <strong>If someone in the chat is in crisis,</strong> Oto stops the car conversation and
            points to the 988 Suicide and Crisis Lifeline, by call or text.
          </li>
          <li>
            <strong>Oto cannot send help.</strong> {SITE_NAME} does not tow, jump-start or come to a
            stranded car, and Oto will say so rather than imply someone is on the way.
          </li>
          <li>
            <strong>Booking and payment are for adults.</strong> Oto answers car questions for anyone,
            but will not book or pay for someone who appears to be under 18.
          </li>
        </ul>
        <p>
          Oto lives in the {SITE_NAME} mobile app. The &ldquo;Talk to Oto&rdquo; on the website is a
          demo of the conversation and creates no real booking.
        </p>
      </Section>

      <Section id="report" title="How do I report a problem?">
        <p>
          For a booking, use the app: message the shop from the booking, or open a dispute once the
          final amount has been charged. For anything else, including a shop, a review, a safety
          concern or something Oto said, email{" "}
          <a href={`mailto:${SUPPORT_EMAIL}?subject=Trust%20and%20safety`}>{SUPPORT_EMAIL}</a>. A
          person reads every message. Security issues have their own route on the{" "}
          <Link href="/security">security page</Link>.
        </p>
      </Section>

      <FaqSection items={FAQ} />
    </PageShell>
  );
}
