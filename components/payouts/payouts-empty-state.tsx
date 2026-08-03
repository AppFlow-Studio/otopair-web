import Link from "next/link";
import { ArrowUpRight, Landmark } from "lucide-react";

/**
 * Shown when the shop has no Stripe Connect account at all.
 *
 * Links to /shop/setup, which is where Connect onboarding actually lives
 * (it POSTs /api/stripe/connect/start). The previous copy of this pointed at
 * /settings, which contains no Stripe surface whatsoever — a dead end for
 * exactly the user who needed it most.
 */
export function PayoutsEmptyState() {
  return (
    <section className="rounded-2xl border border-border bg-card p-10 text-center shadow-sm">
      <span className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl bg-primary/10">
        <Landmark className="size-6 text-primary" aria-hidden="true" />
      </span>
      <h2 className="text-lg font-semibold text-foreground">
        Connect Stripe to get paid
      </h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
        Once your Stripe account is linked, this page fills with your balance,
        payout history, every transaction, and where your revenue comes from.
      </p>
      <Link
        href="/shop/setup"
        className="mt-5 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Set up payments
        <ArrowUpRight className="size-4" aria-hidden="true" />
      </Link>
    </section>
  );
}
