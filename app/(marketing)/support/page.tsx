import type { Metadata } from "next";
import PageShell from "@/components/flagship/page-shell";
import { PillLink } from "@/components/flagship/pill-button";
import { Reveal } from "@/components/flagship/landing/reveal";
import SupportForm from "./support-form";

export const metadata: Metadata = {
  // `absolute`: the root template would otherwise append a second "— Otopair".
  title: { absolute: "Get help from Otopair" },
  description:
    "Dispute a charge or report an issue with a service. Tell us what happened and our team will help resolve it.",
  alternates: { canonical: "/support" },
};

/**
 * /support — the public, no-login help + charge-dispute intake. Same page shell
 * and form chrome as /apply. Submissions post to /api/support/submit and land in
 * the director "Disputes" inbox for triage and (where warranted) a refund.
 */
const FACTS = [
  "Tell us what happened — a charge you're disputing or an issue with the work. Include the order number if you have it.",
  "We review every request by hand and reply to the email you give us.",
  "If a refund is due, we can issue it directly to your original payment method.",
];

export default function SupportPage() {
  return (
    <PageShell
      title="Get help with a charge or service."
      lede="Dispute a charge or report an issue with the work. Give us the details and we'll review it and get back to you."
      crumbs={[
        { name: "Home", href: "/" },
        { name: "Support", href: "/support" },
      ]}
      hero={
        <ul className="flex max-w-[44ch] flex-col gap-2 text-[15px] leading-[1.55] text-[#4c5661] [&>li]:relative [&>li]:pl-5 [&>li]:before:absolute [&>li]:before:left-0 [&>li]:before:top-[0.8em] [&>li]:before:h-px [&>li]:before:w-2.5 [&>li]:before:bg-[#4B82A5]">
          {FACTS.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      }
      visual={<SupportForm />}
      visualFrame={false}
      width="wide"
      footerTitle="Prefer to email us?"
      footerAction={
        <PillLink href="/contact" tone="light">
          Contact Otopair
        </PillLink>
      }
    >
      <Reveal>
        <p className="max-w-[62ch] text-[17px] leading-[1.65] text-[#4c5661]">
          Have an Otopair account? You can also raise a dispute from your booking
          in the app.{" "}
          <a
            href="/dashboard"
            className="text-[#4B82A5] underline decoration-[#4B82A5]/40 underline-offset-[3px] hover:decoration-[#4B82A5]"
          >
            Sign in to your dashboard
          </a>
          .
        </p>
      </Reveal>
    </PageShell>
  );
}
