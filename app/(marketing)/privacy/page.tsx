import type { Metadata } from "next";
import { Fragment } from "react";
import Link from "next/link";
import PageShell, { Section, Summary, type TocItem } from "@/components/flagship/page-shell";
import { LEGAL_NAME, LOCALITY, SITE_NAME, SUPPORT_EMAIL } from "@/lib/site";

export const metadata: Metadata = {
  title: "Privacy policy",
  description:
    "What Otopair collects when you use the app or the shop dashboard, why, who it is shared with, and the choices you have.",
  alternates: { canonical: "/privacy" },
};

/**
 * Plain-language privacy policy, written against what the product actually
 * does (Clerk sign-in, Stripe Connect payments, Convex hosting, ElevenLabs
 * voice for Oto, Mapbox maps, Resend email, NHTSA VIN decoding). Keep it
 * true: if a processor is added or removed, this page changes in the same
 * PR. Not a substitute for counsel's review — see the session notes.
 */
const UPDATED = "2026-09-04";

const TOC: TocItem[] = [
  { id: "who", title: "Who is responsible for my data?" },
  { id: "collect", title: "What information does Otopair collect?" },
  { id: "use", title: "How is that information used?" },
  { id: "share", title: "Who is my information shared with?" },
  { id: "retain", title: "How long is it kept?" },
  { id: "choices", title: "What choices do I have?" },
  { id: "security", title: "How is it protected?" },
  { id: "children", title: "Can minors use Otopair?" },
  { id: "changes", title: "Will this policy change?" },
];

export default function PrivacyPage() {
  return (
    <PageShell
      title="What we collect, and why"
      lede={`This policy explains what ${SITE_NAME} collects when you use the driver app, the website, or the shop dashboard, how it is used, and the choices you have. It is written to be read, not skimmed past.`}
      updated={UPDATED}
      crumbs={[
        { name: "Home", href: "/" },
        { name: "Privacy policy", href: "/privacy" },
      ]}
      toc={TOC}
      numbered
    >
      <Summary
        items={[
          "We collect what a booking needs: who you are, your car, the problem, where you are, and how you pay.",
          "The shop you book sees your name, number, vehicle and the issue. Never your card.",
          "We do not sell personal information. De-identified repair data feeds our vehicle-data products.",
          "Card numbers never touch our servers. Payments run through Stripe.",
          <Fragment key="privacy-request">
            Ask for, fix or delete your data any time at{" "}
            <a href={`mailto:${SUPPORT_EMAIL}?subject=Privacy%20request`}>{SUPPORT_EMAIL}</a>.
          </Fragment>,
        ]}
      />
      <Section id="who" title="Who is responsible for my data?">
        <p>
          {LEGAL_NAME}, based in {LOCALITY.city}, {LOCALITY.region}, operates {SITE_NAME} and is the
          controller of the personal information described here. Questions about this policy go to{" "}
          <a href={`mailto:${SUPPORT_EMAIL}?subject=Privacy`}>{SUPPORT_EMAIL}</a>.
        </p>
      </Section>

      <Section id="collect" title="What information does Otopair collect?">
        <p>
          Otopair collects what it needs to book a repair and settle it: who you are, what car you
          have, what is wrong with it, where you are, and how you pay. Specifically:
        </p>
        <ul>
          <li>
            <strong>Account details.</strong> Name, email address and phone number when you sign up.
            Sign-in is handled by our authentication provider; we never see your password.
          </li>
          <li>
            <strong>Vehicle details.</strong> VIN, year, make, model, trim, mileage and any photos or
            service records you add. A VIN you enter is decoded against the public NHTSA database.
          </li>
          <li>
            <strong>What you tell Oto.</strong> The text and voice messages you send the in-app
            assistant, and the symptoms, chips and choices you pick. Voice is transcribed by a speech
            provider and the transcript is kept with your conversation.
          </li>
          <li>
            <strong>Location.</strong> Your approximate or precise location, only when you allow it,
            to show shops near you and distances to them.
          </li>
          <li>
            <strong>Bookings and payments.</strong> The jobs you book, the locked prices, approvals,
            receipts and payout records. Card details are entered directly with our payment processor;
            Otopair stores only a token and the last four digits.
          </li>
          <li>
            <strong>Messages with shops.</strong> Anything you and the shop send each other through the
            app.
          </li>
          <li>
            <strong>Device and usage data.</strong> Device type, app version, crash reports and how
            screens are used, so we can keep the app working.
          </li>
        </ul>
        <p>
          Shop owners and staff who use the dashboard give us business details as well: the shop
          name, address, hours, services, licences, team members and a Stripe Connect account for
          payouts.
        </p>
      </Section>

      <Section id="use" title="How is that information used?">
        <p>
          To run the service you asked for. That means matching you with shops, producing a quote,
          locking the price, holding the deposit, letting the shop see the job, processing payment,
          sending receipts and notifications, and helping when something goes wrong.
        </p>
        <p>We also use it to:</p>
        <ul>
          <li>keep Oto accurate, by reviewing conversations where it got a diagnosis or a price wrong;</li>
          <li>prevent fraud and abuse on both sides of the marketplace;</li>
          <li>meet legal and tax obligations, including payout reporting for shops;</li>
          <li>send service messages about your bookings, and marketing only if you opt in.</li>
        </ul>
      </Section>

      <Section id="share" title="Who is my information shared with?">
        <p>
          The shop you book sees what it needs to do the job: your name, contact number, vehicle,
          the issue you described and your booking history with that shop. It does not see your
          payment details.
        </p>
        <p>
          Otopair also relies on a small set of service providers who process data on our behalf
          and under contract: an authentication provider (sign-in), a payment processor (cards,
          deposits and shop payouts), a database and hosting provider, a speech provider for Oto&rsquo;s
          voice mode, a maps provider, and an email delivery provider. We share information with the
          authorities when the law requires it, and with a successor if Otopair is ever acquired.
        </p>
        <p>
          <strong>Otopair does not sell your personal information.</strong> Repair and service data
          that has been stripped of anything identifying you, your car or your shop may be combined
          with other records to build Otopair&rsquo;s aggregate vehicle-data products, such as typical
          service intervals and labor times for a given model.
        </p>
      </Section>

      <Section id="retain" title="How long is it kept?">
        <p>
          For as long as your account is open, plus whatever tax and payment rules require for
          booking and payout records. Oto conversations tied to a booking stay with that booking;
          conversations that never became a booking may be deleted after a period of inactivity.
          Asking to delete your account closes it and removes your profile and vehicle details from
          the app; records that tax and payment rules require are kept for as long as they require,
          detached from your profile. Deletion is handled as a request today rather than an automatic
          purge, so allow some time for it to complete.
        </p>
      </Section>

      <Section id="choices" title="What choices do I have?">
        <ul>
          <li>
            <strong>Access, correct or delete</strong> your information from the app&rsquo;s account
            settings, or by emailing{" "}
            <a href={`mailto:${SUPPORT_EMAIL}?subject=Privacy%20request`}>{SUPPORT_EMAIL}</a>.
          </li>
          <li>
            <strong>Location</strong> can be turned off in your device settings; you can still search
            by address.
          </li>
          <li>
            <strong>Voice</strong> is optional; Oto works fully in text.
          </li>
          <li>
            <strong>Marketing email</strong> has an unsubscribe link in every message. Booking and
            receipt messages are part of the service and continue while you have an account.
          </li>
        </ul>
        <p>
          New York residents and residents of states with consumer privacy laws can exercise those
          rights through the same address. We will confirm your identity before acting on a request
          and will not treat you differently for making one.
        </p>
      </Section>

      <Section id="security" title="How is it protected?">
        <p>
          Data is encrypted in transit, stored with our cloud database provider, and access inside
          Otopair is limited to people who need it to do their job and logged when staff act on it.
          Payment card data never touches our servers. No system is perfect; if a breach affects you,
          we will tell you and the relevant authorities as the law requires. The{" "}
          <Link href="/security">security page</Link> lists exactly what is in place and what is not
          yet.
        </p>
      </Section>

      <Section id="children" title="Can minors use Otopair?">
        <p>
          No. Otopair is for people 18 and over who can book and pay for vehicle service. We do not
          knowingly collect information from anyone under 18, and we delete it if we learn we have.
        </p>
      </Section>

      <Section id="changes" title="Will this policy change?">
        <p>
          When it does, the date at the top changes and, for anything material, we notify you in
          the app or by email before it takes effect. Continued use after that date means the updated
          policy applies. The <Link href="/terms">terms of service</Link> cover the rest of the
          relationship.
        </p>
      </Section>
    </PageShell>
  );
}
