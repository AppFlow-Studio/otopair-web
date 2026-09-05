import type { Metadata } from "next";
import Link from "next/link";
import PageShell from "@/components/flagship/page-shell";
import { ShopDay } from "@/components/flagship/editorial-sections";
import { PillAnchor, TextLink } from "@/components/flagship/pill-button";
import { LOCALITY, SUPPORT_EMAIL } from "@/lib/site";

export const metadata: Metadata = {
  title: "Careers",
  description:
    "Work on Otopair, the fixed-price car repair marketplace built in Staten Island, NY. No open listings right now; here is what we build and how to reach us.",
  alternates: { canonical: "/careers" },
};

/**
 * /careers (design pass 2026-09-05): there are no posted roles, and the
 * page says so rather than inventing any; it exists so the URL resolves,
 * the entity is grounded, and someone who wants in has a real address to
 * write to. Three answers in one editorial list, and one product object
 * under the first: the shop's day as the dashboard shows it, beside the
 * three products the team builds (the app up close, 2026-09-05).
 */
const ROW = "grid gap-2 py-6 tab:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] tab:gap-x-10 tab:py-7";
const TERM = "serif-text text-[21px] leading-[1.3] text-[#1a1a1a] [text-wrap:balance]";
const ANSWER =
  "max-w-[60ch] text-[16px] leading-[1.6] text-[#4c5661] [&_p+p]:mt-3 [&_a]:text-[#4B82A5] [&_a]:underline [&_a]:decoration-[#4B82A5]/40 [&_a]:underline-offset-[3px] [&_a:hover]:decoration-[#4B82A5] [&_ul]:flex [&_ul]:flex-col [&_ul]:gap-1.5 [&_ul]:pl-5 [&_li]:relative [&_li]:before:absolute [&_li]:before:-left-5 [&_li]:before:top-[0.8em] [&_li]:before:h-px [&_li]:before:w-2.5 [&_li]:before:bg-[#4B82A5]";

export default function CareersPage() {
  return (
    <PageShell
      title="Small team, hard problem, real cars."
      lede={`Otopair is built by a small team in ${LOCALITY.city}, ${LOCALITY.region}. No open listings right now; if you want to work on this anyway, write to us.`}
      crumbs={[
        { name: "Home", href: "/" },
        { name: "Careers", href: "/careers" },
      ]}
      hero={
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <PillAnchor href={`mailto:${SUPPORT_EMAIL}?subject=Careers`} icon="external">
            Write to us
          </PillAnchor>
          <TextLink href="/about">About the company</TextLink>
        </div>
      }
      heroAlign="start"
      width="wide"
    >
      <section id="details" className="scroll-mt-28">
        <dl className="flex flex-col divide-y divide-[#1a1a1a]/10 border-b border-[#1a1a1a]/10">
          <div className={`${ROW} pt-0! tab:pt-0!`} id="what">
            <dt className={TERM}>What we are building</dt>
            <dd className={ANSWER}>
              <p>
                A marketplace where a driver describes a problem to an assistant, sees the price a verified shop set,
                and books it locked. That means three products at once: Oto, the assistant that turns &ldquo;it
                squeals when I brake&rdquo; into a scoped job; the pricing and booking system that holds a deposit,
                locks a price and settles it through Stripe; and the shop dashboard that runs a real garage&rsquo;s
                day. Underneath all three is a vehicle-data asset built from verified shop work.
              </p>
            </dd>
          </div>
        </dl>
        <div className="mt-2 tab:mt-4">
          <ShopDay />
        </div>
        <dl className="mt-14 flex flex-col divide-y divide-[#1a1a1a]/10 border-y border-[#1a1a1a]/10 tab:mt-20">
          <div className={ROW} id="who">
            <dt className={TERM}>Who does well here</dt>
            <dd className={ANSWER}>
              <ul>
                <li>People who have stood in a shop, or would, to watch how a job actually flows.</li>
                <li>Engineers comfortable across a TypeScript stack: Next.js, React Native, Convex, Stripe.</li>
                <li>Anyone who would rather write the true sentence than the impressive one.</li>
              </ul>
            </dd>
          </div>
          <div className={ROW} id="how">
            <dt className={TERM}>How to reach us</dt>
            <dd className={ANSWER}>
              <p>
                Email <a href={`mailto:${SUPPORT_EMAIL}?subject=Careers`}>{SUPPORT_EMAIL}</a> with &ldquo;Careers&rdquo;
                in the subject, a few lines about you, and links to something you built. If you run a repair shop
                rather than want a job, the <Link href="/partner-with-us">partner page</Link> is where to start.
              </p>
            </dd>
          </div>
        </dl>
      </section>
    </PageShell>
  );
}
