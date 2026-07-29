"use client";

import { Reveal, serif } from "./reveal";

const STATS = [
  {
    value: "Fixed",
    lines: ["Locked before you book,", "Never negotiate."],
  },
  {
    value: "$0",
    lines: ["No subscription.", "No Setup fee."],
  },
  {
    value: "Both",
    lines: ["iPhone & Android,", "from day one."],
  },
  {
    value: "90s",
    lines: ["From symptoms to", "booked."],
  },
];

/** Onboarding ticker band + centered "Why drivers download Oto" stats row (on cream). */
export default function WhyOtoSection() {
  return (
    <section className="w-full">
      {/* Now-onboarding band: centered serif line over a full-width hairline rule */}
      <Reveal>
        <div className="mx-auto w-full max-w-[1440px] px-4 sm:px-10 lg:px-[110px]">
          <p
            className="pb-5 pt-10 text-center text-[19px] leading-[1.4] text-[#1a1a1a] sm:text-[22px] sm:leading-[45px] lg:text-[25px]"
            style={serif}
          >
            Now onboarding · Staten Island, NYC
          </p>
          <div className="h-px w-full bg-[rgba(26,26,26,0.15)]" />
        </div>
      </Reveal>

      {/* Why-drivers stats block (centered, no card — transparent on cream) */}
      <div className="mx-auto w-full max-w-[1440px] px-4 pt-24 sm:px-10 sm:pt-32 lg:px-[108px]">
        <Reveal>
          <p className="text-center text-[15px] leading-[28px] tracking-[0.05em] text-[#777169]">
            THE NUMBERS
          </p>
          <h2
            className="mt-2 text-center text-[34px] leading-[1.3] text-[#1a1a1a] sm:text-[42px] lg:text-[50px] lg:leading-[75px]"
            style={serif}
          >
            Why drivers download Oto
          </h2>
        </Reveal>

        <Reveal delay={0.05}>
          <div className="mt-14 grid grid-cols-2 gap-y-12 lg:mt-16 lg:grid-cols-4 lg:gap-y-0">
            {STATS.map((stat, i) => (
              <div
                key={stat.value}
                className="relative flex flex-col px-5 sm:px-8 lg:px-10"
              >
                {/* Short vertical divider between columns */}
                {i % 2 === 1 && (
                  <span className="pointer-events-none absolute left-0 top-1/2 h-20 w-px -translate-y-1/2 bg-[rgba(119,113,105,0.2)] lg:hidden" />
                )}
                {i > 0 && (
                  <span className="pointer-events-none absolute left-0 top-1/2 hidden h-20 w-px -translate-y-1/2 bg-[rgba(119,113,105,0.2)] lg:block" />
                )}

                <span
                  className="text-[48px] leading-none tracking-[0.374px] text-[#1a1a1a] sm:text-[60px] lg:text-[70px]"
                  style={serif}
                >
                  {stat.value}
                </span>
                <span className="mt-4 text-[14px] leading-[20px] tracking-[0.05em] text-[#777169] sm:text-[15px]">
                  {stat.lines[0]}
                  <br />
                  {stat.lines[1]}
                </span>
              </div>
            ))}
          </div>
        </Reveal>

        <Reveal delay={0.1}>
          <div className="mt-14 flex flex-wrap items-center justify-center gap-3 lg:mt-16">
            <a
              href="#"
              aria-label="Download on the App Store"
              className="flex h-[47px] w-[180px] items-center justify-center rounded-[8px] bg-[#1a1a1a] transition-transform duration-300 hover:scale-[1.03]"
            >
              <img
                src="/images/landing/badge-app-store.svg"
                alt="Download on the App Store"
                width={96}
                height={25}
              />
            </a>
            <a
              href="#"
              aria-label="Get it on Google Play"
              className="flex h-[47px] w-[189px] items-center justify-center rounded-[8px] bg-[#1a1a1a] transition-transform duration-300 hover:scale-[1.03]"
            >
              <img
                src="/images/landing/badge-google-play.svg"
                alt="Get it on Google Play"
                width={100}
                height={24}
              />
            </a>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
