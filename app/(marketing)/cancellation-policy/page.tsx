import type { Metadata } from "next";
import Link from "next/link";
import PageShell, { Section, Summary, type TocItem } from "@/components/flagship/page-shell";
import { FaqSection } from "@/components/seo/faq";
import { Plate } from "@/components/flagship/product/device";
import { LifecyclePull } from "@/components/flagship/product/pullouts";

export const metadata: Metadata = {
  title: "Cancellation policy",
  description:
    "Otopair's cancellation defaults as the app enforces them: free up to 24 hours before the appointment, the $20 hold kept inside 24 hours, free reschedules up to 12 hours before, and when the hold is released in full.",
  alternates: { canonical: "/cancellation-policy" },
};

/**
 * Driver-facing cancellation policy. Every window and amount here is the
 * platform default the server enforces (convex/lib/cancellation_policy.ts
 * POLICY_DEFAULTS, convex/bookings.ts UNCONFIRMED_EXPIRY_DEFAULTS,
 * convex/booking_approvals.ts SLA_MS). The booking in the app shows the
 * same numbers at the moment they apply; if the two ever differ, the app
 * is the one that is enforced, and this page says so.
 */
const UPDATED = "2026-09-04";

const TOC: TocItem[] = [
  { id: "free", title: "When is cancelling free?" },
  { id: "late", title: "What if I cancel inside 24 hours?" },
  { id: "no-show", title: "What if I don't show up?" },
  { id: "reschedule", title: "Can I reschedule instead?" },
  { id: "at-shop", title: "What if my car is already at the shop?" },
  { id: "shop-cancels", title: "What if the shop cancels or never answers?" },
  { id: "estimate", title: "What if I don't answer the inspection estimate?" },
  { id: "far-out", title: "Why might a far-out booking need a re-confirmed hold?" },
  { id: "table", title: "Every situation, in one table" },
  { id: "faq", title: "Questions people ask" },
];

const FAQ = [
  {
    q: "Is the $20 a charge or a hold?",
    a: "A hold. When you confirm a booking, Otopair places a $20 authorization on your card; nothing is charged at that point. It is the most that is ever blocked before the shop has inspected the car. The hold is only captured when the job is marked complete (raised to the confirmed price) or when a cancellation fee applies under this policy.",
  },
  {
    q: "Can a late cancellation cost more than $20?",
    a: "No. Before the shop inspects the car, the $20 hold is the most Otopair ever has on your card, and a late-cancellation or no-show fee is capped at that hold. Nothing else is charged.",
  },
  {
    q: "Where do I see my own cutoff times?",
    a: "On the booking in the app. It shows whether cancelling right now is free, what the fee would be if it is not, until when you can reschedule for free, and how many free reschedules you have left. Those numbers are read from the same rule the server enforces, so what you see is what applies.",
  },
  {
    q: "I'm inside the 24-hour window but the shop is fine with cancelling. What then?",
    a: "Message the shop in the app. A cancellation the shop makes on its side releases your hold in full, so a shop that agrees to let you go can do that without you paying the late fee.",
  },
  {
    q: "Do different shops have different cancellation windows?",
    a: "The defaults on this page apply across the network today. Whatever windows apply to your booking are shown on the booking itself before you confirm and again when you cancel, and the app's numbers are the ones that count.",
  },
];

export default function CancellationPolicyPage() {
  return (
    <PageShell
      title="Cancelling, rescheduling, and the $20 hold"
      lede="Every appointment you book in the app is held by a $20 card hold, not a full prepayment. This page states the default windows exactly as the app enforces them: when cancelling is free, when the hold is kept, and when it is released in full."
      updated={UPDATED}
      crumbs={[
        { name: "Home", href: "/" },
        { name: "Cancellation policy", href: "/cancellation-policy" },
      ]}
      toc={TOC}
      numbered
    >
      <Summary
        items={[
          "Cancel free up to 24 hours before your appointment; the $20 hold is released.",
          "Inside 24 hours, the $20 hold is kept as a late-cancellation fee.",
          "Reschedule free up to 12 hours before, up to 2 times per booking; after that, message the shop.",
          "If the shop cancels, or never answers your request, the hold is released in full.",
          "An inspection estimate you leave unanswered for 24 hours forfeits the deposit.",
        ]}
      />

      <Section first id="free" title="When is cancelling free?">
        <p>
          Any time up to 24 hours before your appointment. Cancel from the booking in the app and the
          $20 hold is released in full; nothing is charged. The booking screen tells you whether
          cancelling right now is free and, if it is not, exactly what the fee would be before you
          confirm the cancellation.
        </p>
      </Section>

      <Section id="late" title="What if I cancel inside 24 hours?">
        <p>
          The $20 hold is kept as a late-cancellation fee. The shop set aside a bay and a mechanic
          for you, and the deposit pays for the slot it can no longer fill. That fee is capped at the
          hold: it is never more than $20, and nothing beyond it is charged. The app shows the fee
          before you confirm, and cancelling stays your choice.
        </p>
      </Section>

      <Section id="no-show" title="What if I don't show up?">
        <p>
          If you do not arrive for a confirmed appointment, the shop may mark you as a no-show, and
          the $20 hold is forfeited. Before that happens the app reminds you, so an unexpected delay
          has a chance to become a message to the shop instead. A no-show is treated like a late
          cancellation: the deposit is the whole fee.
        </p>
      </Section>

      <Section id="reschedule" title="Can I reschedule instead?">
        <p>
          Yes. You can move a booking for free up to 12 hours before the appointment, up to 2 times
          per booking, and the $20 hold simply carries over to the new time. A reschedule goes back
          to the shop to re-confirm the new slot. Inside 12 hours, or after your second reschedule,
          the app asks you to message the shop, which can move the appointment on its side.
        </p>
      </Section>

      <Section id="at-shop" title="What if my car is already at the shop?">
        <p>
          Once the car is at the shop, cancelling becomes a request to the shop rather than a button.
          You ask for pickup through the app, the front desk and the mechanic are notified, and the
          shop brings the car out and cancels the booking on its side, which releases your hold.
          Anything owed for work already done is settled with the shop directly. Work that is in progress cannot be cancelled from the app; the
          same message-the-shop route applies.
        </p>
      </Section>

      <Section id="shop-cancels" title="What if the shop cancels or never answers?">
        <p>
          Your hold is released in full. If the shop cancels a booking, no fee is charged and the $20
          authorization is voided. If the shop never accepts your request, the request expires on its
          own: after 48 hours, or 2 hours past the requested appointment time, whichever comes first.
          The hold is released and the app invites you to rebook.
        </p>
      </Section>

      {/* Section already reveals its copy (page-shell wraps every Section in a
          Reveal), and LifecyclePull's own PullCard carries a whileInView
          fade-up on a later trigger than the section's — so the receipt
          already settles a beat behind the text. Deliberately NOT wrapped in a
          Reveal the way the sibling legal pages wrap their `after` plates
          (a phone screen, which does not animate itself): here that would put
          a third fade-up on a card that already rides two. */}
      <Section id="estimate" title="What if I don't answer the inspection estimate?" after={<Plate tone="pale" className="p-3 tab:p-5"><LifecyclePull /></Plate>}>
        <p>
          After inspecting the car, the shop confirms the final price in the app. If it lands within
          what you approved when you booked, no further approval of the price is needed. If it is above that,
          you have 24 hours to approve or decline. An estimate you leave unanswered for 24 hours
          expires, and the $20 deposit is kept to pay the shop for the inspection it already did. See <Link href="/pricing">how pricing works</Link>.
        </p>
      </Section>

      <Section id="far-out" title="Why might a far-out booking need a re-confirmed hold?">
        <p>
          Card holds expire after about 7 days. A booking made well ahead of the appointment can
          outlive its original authorization, so the shop may contact you to re-confirm it before the visit. Nothing extra is charged.
          The shop is warned a day before a hold is due to lapse, so you should hear before it does.
        </p>
      </Section>

      <Section id="table" title="Every situation, in one table">
        <p>What happens to the $20 hold, by situation, under the default policy:</p>
        <div className="overflow-x-auto">
          <table>
            <thead>
              <tr>
                <th scope="col">Situation</th>
                <th scope="col">What happens to the $20 hold</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>You cancel 24 hours or more before the appointment</td>
                <td>Released in full</td>
              </tr>
              <tr>
                <td>You cancel inside 24 hours</td>
                <td>Kept as the late-cancellation fee</td>
              </tr>
              <tr>
                <td>The shop marks you as a no-show</td>
                <td>Forfeited</td>
              </tr>
              <tr>
                <td>You reschedule 12 hours or more before (first two times)</td>
                <td>Carries over to the new time</td>
              </tr>
              <tr>
                <td>The shop cancels</td>
                <td>Released in full</td>
              </tr>
              <tr>
                <td>Your request goes unanswered (48 hours, or 2 hours past the slot)</td>
                <td>Released in full</td>
              </tr>
              <tr>
                <td>You leave the inspection estimate unanswered for 24 hours</td>
                <td>Forfeited, to pay the shop for the inspection</td>
              </tr>
              <tr>
                <td>The shop marks the job complete</td>
                <td>Applied to the confirmed price; the balance is charged then</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          The windows that apply to a specific booking are shown on that booking before you confirm
          and again when you cancel. If the app and this page ever differ, the app&rsquo;s numbers
          are the ones enforced. The <Link href="/terms">terms of service</Link> cover the rest of the
          relationship, and the <Link href="/warranty">warranty page</Link> covers what happens after
          the work is done.
        </p>
      </Section>

      <FaqSection items={FAQ} />
    </PageShell>
  );
}
