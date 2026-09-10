import type { Metadata } from "next";
import Link from "next/link";
import PageShell from "@/components/flagship/page-shell";
import { Reveal } from "@/components/flagship/landing/reveal";

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
      title="Guides for deciding, not just booking."
      lede="Longer reads on the questions that come before a booking, written to be balanced rather than to sell. Each one says when the answer is not Otopair."
      crumbs={[
        { name: "Home", href: "/" },
        { name: "Guides", href: "/guides" },
      ]}
      heroAlign="start"
      width="wide"
    >
      {/* One <dl>, and divide-y is doing the ruling between rows, so the
          index settles as a single block under the hero rather than row by
          row (motion contract, hazard 2). */}
      <Reveal>
        <dl className="flex flex-col divide-y divide-[#1a1a1a]/10 border-y border-[#1a1a1a]/10">
          {GUIDES.map((g) => (
            <div key={g.slug} className="grid gap-2 py-6 tab:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] tab:gap-x-10 tab:py-7">
              <dt className="serif-text text-[21px] leading-[1.3] text-[#1a1a1a] [text-wrap:balance]">
                <Link href={`/guides/${g.slug}`} className="transition-colors duration-300 hover:text-[#4B82A5]">
                  {g.title}
                </Link>
              </dt>
              <dd className="max-w-[60ch] text-[16px] leading-[1.6] text-[#4c5661]">
                {g.summary}{" "}
                <Link href={`/guides/${g.slug}`} className="whitespace-nowrap text-[#4B82A5] underline decoration-[#4B82A5]/40 underline-offset-[3px] hover:decoration-[#4B82A5]">
                  Read the guide
                </Link>
              </dd>
            </div>
          ))}
        </dl>
      </Reveal>
    </PageShell>
  );
}
