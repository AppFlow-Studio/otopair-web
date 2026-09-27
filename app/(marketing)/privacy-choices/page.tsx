import type { Metadata } from "next";
import Link from "next/link";
import PageShell, { Section } from "@/components/flagship/page-shell";
import PrivacyRequestForm from "@/components/legal/privacy-request-form";
import { SUPPORT_EMAIL } from "@/lib/site";

// Link text a shade darker than the site's #4B82A5, which is 4.17:1 on white
// and fails WCAG AA for body text; #3a6f92 is 5.43:1 (4.91:1 on the sky tint).
// The prose shell styles links with a descendant selector, so this needs `!`.
const LINK = "text-[#3a6f92]!";

export const metadata: Metadata = {
  title: "Your privacy choices",
  description:
    "Opt out of Otopair licensing your car's service history as Vehicle History Data. No sign-in or ID needed, just the email on your account.",
  alternates: { canonical: "/privacy-choices" },
};

/**
 * /privacy-choices — the "Your Privacy Choices" link Privacy Policy v6.1 §6
 * sends people to ({{PRIVACY_CHOICES_URL}}). Every statement here is v6.1's:
 * what an opt-out stops and doesn't, no verification, GPC as an opt-out,
 * and the other choices in §6. The form records the request
 * (convex/privacyRequests.ts) and emails support.
 *
 * Deliberately not repeated from v6.1: the in-app path "Settings → Privacy →
 * Vehicle History Reports". The driver app has no such setting yet.
 */
export default function PrivacyChoicesPage() {
  return (
    <PageShell
      title="Your Privacy Choices"
      lede="Opt out of Otopair licensing your car’s service history. No sign-in or ID needed."
      crumbs={[
        { name: "Home", href: "/" },
        { name: "Privacy policy", href: "/privacy" },
        { name: "Your privacy choices", href: "/privacy-choices" },
      ]}
    >
      <Section first id="opt-out" title="Opt out of Vehicle History Data" after={<PrivacyRequestForm kind="opt_out_vehicle_history" />}>
        <p>
          Otopair licenses a car’s service records, keyed to its VIN, as Vehicle History Data to vehicle-history
          report providers and automotive marketplaces. Some state laws treat that as a sale of personal
          information, and you can opt out at any time.
        </p>
        <ul>
          <li>
            <strong>What stops.</strong> Your vehicle’s service records are left out of the Vehicle History Data
            Otopair licenses after you opt out, and Otopair directs recipients to delete the records it licensed
            before for your vehicle.
          </li>
          <li>
            <strong>What doesn’t change.</strong> Data Products, which are aggregated and de-identified and
            don’t identify you.
          </li>
          <li>
            <strong>What you need.</strong> The email on your Otopair account. You don’t have to verify your
            identity or give anything else.
          </li>
        </ul>
        <p>A Global Privacy Control signal from your browser also counts as a request to opt out.</p>
      </Section>

      <Section id="other-choices" title="Your other choices">
        <ul>
          <li>
            <strong>Marketing email.</strong> Every marketing email has an unsubscribe link. Messages about your
            bookings and account still arrive.
          </li>
          <li>
            <strong>Push notifications.</strong> Turn off marketing notifications in your device settings.
          </li>
          <li>
            <strong>Delete your account.</strong> <Link className={LINK} href="/delete-account">Request deletion</Link>, or delete
            it in the app’s settings.
          </li>
          <li>
            <strong>See or correct your information.</strong> Email{" "}
            <a className={LINK} href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>. Otopair responds within the time the law
            requires, generally 45 days.
          </li>
        </ul>
        <p>
          The <Link className={LINK} href="/privacy">Privacy Policy</Link> explains each of these in full.
        </p>
      </Section>
    </PageShell>
  );
}
