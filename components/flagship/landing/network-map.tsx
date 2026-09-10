"use client";

import { useRef } from "react";
import Image from "next/image";
import dynamic from "next/dynamic";
import { useInView } from "motion/react";
import MapLoading from "./map-loading";

/**
 * Standalone live network map — the same Mapbox `CoverageMap` the home coverage
 * section renders (pulsing shop pins + address search), packaged as a
 * self-contained rounded panel so other pages (the partner page) can drop in
 * the real map instead of a stylized illustration.
 *
 * The home section has its own finely-tuned boot deferral (see
 * coverage-section.tsx); here we keep it simple — mount when the panel is
 * roughly a screen away and let CoverageMap own its loading/idle handoff.
 */

// mapbox-gl is ~1.8 MB of client JS — browser-only, and only once near view.
const CoverageMap = dynamic(() => import("./coverage-map"), {
  ssr: false,
  loading: () => <MapLoading />,
});

// Hard-fail art (no token / no WebGL). Same asset the home section falls back to.
function MapImageFallback() {
  return (
    <Image
      src="/images/landing/nyc-map-light.jpg"
      alt="Map of the NYC network coverage area"
      fill
      sizes="(max-width: 1024px) 100vw, 50vw"
      className="object-cover"
    />
  );
}

export default function NetworkMap({ className, frame = true }: { className?: string; frame?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  // Boot a touch ahead of arrival so tiles/WebGL warm up before it's on screen.
  const near = useInView(ref, { once: true, margin: "800px 0px" });

  return (
    <div
      ref={ref}
      // `frame={false}` drops the panel's own radius and hairline for callers
      // that seat the map inside a Bezel plate, which clips and frames it.
      className={`relative overflow-hidden ${frame ? "rounded-[20px] border border-[#1a1a1a]/8" : ""} ${
        className ?? "aspect-[5/4]"
      }`}
    >
      {near ? <CoverageMap fallback={<MapImageFallback />} /> : <MapLoading />}
    </div>
  );
}
