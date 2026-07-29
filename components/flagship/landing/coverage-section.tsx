"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import dynamic from "next/dynamic";
import { useInView } from "motion/react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { CountUp } from "../shared";
import { Reveal, serif } from "./reveal";
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

/** The pre-Mapbox static render — SSR placeholder and no-token/WebGL fallback. */
function MapImageFallback() {
  return (
    <Image
      src="/images/landing/nyc-map-3d.jpg"
      alt="3D render of the NYC network coverage map"
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
  loading: () => <MapImageFallback />,
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

/** "Network coverage across NYC boroughs" — rollout timeline, live map, network stats. */
export default function CoverageSection() {
  const mapCellRef = useRef<HTMLDivElement>(null);
  // Mount + boot the map ahead of arrival (tiles and WebGL warm up on the
  // skyline hold), then hand CoverageMap a "play" signal when the cell is
  // actually on screen so the cinematic sweep never runs unseen.
  const nearView = useInView(mapCellRef, { once: true, margin: "1800px 0px" });
  const inSight = useInView(mapCellRef, { once: true, amount: 0.3 });

  // Warm up early, but never while the story section is still on screen —
  // see useStoryOnScreen. Latched: once the map boots it stays booted, so
  // scrolling back up never tears it down and pays the cost twice.
  const storyOnScreen = useStoryOnScreen();
  const [booted, setBooted] = useState(false);
  useEffect(() => {
    if (nearView && !storyOnScreen) setBooted(true);
  }, [nearView, storyOnScreen]);

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
      <Reveal>
        <h2
          className="max-w-[760px] text-[40px] leading-[1.02] text-[#1a1a1a] sm:text-[54px] lg:text-[68px]"
          style={serif}
        >
          Network coverage across NYC boroughs
        </h2>
      </Reveal>

      <Reveal delay={0.1}>
        <div className="mt-12 border border-[rgba(26,26,26,0.12)] sm:mt-16">
          {/* Timeline — numbered header strip (lg) + borough / date body row */}
          <div
            className="hidden grid-cols-5 bg-[#f5f5f3] lg:grid"
            style={{ borderBottom: `1px solid ${HAIRLINE}` }}
          >
            {BOROUGHS.map((b) => (
              <span
                key={b.num}
                className="px-8 py-1.5 text-[13px] tracking-[0.05em] text-[#777169]"
              >
                {b.num}
              </span>
            ))}
          </div>

          <div
            className="grid grid-cols-2 gap-px sm:grid-cols-3 lg:grid-cols-5"
            style={{ backgroundColor: HAIRLINE }}
          >
            {BOROUGHS.map((b) => (
              <div key={b.name} className="bg-[#eceae6] px-6 py-6 lg:px-8">
                <span className="mb-1 block text-[12px] tracking-[0.05em] text-[#777169] lg:hidden">
                  {b.num}
                </span>
                <p className="text-[19px] leading-[26px] text-[#1a1a1a] sm:text-[20px]" style={serif}>
                  {b.name}
                </p>
                <p className="text-[13px] leading-[26px] text-[#777169]">{b.date}</p>
              </div>
            ))}
          </div>

          {/* Map + stats sidebar — one continuous bordered panel */}
          <div
            className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_270px]"
            style={{ borderTop: `1px solid ${HAIRLINE}` }}
          >
            {/* Map cell — live Mapbox network map (static render until near view) */}
            <div
              ref={mapCellRef}
              className="relative h-[380px] overflow-hidden border-b border-[rgba(26,26,26,0.12)] sm:h-[520px] lg:h-auto lg:min-h-[720px] lg:border-b-0 lg:border-r"
            >
              {booted ? (
                <CoverageMap play={inSight} fallback={<MapImageFallback />} />
              ) : (
                <MapImageFallback />
              )}
            </div>

            {/* Stats sidebar */}
            <div className="flex flex-col">
              <div className="px-8 pt-9">
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

              <div className="mt-8 px-8 pt-8" style={{ borderTop: `1px solid ${HAIRLINE}` }}>
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

              <div className="mt-8 px-8 pt-8" style={{ borderTop: `1px solid ${HAIRLINE}` }}>
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

              {/* Dark live-signups bar */}
              <div className="mt-9 flex items-center gap-2 bg-[#1a1a1a] px-8 py-3">
                <span className="h-1.5 w-1.5 rounded-full bg-[#457942]" />
                <span className="text-[15px] tracking-[0.05em] text-[#eceae6]">Live signups</span>
              </div>

              <div className="flex-1 px-8 pb-9 pt-6">
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
        </div>
      </Reveal>
    </section>
  );
}
