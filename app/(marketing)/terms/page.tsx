import type { Metadata } from "next";
import Link from "next/link";
import PageShell, { Section, Summary, type TocItem } from "@/components/flagship/page-shell";
import { LEGAL_NAME, SITE_NAME, SUPPORT_EMAIL } from "@/lib/site";

export const metadata: Metadata = {
  title: "Terms of service",
  description:
    "The terms for using Otopair to find, book and pay verified repair shops: locked prices, deposits, approvals, cancellations and what Otopair is responsible for.",
  alternates: { canonical: "/terms" },
};

/**
 * Driver-facing terms, written against the product's real mechanics: the
 * shop sets the price, Otopair locks it at confirmation, a deposit holds
 * the slot, added work needs in-app approval (Pre-Job Approval), payment
 * settles through Stripe. Numbers (deposit amount, cancellation windows)
 * are deliberately not hard-coded here — they are shown in the app at the
 * moment they apply, and a legal page that drifts from the app is worse
 * than one that defers to it. Shops are governed by the separate partner
 * agreement. Not a substitute for counsel's review.
 */
const UPDATED = "2026-09-04";

const TOC: TocItem[] = [
  { id: "what", title: "What is Otopair?" },
  { id: "account", title: "Who can use it?" },
  { id: "price", title: "How does the locked price work?" },
  { id: "deposit", title: "What is the deposit for?" },
  { id: "cancel", title: "Cancelling or missing an appointment" },
  { id: "disputes", title: "What if the work is not right?" },
  { id: "conduct", title: "What am I not allowed to do?" },
  { id: "ip", title: "Who owns what?" },
  { id: "liability", title: "What is Otopair responsible for?" },
  { id: "shops", title: "Do these terms apply to shops?" },
  { id: "law", title: "Which law applies?" },
  { id: "changes", title: "Will these terms change?" },
];

export default function TermsPage() {
  return (
    <PageShell
      title="The deal, in plain words"
      lede={`These terms govern your use of ${SITE_NAME} (the app, the website and the shop dashboard), operated by ${LEGAL_NAME}. By creating an account or booking a job you agree to them.`}
      updated={UPDATED}
      crumbs={[
        { name: "Home", href: "/" },
        { name: "Terms of service", href: "/terms" },
      ]}
      toc={TOC}
      numbered
    >
      <Summary
        items={[
          "Otopair is a marketplace. The shop does the repair; Otopair locks the price and settles payment.",
          "The price you confirm is the price you pay. Added work needs your approval in the app first.",
          "A deposit holds your slot and counts toward the total. Cancellation windows are shown before you confirm.",
          "Oto is a guide, not a diagnosis. The shop's inspection decides the work.",
          "Problems go to the shop first, then to support. Otopair can hold a payout while it reviews.",
        ]}
      />
      <Section first id="what" title="What is Otopair?">
        <p>
          Otopair is a marketplace. It connects drivers with independent repair shops that Otopair
          has verified, shows a price the shop set, and locks that price when you book. The shop, not
          Otopair, performs the repair. Otopair is not a repair shop, does not employ the mechanics,
          and does not take custody of your vehicle.
        </p>
        <p>
          Oto, the in-app assistant, helps you describe a problem and understand a quote. It is a
          guide, not a diagnosis. A shop&rsquo;s inspection is what determines the work your car needs.
        </p>
      </Section>

      <Section id="account" title="Who can use it?">
        <p>
          Anyone 18 or older who can legally book and pay for service on the vehicle. You are
          responsible for keeping your sign-in secure and for what happens under your account. One
          person, one account; Otopair may close accounts used for fraud, abuse, or to circumvent
          the platform.
        </p>
      </Section>

      <Section id="price" title="How does the locked price work?">
        <p>
          The shop sets its price for the job you described. Before you confirm, you see the full
          total for your exact car: parts, labor, tax and Otopair&rsquo;s service fee are all inside
          it, and nothing is added after you confirm. After the shop inspects the car it confirms the
          final price. That price cannot go above what you approved without your OK in the app.
        </p>
        <p>
          If the shop finds something the quote did not cover, it must send you the additional work
          and its price in the app, and nothing beyond what you approved is charged unless you approve
          it there. You can decline added work; the shop then completes what you originally booked.
          An estimate you leave unanswered for 24 hours after the inspection is treated as declined,
          and the deposit is kept to pay the shop for the inspection.
        </p>
      </Section>

      <Section id="deposit" title="What is the deposit for?">
        <p>
          A deposit holds your appointment and is applied to the locked price when the job is done.
          Its amount is shown before you confirm. The balance is collected through Otopair when the
          shop marks the job complete, and the shop is paid through Stripe on Stripe&rsquo;s payout
          schedule.
        </p>
      </Section>

      <Section id="cancel" title="What if I need to cancel or I miss the appointment?">
        <p>
          You can cancel from the booking in the app. Whether the deposit is returned depends on how
          close to the appointment you cancel, and that window is shown on the booking before you
          confirm and again when you cancel. If the shop marks you as a no-show, the deposit is kept
          the same way as a late cancellation. If the shop cancels or cannot honor the price you
          approved, your deposit is returned in full.
        </p>
      </Section>

      <Section id="disputes" title="What if the work is not right?">
        <p>
          Tell the shop first, through the app, so there is a record. If you cannot resolve it,
          email{" "}
          <a href={`mailto:${SUPPORT_EMAIL}?subject=Booking%20dispute`}>{SUPPORT_EMAIL}</a> as
          soon as possible after pickup, and within 14 days of the final charge to open a formal
          dispute in the app. Otopair reviews the job record, the approvals and the messages, and can
          withhold or reverse a payout to the shop while it does. Any warranty on parts or labor is
          the shop&rsquo;s own, on the shop&rsquo;s terms; Otopair does not itself warrant repairs.
          See the <Link href="/warranty">warranty page</Link> and the{" "}
          <Link href="/cancellation-policy">cancellation policy</Link>.
        </p>
      </Section>

      <Section id="conduct" title="What am I not allowed to do?">
        <ul>
          <li>Book a job with no intention of showing up, or use the platform to source a shop and then pay it off-platform.</li>
          <li>Misrepresent your vehicle, its condition, or who owns it.</li>
          <li>Harass shop staff, or post reviews that are false or that you were paid for.</li>
          <li>Scrape, copy or resell Otopair&rsquo;s content, pricing or data, or reverse-engineer the app.</li>
          <li>Interfere with the service or access parts of it you are not authorized to use.</li>
        </ul>
      </Section>

      <Section id="ip" title="Who owns what?">
        <p>
          Otopair owns the app, the site, Oto, the brand and the vehicle-data assets. You own the
          content you add and give Otopair a licence to use it to run the service. Records of your
          jobs, stripped of anything that identifies you or your shop, may be aggregated into
          Otopair&rsquo;s vehicle-data products as described in the{" "}
          <Link href="/privacy">privacy policy</Link>.
        </p>
      </Section>

      <Section id="liability" title="What is Otopair responsible for?">
        <p>
          For the marketplace working as described: showing verified shops, locking the price,
          holding and settling payment, and handling disputes in good faith. Otopair is not
          responsible for the quality of a shop&rsquo;s work, for damage to your vehicle while it is
          in a shop&rsquo;s care, or for Oto&rsquo;s guidance being treated as a professional diagnosis.
        </p>
        <p>
          The service is provided as is. To the extent the law allows, Otopair&rsquo;s total
          liability to you for any claim is limited to the amount you paid through Otopair for the
          booking the claim is about, and Otopair is not liable for indirect or consequential loss.
          Nothing here limits liability that cannot be limited by law.
        </p>
      </Section>

      <Section id="shops" title="Do these terms apply to shops?">
        <p>
          Shops and their staff are bound by the partner agreement they accept when they join the
          network, which covers verification, pricing, payouts, cancellations and the reciprocal
          obligations between the shop and Otopair. Where the two documents overlap, the partner
          agreement governs the shop.
        </p>
      </Section>

      <Section id="law" title="Which law applies?">
        <p>
          These terms are governed by the laws of the State of New York, and disputes that cannot be
          resolved with support are brought in the state or federal courts located in Richmond
          County, New York. If any
          part of these terms is found unenforceable, the rest still applies.
        </p>
      </Section>

      <Section id="changes" title="Will these terms change?">
        <p>
          Yes, as the product does. The date at the top changes and, for anything material, you are
          notified in the app before it takes effect. Bookings already confirmed keep the terms they
          were made under. Questions go to{" "}
          <a href={`mailto:${SUPPORT_EMAIL}?subject=Terms`}>{SUPPORT_EMAIL}</a>.
        </p>
      </Section>
    </PageShell>
  );
}
