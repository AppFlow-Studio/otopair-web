import type { Metadata } from "next";
import Link from "next/link";
import PageShell from "@/components/flagship/page-shell";
import { PillAnchor } from "@/components/flagship/pill-button";
import { FaqList, type FaqItem } from "@/components/seo/faq";
import { JsonLd } from "@/components/seo/json-ld";
import { OTOINDEX, OTOINDEX_HOST, OTOINDEX_SAMPLES, OTOINDEX_URL } from "@/lib/otoindex";
import { DATA_EMAIL, SITE_NAME } from "@/lib/site";
import { DevelopersClient } from "./developers-client";

export const metadata: Metadata = {
  title: { absolute: "Developers: the Otopair car data API is OtoIndex" },
  description:
    "OEM fluid capacities, exact-fit parts, service intervals and real-world labor times by VIN or year, make and model. Try the sandbox with no signup, read the reference, and request access. The API is OtoIndex, a product of Otopair.",
  alternates: { canonical: "/developers" },
};

/**
 * /developers (2026-09-05): the hand-off to OtoIndex.
 *
 * The car-data API is its own product on its own origin (the `oto-facts`
 * repo; OtoIndex's layout declares Otopair as its parent organization).
 * This page used to be a second developer portal with its own copy of the
 * endpoint reference, which meant two front doors to one API. It is now
 * the connection: what the API returns, the keyless sandbox anyone can
 * curl, where the docs are, and how access is granted, every link
 * resolving through lib/otoindex.ts so one env var moves them all.
 *
 * The Clerk and Convex account island is still below the fold for people
 * who minted a key here before the split; nothing about the devPortal
 * contract changed.
 */
const RETURNS: [string, string][] = [
  ["Fluids", "OEM fluid types and capacities for the exact configuration, not the model line."],
  ["Parts", "Exact-fit parts for the job, with live prices where they are available."],
  ["Intervals", "The manufacturer's service schedule for that car, by service."],
  ["Labor", "Real-world labor times, measured on completed jobs rather than quoted from a book."],
];

const FAQ: FaqItem[] = [
  {
    q: "Is the car data API the same thing as Otopair?",
    a: "It is a product of Otopair, published under its own name, OtoIndex. Otopair is the repair marketplace drivers and shops use; OtoIndex is the vehicle-data catalogue underneath it, offered as an API. The same data prices a job in the Otopair app and answers a call to the API.",
  },
  {
    q: "Can I try it before asking for access?",
    a: "Yes. The sample endpoints are public, need no key and no signup, and return the real response shape for one reference vehicle. There is also an interactive console that runs against them in the browser.",
  },
  {
    q: "How do I get a key?",
    a: "By request while the API is pre-launch. Tell the team what you are building and they will come back to you. Self-serve keys and plans open at launch.",
  },
  {
    q: "Where do I look up a single car instead?",
    a: "The car data page on otopair.com decodes one vehicle by VIN or by year, make and model and shows a free teaser of what the catalogue holds for it. That is for looking, not for integrating.",
  },
];

const H2 = "serif-display max-w-[16ch] text-[32px] leading-[1.04] tracking-[-0.01em] text-[#1a1a1a] [text-wrap:balance] tab:text-[38px]";
const LEAD = "max-w-[46ch] text-[17px] leading-[1.55] text-[#4c5661] [text-wrap:pretty]";
const PROSE =
  "max-w-[62ch] text-[17px] leading-[1.65] text-[#4c5661] [text-wrap:pretty] [&_p+p]:mt-4 [&_a]:text-[#4B82A5] [&_a]:underline [&_a]:decoration-[#4B82A5]/40 [&_a]:underline-offset-[3px] [&_a:hover]:decoration-[#4B82A5]";
const LINK = "text-[#4B82A5] underline decoration-[#4B82A5]/40 underline-offset-[3px] hover:decoration-[#4B82A5]";

function Head({ id, title, line }: { id: string; title: string; line: string }) {
  return (
    <div id={id} className="grid scroll-mt-28 gap-3 tab:grid-cols-12 tab:items-end tab:gap-8">
      <h2 className={`${H2} tab:col-span-6`}>{title}</h2>
      <p className={`${LEAD} tab:col-span-5 tab:col-start-8 tab:pb-1`}>{line}</p>
    </div>
  );
}

/** A terminal block. The requests in it are real: these endpoints are
 *  public, keyless and CORS-open on the OtoIndex origin. */
function Terminal({ lines, caption }: { lines: { cmd: string; note?: string }[]; caption?: string }) {
  return (
    <figure className="w-full min-w-0 overflow-hidden rounded-[20px] bg-[#0f1519] shadow-[0_24px_60px_rgba(20,40,80,0.18)]">
      <div className="flex h-[38px] items-center gap-[7px] border-b border-white/8 px-4">
        {["#FF5F57", "#FEBC2E", "#28C840"].map((c) => (
          <span key={c} className="h-[10px] w-[10px] rounded-full" style={{ backgroundColor: c }} />
        ))}
        <span className="ml-2 font-mono text-[11.5px] text-white/40">{OTOINDEX_HOST}</span>
      </div>
      <div className="overflow-x-auto px-5 py-4">
        <pre className="font-mono text-[12.5px] leading-[1.9] text-[#d7e3ea]">
          {lines.map((l) => (
            <span key={l.cmd} className="block whitespace-pre">
              <span className="select-none text-[#4B82A5]">$ </span>
              {l.cmd}
              {l.note ? <span className="text-white/35">{`  # ${l.note}`}</span> : null}
            </span>
          ))}
        </pre>
      </div>
      {caption && <figcaption className="border-t border-white/8 px-5 py-3 text-[12.5px] text-white/45">{caption}</figcaption>}
    </figure>
  );
}

export default function DevelopersPage() {
  return (
    <PageShell
      title="The car data behind Otopair, as an API."
      lede={`Fluid capacities, exact-fit parts, service intervals and real-world labor times, by VIN or by year, make and model. It is published as OtoIndex, a product of ${SITE_NAME}, on its own site.`}
      crumbs={[
        { name: "Home", href: "/" },
        { name: "Developers", href: "/developers" },
      ]}
      hero={
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <PillAnchor href={OTOINDEX.docs} icon="external">
            Read the API reference
          </PillAnchor>
          <a href={OTOINDEX.quickstart} className="text-[15px] text-[#1a1a1a] underline decoration-[#1a1a1a]/25 underline-offset-[4px] transition-colors hover:decoration-[#1a1a1a]">
            Or open the console
          </a>
        </div>
      }
      visual={
        <Terminal
          lines={OTOINDEX_SAMPLES.map((s) => ({ cmd: `curl ${OTOINDEX_URL}${s.path}` }))}
          caption="Public sample endpoints. No key, no signup, real response shapes."
        />
      }
      visualFrame={false}
      width="wide"
    >
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "FAQPage",
          mainEntity: FAQ.map((it) => ({
            "@type": "Question",
            name: it.q,
            acceptedAnswer: { "@type": "Answer", text: it.a },
          })),
        }}
      />

      {/* ---------- What comes back ---------- */}
      <section className="scroll-mt-28">
        <Head
          id="returns"
          title="What comes back."
          line="One request, one configuration. Not the model line, not an average of the trims."
        />
        <dl className="mt-8 flex flex-col divide-y divide-[#1a1a1a]/10 border-y border-[#1a1a1a]/10">
          {RETURNS.map(([k, v]) => (
            <div key={k} className="grid gap-2 py-6 tab:grid-cols-[minmax(0,1fr)_minmax(0,3fr)] tab:gap-x-10 tab:py-7">
              <dt className="serif-text text-[21px] leading-[1.3] text-[#1a1a1a]">{k}</dt>
              <dd className="max-w-[60ch] text-[16px] leading-[1.6] text-[#4c5661]">{v}</dd>
            </div>
          ))}
        </dl>
        <p className={`mt-6 ${PROSE}`}>
          Every value carries the layer it came from, so you can see whether a number is manufacturer data, our own
          research, something measured on a completed job, or a figure a mechanic confirmed by hand.{" "}
          <Link href="/about#build">How the catalogue is built</Link>.
        </p>
      </section>

      {/* ---------- Try it ---------- */}
      <section className="mt-16 scroll-mt-28 border-t border-[#1a1a1a]/10 pt-16 tab:mt-20 tab:pt-20">
        <Head
          id="try"
          title="Try it without an account."
          line="The sandbox mirrors the real routes for one reference vehicle. Nothing to sign, nothing to install."
        />
        <div className="mt-10 grid items-start gap-10 tab:mt-12 tab:grid-cols-12 tab:gap-12">
          <ul className="flex min-w-0 flex-col divide-y divide-[#1a1a1a]/10 border-y border-[#1a1a1a]/10 tab:col-span-5">
            {OTOINDEX_SAMPLES.map((s) => (
              <li key={s.path} className="py-4">
                <code className="block break-all font-mono text-[13px] text-[#1a1a1a]">{s.path}</code>
                <p className="mt-1 text-[15px] leading-[1.55] text-[#4c5661]">{s.what}</p>
              </li>
            ))}
          </ul>
          <div className="min-w-0 tab:col-span-7">
            <Terminal
              lines={[
                { cmd: `curl ${OTOINDEX_URL}${OTOINDEX_SAMPLES[0].path}`, note: "keyless" },
                { cmd: `curl ${OTOINDEX_URL}/api/v1/fluids?vin=… \\` },
                { cmd: `  -H "Authorization: Bearer otp_live_…"`, note: "with a key" },
              ]}
              caption="Same routes, same shapes. A key swaps the sample vehicle for any car in the catalogue."
            />
            <p className="mt-5 text-[15px] leading-[1.55] text-[#4c5661]">
              The{" "}
              <a href={OTOINDEX.quickstart} className={LINK}>
                interactive console
              </a>{" "}
              runs the same calls in the browser, with pickers for the vehicle, the service and the fields you want
              included.
            </p>
          </div>
        </div>
      </section>

      {/* ---------- Docs and access ---------- */}
      <section className="mt-16 scroll-mt-28 border-t border-[#1a1a1a]/10 pt-16 tab:mt-20 tab:pt-20">
        <Head
          id="access"
          title="Docs, and how access works."
          line="Everything a developer needs lives on the OtoIndex site. Keys are issued by request while it is pre-launch."
        />
        <div className="mt-10 grid gap-x-12 gap-y-8 tab:grid-cols-2">
          {[
            { t: "The reference", b: "Every endpoint, its parameters and a live example response.", href: OTOINDEX.docs, l: "Open the reference" },
            { t: "Authentication", b: "How a Bearer key is sent, how keys are scoped, and what happens when one is rotated.", href: OTOINDEX.authentication, l: "Authentication" },
            { t: "Errors and rate limits", b: "The error shape, the codes it uses, and the per-minute and daily ceilings.", href: OTOINDEX.errors, l: "Errors" },
            { t: "Coverage and status", b: "Which vehicles the catalogue answers for today, and whether the service is up right now.", href: OTOINDEX.coverage, l: "Coverage" },
          ].map((c) => (
            <div key={c.t} className="border-t border-[#1a1a1a]/10 pt-5">
              <h3 className="serif-text text-[21px] leading-[1.25] text-[#1a1a1a]">{c.t}</h3>
              <p className="mt-2 max-w-[46ch] text-[16px] leading-[1.6] text-[#4c5661]">{c.b}</p>
              <a href={c.href} className={`mt-3 inline-block text-[14.5px] ${LINK}`}>
                {c.l}
              </a>
            </div>
          ))}
        </div>
        <div className={`mt-10 ${PROSE}`}>
          <p>
            Access is granted by request for now: say what you are building and the team answers from a real inbox.
            Self-serve keys and published plans open at launch, on{" "}
            <a href={OTOINDEX.pricing} className={LINK}>
              the access page
            </a>
            .
          </p>
        </div>
        <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
          <PillAnchor href={OTOINDEX.contact} icon="external">
            Request access
          </PillAnchor>
          <a href={`mailto:${DATA_EMAIL}?subject=Data%20API%20access`} className="text-[15px] text-[#1a1a1a] underline decoration-[#1a1a1a]/25 underline-offset-[4px] transition-colors hover:decoration-[#1a1a1a]">
            Or email {DATA_EMAIL}
          </a>
        </div>
      </section>

      {/* ---------- Questions, and the account island ---------- */}
      <section className="mt-16 scroll-mt-28 border-t border-[#1a1a1a]/10 pt-16 tab:mt-20 tab:pt-20">
        <h2 className={H2}>Questions developers ask.</h2>
        <FaqList items={FAQ} className="mt-8 border-b border-[#1a1a1a]/10 [&_dd]:max-w-[60ch]" />
        <p className="mt-8 text-[15px] text-[#4c5661]">
          Looking up one car rather than integrating?{" "}
          <Link href="/car-data" className={LINK}>
            The car data lookup
          </Link>{" "}
          decodes a VIN or a year, make and model and shows what the catalogue holds for it.
        </p>
        <div className="mt-12">
          <DevelopersClient />
        </div>
      </section>
    </PageShell>
  );
}
