"use client";

import { Check } from "lucide-react";
import { Waveform } from "../voice-bar";
import { PopIn, Reveal, Seq, SeqPop, Sequence, serif, serifDisplay } from "./reveal";

/* ------------------------------------------------------------------ */
/*  Live quote assembly — three overlapping shop cards                 */
/* ------------------------------------------------------------------ */

function ShopCard({
  name,
  meta,
  price,
  tone = "white",
  best = false,
  className,
}: {
  name: string;
  meta: string;
  price: string;
  tone?: "white" | "cream";
  best?: boolean;
  className?: string;
}) {
  const toneClass =
    tone === "cream"
      ? "bg-[#e4e2dd]/90 opacity-75"
      : best
        ? "bg-white/85 ring-1 ring-inset ring-white shadow-[0_12px_34px_rgba(0,0,0,0.10)]"
        : "bg-white/70 shadow-[0_4px_10px_rgba(0,0,0,0.05)]";

  return (
    <div
      className={`w-full rounded-[12px] px-4 py-3 backdrop-blur-md ${toneClass} ${className ?? ""}`}
    >
      {best && (
        <span className="mb-1.5 inline-flex rounded-full bg-white px-2 py-[3px] text-[8px] font-medium tracking-[0.08em] text-[#1a1a1a]">
          BEST VALUE
        </span>
      )}
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-[13px] tracking-[0.05em] text-[#1a1a1a]">{name}</p>
          <p className="mt-0.5 text-[11px] tracking-[0.05em] text-[#777169]">{meta}</p>
        </div>
        <span
          className="shrink-0 text-[20px] leading-none tracking-[0.05em] text-[#1a1a1a]"
          style={{ ...serif, fontWeight: 500 }}
        >
          {price}
        </span>
      </div>
    </div>
  );
}

/* One clock for the whole block: the quotes land in price order — the two
   outliers first, the BEST VALUE card last and on top — then the label and copy
   arrive to name what just assembled. `delay` trails the Voice Intake box. */
const QUOTE = {
  precision: 0,
  forest: 0.16,
  best: 0.34,
  heading: 0.46,
  copy: 0.56,
} as const;

function LiveQuoteBlock() {
  return (
    <Sequence delay={0.1} className="flex flex-col">
      {/* Floating, overlapping shop cards — quotes arrive one by one, the
          BEST VALUE card landing last, on top. */}
      <div className="relative flex flex-col gap-3 lg:block lg:h-[220px]">
        <SeqPop
          at={QUOTE.precision}
          y={14}
          className="z-20 lg:absolute lg:left-[41%] lg:top-0 lg:w-[376px]"
        >
          <ShopCard name="Precision Motors" meta="1.2 mi  ★ 4.5 · Today" price="$320" />
        </SeqPop>
        <SeqPop
          at={QUOTE.best}
          y={16}
          scale={0.92}
          className="z-30 lg:absolute lg:left-[14%] lg:top-[42px] lg:w-[376px]"
        >
          <ShopCard name="Eltingville Auto Care" meta="0.8 mi  ★ 4.9 · Today" price="$124" best />
        </SeqPop>
        <SeqPop
          at={QUOTE.forest}
          y={14}
          className="z-10 lg:absolute lg:left-[44%] lg:top-[150px] lg:w-[376px]"
        >
          <ShopCard
            name="Forest Ave German"
            meta="2.2 mi  ★ 4.7 · Tomorrow"
            price="$340"
            tone="cream"
          />
        </SeqPop>
      </div>

      <div className="mt-8 lg:mt-6">
        <Seq at={QUOTE.heading} y={16}>
          <h3 className="text-[25px] leading-[1.1] text-[#1a1a1a]" style={serif}>
            Live quote assembly
          </h3>
        </Seq>
        <Seq at={QUOTE.copy} y={14} className="mt-4">
          <p className="max-w-[400px] text-[17px] leading-[26px] text-[#777169]">
            Labor hours × each shop&apos;s own rate, plus itemized parts, plus the flat 7% line.
            Real shops, real totals.
          </p>
        </Seq>
      </div>
    </Sequence>
  );
}

/* ------------------------------------------------------------------ */
/*  Voice intake — hairline box                                        */
/* ------------------------------------------------------------------ */

function VoiceIntakeBox() {
  return (
    <div className="flex min-h-[386px] flex-col rounded-[20px] border border-[#1a1a1a]/12 px-8 py-10 lg:px-14 lg:pt-[72px]">
      <h3 className="text-[25px] leading-[1.1] text-[#1a1a1a]" style={serif}>
        Voice Intake
      </h3>
      <p className="mt-6 max-w-[368px] text-[17px] leading-[26px] text-[#777169]">
        You describe the car and the symptom out loud — no forms, no typing. Oto transcribes and
        understands as you speak.
      </p>

      <div className="mt-auto pt-10">
        <div className="flex items-center gap-4">
          <Waveform active bars={8} className="h-[52px] text-[#1a1a1a]" />
          <span
            className="text-[17px] italic leading-none tracking-[0.05em] text-[#1a1a1a]"
            style={serif}
          >
            → real time
          </span>
        </div>
        <div className="mt-6 max-w-[368px] border-t border-dashed border-[#1a1a1a]/20" />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Verified capture & payout — blue blob card                         */
/* ------------------------------------------------------------------ */

function GlassTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[10px] border border-white/15 bg-white/10 px-4 py-2.5 backdrop-blur-md">
      <p className="text-[13px] tracking-[0.05em] text-white/60">{label}</p>
      <p className="text-[15px] leading-[22px] text-white">{value}</p>
    </div>
  );
}

function BlueBlobCard() {
  return (
    <div
      className="relative min-h-[245px] overflow-hidden rounded-[20px] px-8 py-10 text-white lg:px-12"
      style={{
        background:
          "radial-gradient(130% 130% at 22% 22%, #7fb6f8 0%, #4a8bf0 55%, #3778e6 100%)",
      }}
    >
      <div className="flex flex-col gap-8 lg:flex-row lg:items-center lg:justify-between">
        <div className="max-w-[240px]">
          <h3 className="text-[25px] leading-[1.05] text-white" style={serif}>
            Verified capture &amp; payout
          </h3>
          <p className="mt-5 text-[17px] leading-[26px] text-white">
            Funds capture only after verification. Shop paid within 24 hours. Disputes refund
            automatically.
          </p>
        </div>
        <div className="flex w-full flex-col gap-3 lg:w-[278px]">
          <GlassTile label="Status" value="Verified" />
          <GlassTile label="Payout" value="Within 24hrs" />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Secure authorization — hairline box                                */
/* ------------------------------------------------------------------ */

function SecureAuthBox() {
  return (
    <div className="relative flex min-h-[242px] flex-col rounded-[20px] border border-[#1a1a1a]/12 px-8 py-10 lg:px-14">
      {/* Floating "Your booking / Secure" tile, top-right — snaps in after
          the box reveals, check first. */}
      <PopIn delay={0.35} y={14} scale={0.9} className="mb-8 self-end lg:absolute lg:right-8 lg:top-4 lg:mb-0">
        <div className="inline-flex items-center gap-3 rounded-[10px] border border-white/60 bg-white/70 px-4 py-3 shadow-[0_10px_30px_rgba(0,0,0,0.06)] backdrop-blur-md">
          <PopIn delay={0.55} scale={0.4} y={0} className="shrink-0">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[#1a1a1a]">
              <Check className="h-4 w-4 text-[#fffbf2]" strokeWidth={2.4} />
            </span>
          </PopIn>
          <div>
            <p className="text-[13px] tracking-[0.05em] text-[#777169]">Your booking</p>
            <p className="text-[15px] leading-[22px] text-[#1a1a1a]">Secure</p>
          </div>
        </div>
      </PopIn>

      <div className="mt-auto">
        <h3 className="text-[25px] leading-[1.1] text-[#1a1a1a]" style={serif}>
          Secure Authorization
        </h3>
        <p className="mt-4 max-w-[400px] text-[17px] leading-[26px] text-[#777169]">
          Apple Pay, Stripe, and MCC 7538 compliance. Your money doesn&apos;t move until the job is
          done.
        </p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Section                                                            */
/* ------------------------------------------------------------------ */

/** "The whole path, shown." — voice intake → live quote → verified payout → secure auth. */
export default function PathSection() {
  return (
    <section className="mx-auto w-full max-w-[1440px] px-4 pt-28 sm:px-10 sm:pt-36 lg:px-[78px]">
      <Reveal>
        <h2
          className="max-w-[600px] text-[40px] leading-[1.0] text-[#1a1a1a] sm:text-[54px] lg:text-[68px]"
          style={serifDisplay}
        >
          The whole path, shown.
        </h2>
      </Reveal>

      <div className="mt-14 flex flex-col gap-5 lg:mt-20">
        {/* Row 1 — Voice intake (≈40%) + Live quote assembly (≈55%) */}
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[466fr_710fr]">
          <Reveal>
            <VoiceIntakeBox />
          </Reveal>
          <LiveQuoteBlock />
        </div>

        {/* Row 2 — Verified payout blob (≈55%) + Secure authorization (≈42%) */}
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[660fr_515fr]">
          <Reveal>
            <BlueBlobCard />
          </Reveal>
          <Reveal delay={0.1}>
            <SecureAuthBox />
          </Reveal>
        </div>
      </div>
    </section>
  );
}
