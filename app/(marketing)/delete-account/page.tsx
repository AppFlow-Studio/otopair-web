import type { Metadata } from "next";
import Link from "next/link";
import PageShell, { Section } from "@/components/flagship/page-shell";
import PrivacyRequestForm from "@/components/legal/privacy-request-form";
import { SUPPORT_EMAIL } from "@/lib/site";

export const metadata: Metadata = {
  title: "Delete your account",
  description:
    "Ask Otopair to delete your account and your personal information. Enter the email on your account; the request is verified before anything is deleted.",
  alternates: { canonical: "/delete-account" },
};

/**
 * /delete-account — the page Privacy Policy v6.1 §6 names for account
 * deletion ({{DELETE_ACCOUNT_URL}}). What happens, verification and timing
 * are v6.1's words ("Account deletion", "Exercising your rights"); what is
 * kept is left to §10 rather than summarized. The form records the request
 * (convex/privacyRequests.ts) and emails support; nothing is deleted from
 * here, because a typed email proves nothing about who owns the account.
 */
export default function DeleteAccountPage() {
  return (
    <PageShell
      title="Delete your account"
      lede="Ask Otopair to close your account and delete your personal information."
      crumbs={[
        { name: "Home", href: "/" },
        { name: "Privacy policy", href: "/privacy" },
        { name: "Delete your account", href: "/delete-account" },
      ]}
    >
      <Section first id="request" title="Request account deletion" after={<PrivacyRequestForm kind="delete_account" />}>
        <p>
          Enter the email on your Otopair account. You can also delete your account in the app’s settings, or by
          emailing <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
        </p>
        <ul>
          <li>
            <strong>What’s deleted.</strong> Otopair deletes or de-identifies your personal information, except
            records it’s required or permitted to keep, which Section 10 of the{" "}
            <Link href="/privacy">Privacy Policy</Link> describes.
          </li>
          <li>
            <strong>Your cars.</strong> Your vehicles are left out of the Vehicle History Data Otopair licenses
            after the deletion.
          </li>
          <li>
            <strong>Verification.</strong> The request is verified with the email address or phone number on the
            account before anything is deleted.
          </li>
          <li>
            <strong>Timing.</strong> Otopair responds within the time the law requires, generally 45 days.
          </li>
        </ul>
      </Section>

      <Section id="instead" title="Only want to stop something?">
        <p>
          You don’t have to delete your account to stop your car’s service records being licensed.{" "}
          <Link href="/privacy-choices">Opt out on Your Privacy Choices</Link> instead. Every marketing email also
          has an unsubscribe link.
        </p>
      </Section>
    </PageShell>
  );
}
