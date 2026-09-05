import type { Metadata } from "next";
import PageShell from "@/components/flagship/page-shell";
import { PillLink } from "@/components/flagship/pill-button";
import ApplyForm from "./apply-form";

export const metadata: Metadata = {
  // `absolute`: the root template would otherwise append a second "— Otopair".
  title: { absolute: "Apply to partner with Otopair" },
  description:
    "Apply to join the Otopair network. Tell us about your shop and we'll be in touch about setting up your account.",
  alternates: { canonical: "/apply" },
};

/**
 * /apply (design pass 2026-09-05): the three-step application on the page
 * shell, the form seated on the paper plate as the hero's object (the
 * contact page's move). The form's logic and the /api/applications/submit
 * contract are untouched; only the chrome changed: the site's pills and
 * fields, ink instead of the app's blue, no beige canvas.
 */
const FACTS = [
  "No subscription and no setup fee. You set your own labor rate and can set a flat price per service.",
  "Otopair reviews and approves every shop by hand before drivers can see it.",
  "Payouts run through Stripe on Stripe's payout schedule; the $20 hold and the final charge run through Otopair.",
];

export default function ApplyPage() {
  return (
    <PageShell
      title="Apply to partner with Otopair."
      lede="Two minutes: your shop, how we reach you, where you are. If approved, you get a private invite to set up your dashboard."
      crumbs={[
        { name: "Home", href: "/" },
        { name: "Partner with us", href: "/partner-with-us" },
        { name: "Apply", href: "/apply" },
      ]}
      hero={
        <ul className="flex max-w-[44ch] flex-col gap-2 text-[15px] leading-[1.55] text-[#4c5661] [&>li]:relative [&>li]:pl-5 [&>li]:before:absolute [&>li]:before:left-0 [&>li]:before:top-[0.8em] [&>li]:before:h-px [&>li]:before:w-2.5 [&>li]:before:bg-[#4B82A5]">
          {FACTS.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      }
      visual={<ApplyForm />}
      visualFrame={false}
      width="wide"
      footerTitle="Questions before you apply?"
      footerAction={
        <PillLink href="/partner-with-us" tone="light">
          How the network works for shops
        </PillLink>
      }
    >
      <p className="max-w-[62ch] text-[17px] leading-[1.65] text-[#4c5661]">
        Already on the network?{" "}
        <a href="/dashboard" className="text-[#4B82A5] underline decoration-[#4B82A5]/40 underline-offset-[3px] hover:decoration-[#4B82A5]">
          Sign in to your dashboard
        </a>
        . Not sure yet? The <a href="/for-shops" className="text-[#4B82A5] underline decoration-[#4B82A5]/40 underline-offset-[3px] hover:decoration-[#4B82A5]">for-shops tour</a> shows the dashboard page by page, and{" "}
        <a href="/how-shops-are-verified" className="text-[#4B82A5] underline decoration-[#4B82A5]/40 underline-offset-[3px] hover:decoration-[#4B82A5]">how shops are verified</a> lists what the review checks.
      </p>
    </PageShell>
  );
}
