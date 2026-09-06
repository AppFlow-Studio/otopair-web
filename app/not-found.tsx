import type { Metadata } from "next";
import Link from "next/link";
import PageShell, { Card } from "@/components/flagship/page-shell";
import { PillLink } from "@/components/flagship/pill-button";
import { SUPPORT_EMAIL } from "@/lib/site";

export const metadata: Metadata = {
  title: "Page not found",
  robots: { index: false, follow: true },
};

/**
 * 404 in the flagship's own language (site audit 2026-08-31, Phase 1
 * follow-through). Replaced the black "glitch" page set in Jersey 20 — the
 * only surface on the site that still looked like the pre-rename brand.
 * Now that unknown URLs actually reach this page (middleware used to send
 * them to sign-in), it has to carry the visitor somewhere useful: the four
 * places a lost visitor most likely wanted.
 */
const ROUTES = [
  { title: "How Otopair works", body: "Talk to Oto, get a locked price, book a verified shop.", href: "/#how-it-works", label: "See how it works" },
  { title: "Verified shops", body: "The Staten Island shops on the network, with hours and services.", href: "/shops", label: "Browse shops" },
  { title: "For repair shops", body: "Fill your bays with booked, pre-diagnosed customers.", href: "/partner-with-us", label: "Partner with us" },
  { title: "Help", body: "Answers about pricing, deposits, cancellations and Oto.", href: "/help", label: "Open the help hub" },
];

export default function NotFound() {
  return (
    <PageShell
      eyebrow="404"
      title="That page took a wrong turn"
      lede={
        <>
          The address you followed doesn&rsquo;t exist on otopair.com. If a link on our site brought you
          here, tell us at <a href={`mailto:${SUPPORT_EMAIL}?subject=Broken%20link`} className="underline">{SUPPORT_EMAIL}</a>{" "}
          and we&rsquo;ll fix it.
        </>
      }
      hero={
        <PillLink href="/">Back to the home page</PillLink>
      }
      width="wide"
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {ROUTES.map((r) => (
          <Card key={r.href} title={r.title}>
            <p className="mt-3 flex-1 text-[15px] leading-[1.6] text-[#6b655d]">{r.body}</p>
            <Link
              href={r.href}
              className="mt-5 text-[14px] text-[#4B82A5] underline decoration-[#4B82A5]/40 underline-offset-[3px] hover:decoration-[#4B82A5]"
            >
              {r.label}
            </Link>
          </Card>
        ))}
      </div>
    </PageShell>
  );
}
