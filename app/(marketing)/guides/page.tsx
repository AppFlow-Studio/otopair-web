import type { Metadata } from "next";
import Link from "next/link";
import PageShell, { Card } from "@/components/flagship/page-shell";

export const metadata: Metadata = {
  title: "Guides",
  description:
    "Longer reads for deciding, not just booking: when a dealership is the right call and when an independent shop is, and what to check either way.",
  alternates: { canonical: "/guides" },
};

/**
 * /guides — index for the authority guides (audit Tier 5). Kept to what is
 * actually published; each guide is its own route under /guides/<slug>.
 */
const GUIDES = [
  {
    slug: "dealership-vs-independent-mechanic",
    title: "Dealership or independent mechanic: which should I choose?",
    summary:
      "It depends on the job. Warranty repairs, recalls and anything that needs the manufacturer's own tools belong at a dealership; out-of-warranty maintenance and most repairs are well served by a good independent shop. How to decide, and what to check either way.",
  },
];

export default function GuidesPage() {
  return (
    <PageShell
      eyebrow="GUIDES"
      title="Guides for deciding, not just booking"
      lede="Longer reads on the questions that come before a booking, written to be balanced rather than to sell. Each one says when the answer is not Otopair."
      crumbs={[
        { name: "Home", href: "/" },
        { name: "Guides", href: "/guides" },
      ]}
    >
      <ul className="grid list-none gap-4 p-0">
        {GUIDES.map((g) => (
          <li key={g.slug}>
            <Link
              href={`/guides/${g.slug}`}
              className="block h-full rounded-[20px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4B82A5]"
            >
              <Card title={g.title} eyebrow="GUIDE">
                <p className="mt-3 flex-1 text-[15px] leading-[1.6] text-[#6b655d]">{g.summary}</p>
                <span className="mt-4 text-[14px] text-[#4B82A5] underline decoration-[#4B82A5]/40 underline-offset-[3px]">
                  Read the guide
                </span>
              </Card>
            </Link>
          </li>
        ))}
      </ul>
    </PageShell>
  );
}
