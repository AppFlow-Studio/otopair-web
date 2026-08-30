import type { Metadata } from "next";
import Link from "next/link";

// /data — the umbrella landing for Otopair's car-data product. One hero, two
// clearly-labelled lanes: consumers look up their car (→ /car-data, lead-gen
// into booking), developers build on the API (→ /developers). States the ONE
// differentiator — tracked per-field provenance + maintenance-grade depth —
// and previews the data groups. Static server component (SEO + fast).

export const metadata: Metadata = {
  title: "Car Data — Otopair",
  description:
    "Maintenance-grade vehicle data with tracked provenance: OEM fluid capacities, service intervals, exact-fit OEM parts with live prices, and labor times measured from real jobs. Look up your car free, or build on the API.",
  openGraph: {
    title: "Otopair Car Data",
    description:
      "OEM fluids, intervals, exact-fit parts with live prices, and real-world labor times — every field tagged with where it came from.",
  },
};

const ink = "#1a1a1a";
const muted = "#6b655d";

const CARD = "rounded-2xl border border-[#dcd8d0] bg-[#f7f5f1] p-6";

// The per-car data groups, grouped the way a buyer reads them. `depth` marks
// where our coverage is strongest so we don't over-promise.
const GROUPS: Array<{ title: string; blurb: string; depth: "deep" | "growing" }> = [
  {
    title: "Fluids & capacities",
    blurb:
      "Engine oil viscosity + capacity, coolant, transmission, brake, power-steering, and differential / transfer-case fluids.",
    depth: "deep",
  },
  {
    title: "Maintenance schedule",
    blurb: "OEM service intervals by miles and months, with confidence and mechanic-verified flags.",
    depth: "deep",
  },
  {
    title: "Parts & live prices",
    blurb: "Exact-fit OEM part numbers per service, position and quantity — each with a current scraped price.",
    depth: "deep",
  },
  {
    title: "Tires & wheels",
    blurb: "Full OEM fitment package: sizes, recommended pressures, load index, run-flat / staggered, battery CCA.",
    depth: "deep",
  },
  {
    title: "Empirical labor",
    blurb: "Labor times measured from completed jobs — hours with p25–p75 spread — plus a tier-model estimate.",
    depth: "growing",
  },
  {
    title: "Provenance",
    blurb: "Every value carries its data layer (OEM / sourced / empirical / verified), confidence, and source domain.",
    depth: "deep",
  },
];

function LaneCard({
  href,
  eyebrow,
  title,
  blurb,
  cta,
  external,
}: {
  href: string;
  eyebrow: string;
  title: string;
  blurb: string;
  cta: string;
  external?: boolean;
}) {
  return (
    <Link
      href={href}
      className="group flex flex-col rounded-2xl border border-[#dcd8d0] bg-[#f7f5f1] p-7 shadow-sm transition hover:border-[#2f7bff] hover:shadow-md"
    >
      <span className="text-[12px] font-semibold uppercase tracking-wider" style={{ color: "#2f7bff" }}>
        {eyebrow}
      </span>
      <h3 className="mt-2 text-2xl" style={{ fontFamily: "var(--font-Lora)", color: ink }}>
        {title}
      </h3>
      <p className="mt-3 flex-1 text-[14px] leading-6" style={{ color: muted }}>
        {blurb}
      </p>
      <span
        className="mt-5 inline-flex items-center gap-1 text-[14px] font-semibold transition group-hover:gap-2"
        style={{ color: ink }}
      >
        {cta}
        <span aria-hidden>{external ? "↗" : "→"}</span>
      </span>
    </Link>
  );
}

export default function DataLandingPage() {
  return (
    <main className="min-h-screen w-full bg-[#eceae6] px-4 pb-24 pt-28 md:pt-32">
      <div className="mx-auto max-w-5xl">
        {/* Hero */}
        <div className="text-center">
          <span className="text-[12px] font-semibold uppercase tracking-wider" style={{ color: muted }}>
            Otopair Car Data
          </span>
          <h1
            className="mx-auto mt-3 max-w-3xl text-4xl leading-tight md:text-5xl"
            style={{ fontFamily: "var(--font-Lora)", color: ink }}
          >
            The data behind every repair.
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-[16px] leading-7" style={{ color: muted }}>
            Not another VIN decoder. Maintenance-grade depth — real OEM fluid capacities, exact-fit
            OEM part numbers with live prices, and labor times measured from completed jobs — and
            every single value carries tracked provenance: where it came from, how confident we are,
            and which data layer it sits in.
          </p>
        </div>

        {/* Two lanes */}
        <div className="mt-12 grid gap-5 md:grid-cols-2">
          <LaneCard
            href="/car-data"
            eyebrow="For car owners"
            title="Look up your car"
            blurb="Enter a VIN or year / make / model and see the specs, intervals and parts for your exact car — free, no account. Then book the work with a vetted shop."
            cta="Look up my car"
          />
          <LaneCard
            href="/developers"
            eyebrow="For developers & businesses"
            title="Build with the API"
            blurb="A clean, versioned REST API — by VIN, year/make/model, or config key. Mint a free key in under a minute; all read scopes, 60 requests/min, no card."
            cta="Get an API key"
          />
        </div>

        {/* What's in the data */}
        <section className="mt-20">
          <h2 className="text-center text-2xl md:text-3xl" style={{ fontFamily: "var(--font-Lora)", color: ink }}>
            What we know about a car
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-center text-[15px]" style={{ color: muted }}>
            Identify a vehicle by VIN, year/make/model, or config key — then pull any of these,
            on their own or all at once.
          </p>
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {GROUPS.map((g) => (
              <div key={g.title} className={CARD}>
                <div className="flex items-center gap-2">
                  <h3 className="text-[16px] font-semibold" style={{ color: ink }}>
                    {g.title}
                  </h3>
                  <span
                    className={`ml-auto inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                      g.depth === "deep"
                        ? "bg-emerald-100 text-emerald-700"
                        : "bg-amber-100 text-amber-700"
                    }`}
                  >
                    {g.depth === "deep" ? "deep coverage" : "growing"}
                  </span>
                </div>
                <p className="mt-2 text-[13px] leading-5" style={{ color: muted }}>
                  {g.blurb}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* Differentiator strip */}
        <section className="mt-20 rounded-2xl border border-[#dcd8d0] bg-[#1a1a1a] p-8 md:p-10">
          <h2 className="text-2xl md:text-3xl text-white" style={{ fontFamily: "var(--font-Lora)" }}>
            Provenance is the product.
          </h2>
          <p className="mt-4 max-w-2xl text-[15px] leading-7 text-[#cfcabf]">
            Free VIN decoders tell you the make, model and engine. We tell you the 2019 CR-V takes
            3.7&nbsp;qt of 0W-20, here is the OEM oil-filter part number, here is what it costs today,
            and here is how long the job actually takes — each value tagged with its source and a
            confidence score. Licensed third-party rows are excluded and <em>listed</em>, so the gate
            is visible, never silent.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <Link
              href="/developers"
              className="rounded-xl bg-white px-5 py-2.5 text-[14px] font-semibold text-[#1a1a1a] transition hover:brightness-95"
            >
              Read the API docs
            </Link>
            <Link
              href="/car-data"
              className="rounded-xl border border-white/30 px-5 py-2.5 text-[14px] font-semibold text-white transition hover:bg-white/10"
            >
              Try a free lookup
            </Link>
          </div>
        </section>
      </div>
    </main>
  );
}
