"use client";

import { Reveal, serif } from "./reveal";

const COLUMNS = [
  {
    stat: "100%",
    label: "of your rate, to you",
    body: "You set your hourly. The customer pays it in full. We never touch it.",
  },
  {
    stat: "7%",
    label: "Added for the customer",
    body: "A separate line on their invoice — not a cut of your price. Walk-ins pay zero.",
  },
  {
    stat: "24hr",
    label: "To your account",
    body: "Stripe Connect Express. Paid the day after the job is verified.",
  },
  {
    stat: "$0",
    label: "To join",
    body: "No subscription, no setup fee, no monthly. You earn, then we earn.",
  },
];

/** "You keep 100% of your rate." — the shops' payout promise, four neutral stat columns. */
export default function PayoutSection() {
  return (
    <section
      id="for-shops"
      className="mx-auto w-full max-w-[1440px] px-4 pt-28 sm:px-10 sm:pt-36 lg:px-[78px]"
    >
      <div className="flex flex-col gap-8 sm:flex-row sm:items-start sm:justify-between">
        <Reveal>
          <h2
            className="max-w-[660px] text-[40px] leading-[1.0] text-[#1a1a1a] sm:text-[54px] lg:text-[68px]"
            style={serif}
          >
            You keep 100% of your rate.
          </h2>
        </Reveal>

        <Reveal delay={0.1}>
          <div className="flex flex-wrap items-center gap-2.5">
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

      <div className="mt-16 grid grid-cols-1 gap-x-[58px] gap-y-12 sm:grid-cols-2 lg:mt-24 lg:grid-cols-4">
        {COLUMNS.map((col, i) => (
          <Reveal key={col.stat} delay={i * 0.1}>
            <div className="border-t border-[#1a1a1a]/40 pt-3">
              <p className="text-[25px] leading-[28px] text-[#1a1a1a]" style={serif}>
                {col.stat}
              </p>
              <p className="mt-3 text-[15px] font-medium leading-[23px] text-[#1a1a1a]">
                {col.label}
              </p>
              <p className="mt-2 max-w-[258px] text-[15px] leading-[23px] text-[#777169]">
                {col.body}
              </p>
            </div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}
