import type { Metadata } from "next";
import Link from "next/link";
import PageShell, { Section, Summary, type TocItem } from "@/components/flagship/page-shell";
import { FaqSection } from "@/components/seo/faq";
import { SITE_NAME, SUPPORT_EMAIL } from "@/lib/site";

export const metadata: Metadata = {
  title: "Security",
  description:
    "How Otopair protects accounts, payments and data: Clerk sign-in, authenticator codes for staff, Stripe for every card, hashed keys, an audit trail, and what it does not claim yet.",
  alternates: { canonical: "/security" },
};

/**
 * /security — audit Tier 4. Only claims the codebase backs: Clerk for
 * driver and shop sign-in (middleware.ts, Convex auth config); staff
 * consoles on email + TOTP with an 8-hour session, a generic login error
 * and failed attempts written to audit_log (convex/director_auth.ts);
 * Stripe holds every card number, Otopair stores brand + last four
 * (convex/payments_stripe.ts, schema payments.card_brand/card_last4);
 * Stripe Connect Express with Stripe-run identity/bank verification
 * (app/api/stripe/connect/start/route.ts); Stripe, Clerk and Telnyx
 * webhooks signature-verified (convex/http.ts, app/api/webhooks/clerk,
 * convex/lib/telnyx_webhook.ts); API keys and invite links stored as
 * SHA-256 hashes, keys shown once, scoped and rate-limited per key
 * (convex/dataApi.ts, app/api/applications/approve/route.ts); the
 * audit_log table (convex/schema.ts); receipt links as capability tokens
 * (convex/invoices.ts). "What we don't claim yet" is deliberate: no
 * attestations, some internal tools still being brought under the same
 * session checks, and deletion as a request rather than an automated purge
 * (convex/crons.ts, cleanup job disabled). Do not add "encrypted at rest"
 * or "every admin action requires 2FA" until the code says so.
 */
const UPDATED = "2026-09-04";

const TOC: TocItem[] = [
  { id: "signin", title: "How do I sign in?" },
  { id: "staff", title: "How are staff consoles protected?" },
  { id: "payments", title: "How are payments handled?" },
  { id: "keys", title: "How are integrations and API keys secured?" },
  { id: "audit", title: "What is written to the audit trail?" },
  { id: "data", title: "How is data protected in transit and in storage?" },
  { id: "receipts", title: "Why is my receipt link private?" },
  { id: "report", title: "How do I report a vulnerability?" },
  { id: "not-yet", title: "What we don't claim yet" },
  { id: "faq", title: "Questions people ask" },
];

const FAQ = [
  {
    q: "Does Otopair store my card number?",
    a: "No. Card details are entered directly with Stripe, from the app's payment sheet, and never pass through Otopair's servers. Otopair stores the card brand and the last four digits so your receipt can show which card was used, plus Stripe's own identifiers for the payment.",
  },
  {
    q: "Is Otopair SOC 2 or PCI certified?",
    a: "Otopair has not published a SOC 2, ISO 27001 or PCI attestation. Card handling is delegated to Stripe, which holds its own PCI certification; Otopair never touches card numbers. This page lists what is built rather than claiming a certificate that does not exist yet.",
  },
  {
    q: "Can Otopair staff see my password?",
    a: "No. Sign-in is handled by Clerk, a dedicated authentication provider. Otopair receives a signed token that says who you are; it never receives or stores your password.",
  },
  {
    q: "What happens if I delete my account?",
    a: "Today deletion is a request. Your account is flagged for deletion and closed. Removing your profile and vehicle details, and detaching your identity from the transaction records that tax and payment rules require Otopair to keep, is done by the team rather than on an automated schedule. The privacy policy explains how to make the request.",
  },
  {
    q: "How do I report a security issue?",
    a: `Email ${SUPPORT_EMAIL} with 'Security' in the subject line and as much detail as you can share safely. Otopair acknowledges the report, fixes confirmed issues, and credits the reporter if they would like to be named. Please do not test against other people's accounts or data.`,
  },
];

export default function SecurityPage() {
  return (
    <PageShell
      title="What protects your account, your card and your data"
      lede={`This page lists what ${SITE_NAME} has built to keep accounts, payments and data safe, in specific terms, and ends with what it does not claim yet. Nothing here is a promise the code does not keep.`}
      updated={UPDATED}
      crumbs={[
        { name: "Home", href: "/" },
        { name: "Security", href: "/security" },
      ]}
      toc={TOC}
      numbered
    >
      <Summary
        items={[
          "Drivers and shops sign in through Clerk; Otopair never sees a password.",
          "Staff consoles need an email plus an authenticator-app code, and sessions end after 8 hours.",
          "Card numbers never reach Otopair. Stripe holds them; Otopair keeps the brand and last four digits.",
          "Webhooks from Stripe, Clerk and the SMS provider are signature-verified; API keys and invite links are stored only as SHA-256 hashes.",
          "Admin actions are written to an audit log, data travels over TLS, and this page says plainly what is not claimed yet.",
        ]}
      />

      <Section id="signin" title="How do I sign in?">
        <p>
          Through Clerk, a dedicated authentication provider, whether you are a driver in the app or a
          shop owner or staff member on the web dashboard. Clerk handles your credentials and issues a
          signed token; {SITE_NAME}&rsquo;s backend verifies that token itself rather than trusting
          the app, and never receives or stores your password. Your role, such as driver, shop owner
          or mechanic, travels on that token.
        </p>
      </Section>

      <Section id="staff" title="How are staff consoles protected?">
        <p>
          With two factors and short sessions. {SITE_NAME}&rsquo;s internal consoles, where the team
          reviews shop applications and licence documents, are separate from the driver and shop
          sign-in. Staff log in with their email and a six-digit code from an authenticator app; the
          session that creates expires after 8 hours and then requires a fresh code.
        </p>
        <ul>
          <li>
            <strong>Generic errors.</strong> A wrong email and a wrong code produce the same message,
            so the login screen cannot be used to discover which emails belong to staff.
          </li>
          <li>
            <strong>Failed attempts are logged.</strong> Every failed login is written to the audit
            log alongside successful logins and logouts.
          </li>
          <li>
            <strong>Roles limit what a session can do.</strong> Managing shops, money, data and staff
            accounts are separate capabilities; a session only has the ones its role grants.
          </li>
        </ul>
      </Section>

      <Section id="payments" title="How are payments handled?">
        <p>
          By Stripe, end to end. Your card is entered in Stripe&rsquo;s own payment sheet inside the
          app; the number never reaches {SITE_NAME}&rsquo;s servers. {SITE_NAME} stores the card brand
          and the last four digits, for your receipt, and Stripe&rsquo;s identifiers for the hold and
          the charge. Apple Pay and Google Pay go through the same path.
        </p>
        <p>
          Shops are paid through Stripe Connect Express accounts. Stripe, not {SITE_NAME}, verifies
          each shop&rsquo;s business identity and payout bank details; {SITE_NAME} stores only
          Stripe&rsquo;s report of whether charges and payouts are enabled and whether anything is
          outstanding. A shop cannot take bookings until that report is clean. How the hold, the
          capture and refunds work is on <Link href="/trust-and-safety">trust and safety</Link>.
        </p>
      </Section>

      <Section id="keys" title="How are integrations and API keys secured?">
        <p>
          Every message that arrives from a partner service is checked for a valid signature before
          it is trusted. Stripe payment and payout events, Clerk account events and delivery events
          from the SMS provider are each verified against that provider&rsquo;s signing key, and
          unsigned or mis-signed messages are rejected; the SMS provider&rsquo;s events additionally
          carry a timestamp and are refused if they are more than five minutes old.
        </p>
        <ul>
          <li>
            <strong>API keys are stored as hashes.</strong> A key for the{" "}
            <Link href="/developers">vehicle-data API</Link> is shown once, when it is created.{" "}
            {SITE_NAME} keeps only its SHA-256 hash and a short display prefix, so a copy of the
            database does not contain a usable key.
          </li>
          <li>
            <strong>Keys are scoped and rate-limited.</strong> Each key carries the scopes it may use,
            such as maintenance data or labor data, and its own requests-per-minute limit. Every
            request is metered, and a key can be revoked at any time.
          </li>
          <li>
            <strong>Shop invite links are stored the same way.</strong> The private link an approved
            shop owner receives is single-use and expires in 7 days; {SITE_NAME} stores only its
            SHA-256 hash.
          </li>
        </ul>
      </Section>

      <Section id="audit" title="What is written to the audit trail?">
        <p>
          Staff actions that change who is on the platform and what they can do. The audit log
          records: staff logins, logouts and failed logins; shop applications approved or declined;
          licence documents marked verified or rejected, with the reason; shops activated or
          deactivated; the Verified badge granted or removed, with the reason; edits to a shop&rsquo;s
          details; changes to the vehicle health score weights; staff accounts added, removed or
          changed; and API keys created or revoked.
        </p>
        <p>
          Each entry carries who acted, what changed, the reason where one is required, and when.
          Reading the log requires a staff session.
        </p>
      </Section>

      <Section id="data" title="How is data protected in transit and in storage?">
        <p>
          In transit, everything travels over TLS: between the app or website and {SITE_NAME}&rsquo;s
          backend, and between the backend and Stripe, Clerk and the other providers it talks to. In
          storage, your data lives with {SITE_NAME}&rsquo;s cloud database provider; the app and the
          website never talk to the database directly, only to {SITE_NAME}&rsquo;s backend functions.
        </p>
        <p>
          Access inside {SITE_NAME} is limited to the people who need it for their role, and staff
          reads of the audit log and of shop records go through the staff session described above.
          Uploaded files such as licence documents are stored as files behind long, unguessable
          links rather than in a browsable folder; a link is issued through the shop owner&rsquo;s or
          a staff member&rsquo;s own session, and because anyone holding one can open the file, they
          are never published.
        </p>
      </Section>

      <Section id="receipts" title="Why is my receipt link private?">
        <p>
          Because the link is the key. When a payment settles, the receipt email contains a private
          link that opens your itemised receipt and its PDF without a sign-in, so that walk-in
          customers without an {SITE_NAME} account can read theirs. The link carries a long random
          token; anyone holding it can open that receipt. Treat the link like the receipt itself:
          do not forward the email, and if you have an account, the same receipt is always available
          from the booking in the app.
        </p>
      </Section>

      <Section id="report" title="How do I report a vulnerability?">
        <p>
          Email <a href={`mailto:${SUPPORT_EMAIL}?subject=Security`}>{SUPPORT_EMAIL}</a> with
          &ldquo;Security&rdquo; in the subject line. Include what you found, where, and how to
          reproduce it, and keep any proof-of-concept to your own accounts and data. {SITE_NAME}{" "}
          acknowledges every report, fixes confirmed issues, and credits the reporter publicly if they
          would like to be named. There is no formal bounty programme yet.
        </p>
      </Section>

      <Section id="not-yet" title="What we don't claim yet">
        <p>
          A security page is only useful if it is exact about its edges. Three things {SITE_NAME}{" "}
          does not claim today:
        </p>
        <ul>
          <li>
            <strong>No third-party attestations yet.</strong> {SITE_NAME} has not published a SOC 2,
            ISO 27001 or PCI report. Card handling is delegated to Stripe, which holds its own
            certifications; {SITE_NAME}&rsquo;s own attestations are future work.
          </li>
          <li>
            <strong>Not every internal tool enforces the same session checks yet.</strong> The staff
            login described above is in place, and the audit log records staff actions, but bringing
            every internal function under the same server-side session check is still in progress.
            Until it is done this page does not say &ldquo;every admin action requires a verified
            session&rdquo;.
          </li>
          <li>
            <strong>Account deletion is a request, not an automated purge.</strong> Deleting your
            account flags it for deletion and closes it; removing your profile and vehicle details is
            done by the team rather than on a fixed automated schedule. The{" "}
            <Link href="/privacy">privacy policy</Link> explains what is kept and why.
          </li>
        </ul>
        <p>
          When any of these changes, this page changes with it and the date at the top moves.
        </p>
      </Section>

      <FaqSection items={FAQ} />
    </PageShell>
  );
}
