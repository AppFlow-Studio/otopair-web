import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import PageShell from "@/components/flagship/page-shell";
import { ProductStack } from "@/components/flagship/editorial-sections";
import { Reveal } from "@/components/flagship/landing/reveal";
import { PillAnchor, TextLink } from "@/components/flagship/pill-button";
import { LEGAL_NAME, LOCALITY, SITE_NAME, SITE_URL, SUPPORT_EMAIL } from "@/lib/site";

export const metadata: Metadata = {
  title: "Press kit",
  description:
    "Otopair press kit: company boilerplate, key facts, and downloadable logo and mark files for editorial use.",
  alternates: { canonical: "/press" },
};

/**
 * /press (design pass 2026-09-05): boilerplate, facts and the brand files
 * that already live in public/. Founder bios are not in the repo and are
 * not invented. The brand assets are the one place on the site where a
 * mark on a plate is the content rather than decoration, so they sit as
 * three plain plates inside the same editorial list as everything else.
 * Between the facts and the files: the two products in one frame, the
 * driver app in front of the shop dashboard, drawn from the app's own
 * components (the app up close, 2026-09-05). Renders, not screenshots;
 * the row says so.
 */
const ASSETS = [
  { file: "/logo.png", name: "Pin mark", spec: "PNG, 200 × 200", w: 200, h: 200 },
  { file: "/pin-logo-3d.png", name: "Pin mark, 3D", spec: "PNG, 500 × 500", w: 500, h: 500 },
  { file: "/oto-orb.png", name: "Oto orb", spec: "PNG, 1071 × 1072", w: 1071, h: 1072 },
];

const FACTS: Array<[string, string]> = [
  ["Company", LEGAL_NAME],
  ["Product", `${SITE_NAME}: driver app (iOS, Android) and shop dashboard (web)`],
  ["Headquarters", `${LOCALITY.city}, ${LOCALITY.region}`],
  ["Live since", "2026, Staten Island, NY"],
  ["Model", "Marketplace. Verified independent shops set their own prices; the price is locked at booking."],
  ["Payments", "Stripe Connect. Drivers pay a deposit at booking and the balance on completion."],
  ["Cost to shops", "No subscription, no setup fee."],
  ["Coverage", "Staten Island live; Brooklyn Q4 2026, Queens Q1 2027, The Bronx Q2 2027, Manhattan Q3 2027."],
  ["Website", SITE_URL],
];

const ROW = "grid gap-2 py-6 tab:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] tab:gap-x-10 tab:py-7";
const TERM = "serif-text text-[21px] leading-[1.3] text-[#1a1a1a] [text-wrap:balance]";
const ANSWER =
  "max-w-[60ch] text-[16px] leading-[1.6] text-[#4c5661] [&_p+p]:mt-3 [&_a]:text-[#4B82A5] [&_a]:underline [&_a]:decoration-[#4B82A5]/40 [&_a]:underline-offset-[3px] [&_a:hover]:decoration-[#4B82A5] [&_strong]:font-medium [&_strong]:text-[#1a1a1a]";

export default function PressPage() {
  return (
    <PageShell
      title="Otopair, for people writing about it."
      lede="Boilerplate you can paste, facts you can check, and logo files you can use. For anything else, one email reaches the team."
      crumbs={[
        { name: "Home", href: "/" },
        { name: "Press", href: "/press" },
      ]}
      hero={
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <PillAnchor href={`mailto:${SUPPORT_EMAIL}?subject=Press`} icon="external">
            {SUPPORT_EMAIL}
          </PillAnchor>
          <TextLink href="/about">About the company</TextLink>
        </div>
      }
      heroAlign="start"
      width="wide"
    >
      <section id="kit" className="scroll-mt-28">
        {/* The kit is a definition list — boilerplate a writer pastes and facts
            they check. It fades up whole; a term-by-term cascade would turn a
            reference into a slideshow (docs/design/motion.md). */}
        <Reveal>
          <dl className="flex flex-col divide-y divide-[#1a1a1a]/10 border-b border-[#1a1a1a]/10">
            <div className={`${ROW} pt-0! tab:pt-0!`} id="boilerplate">
              <dt className={TERM}>Boilerplate</dt>
              <dd className={ANSWER}>
                <p>
                  {SITE_NAME} is a trust-first car repair marketplace that connects drivers with verified independent
                  mechanic shops. Drivers describe the problem to Oto, the in-app assistant, see the full price each
                  nearby shop set, and book it at a locked price, with any extra work approved in the app before it
                  happens. Shops get booked, pre-diagnosed customers with no subscription and no setup fee. {SITE_NAME}{" "}
                  is operated by {LEGAL_NAME} and went live in {LOCALITY.city}, New York in 2026.
                </p>
                <p>
                  <strong>One line.</strong> {SITE_NAME} lets drivers book verified repair shops at a price that is
                  locked before the car goes in.
                </p>
              </dd>
            </div>
            <div className={ROW} id="facts">
              <dt className={TERM}>Key facts</dt>
              <dd className={ANSWER}>
                <dl className="grid grid-cols-[130px_minmax(0,1fr)] gap-x-4 gap-y-2 text-[15px] leading-[1.55]">
                  {FACTS.map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt className="text-[#777169]">{k}</dt>
                      <dd className="m-0 text-[#4c5661]">{v}</dd>
                    </div>
                  ))}
                </dl>
              </dd>
            </div>
          </dl>
        </Reveal>
      </section>

      <section id="product" className="scroll-mt-28 pt-14 tab:pt-20">
        {/* Head as one block; the frame under it is a ProductStack, which is
            already on its own Rise, so it is left alone. */}
        <Reveal>
          <div className="grid gap-3 tab:grid-cols-12 tab:items-end tab:gap-8">
            <h2 className="serif-display max-w-[16ch] text-[32px] leading-[1.04] tracking-[-0.01em] text-[#1a1a1a] [text-wrap:balance] tab:col-span-6 tab:text-[38px]">The product, at a glance.</h2>
            <p className="max-w-[46ch] text-[17px] leading-[1.55] text-[#4c5661] tab:col-span-5 tab:col-start-8 tab:pb-1">Two products: the driver app, where Oto listens and the price is locked, and the shop dashboard, where the day runs. The frames below are drawn from the app&rsquo;s own components; press-ready captures are available by email.</p>
          </div>
        </Reveal>
        <div className="mt-10 tab:mt-14">
          <ProductStack />
        </div>
      </section>

      <section id="files" className="scroll-mt-28 pt-14 tab:pt-20">
        {/* The three marks are <li> under a <ul>, so the list arrives with the
            row it belongs to rather than being wrapped tile by tile. */}
        <Reveal>
          <dl className="flex flex-col divide-y divide-[#1a1a1a]/10 border-y border-[#1a1a1a]/10">
            <div className={ROW} id="assets">
              <dt className={TERM}>Brand assets</dt>
              <dd className={ANSWER}>
                <p>
                  Use the mark on a light or dark ground with clear space equal to its own width. Do not recolor it, add
                  effects, or place it inside another shape. The product name is written &ldquo;Otopair&rdquo; with one
                  capital; the assistant is &ldquo;Oto&rdquo;. All three files are transparent PNGs.
                </p>
                <ul className="mt-5 grid grid-cols-3 gap-3 sm:gap-4">
                  {ASSETS.map((a) => (
                    <li key={a.file}>
                      <div className="flex aspect-square items-center justify-center rounded-[18px] bg-[linear-gradient(to_bottom,#e9f3fa,#ffffff)] p-4 ring-1 ring-[#1a1a1a]/[0.06] sm:p-6">
                        <Image src={a.file} alt={`${SITE_NAME} ${a.name}`} width={a.w} height={a.h} className="h-auto max-h-full w-auto max-w-[70%]" />
                      </div>
                      <p className="mt-3 text-[14px] text-[#1a1a1a] sm:text-[15px]">{a.name}</p>
                      <p className="mt-0.5 text-[12px] tracking-[0.03em] text-[#777169] sm:text-[12.5px]">{a.spec}</p>
                      <a href={a.file} download className="mt-1.5 inline-block text-[14px]">
                        Download
                      </a>
                    </li>
                  ))}
                </ul>
              </dd>
            </div>
            <div className={ROW} id="contact">
              <dt className={TERM}>Contact</dt>
              <dd className={ANSWER}>
                <p>
                  <a href={`mailto:${SUPPORT_EMAIL}?subject=Press`}>{SUPPORT_EMAIL}</a> with &ldquo;Press&rdquo; in the
                  subject. For the company itself, see <Link href="/about">About</Link>; for how the network works for
                  shops, see <Link href="/partner-with-us">Partner with us</Link>.
                </p>
              </dd>
            </div>
          </dl>
        </Reveal>
      </section>
    </PageShell>
  );
}
