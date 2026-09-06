import type { Metadata } from "next";
import Link from "next/link";
import PageShell, { Section, Summary, type TocItem } from "@/components/flagship/page-shell";
import { FaqSection } from "@/components/seo/faq";
import { SUPPORT_EMAIL } from "@/lib/site";
import { Reveal } from "@/components/flagship/landing/reveal";
import { Plate } from "@/components/flagship/product/device";
import { ReceiptScreen } from "@/components/flagship/product/screens/bookings";
import { PhoneAt } from "../pricing/sections";

export const metadata: Metadata = {
  title: "Warranty",
  description:
    "Otopair does not warrant repairs. Any parts or labor warranty is the shop's own, on the shop's terms. Otopair keeps the itemised receipt and runs a 14-day dispute channel after the final charge.",
  alternates: { canonical: "/warranty" },
};

/**
 * Warranty page, written against what the product actually does: Otopair
 * is a marketplace and warrants nothing about the repair itself; the shop's
 * warranty is the shop's; what Otopair holds is the record (approvals,
 * messages, the itemised receipt with Stripe settlement facts) and a
 * 14-day post-charge dispute channel (convex/booking_disputes.ts). No
 * warranty text or field exists on receipts, so this page never claims
 * the receipt states one.
 */
const UPDATED = "2026-09-04";

const TOC: TocItem[] = [
  { id: "otopair", title: "Does Otopair warrant repairs?" },
  { id: "shop", title: "Whose warranty applies to my repair?" },
  { id: "record", title: "What does Otopair keep that helps?" },
  { id: "dispute", title: "What if the work is wrong, or I was overcharged?" },
  { id: "how", title: "How do I raise a problem?" },
  { id: "faq", title: "Questions people ask" },
];

const FAQ = [
  {
    q: "Does Otopair guarantee the repair?",
    a: "No. Otopair is a marketplace: the shop performs the repair and stands behind it on the shop's own terms. Otopair locks the price, holds and settles payment, keeps the record of the job, and reviews disputes filed within 14 days of the final charge.",
  },
  {
    q: "How do I find out what the shop's warranty covers?",
    a: "Ask the shop, ideally in the app so the answer is on the record. Warranties differ from shop to shop and by part and job; Otopair does not set them and does not print them on the receipt.",
  },
  {
    q: "The part failed a month after the job. Who do I contact?",
    a: "The shop first, through the app. A warranty claim after Otopair's 14-day dispute window is between you and the shop under its own terms, and the itemised receipt in the app is the record of what was done and paid. Support can share the job record if it helps.",
  },
  {
    q: "What can a dispute lead to?",
    a: "Otopair reviews the job record, the approvals and the messages, and resolves the dispute as no refund, a partial refund, or a full refund. For card payments made through Otopair, a refund is issued by the shop through Otopair to the card you paid with. It is a review, not an automatic reversal.",
  },
  {
    q: "Does the itemised receipt state the warranty?",
    a: "No. The receipt records what was approved, what was done and what was charged, along with the settlement facts from the payment processor. Warranty terms are the shop's to state; get them from the shop in the app.",
  },
];

export default function WarrantyPage() {
  return (
    <PageShell
      title="Who stands behind the repair?"
      lede="The shop that did the work. Otopair does not warrant repairs; any parts or labor warranty is the shop's own, on the shop's terms. What Otopair keeps is the record of the job, and a 14-day dispute channel after the final charge if something is wrong."
      updated={UPDATED}
      crumbs={[
        { name: "Home", href: "/" },
        { name: "Warranty", href: "/warranty" },
      ]}
      toc={TOC}
      numbered
    >
      <Summary
        items={[
          "Otopair does not warrant repairs. The shop performs the work and stands behind it.",
          "Any parts or labor warranty is the shop's own, on the shop's terms. Ask the shop in the app so it is on the record.",
          "Otopair keeps the itemised receipt, the approvals and the messages, so a warranty conversation has a record.",
          "Within 14 days of the final charge you can open a dispute; Otopair reviews it and can result in no refund, a partial refund or a full refund.",
          "For card payments made through Otopair, a refund is issued by the shop through Otopair, to the card you paid with.",
        ]}
      />

      <Section first id="otopair" title="Does Otopair warrant repairs?">
        <p>
          No. Otopair is a marketplace: it connects you with a verified independent shop, locks the
          price the shop set, holds and settles payment, and keeps the record. The shop, not
          Otopair, performs the repair, and Otopair does not itself warrant parts, labor or the
          outcome. That is stated in the <Link href="/terms">terms of service</Link> and it is how the
          product works.
        </p>
      </Section>

      <Section id="shop" title="Whose warranty applies to my repair?">
        <p>
          The shop&rsquo;s. Any warranty on parts or labor is the shop&rsquo;s own and runs on the
          shop&rsquo;s terms, which differ from shop to shop and by part and job. Otopair does not
          set those terms and does not print them on the receipt, so ask the shop what it covers and
          for how long. Asking in the app keeps the answer with the booking, where it counts.
        </p>
        <p>
          If a shop replaces a part under its own warranty later, that is between you and the shop.
          Otopair&rsquo;s record of the original job stays available to both of you.
        </p>
      </Section>

      {/* Motion nested under motion: page-shell wraps every Section in a
          Reveal, so this object rides one already. It is allowed here because
          the payload is a Plate holding a PhoneAt and device.tsx carries no
          motion of its own — the object would otherwise never move at all —
          and it is bounded: the rise is 14, not the house 18, so it cannot
          compound with the section's own 26 into a lurch. (FaqList used to be
          cited here; it no longer nests — it takes cascade={false} under a
          Section and rides the section's single Reveal whole.) Reveal carries
          its own observer, so the delay separates the object from the prose
          only when the whole section fits one screen; further down the page
          the phone simply settles on its own entry. */}
      <Section id="record" title="What does Otopair keep that helps?" after={<Reveal delay={0.12} y={14}><Plate tone="pale" className="flex justify-center px-6 pt-8" clip><div className="-mb-[22%]"><PhoneAt w={300}><ReceiptScreen /></PhoneAt></div></Plate></Reveal>}>
        <p>
          The whole paper trail of the job. Every booking keeps the price you approved, every
          estimate the shop sent and your answer to it, the messages between you and the shop, and
          an itemised receipt issued once the final amount is charged. The receipt records what was
          done and what was paid, together with the settlement facts from the payment processor:
          what moved, and where.
        </p>
        <p>
          That record is what makes a warranty conversation, or a dispute, a matter of fact rather
          than memory. It is yours in the app for as long as your account is open.
        </p>
      </Section>

      <Section id="dispute" title="What if the work is wrong, or I was overcharged?">
        <p>
          Within 14 days of the final charge, as recorded on the booking, you can open a dispute in the app: the wrong part was
          fitted, you were overcharged, the work was not done, or you have a concern about its
          quality. Otopair reviews the job record, the approvals and the messages. A dispute
          resolves as no refund, a partial refund or a full refund.
        </p>
        <p>
          For card payments made through Otopair, a refund is issued by the shop through Otopair to
          the card you paid with. A dispute is a
          review, not an automatic reversal, and only one dispute is open on a booking at a time.
        </p>
      </Section>

      <Section id="how" title="How do I raise a problem?">
        <p>
          Tell the shop first, through the app, so there is a record. Most problems are fixed there.
          If that does not resolve it, open a dispute from the booking within 14 days of the final
          charge, or email{" "}
          <a href={`mailto:${SUPPORT_EMAIL}?subject=Booking%20dispute`}>{SUPPORT_EMAIL}</a> with the
          booking and what happened. For a cancellation rather than a completed job, see the{" "}
          <Link href="/cancellation-policy">cancellation policy</Link>.
        </p>
      </Section>

      <FaqSection items={FAQ} />
    </PageShell>
  );
}
