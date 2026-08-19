"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import dynamic from "next/dynamic";
import { useInView } from "motion/react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { CountUp } from "../shared";
import { Reveal, serif, serifDisplay } from "./reveal";
import MapLoading from "./map-loading";
import { avgNearestMiles, mergeNetworkPins } from "./network-pins";

const HAIRLINE = "rgba(26,26,26,0.12)";

const BOROUGHS = [
  { num: "01.", name: "Staten Island", date: "June 1, 2026" },
  { num: "02.", name: "Brooklyn", date: "Q3 2026" },
  { num: "03.", name: "Queens", date: "Q4 2026" },
  { num: "04.", name: "The Bronx", date: "Q1 2027" },
  { num: "05.", name: "Manhattan", date: "Q2 2027" },
];

type Signup = { name: string; when: string; badge: "Verified" | "Onboarding" };

// Stand-in feed entries — only ever FILL below three real signups, same
// policy as the map's curated pins.
const SIGNUPS: Signup[] = [
  { name: "Bay Ridge Motors", when: "just now", badge: "Verified" },
  { name: "Port Richmond Service", when: "4 min ago", badge: "Onboarding" },
  { name: "Eltingville Auto Care", when: "12 min ago", badge: "Verified" },
];

function timeAgo(ms: number): string {
  const mins = Math.floor((Date.now() - ms) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days} day${days > 1 ? "s" : ""} ago`;
  const wks = Math.floor(days / 7);
  return `${wks} wk${wks > 1 ? "s" : ""} ago`;
}

/**
 * The pre-Mapbox static render — SSR placeholder and no-token/WebGL fallback.
 *
 * Regenerated from the live light-mode map at its resting camera (see
 * .agent/pw/make-light-fallback.mjs). The previous asset was the dark 3D
 * render: against a light basemap it flashed dark before the map arrived, and
 * the deferred boot keeps this placeholder on screen longer than it used to be.
 */
function MapImageFallback() {
  return (
    <Image
      src="/images/landing/nyc-map-light.jpg"
      alt="Map of the NYC network coverage area"
      fill
      sizes="(max-width: 1024px) 100vw, 70vw"
      className="object-cover"
    />
  );
}

// mapbox-gl is ~1.8 MB of client JS — load it only in the browser, and only
// once the section is approaching the viewport.
const CoverageMap = dynamic(() => import("./coverage-map"), {
  ssr: false,
  loading: () => <MapLoading />,
});

/**
 * Is the phone-story section currently on screen?
 *
 * Booting mapbox parses ~1.8 MB and compiles WebGL shaders — one ~1.2s
 * main-thread block. A distance-only preload gate fires ~20% into the story
 * section's on-screen window, so that block used to land right on top of the
 * story's per-frame animation work and read as scroll stutter. Nothing about
 * the map's own geometry can express "don't stutter the section above me", so
 * we watch that section directly.
 */
function useStoryOnScreen(): boolean {
  const [onScreen, setOnScreen] = useState(false);
  useEffect(() => {
    const story = document.getElementById("how-it-works");
    if (!story) return; // story section absent — nothing to protect
    const io = new IntersectionObserver(([e]) => setOnScreen(e.isIntersecting), {
      threshold: 0,
    });
    io.observe(story);
    return () => io.disconnect();
  }, []);
  return onScreen;
}

/**
 * Resolves true at the first moment the page is not scrolling AND the main
 * thread is free — and stays true.
 *
 * Booting mapbox is a single unsplittable block: parse ~1.8 MB, compile the
 * Standard style's shaders, build its 3D objects. Measured headed on the live
 * page, that first boot produced 11 long tasks totalling 2,575 ms, 10 of them
 * landing mid-scroll, with a worst frame of 536 ms; with the chunk blocked the
 * identical scroll ran 0 long tasks and a 20 ms worst frame. So the block is
 * 100% of the stutter, and none of it is avoidable work — the fix is to spend
 * it while nothing is moving, where a busy main thread costs the visitor
 * nothing. The idle callback carries a timeout so a visitor who never stops
 * scrolling still gets a map.
 */
const SCROLL_SETTLE_MS = 180;

function useQuietMoment(armed: boolean): boolean {
  const [quiet, setQuiet] = useState(false);
  useEffect(() => {
    if (!armed || quiet) return;
    let settle: number | undefined;
    let idle: number | undefined;
    // Captured rather than probed with `in window`: that form narrows `window`
    // itself to never in the negative branch, since the DOM lib declares these
    // as always present.
    const ric = typeof window.requestIdleCallback === "function" ? window.requestIdleCallback.bind(window) : null;
    const cic = typeof window.cancelIdleCallback === "function" ? window.cancelIdleCallback.bind(window) : null;
    const cancelIdle = () => {
      if (idle === undefined) return;
      cic?.(idle);
      idle = undefined;
    };
    // Every scroll event pushes the boot back out; it only fires once the
    // wheel has been still for SCROLL_SETTLE_MS and the thread has a gap.
    const arm = () => {
      window.clearTimeout(settle);
      cancelIdle();
      settle = window.setTimeout(() => {
        if (ric) idle = ric(() => setQuiet(true), { timeout: 1200 });
        else settle = window.setTimeout(() => setQuiet(true), 0);
      }, SCROLL_SETTLE_MS);
    };
    arm();
    window.addEventListener("scroll", arm, { passive: true });
    return () => {
      window.removeEventListener("scroll", arm);
      window.clearTimeout(settle);
      cancelIdle();
    };
  }, [armed, quiet]);
  return quiet;
}

/** "Network coverage across NYC boroughs" — rollout timeline, live map, network stats. */
export default function CoverageSection() {
  const mapCellRef = useRef<HTMLDivElement>(null);
  // Mount + boot the map ahead of arrival (tiles and WebGL warm up on the
  // skyline hold), then hand CoverageMap a "play" signal when the cell is
  // actually on screen so the cinematic sweep never runs unseen.
  const nearView = useInView(mapCellRef, { once: true, margin: "1800px 0px" });

  // Warm up early, but never while the story section is still on screen (see
  // useStoryOnScreen) and never mid-scroll (see useQuietMoment). Latched via a
  // ref rather than an effect: the condition is monotonic, so once the map
  // boots it stays booted and scrolling back up never pays the cost twice.
  const storyOnScreen = useStoryOnScreen();
  const quiet = useQuietMoment(nearView && !storyOnScreen);
  // useQuietMoment only ever listens while it is armed and only ever flips
  // false -> true, so `quiet` IS the latch: it can only have become true at a
  // moment the map was cleared to boot, and it never goes back.
  const booted = quiet;

  // Live network data. Real signups lead the feed (stand-ins only fill below
  // three), and the avg-distance stat is computed from the same merged pin
  // set the map renders. Both settle client-side — SSR shows the stand-ins.
  const liveSignups = useQuery(api.landing.recentSignups);
  const livePins = useQuery(api.landing.shopPins);
  const signups = useMemo<Signup[]>(() => {
    const real: Signup[] = (liveSignups ?? []).map((s) => ({
      name: s.name,
      when: timeAgo(s.joinedAt),
      badge: s.verified ? "Verified" : "Onboarding",
    }));
    // Fill entries sit BELOW the real ones, so when real signups lead, their
    // fresh "just now" labels would read out of order — age them instead.
    const olderWhens = ["2 wks ago", "3 wks ago", "1 mo ago"];
    const fill = SIGNUPS.filter((f) => !real.some((r) => r.name === f.name)).map((f, i) =>
      real.length > 0 ? { ...f, when: olderWhens[i] ?? f.when } : f,
    );
    return [...real, ...fill].slice(0, 3);
  }, [liveSignups]);
  const avgMi = useMemo(() => {
    const v = avgNearestMiles(mergeNetworkPins(livePins));
    return v === null ? 1.4 : Math.round(v * 10) / 10;
  }, [livePins]);
  return (
    <section
      id="coverage"
      className="mx-auto w-full max-w-[1440px] px-4 pt-28 sm:px-10 sm:pt-36 lg:px-[78px]"
    >
      {/* V1's content box for this band is the same centred 1190 as the payout
          section — measured off the render: bar 121->1303, sidebar ends 1305. */}
      <div className="mx-auto w-full max-w-[1190px]">
        <Reveal>
          <h2
            className="max-w-[760px] text-[40px] leading-[1.02] text-[#1a1a1a] sm:text-[54px] lg:text-[68px]"
            style={serifDisplay}
          >
            Network coverage across NYC boroughs
          </h2>
        </Reveal>

        {/* Rollout timeline. V1 carries the numbers on ONE pale bar (26px tall,
            r8, #EBF5FB) and sets the boroughs on plain white beneath it — no
            grid box, no vertical dividers, no second tinted block. */}
        <Reveal delay={0.1}>
          <div className="mt-12 sm:mt-16 lg:mt-[68px]">
            <div className="hidden lg:block">
              <div className="grid grid-cols-5 rounded-[8px] bg-[#EBF5FB]">
                {BOROUGHS.map((b) => (
                  <span
                    key={b.num}
                    className="px-3 py-[3px] text-[13px] leading-[20px] tracking-[0.05em] text-[#777169]"
                  >
                    {b.num}
                  </span>
                ))}
              </div>
              <div className="mt-3 grid grid-cols-5">
                {BOROUGHS.map((b) => (
                  <div key={b.name} className="px-3">
                    <p className="text-[20px] leading-[26px] text-[#1a1a1a]" style={serif}>
                      {b.name}
                    </p>
                    <p className="mt-1.5 text-[13px] leading-[18px] text-[#777169]">{b.date}</p>
                  </div>
                ))}
              </div>
            </div>

            {/* Below lg the bar-and-row split would orphan each number from its
                borough, so the stack keeps them together in one tinted cell. */}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:hidden">
              {BOROUGHS.map((b) => (
                <div key={b.name} className="rounded-[8px] bg-[#EBF5FB] px-4 py-4">
                  <span className="block text-[12px] tracking-[0.05em] text-[#777169]">{b.num}</span>
                  <p className="mt-1 text-[19px] leading-[26px] text-[#1a1a1a]" style={serif}>
                    {b.name}
                  </p>
                  <p className="text-[13px] leading-[20px] text-[#777169]">{b.date}</p>
                </div>
              ))}
            </div>
          </div>
        </Reveal>

        {/* Map and sidebar. V1 separates them with a 41px gutter rather than
            welding them into one bordered panel, and the sidebar carries the
            same #EBF5FB tint as the bar above. */}
        <Reveal delay={0.15}>
          <div className="mt-10 grid grid-cols-1 gap-6 lg:mt-[54px] lg:grid-cols-[minmax(0,1fr)_250px] lg:gap-[41px]">
            <div
              ref={mapCellRef}
              className="relative h-[380px] overflow-hidden rounded-[8px] sm:h-[520px] lg:h-auto lg:min-h-[720px]"
            >
              {/* One loader from arrival through the deferred boot to the
                  map's own idle event — the static still is now only the
                  hard-fail art (no token, no WebGL). */}
              {booted ? <CoverageMap fallback={<MapImageFallback />} /> : <MapLoading />}
            </div>

            <div className="flex flex-col overflow-hidden rounded-[8px] bg-[#EBF5FB]">
              <div className="px-6 pt-7">
                <p className="text-[13px] tracking-[0.05em] text-[#777169]">VERIFIED SHOPS</p>
                <p className="mt-2 flex items-baseline gap-1.5">
                  <span className="text-[40px] leading-none text-[#1a1a1a]" style={serif}>
                    <CountUp to={23} />
                  </span>
                  <span className="text-[17px] text-[#777169]">live</span>
                </p>
                <p className="mt-1 text-[15px] leading-[26px] text-[#777169]">
                  Staten Island - at launch
                </p>
              </div>

              <div className="mt-7 px-6 pt-7" style={{ borderTop: `1px solid ${HAIRLINE}` }}>
                <p className="text-[13px] tracking-[0.05em] text-[#777169]">AVG. DISTANCE</p>
                <p className="mt-2 flex items-baseline gap-1.5">
                  <span className="text-[40px] leading-none text-[#1a1a1a]" style={serif}>
                    <CountUp to={avgMi} decimals={1} />
                  </span>
                  <span className="text-[17px] text-[#777169]">mi</span>
                </p>
                <p className="mt-1 text-[15px] leading-[26px] text-[#777169]">
                  Within the live network
                </p>
              </div>

              <div className="mt-7 px-6 pt-7" style={{ borderTop: `1px solid ${HAIRLINE}` }}>
                <p className="text-[13px] tracking-[0.05em] text-[#777169]">CAR OWNERSHIP</p>
                <p className="mt-2 flex items-baseline gap-1.5">
                  <span className="text-[40px] leading-none text-[#1a1a1a]" style={serif}>
                    <CountUp to={83} />
                  </span>
                  <span className="text-[17px] text-[#777169]">%</span>
                </p>
                <p className="mt-1 text-[15px] leading-[26px] text-[#777169]">
                  Highest borough in NYC
                </p>
              </div>

              {/* V1's signups header is the section's blue (#4B82A5), not the
                  ink bar this used to carry. */}
              <div className="mt-8 flex items-center gap-2 bg-[#4B82A5] px-6 py-3">
                <span className="h-1.5 w-1.5 rounded-full bg-white/85" />
                <span className="text-[13px] tracking-[0.08em] text-white">LIVE SIGNUPS</span>
              </div>

              <div className="flex-1 px-6 pb-8 pt-6">
                {signups.map((s, i) => (
                  <div key={i} className={i > 0 ? "mt-6" : ""}>
                    <p className="text-[15px] tracking-[0.05em] text-[#1a1a1a]">{s.name}</p>
                    <p className="text-[12px] tracking-[0.05em] text-[#777169]/60">{s.when}</p>
                    <span
                      className={`mt-2 inline-block w-full rounded-[10px] px-3.5 py-0.5 text-[12px] font-medium tracking-[0.05em] ${
                        s.badge === "Verified"
                          ? "bg-[#457942]/20 text-[#457942]"
                          : "bg-[#777169]/20 text-[#777169]"
                      }`}
                    >
                      {s.badge}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
