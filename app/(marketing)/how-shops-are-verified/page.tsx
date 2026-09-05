import type { Metadata } from "next";
import Link from "next/link";
import PageShell, { Section, Summary, type TocItem } from "@/components/flagship/page-shell";
import { FaqSection } from "@/components/seo/faq";
import { SITE_NAME, SUPPORT_EMAIL } from "@/lib/site";
import { FitZoom, Plate } from "@/components/flagship/product/device";
import { PortalWindow } from "@/components/flagship/product/screens/portal";

export const metadata: Metadata = {
  title: "How shops are verified",
  description:
    "What Otopair's Verified badge means: a hand-reviewed application, Stripe identity and payout checks, DMV inspection-licence review, and what is not checked yet.",
  alternates: { canonical: "/how-shops-are-verified" },
};

/**
 * /how-shops-are-verified — audit Tier 4, "the verification standard,
 * named and public". Every step below is the pipeline as the code runs it:
 * app/(marketing)/apply (five intake fields) → director review by hand
 * (convex/shopInvites.ts approveApplication, requireDirector shops.write,
 * audit-logged) → a single-use SHA-256-hashed invite that expires in 7 days
 * (app/api/applications/approve/route.ts INVITE_TTL_MS) → Stripe Connect
 * Express, where Stripe verifies the business and the payout account
 * (convex/shops.ts assertOnboardingCanBeCompleted) → hours, labor rate,
 * services and at least one mechanic before the shop is bookable
 * (lib/bookableShop.ts) → DMV inspection-station licence review with a
 * written reason (convex/shopsDirectory.ts reviewShopLicense) → the badge
 * itself, a manual decision by Otopair's team with a written reason
 * (convex/director.ts setShopVerified). The "What we don't check today"
 * section is the point of the page: no claim here outruns the code.
 */
const UPDATED = "2026-09-04";

const TOC: TocItem[] = [
  { id: "apply", title: "How does a shop apply?" },
  { id: "review", title: "Who reviews the application?" },
  { id: "invite", title: "What happens after approval?" },
  { id: "stripe", title: "How is the business checked?" },
  { id: "setup", title: "What must a shop set up before drivers see it?" },
  { id: "licence", title: "Which licences does Otopair review?" },
  { id: "badge", title: "Who grants the Verified badge?" },
  { id: "not-checked", title: "What we don't check today" },
  { id: "meaning", title: "What 'verified' means on a shop page" },
  { id: "report", title: "How to report a shop" },
  { id: "faq", title: "Questions people ask" },
];

const FAQ = [
  {
    q: "Does 'verified' mean the shop is licensed and insured?",
    a: "No. Verified means Otopair's team reviewed the shop's application by hand and approved it, the shop completed Stripe's business and payout checks, finished its setup, and a member of Otopair's team granted the badge with a written reason. Otopair does not verify insurance, and the only licence it reviews is the New York DMV inspection-station licence, for shops that offer State Inspection or Emissions Test.",
  },
  {
    q: "Are mechanics background-checked or certified?",
    a: "Not by Otopair. Shops add their own mechanics by name and email. Otopair does not run background or criminal checks and does not verify mechanic certifications. If those checks matter to you, ask the shop directly through the app before your visit.",
  },
  {
    q: "Can a shop lose its Verified badge?",
    a: "Yes. The badge is granted and removed by Otopair's team, each time with a written reason, and every change is written to an audit log. A shop can also be deactivated, which removes it from the app entirely.",
  },
  {
    q: "Who checks the shop's identity and bank account?",
    a: "Stripe does. Every shop on Otopair is paid through a Stripe Connect account, and Stripe verifies the business's identity and its payout bank details before it reports the account ready. Otopair stores only whether Stripe has enabled charges and payouts and whether anything is still outstanding. A shop cannot finish setup or take bookings until Stripe reports it ready.",
  },
  {
    q: "How long does verification take?",
    a: "There is no fixed time. Applications are reviewed by a person, the invite link is valid for 7 days once sent, and Stripe's own checks take as long as Stripe needs. A shop can finish setup in a day or take longer if Stripe asks for more information.",
  },
];

export default function HowShopsAreVerifiedPage() {
  return (
    <PageShell
      title="What it takes to be a verified shop"
      lede={`Every shop on ${SITE_NAME} goes through the same steps, and the badge on a shop page means those steps happened. This page lists them in order, in plain language, and is equally clear about what ${SITE_NAME} does not check yet.`}
      updated={UPDATED}
      crumbs={[
        { name: "Home", href: "/" },
        { name: "How shops are verified", href: "/how-shops-are-verified" },
      ]}
      toc={TOC}
      numbered
    >
      <Summary
        items={[
          "A shop applies with its legal name, owner, business email, phone and street address. A person at Otopair reviews every application and approves or declines it.",
          "Approved owners get a private, single-use invite link that expires in 7 days.",
          "Stripe, not Otopair, verifies the business's identity and payout bank details. No bookings until Stripe reports the account ready.",
          "Before drivers see the shop it sets hours for all 7 days, a labor rate and its services, and adds at least one mechanic.",
          "Shops offering State Inspection or Emissions Test upload their NY DMV inspection-station licence for review. That is the only licence Otopair reviews.",
          "The Verified badge is a decision by Otopair's team, made and removed with a written reason, and every change is logged.",
        ]}
      />

      <Section first id="apply" title="How does a shop apply?">
        <p>
          Through the <Link href="/apply">application form</Link>, with five things: the shop&rsquo;s
          legal name, the owner&rsquo;s full name, a business email, a phone number and the street
          address of the shop. That is the whole intake. Otopair does not ask for bay counts, staff
          lists or documents at this stage; those come later, inside the shop&rsquo;s own setup.
        </p>
        <p>
          A few rules apply before an application is even accepted: the email cannot belong to an
          existing Otopair account, and one email can have only one application under review at a
          time. The shop receives a receipt by email and the application is queued for review.
        </p>
      </Section>

      <Section id="review" title="Who reviews the application?">
        <p>
          A person on Otopair&rsquo;s team. Every application is read by hand and either approved or
          declined; nothing is approved automatically, and no automated business-registry, licence,
          insurance or background check runs at this step. Approving or declining requires a staff
          account with the right to manage shops, and each decision is written to an audit log with
          the reviewer&rsquo;s name and, for a decline, the reason.
        </p>
      </Section>

      <Section id="invite" title="What happens after approval?">
        <p>
          The owner receives a private invite link by email. The link is single-use, is valid for 7
          days, and is the only way into a new shop account: Otopair creates the shop in an
          &ldquo;invited&rdquo; state with no owner, and the shop stays invisible to drivers until
          setup is complete. Otopair never stores the invite link itself, only a one-way hash of it,
          so the link cannot be read out of the database.
        </p>
        <p>
          Opening the link signs the owner in through {SITE_NAME}&rsquo;s sign-in provider and claims
          the shop. Once claimed, the invite is spent; a second person opening the same link is turned
          away.
        </p>
      </Section>

      <Section id="stripe" title="How is the business checked?">
        <p>
          By Stripe, as part of payments setup. Every shop on {SITE_NAME} is paid through a Stripe
          Connect account, and Stripe&rsquo;s onboarding is where the business&rsquo;s identity and
          its payout bank details are verified. {SITE_NAME} does not see or store identity documents
          or bank numbers; it stores only what Stripe reports back: whether charges are enabled,
          whether payouts are enabled, and whether anything is still outstanding.
        </p>
        <p>
          That report is a hard gate. A shop cannot finish setup, and cannot take a single booking,
          until Stripe says charges and payouts are enabled with nothing outstanding. If Stripe later
          asks the shop for more information, the shop drops out of the bookable list until it is
          provided.
        </p>
      </Section>

      {/* Every gate on this page is prose, and page-shell already wraps each
          Section (and the Summary, and the FAQ) in a Reveal, so the clauses
          arrive as blocks and are never animated line by line. The rates
          window rides that same Reveal: a second one around the `after` slot
          would be a Reveal inside a Reveal, compounding 26px and 16px into a
          lurch whenever the section fits the viewport. */}
      <Section id="setup" title="What must a shop set up before drivers see it?" after={<Plate tone="paper" className="p-3 tab:p-5" clip><FitZoom base={1100}><PortalWindow page="rates" shop="Your shop" /></FitZoom></Plate>}>
        <p>
          Four things, all of them checked on the server before the shop appears in the app: opening
          hours for all seven days of the week (including days it is closed), an hourly labor rate,
          the services it offers from {SITE_NAME}&rsquo;s catalog, and at least one active mechanic
          on the team. A shop missing any one of these is not shown to drivers, however far along the
          rest of its setup is.
        </p>
        <p>
          The setup also collects the shop&rsquo;s public details, its compliance documents where they
          apply, and its team. Mechanics are added by the owner with a name and email; see{" "}
          <a href="#not-checked">what we don&rsquo;t check today</a> for what that does and does not
          mean.
        </p>
      </Section>

      <Section id="licence" title="Which licences does Otopair review?">
        <p>
          One: the New York DMV inspection-station licence, and only for shops that offer State
          Inspection or Emissions Test, which legally require it. Those shops upload the licence in
          their settings. A member of {SITE_NAME}&rsquo;s team reviews the document and marks it
          verified or rejected, must write a reason either way, and the decision is written to the
          audit log. A shop that offers those services without a reviewed licence on file is flagged
          to {SITE_NAME}&rsquo;s team until it is resolved.
        </p>
        <p>
          The upload area accepts other documents too, such as a business licence or a certification,
          but {SITE_NAME} does not require them and does not review them today. Only the DMV
          inspection-station licence is part of the standard.
        </p>
      </Section>

      <Section id="badge" title="Who grants the Verified badge?">
        <p>
          {SITE_NAME}&rsquo;s team, by hand, after review. The badge is not switched on by any
          automated check; a member of the team grants it and must write a reason. The same person or
          a colleague can remove it later, again with a written reason, and every grant and removal is
          written to the audit log with who did it and when.
        </p>
        <p>
          The badge is separate from the checks above. Stripe and the setup gate decide whether a shop
          can take bookings; the badge records {SITE_NAME}&rsquo;s own review on top of them.
        </p>
      </Section>

      <Section id="not-checked" title="What we don't check today">
        <p>
          Background or criminal checks, insurance verification, mechanic certification checks, any
          licence beyond the DMV inspection-station licence, and in-person visits. {SITE_NAME} does not
          run these today and does not claim to. In detail:
        </p>
        <ul>
          <li>
            <strong>No automated background or criminal checks</strong> on owners, staff or
            mechanics.
          </li>
          <li>
            <strong>No insurance verification.</strong> {SITE_NAME} does not confirm that a shop
            carries garage liability or any other coverage.
          </li>
          <li>
            <strong>No mechanic certification checks.</strong> Mechanics are added by the shop with a
            name and email; {SITE_NAME} does not collect or verify ASE, manufacturer or other
            credentials.
          </li>
          <li>
            <strong>No licences beyond the DMV inspection-station licence,</strong> and that one only
            for shops offering State Inspection or Emissions Test.
          </li>
          <li>
            <strong>No in-person visits.</strong> Review is of the application, the Stripe report and
            the uploaded licence, not a walk-through of the shop.
          </li>
        </ul>
        <p>
          If any of these matter to your decision, ask the shop directly in the app before your
          visit. If {SITE_NAME} adds one of them to the standard, this page will say so and the date
          at the top will change.
        </p>
      </Section>

      <Section id="meaning" title="What 'verified' means on a shop page">
        <p>
          It means the steps on this page happened: a person at {SITE_NAME} approved the application,
          Stripe verified the business and its payout account, the shop completed its setup with real
          hours, a real labor rate, real services and at least one mechanic, any required DMV
          inspection licence was reviewed, and a member of {SITE_NAME}&rsquo;s team granted the badge
          with a written reason.
        </p>
        <p>
          It does not mean the shop is insured, that its mechanics are certified, or that anyone has
          been background-checked. A shop page without the badge means the team has not granted it,
          or has removed it; the shop may still be completing review.
        </p>
      </Section>

      <Section id="report" title="How to report a shop">
        <p>
          Email <a href={`mailto:${SUPPORT_EMAIL}?subject=Report%20a%20shop`}>{SUPPORT_EMAIL}</a> with
          the shop&rsquo;s name and what happened. A person reads every report. If the problem is with
          a specific booking, the fastest route is in the app: message the shop from the booking, or,
          once the final amount has been charged, open a dispute within 14 days and {SITE_NAME}{" "}
          reviews the job record and the messages on both sides. See{" "}
          <Link href="/trust-and-safety">trust and safety</Link> for how disputes and reviews work.
        </p>
        <p>
          Reports can lead to the badge being removed or the shop being deactivated. Both are decisions
          by {SITE_NAME}&rsquo;s team, made with a written reason and logged.
        </p>
      </Section>

      <FaqSection items={FAQ} />
    </PageShell>
  );
}
