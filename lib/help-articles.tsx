import type { ReactNode } from "react";
import Link from "next/link";

/**
 * Static help articles for /help and /help/<slug> — audit Tier 4, "long-tail
 * question capture". There is no help-center table or CMS in the backend
 * (kb_topics is Oto's vehicle-spec knowledge base, not a help center), so
 * the articles live here as typed TSX and the routes render them.
 *
 * Every claim is written against what the product enforces today:
 *   - $20 hold            convex/lib/payment_constants.ts BOOKING_DEPOSIT_CENTS
 *   - approvals + 24h SLA convex/booking_approvals.ts SLA_MS
 *   - cancellation        convex/lib/cancellation_policy.ts POLICY_DEFAULTS
 *   - disputes, 14 days   convex/booking_disputes.ts DISPUTE_WINDOW_MS
 *   - shop messages       convex/lib/shopTicketConstants.ts
 *   - check-in, 90 days   convex/checkin.ts next_checkin_due
 *   - warning lights      lib/warningLightVocab.ts CANONICAL_WARNING_LIGHTS
 *   - tire quotes         convex/tire_quote_responses.ts
 *   - VIN decode          app/api/vin/[vin]/route.ts (NHTSA vPIC)
 *
 * House rules (locked, 2026-08/09): no fee rate, no price ranges or
 * averages, no vendor names, no rewards amounts or expiry (constants are
 * unreconciled — there is deliberately no rewards article), no payout
 * timing beyond "Stripe's schedule". Summaries are 40–60 words and answer
 * the title on their own (audit §5.2/5.3); they double as the meta
 * description and the FAQPage answer on the article page, so keep them
 * plain strings.
 */

export type HelpCategory = "Booking" | "Paying" | "Your car" | "Oto" | "Account & support";

export type HelpArticle = {
  slug: string;
  /** Question-shaped. */
  title: string;
  /** 40–60 words, answer-first. Doubles as meta description + FAQ answer. */
  summary: string;
  category: HelpCategory;
  /** ISO date, rendered as "Last updated". */
  updated: string;
  body: ReactNode;
  /** Slugs of related articles, rendered under the body. */
  related: string[];
};

/** Category order on the hub. Categories with no articles are not rendered. */
export const HELP_CATEGORIES: readonly HelpCategory[] = [
  "Booking",
  "Paying",
  "Your car",
  "Oto",
  "Account & support",
];

export const HELP_CATEGORY_META: Record<HelpCategory, { id: string; blurb: string }> = {
  Booking: {
    id: "booking",
    blurb: "Cancelling, rescheduling, messaging the shop, and how tire quotes work.",
  },
  Paying: {
    id: "paying",
    blurb: "The $20 hold, what the locked price covers, approving extra work, and disputes.",
  },
  "Your car": {
    id: "your-car",
    blurb: "The health score, the quarterly check-in, warning lights, and adding a car by VIN.",
  },
  Oto: {
    id: "oto",
    blurb: "What the assistant in the app can and cannot do.",
  },
  "Account & support": {
    id: "account-support",
    blurb: "How to reach a person, and which address is for what.",
  },
};

const UPDATED = "2026-09-04";

export const HELP_ARTICLES: readonly HelpArticle[] = [
  // ---------------------------------------------------------------- Paying
  {
    slug: "how-the-20-dollar-hold-works",
    title: "How does the $20 hold work?",
    summary:
      "When you confirm a booking, Otopair places a $20 hold on your card. Nothing is charged at that point, and it is the most ever blocked before the shop has inspected the car. After inspection the hold is raised to the confirmed price, and it is only captured when the shop marks the job complete.",
    category: "Paying",
    updated: UPDATED,
    related: ["what-locked-price-means", "approving-extra-work", "cancelling-or-rescheduling"],
    body: (
      <>
        <p>
          A hold is an authorization, not a payment. Your bank sets the amount aside so it is
          available later, but no money moves when you book. The $20 is a fixed amount, the same
          for every booking and every shop, and it is the ceiling on what can be blocked before a
          mechanic has looked at the car.
        </p>
        <h3>What happens to the hold, step by step</h3>
        <ol>
          <li>
            <strong>You confirm the booking.</strong> The $20 hold is placed on the card or wallet
            you chose.
          </li>
          <li>
            <strong>The shop inspects the car and confirms the price.</strong> The hold is raised
            to that price. If the price lands within what you approved when you booked, that
            happens without another tap; if it is above, the app asks you to approve it first.
          </li>
          <li>
            <strong>The shop marks the job complete.</strong> The hold is captured for the
            confirmed price. That is the only moment a completed job is charged.
          </li>
        </ol>
        <p>
          If you paid with a wallet such as Apple Pay or Google Pay, the app may ask you to
          re-confirm the hold when it is raised; a saved card is re-authorized without an extra
          step. A booking made well ahead of the appointment can outlive its original
          authorization, in which case you may be asked to re-confirm the same $20 hold before the
          visit.
        </p>
        <h3>When the hold is kept instead</h3>
        <p>
          Before the inspection, any late-cancellation or no-show fee is capped at the hold: it is
          never more than $20, and nothing beyond it is charged. An inspection estimate you leave
          unanswered for 24 hours is treated as declined, and the $20 is kept to pay the shop for
          the inspection it already did. If the shop cancels, or never accepts your request, the
          hold is released in full. The <Link href="/cancellation-policy">cancellation policy</Link> has
          every case in one table.
        </p>
      </>
    ),
  },
  {
    slug: "what-locked-price-means",
    title: "What does “locked price” mean?",
    summary:
      "The total you approve before you confirm the booking is the ceiling. It is built for your exact car and includes parts, labor, tax and Otopair's service fee. After inspecting the car, the shop confirms the final price; anything above what you approved needs your approval in the app, and you have 24 hours to answer.",
    category: "Paying",
    updated: UPDATED,
    related: ["how-the-20-dollar-hold-works", "approving-extra-work", "tire-replacement-quotes"],
    body: (
      <>
        <p>
          &ldquo;Locked&rdquo; means the shop cannot charge more than the figure you approved
          without asking you first, in the app, and getting a yes. It does not mean a number pulled
          from a price list: every total on Otopair is built in the app for the car you added and
          the shop you picked.
        </p>
        <h3>What is inside the total</h3>
        <ul>
          <li>Parts, chosen for your exact year, make, model and engine.</li>
          <li>Labor, at the rate the shop set. Shops set their own prices on Otopair, and some list a flat price for a service.</li>
          <li>Sales tax.</li>
          <li>Otopair&rsquo;s service fee, which is inside the figure you see rather than added on top at checkout.</li>
        </ul>
        <p>
          The shop confirms its final price without seeing the figure you approved, so there is
          nothing for it to anchor to.
        </p>
        <h3>What happens after the inspection</h3>
        <p>
          The shop inspects the car and confirms the final price in the app. Within what you
          approved, it is confirmed without another tap and the $20 hold is raised to it. Above what
          you approved, you get an approval request with the breakdown and 24 hours to answer. A
          pre-job estimate left unanswered is treated as declined and the $20 deposit is kept; see{" "}
          <Link href="/help/approving-extra-work">approving or declining extra work</Link>.
        </p>
        <p>
          Otopair does not publish price lists, ranges or averages, and Oto will not quote a number
          in chat either. The real total appears when you pick a shop, before you pay.
        </p>
      </>
    ),
  },
  {
    slug: "approving-extra-work",
    title: "How do I approve or decline extra work?",
    summary:
      "From the booking in the app. A shop can ask for approval before the job starts (the inspection estimate) or mid-job (added work). Decline mid-job work and it is removed and never charged. Each request stays open for 24 hours; a pre-job estimate left unanswered is treated as declined, and the $20 deposit is kept.",
    category: "Paying",
    updated: UPDATED,
    related: ["what-locked-price-means", "how-the-20-dollar-hold-works", "messaging-your-shop"],
    body: (
      <>
        <p>
          There are two moments a shop can ask you for approval, and both arrive as a request on
          the booking in the app with the mechanic&rsquo;s price, a breakdown, notes and any photos of
          what they found. Only one request can be open at a time, and the shop can withdraw one it
          sent by mistake.
        </p>
        <h3>Before the job: the inspection estimate</h3>
        <p>
          After inspecting the car, the shop confirms the price. If it lands within what you
          approved when you booked, it is confirmed automatically. If it is above, you get a
          request. Approve it and the work goes ahead at the new figure, which becomes the ceiling.
          Decline it and the shop does not start the work at that price; what happens to the $20
          hold then depends on how the booking is closed. A cancellation made by the shop releases it
          in full; if you cancel, the windows shown on the booking apply. Leave the request
          unanswered for 24 hours and it is treated as declined, and the $20 deposit is kept to pay
          the shop for the inspection it did.
        </p>
        <h3>Mid-job: added work</h3>
        <p>
          If the mechanic finds something else once the work is under way, the shop sends a request
          listing the added lines. Approve it and the lines are added to the job and the ceiling
          rises to match. Decline it and the added lines are removed from the booking; they are
          never charged. If a mid-job request goes unanswered for 24 hours, the job simply continues
          at the last price you approved and the added work is not charged.
        </p>
        <h3>After the job</h3>
        <p>
          Once the job is done, the amount charged cannot exceed the ceiling you last approved. If
          something on the final receipt looks wrong, you have 14 days from the final charge to{" "}
          <Link href="/help/disputes-and-refunds">open a dispute</Link>.
        </p>
      </>
    ),
  },
  {
    slug: "disputes-and-refunds",
    title: "How do disputes and refunds work?",
    summary:
      "You can open a dispute from the booking within 14 days of the final charge. Otopair reviews the job record, the approvals and the messages, and resolves it as no refund, a partial refund or a full refund. A refund is issued by the shop through Otopair to the card you paid with, not automatically.",
    category: "Paying",
    updated: UPDATED,
    related: ["approving-extra-work", "messaging-your-shop", "contacting-support"],
    body: (
      <>
        <h3>When you can file</h3>
        <p>
          Within 14 days of the final charge, once the final amount has actually been charged; a
          booking can have one open dispute at a time. For a problem right after pickup, message the
          shop first from the booking (there is a quick action for it); a dispute is the formal step
          when that does not resolve it.
        </p>
        <h3>What you can dispute</h3>
        <ul>
          <li>The wrong part was fitted.</li>
          <li>You were overcharged against what you approved.</li>
          <li>Work you paid for was not done.</li>
          <li>Work you declined was charged anyway.</li>
          <li>A concern about the quality of the work.</li>
          <li>Something else, with your own description.</li>
        </ul>
        <h3>What happens next</h3>
        <p>
          Otopair reviews the job record: the price you approved, every approval request and your
          answer to it, the messages between you and the shop, and the itemized receipt. The dispute
          is resolved as no refund, a partial refund, or a full refund. It is a review, not an
          automatic reversal, and a person decides it.
        </p>
        <h3>How a refund reaches you</h3>
        <p>
          A refund is issued by the shop through Otopair, back to the card you paid with, in full or
          in part. If you paid a shop in cash for a walk-in job, there is nothing to reverse on a
          card and the refund is handled in person at the shop. If you take a charge up with your
          card issuer instead, that follows the card network&rsquo;s process, not this one.
        </p>
        <p>
          Otopair does not warrant repairs; any parts or labor warranty is the shop&rsquo;s own. The{" "}
          <Link href="/warranty">warranty page</Link> explains who stands behind the work after the
          dispute window closes.
        </p>
      </>
    ),
  },

  // --------------------------------------------------------------- Booking
  {
    slug: "cancelling-or-rescheduling",
    title: "Can I cancel or reschedule a booking?",
    summary:
      "Yes, from the booking in the app. By default, cancelling is free up to 24 hours before the appointment; inside 24 hours the $20 hold is kept. You can reschedule free up to 12 hours before, up to 2 times. The exact windows for your booking are shown on the booking itself before you confirm.",
    category: "Booking",
    updated: UPDATED,
    related: ["how-the-20-dollar-hold-works", "messaging-your-shop", "disputes-and-refunds"],
    body: (
      <>
        <h3>Cancelling</h3>
        <p>
          Cancel from the booking any time up to 24 hours before the appointment and the $20 hold is
          released in full. Inside 24 hours the hold is kept as a late-cancellation fee; it is capped
          at the hold, so it is never more than $20. The booking screen tells you whether cancelling
          right now is free and, if not, exactly what the fee would be before you confirm. If you do
          not arrive, the shop may mark you as a no-show, which forfeits the hold.
        </p>
        <h3>Rescheduling</h3>
        <p>
          You can move a booking for free up to 12 hours before the appointment, up to 2 times per
          booking; the $20 hold carries over to the new time. A reschedule goes back to the shop to
          re-confirm the new slot. Inside 12 hours, or after your second reschedule, the app asks you
          to message the shop, which can move the appointment from its side.
        </p>
        <h3>Once the car is at the shop</h3>
        <p>
          Cancelling becomes a request rather than a button. Ask for pickup through the booking; the
          front desk and the mechanic are notified, and the shop brings the car out and settles
          anything owed for work already done. Work that is in progress cannot be cancelled from the
          app.
        </p>
        <h3>If the shop cancels or never answers</h3>
        <p>
          The hold is released in full. A request the shop never accepts expires on its own and the
          app invites you to rebook. One more case to know: an inspection estimate you leave
          unanswered for 24 hours is treated as declined and the deposit is kept. The{" "}
          <Link href="/cancellation-policy">cancellation policy</Link> lists every situation in one table.
        </p>
      </>
    ),
  },
  {
    slug: "messaging-your-shop",
    title: "How do I message my shop?",
    summary:
      "From the booking. Every conversation with a shop is attached to a specific booking, so the shop sees which car and job you mean. Quick actions change with the booking's stage: running late, reschedule or cancel before the visit; status and adding a service while the car is there; approvals and pickup, invoice or post-service questions after.",
    category: "Booking",
    updated: UPDATED,
    related: ["cancelling-or-rescheduling", "approving-extra-work", "disputes-and-refunds"],
    body: (
      <>
        <p>
          Open the booking and tap <strong>Message shop</strong>. Messages are scoped to that
          booking, so the shop&rsquo;s team answers with your car and your job in front of them, and
          the thread stays on the booking for the record.
        </p>
        <h3>Quick actions, by stage</h3>
        <ul>
          <li>
            <strong>Confirmed, before the visit:</strong> Running late; Reschedule request; Cancel /
            pick up.
          </li>
          <li>
            <strong>Car at the shop:</strong> Status check; Add a service.
          </li>
          <li>
            <strong>Work in progress:</strong> When will it be ready?; Approve extra work; Question
            about the work.
          </li>
          <li>
            <strong>Completed:</strong> Pickup arrangement; Invoice question; Issue after service.
          </li>
          <li>
            <strong>Any time:</strong> a free-text message.
          </li>
        </ul>
        <p>
          A quick action starts the thread with the right subject so the shop can act on it without
          a back-and-forth. The shop replies from its dashboard; the thread shows when the shop has
          responded and when it is resolved, and a new message from you reopens it. Updates about the
          booking itself, such as the car arriving or the job completing, appear in the app on the
          booking.
        </p>
        <p>
          The shop&rsquo;s team is who answers here. Oto, the assistant in the app, is separate: it
          can bring you to the booking, but there is no live human on the other end of the Oto chat,
          and it cannot message a shop for you. For a formal complaint after the job, see{" "}
          <Link href="/help/disputes-and-refunds">disputes and refunds</Link>.
        </p>
      </>
    ),
  },
  {
    slug: "tire-replacement-quotes",
    title: "How do tire replacement quotes work?",
    summary:
      "Tire replacement is booked as a quote request rather than a fixed menu item. You post the request for your car; shops respond with the tire brand and model, a per-tire price, quantity, labor, the total and an appointment slot they can offer. You compare the responses and accept one, and that shop gets the booking.",
    category: "Booking",
    updated: UPDATED,
    related: ["what-locked-price-means", "how-the-20-dollar-hold-works", "messaging-your-shop"],
    body: (
      <>
        <p>
          Tires are the one service where the part is the whole conversation: brand, model, size and
          specification vary more than any other line on a job. So instead of a single built total,
          tire replacement collects quotes from shops for the exact tire they would fit.
        </p>
        <ol>
          <li>
            <strong>Post the request.</strong> The app already knows your car&rsquo;s tire size from
            its profile.
          </li>
          <li>
            <strong>Shops respond.</strong> Each response lists the tire brand and model, the price
            per tire, how many, labor, the total, and a date and time the shop can offer.
          </li>
          <li>
            <strong>Accept one.</strong> The booking goes to that shop at that slot, and the other
            responses are set aside.
          </li>
        </ol>
        <p>
          Until you accept, the request is at the quote stage and you can cancel it for free. Once
          you accept, it is a normal booking: the total you accepted is the figure you approved, and
          the usual $20 hold and approval rules apply.
        </p>
        <p>
          Otopair does not publish tire prices or recommend brands on the website, and Oto will not
          quote a tire price in chat; the quotes come from the shops, for your car. After the job,
          the shop can record the tires it fitted on your car&rsquo;s record.
        </p>
      </>
    ),
  },

  // -------------------------------------------------------------- Your car
  {
    slug: "vehicle-health-score-explained",
    title: "What is the Vehicle Health Score?",
    summary:
      "A single score for your car's upkeep, built from the maintenance items the app tracks: oil, brakes, tires and the 12-volt battery, plus state inspection when it is on file. It is not a whole-car check. Warning lights and open mechanic findings lower it; completed services and shop inspections update the items they touch.",
    category: "Your car",
    updated: UPDATED,
    related: ["quarterly-check-in", "warning-lights-the-app-recognizes", "adding-a-car-by-vin"],
    body: (
      <>
        <p>
          The score tracks a short list of systems: engine oil, brakes, tires and the 12-volt starter
          battery, plus the state inspection when a record of it exists. Each item is graded on time,
          due soon, needs attention or overdue, from the service intervals for your car and the
          mileage you report.
        </p>
        <p>
          It does not track a hybrid or EV drive battery, the transmission, suspension, air
          conditioning or anything else. Where the app has no record of something, it treats it as
          unchecked, not as healthy.
        </p>
        <h3>What moves it</h3>
        <ul>
          <li>An active dashboard warning light lowers it while the light is on.</li>
          <li>
            An open recommendation from a mechanic lowers it gradually, phased in over time so the
            score never drops suddenly.
          </li>
          <li>
            A shop&rsquo;s inspection updates the items it measured shortly after the visit closes.
            A problem fixed during the same visit never lowers the score.
          </li>
          <li> Answering the quarterly check-in keeps the score current.
          </li>
        </ul>
        <p>
          Health Points in the app do not change the score, and no connected-car or telematics data
          is used; the app only knows what you and the shops tell it. The{" "}
          <Link href="/vehicle-health-score">Vehicle Health Score page</Link> has the full formula.
        </p>
      </>
    ),
  },
  {
    slug: "quarterly-check-in",
    title: "What is the quarterly check-in?",
    summary:
      "A short set of questions the app asks about every 90 days: your current mileage, any service done elsewhere, any warning lights, and anything unusual. It is optional. Answering keeps your health score current instead of estimated.",
    category: "Your car",
    updated: UPDATED,
    related: ["vehicle-health-score-explained", "warning-lights-the-app-recognizes"],
    body: (
      <>
        <p>
          Service intervals depend on mileage, and the app has no way to read your odometer, so it
          asks. The check-in appears in the app when it is due.
        </p>
        <h3>What it asks</h3>
        <ul>
          <li>Your current mileage.</li>
          <li>Any service done outside Otopair since the last check-in.</li>
          <li>Any dashboard warning lights on right now.</li>
          <li>Anything unusual you have noticed.</li>
        </ul>
        <h3>What your answers do</h3>
        <p>
          The mileage refreshes when each item comes due. Items you confirm are treated as confirmed
          until the next check-in, 90 days later. Warning lights you report are logged against the
          car. Your answers are self-reported; a record from a shop is what makes an item verified.
        </p>
        <p>
          If you skip it, nothing is charged or lost; the score just leans on older information until you answer. See{" "}
          <Link href="/help/vehicle-health-score-explained">how the health score works</Link>.
        </p>
      </>
    ),
  },
  {
    slug: "warning-lights-the-app-recognizes",
    title: "Which dashboard warning lights does the app recognize?",
    summary:
      "Nine: oil pressure, battery or charging, engine temperature, ABS or brake, tire pressure (TPMS), airbag (SRS), transmission, check engine, and a “not sure which” option for a light you can't identify. You can log them during onboarding, at the quarterly check-in, or by telling Oto; a shop's inspection can add or clear them.",
    category: "Your car",
    updated: UPDATED,
    related: ["vehicle-health-score-explained", "quarterly-check-in"],
    body: (
      <>
        <p>
          When you report one of these lights, the app leads with the safe first step before
          anything else. These are stop-or-drive calls, not a diagnosis; the shop confirms the cause.
        </p>
        <ul>
          <li>
            <strong>Oil pressure.</strong> Pull over as soon as it is safe and shut the engine off;
            do not drive it any further.
          </li>
          <li>
            <strong>Engine temperature.</strong> Pull over, shut the engine off, and do not open the
            radiator cap or coolant tank.
          </li>
          <li>
            <strong>Transmission.</strong> Stop driving and have the car towed rather than driving
            it in.
          </li>
          <li>
            <strong>Battery / charging.</strong> Drive straight to a shop if one is close, and do not
            shut the engine off until you are there.
          </li>
          <li>
            <strong>ABS / brake.</strong> Red means treat the car as unsafe to drive: stop and have it
            towed. Amber means normal braking still works and only the anti-lock assist is off; get
            it looked at now.
          </li>
          <li>
            <strong>Airbag (SRS).</strong> The car drives normally; book it, and assume the airbags
            may not deploy until it is fixed.
          </li>
          <li>
            <strong>Check engine.</strong> Flashing means stop driving and tow it. Steady means the
            car is safe to drive; book a scan so the fault can be read.
          </li>
          <li>
            <strong>Tire pressure (TPMS).</strong> Drive to the nearest air pump; stop sooner if the
            car pulls, vibrates or a tire looks flat.
          </li>
          <li>
            <strong>Not sure which.</strong> Tell Oto the colour and shape and it will identify the
            light.
          </li>
        </ul>
        <h3>Where lights come from, and go</h3>
        <p>
          A light can be logged when you add the car, at the quarterly check-in, or by telling Oto
          (it shows a card you confirm before anything is written). A shop&rsquo;s inspection can add a
          light the mechanic saw, and after a visit the app asks whether a light is still on and
          clears it if not. Oto cannot read a photo of your dashboard, so describe the light in
          words.
        </p>
        <p>
          An active light reduces the warning-light part of your{" "}
          <Link href="/help/vehicle-health-score-explained">health score</Link> while it is on; the oil
          pressure and temperature lights cost the most.
        </p>
      </>
    ),
  },
  {
    slug: "adding-a-car-by-vin",
    title: "How do I add a car by VIN?",
    summary:
      "Enter the VIN and the app decodes it against the public NHTSA vehicle database to fill in the year, make, model, trim and engine. That decoded profile is what Oto, the health score and every quote are built on, so an exact identification matters.",
    category: "Your car",
    updated: UPDATED,
    related: ["vehicle-health-score-explained", "quarterly-check-in"],
    body: (
      <>
        <p>
          The VIN is on the driver&rsquo;s side of the dashboard, visible through the windshield, on
          the door-jamb sticker, and on your registration and insurance card. Type it in and the app
          looks it up in the public NHTSA database, which returns the year, make, model, trim, engine
          and body style.
        </p>
        <p>
          If a VIN will not decode, check for a mistyped character: VINs never contain the letters
          I, O or Q, which are easy to confuse with digits.
        </p>
        <h3>What the VIN is used for</h3>
        <p>
          Parts, service intervals and the health score are all specific to the engine and trim, so
          the decoded profile is what every quote and recommendation starts from. Otopair also keeps
          a per-VIN record of what shops have physically confirmed about the car, such as mileage,
          tires, fluids, brakes and inspection status, with the date of the last shop confirmation.
          That record travels with the car, not with the owner.
        </p>
        <p>
          If an Otopair shop has already serviced the car as a walk-in, the shop may have sent you a
          claim link by text or email; claiming it attaches those records to your account. If you
          decoded a VIN with Oto on the website and left your email, the car is attached
          automatically when you sign up with the same address. What is stored, and why, is on the{" "}
          <Link href="/privacy">privacy page</Link>.
        </p>
      </>
    ),
  },

  // ----------------------------------------------------- Account & support
  {
    slug: "contacting-support",
    title: "How do I contact Otopair support?",
    summary:
      "Email support@otopair.com for anything about a booking, a job, your account, or something Oto got wrong; a person reads every message. Use data@otopair.com for the car-data API, privacy@otopair.com for privacy requests, and legal@otopair.com for the terms. Problems with a specific booking go to the shop first, through the booking's message thread.",
    category: "Account & support",
    updated: UPDATED,
    related: ["messaging-your-shop", "disputes-and-refunds"],
    body: (
      <>
        <h3>Which address</h3>
        <ul>
          <li>
            <strong>
              <a href="mailto:support@otopair.com?subject=Driver%20support">support@otopair.com</a>
            </strong>{" "}
            for drivers: booking questions, a problem with a job, your account, or something Oto got
            wrong. Press, partnership and accessibility messages go here too, with the topic in the
            subject line.
          </li>
          <li>
            <strong>
              <a href="mailto:data@otopair.com?subject=Data%20API%20access">data@otopair.com</a>
            </strong>{" "}
            for the car-data API: access, keys and reports.
          </li>
          <li>
            <strong>
              <a href="mailto:privacy@otopair.com?subject=Privacy%20request">privacy@otopair.com</a>
            </strong>{" "}
            for privacy questions and requests to access, correct or delete your data.
          </li>
          <li>
            <strong>
              <a href="mailto:legal@otopair.com?subject=Terms">legal@otopair.com</a>
            </strong>{" "}
            for questions about the terms of service.
          </li>
        </ul>
        <p>
          There is no public phone line yet; email is the channel. Otopair is based in Staten
          Island, NY.
        </p>
        <h3>In the app</h3>
        <p>
          For anything about a specific booking, message the shop from the booking first; the
          shop&rsquo;s team answers with the job in front of them. A dispute about a completed job is
          opened from the booking within 14 days of the final charge. The feedback form in the app
          also reaches the support inbox, and a thumbs up or down on an Oto reply is read by the
          team that maintains it.
        </p>
        <p>
          Oto can take you to the support and feedback screens but cannot file a ticket or a dispute
          for you. Rewards, including how credits are earned, applied and when they expire, are
          explained on the rewards screen in the app.
        </p>
      </>
    ),
  },
];

export const HELP_SLUGS: readonly string[] = HELP_ARTICLES.map((a) => a.slug);

const BY_SLUG = new Map<string, HelpArticle>(HELP_ARTICLES.map((a) => [a.slug, a]));

export function helpBySlug(slug: string): HelpArticle | undefined {
  return BY_SLUG.get(slug);
}

export function helpByCategory(category: HelpCategory): HelpArticle[] {
  return HELP_ARTICLES.filter((a) => a.category === category);
}
