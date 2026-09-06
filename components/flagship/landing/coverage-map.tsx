"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, Map as MapIcon, MapPin, Minus, Plus } from "lucide-react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { AnimatePresence, motion } from "motion/react";
import { useReducedMotionSafe } from "../shared";
import MapLoading from "./map-loading";
import { mergeNetworkPins, milesBetween, type Pin } from "./network-pins";

const TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? "";

/* Below sm the camera cluster only appears once the camera has actually left
   the resting frame (a dive, a pinch, a two-finger drag) — the phone frame
   shows the map bare, and the "back out" button is the one control that still
   earns its place there. These are the "has it moved" thresholds. */
const AWAY_ZOOM = 0.25;
const AWAY_MILES = 0.6;

const SI_CENTER: [number, number] = [-74.1385, 40.5885];

/* Camera framing. The map opens directly on the borough-wide coverage frame.
   There used to be a cinematic sweep in front of it — open at zoom 16.2 /
   pitch 74 among the lower-Manhattan towers, then fly 7s out to here — and it
   was measured as the dominant cost of the map's first boot: crossing ~10
   miles and 5 zoom levels at a pitch that sees to the horizon meant loading
   and parsing tiles continuously the whole way. Dropping it cut the boot's
   main-thread work 1,742ms -> 666ms and time-to-idle 2,351ms -> 960ms. */
const RESTING_CAMERA = { center: [-74.117, 40.5845] as [number, number], zoom: 11.1, pitch: 57, bearing: -14 };

/* ------------------------------------------------------------------ */
/*  OtoPair-branded pin                                                */
/* ------------------------------------------------------------------ */

/* Ported from the otopair-1 app (components/booking/ShopMarker.tsx) so the web
   map reads as the same product: the teardrop logo pin with the wrench glyph on
   the brand blue ramp, and — exactly like the app — an Apple-Maps-style POI
   circle + name label that crossfades in once you're close enough to read it.
   The app switches at latitudeDelta < 0.03; the web equivalent is ~zoom 13. */

const LABEL_ZOOM = 13;

// Verbatim from ShopMarker.tsx (teardrop viewBox 0 0 120 132, POI 0 0 120 120).
const PIN_BODY_D =
  "M90 15.192C85.5727 11.1575 80.3846 8.04754 74.7397 6.04433C69.0948 4.04111 63.1068 3.185 57.1267 3.52619C51.1467 3.86738 45.2949 5.39899 39.9145 8.03124C34.534 10.6635 29.7333 14.3434 25.7936 18.8552C21.8539 23.367 18.8546 28.62 16.9716 34.3061C15.0885 39.9922 14.3596 45.997 14.8275 51.9685C15.2954 57.94 16.9508 63.7579 19.6965 69.0813C22.4423 74.4047 26.2231 79.1264 30.8175 82.9695C41.3211 91.7021 50.0973 102.324 56.6925 114.286C57.0149 114.881 57.4927 115.379 58.0751 115.725C58.6574 116.071 59.3226 116.252 60 116.251C60.6769 116.25 61.341 116.067 61.922 115.72C62.503 115.372 62.9792 114.874 63.3 114.278L63.6075 113.701C70.2501 101.884 79.0081 91.388 89.445 82.737C94.2816 78.5572 98.1713 73.394 100.854 67.592C103.538 61.7899 104.953 55.4823 105.005 49.0901C105.058 42.6978 103.747 36.3679 101.159 30.5225C98.5716 24.6771 94.7673 19.4507 90 15.192ZM60 67.5007C56.2916 67.5007 52.6665 66.4011 49.5831 64.3408C46.4996 62.2805 44.0964 59.3522 42.6773 55.9261C41.2581 52.5 40.8868 48.7299 41.6103 45.0928C42.3337 41.4557 44.1195 38.1147 46.7417 35.4925C49.364 32.8703 52.7049 31.0845 56.3421 30.361C59.9792 29.6376 63.7492 30.0089 67.1753 31.428C70.6014 32.8472 73.5298 35.2504 75.5901 38.3338C77.6503 41.4172 78.75 45.0424 78.75 48.7508C78.744 53.7217 76.7667 58.4874 73.2517 62.0024C69.7367 65.5174 64.971 67.4948 60 67.5007Z";
const PIN_WRENCH_D =
  "M52.0381 16.9834C57.4005 15.6352 63.018 15.6743 68.3614 17.0957C68.9752 17.2602 69.5351 17.5829 69.9844 18.0322C70.4338 18.4816 70.7574 19.0414 70.9219 19.6553C71.0871 20.2716 71.0863 20.9212 70.92 21.5371C70.7536 22.1529 70.4274 22.7138 69.9747 23.1631L56.0977 37.04L58.0176 50.4814L71.459 52.4014L85.336 38.5244C85.7853 38.0717 86.3462 37.7454 86.962 37.5791C87.5779 37.4128 88.2275 37.412 88.8438 37.5771C89.4577 37.7417 90.0175 38.0653 90.4669 38.5146C90.9162 38.964 91.2389 39.5239 91.4034 40.1377C92.683 44.9133 92.8553 49.9072 91.9229 54.7422C88.854 69.5523 75.7355 80.6836 60.0157 80.6836C42.0185 80.6835 27.429 66.0939 27.4288 48.0967C27.4288 47.4476 27.4499 46.8028 27.4874 46.1631C27.6786 43.5991 28.1727 41.0565 28.9678 38.5898C30.6642 33.3272 33.6724 28.5824 37.7081 24.8027C41.7439 21.023 46.6756 18.3317 52.0381 16.9834Z";
const ICON_WRENCH_D =
  "M52.0381 26.9834C57.4005 25.6352 63.018 25.6743 68.3614 27.0957C68.9752 27.2602 69.5351 27.5829 69.9844 28.0322C70.4338 28.4816 70.7574 29.0414 70.9219 29.6553C71.0871 30.2716 71.0863 30.9212 70.92 31.5371C70.7536 32.1529 70.4274 32.7138 69.9747 33.1631L56.0977 47.04L58.0176 60.4814L71.459 62.4014L85.336 48.5244C85.7853 48.0717 86.3462 47.7454 86.962 47.5791C87.5779 47.4128 88.2275 47.412 88.8438 47.5771C89.4577 47.7417 90.0175 48.0653 90.4669 48.5146C90.9162 48.964 91.2389 49.5239 91.4034 50.1377C92.683 54.9133 92.8553 59.9072 91.9229 64.7422C88.854 79.5523 75.7355 90.6836 60.0157 90.6836C42.0185 90.6835 27.429 76.0939 27.4288 58.0967C27.4288 57.4476 27.4499 56.8028 27.4874 56.1631C27.6786 53.5991 28.1727 51.0565 28.9678 48.5898C30.6642 43.3272 33.6724 38.5824 37.7081 34.8027C41.7439 31.023 46.6756 28.3317 52.0381 26.9834Z";

const BLUE = `<stop stop-color="#5299FE"/><stop offset="1" stop-color="#70B7FF"/>`;
const GLYPH = `<stop stop-color="#EBF4FF"/><stop offset="1" stop-color="#fff"/>`;

// SVG gradient ids are document-global, so every pin mints its own.
function teardropSvg(uid: string): string {
  return `<svg width="34" height="34" viewBox="0 0 120 120" fill="none" aria-hidden="true">
<path d="${PIN_BODY_D}" fill="url(#ob${uid})"/>
<circle cx="60" cy="48" r="30" fill="url(#or${uid})"/>
<path d="${PIN_WRENCH_D}" fill="url(#og${uid})"/>
<defs>
<linearGradient id="ob${uid}" x1="60" y1="3" x2="60" y2="116" gradientUnits="userSpaceOnUse">${BLUE}</linearGradient>
<linearGradient id="or${uid}" x1="60" y1="18" x2="60" y2="78" gradientUnits="userSpaceOnUse">${BLUE}</linearGradient>
<linearGradient id="og${uid}" x1="60" y1="16" x2="60" y2="81" gradientUnits="userSpaceOnUse">${GLYPH}</linearGradient>
</defs></svg>`;
}

function poiIconSvg(uid: string): string {
  return `<svg width="24" height="24" viewBox="0 0 120 120" fill="none" aria-hidden="true">
<circle cx="60" cy="60" r="58" fill="url(#cb${uid})"/>
<circle cx="60" cy="60" r="45" fill="url(#ci${uid})"/>
<path d="${ICON_WRENCH_D}" fill="url(#cg${uid})"/>
<defs>
<linearGradient id="cb${uid}" x1="60" y1="2" x2="60" y2="118" gradientUnits="userSpaceOnUse">${BLUE}</linearGradient>
<linearGradient id="ci${uid}" x1="60" y1="15" x2="60" y2="105" gradientUnits="userSpaceOnUse">${BLUE}</linearGradient>
<linearGradient id="cg${uid}" x1="60" y1="26" x2="60" y2="91" gradientUnits="userSpaceOnUse">${GLYPH}</linearGradient>
</defs></svg>`;
}

function createPinElement(p: Pin, uid: string): HTMLDivElement {
  const caption = `${p.name} · ${p.city}${p.verified ? " · Verified" : " · Onboarding"}`;
  const el = document.createElement("div");
  el.className = `oto-pin${p.verified ? "" : " oto-pin--onboarding"}`;
  el.title = caption;
  el.setAttribute("role", "img");
  el.setAttribute("aria-label", caption);
  // Static markup only — the shop name is set via textContent below, since it
  // is owner-supplied and must never be parsed as HTML.
  el.innerHTML =
    `<span class="oto-pin__ping" aria-hidden="true"></span>` +
    `<span class="oto-pin__teardrop">${teardropSvg(uid)}</span>` +
    `<span class="oto-pin__poi">${poiIconSvg(uid)}</span>`;
  const label = document.createElement("span");
  label.className = "oto-pin__label";
  label.textContent = p.name;
  el.querySelector(".oto-pin__poi")?.appendChild(label);
  return el;
}

/**
 * Live network map — Mapbox Standard (dusk, 3D) over the launch borough with
 * pulsing shop pins and a working "find your nearest shop" address search.
 * Renders `fallback` (the old static render) when the token is missing or the
 * map fails to boot, so the section never breaks.
 */
export default function CoverageMap({
  fallback,
}: {
  fallback: React.ReactNode;
}) {
  const reduce = useReducedMotionSafe();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const markersRef = useRef<mapboxgl.Marker[]>([]);
  const youRef = useRef<mapboxgl.Marker | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  // `load` only means the style is parsed — tiles are still streaming in, which
  // is what made the map look like it was assembling itself in public. `idle`
  // is the real "nothing left to draw" signal, so that is what uncovers it.
  const [settled, setSettled] = useState(false);
  // Camera off the resting frame — gates the mobile-only control cluster.
  const [away, setAway] = useState(false);

  const [q, setQ] = useState("");
  const [searching, setSearching] = useState(false);
  // `shop` makes the chip clickable — tapping it dives to that shop.
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string; shop?: Pin } | null>(null);

  type Suggestion =
    | { kind: "shop"; pin: Pin }
    | { kind: "place"; name: string; sub: string; lng: number; lat: number };
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const sugSeq = useRef(0);
  // Picking a suggestion writes its label into the input — that q change must
  // not immediately reopen the dropdown.
  const justPickedRef = useRef(false);

  // Live network pins always render; curated stand-ins only fill the map up
  // to the launch floor (deduped against real shops by distance).
  const live = useQuery(api.landing.shopPins);
  const pins = useMemo(() => mergeNetworkPins(live), [live]);

  // ---- boot the map once -------------------------------------------------
  useEffect(() => {
    if (!TOKEN || !containerRef.current || mapRef.current) return;
    let map: mapboxgl.Map;
    try {
      mapboxgl.accessToken = TOKEN;
      map = new mapboxgl.Map({
        container: containerRef.current,
        style: "mapbox://styles/mapbox/standard",
        ...RESTING_CAMERA,
        maxBounds: [
          [-74.62, 40.32],
          [-73.28, 41.08],
        ],
        // One-finger drag scrolls the page (two fingers pan/pinch the map), so
        // the map can never trap a phone mid-scroll. Wheel zoom is disabled
        // below regardless, so the desktop wheel path is unchanged.
        cooperativeGestures: true,
      });
    } catch {
      setFailed(true);
      return;
    }
    mapRef.current = map;

    // The page owns the wheel — never hijack scrolling over the section.
    map.scrollZoom.disable();
    map.dragRotate.disable();
    map.touchZoomRotate.disableRotation();

    map.on("style.load", () => {
      try {
        map.setConfigProperty("basemap", "lightPreset", "day");
        map.setConfigProperty("basemap", "show3dObjects", true);
      } catch {
        /* older style versions — dusk is cosmetic */
      }
    });

    // Grabbing the map closes any open suggestion list.
    const onUserGrab = () => {
      setSuggestions([]);
    };
    map.on("mousedown", onUserGrab);
    map.on("touchstart", onUserGrab);
    map.on("wheel", onUserGrab);

    // One class on the container drives every pin's teardrop → POI crossfade,
    // so zooming costs a single class toggle instead of touching N markers.
    const syncZoomClass = () => {
      containerRef.current?.classList.toggle("oto-map--near", map.getZoom() >= LABEL_ZOOM);
    };
    map.on("zoom", syncZoomClass);
    syncZoomClass();

    // Has the camera left the resting frame? Settles on every moveend, so a
    // pinch, a drag, a dive or the way back all keep the mobile cluster honest.
    const syncAway = () => {
      const c = map.getCenter();
      const drifted =
        Math.abs(map.getZoom() - RESTING_CAMERA.zoom) > AWAY_ZOOM ||
        milesBetween(c.lat, c.lng, RESTING_CAMERA.center[1], RESTING_CAMERA.center[0]) > AWAY_MILES;
      setAway(drifted);
    };
    map.on("moveend", syncAway);

    map.on("load", () => setReady(true));
    map.once("idle", () => setSettled(true));
    // Safety net: `idle` is the right signal but not a guaranteed one — a stalled
    // tile request or a style that never quiesces would otherwise leave the
    // loader up forever, which is worse than the ragged load it replaced. Show
    // the map regardless after this long.
    const revealAnyway = window.setTimeout(() => setSettled(true), 8000);
    map.on("error", (e) => {
      // Token/style-level failures arrive here — fall back to the static art.
      const status = (e.error as { status?: number } | undefined)?.status;
      if (status === 401 || status === 403) setFailed(true);
    });

    return () => {
      markersRef.current.forEach((m) => m.remove());
      markersRef.current = [];
      window.clearTimeout(revealAnyway);
      youRef.current?.remove();
      youRef.current = null;
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // ---- (re)place shop markers when data or map readiness changes ----------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = pins.map((p, i) => {
      const el = createPinElement(p, `${i}-${Math.round(p.lat * 1e4)}`);
      el.addEventListener("click", () => flyToShopRef.current(p));
      // The teardrop's tip marks the shop, so the pin hangs above its point.
      return new mapboxgl.Marker({ element: el, anchor: "bottom" })
        .setLngLat([p.lng, p.lat])
        .addTo(map);
    });
  }, [pins, ready, reduce]);

  // ---- shared camera actions ----------------------------------------------
  /** Deep dive to a shop's own block; chip shows the shop and stays clickable. */
  const flyToShop = (p: Pin) => {
    const map = mapRef.current;
    if (!map) return;
    setSuggestions([]);
    map.flyTo({ center: [p.lng, p.lat], zoom: 17.4, pitch: 67, duration: reduce ? 0 : 2800 });
    setNotice({
      kind: "ok",
      text: `${p.name} · ${p.city} · ${p.verified ? "Verified partner" : "Onboarding"}`,
      shop: p,
    });
  };
  const flyToShopRef = useRef(flyToShop);
  flyToShopRef.current = flyToShop;

  /** Drop the "you" dot, dive to the block, and report the nearest shop. */
  const goToPlace = (lng: number, lat: number) => {
    const map = mapRef.current;
    if (!map) return;
    setSuggestions([]);

    youRef.current?.remove();
    const youEl = document.createElement("div");
    youEl.className = "oto-map-you";
    youEl.title = "Your address";
    youRef.current = new mapboxgl.Marker({ element: youEl }).setLngLat([lng, lat]).addTo(map);

    let nearest: Pin | null = null;
    let best = Infinity;
    for (const p of pins) {
      const d = milesBetween(lat, lng, p.lat, p.lng);
      if (d < best) {
        best = d;
        nearest = p;
      }
    }
    // 3D dive: street-level pitch puts the searched block's buildings in relief.
    map.flyTo({ center: [lng, lat], zoom: 15.9, pitch: 66, duration: reduce ? 0 : 3200, curve: 1.4 });
    setNotice(
      nearest
        ? { kind: "ok", text: `Nearest shop: ${nearest.name} · ${best.toFixed(1)} mi away`, shop: nearest }
        : { kind: "ok", text: "Found it — shops are coming to this area soon." },
    );
  };

  // ---- live suggestions: matching shops + street/address completions ------
  useEffect(() => {
    if (justPickedRef.current) {
      justPickedRef.current = false;
      setSuggestions([]);
      return;
    }
    const query = q.trim();
    if (query.length < 3) {
      setSuggestions([]);
      return;
    }
    const id = window.setTimeout(async () => {
      const mySeq = ++sugSeq.current;
      const needle = query.toLowerCase();
      const shopMatches: Suggestion[] = pins
        .filter((p) => p.name.toLowerCase().includes(needle))
        .slice(0, 3)
        .map((p) => ({ kind: "shop", pin: p }));
      let placeMatches: Suggestion[] = [];
      try {
        const url =
          `https://api.mapbox.com/search/geocode/v6/forward?q=${encodeURIComponent(query)}` +
          `&autocomplete=true&limit=4&proximity=${SI_CENTER[0]},${SI_CENTER[1]}` +
          `&bbox=-74.3,40.45,-73.65,40.95&access_token=${TOKEN}`;
        const res = await fetch(url);
        const json = (await res.json()) as {
          features?: {
            geometry: { coordinates: [number, number] };
            properties?: { name?: string; place_formatted?: string; full_address?: string };
          }[];
        };
        placeMatches = (json.features ?? []).map((f) => ({
          kind: "place",
          name: f.properties?.name ?? "Unnamed",
          sub: f.properties?.place_formatted ?? f.properties?.full_address ?? "",
          lng: f.geometry.coordinates[0],
          lat: f.geometry.coordinates[1],
        }));
      } catch {
        /* typing continues to work without completions */
      }
      if (sugSeq.current !== mySeq) return; // a newer keystroke superseded us
      setSuggestions([...shopMatches, ...placeMatches]);
    }, 260);
    return () => window.clearTimeout(id);
  }, [q, pins]);

  // ---- address search (Enter) → geocode the top match ---------------------
  async function search(e: React.FormEvent) {
    e.preventDefault();
    const query = q.trim();
    if (!mapRef.current || !query || searching) return;
    // If the top suggestion is a shop that matches what's typed, Enter goes
    // straight to it. (The match guard keeps stale suggestions from hijacking
    // an address search typed right after picking a shop.)
    const first = suggestions[0];
    if (first?.kind === "shop" && first.pin.name.toLowerCase().includes(query.toLowerCase())) {
      flyToShop(first.pin);
      return;
    }
    setSearching(true);
    setNotice(null);
    setSuggestions([]);
    try {
      const url =
        `https://api.mapbox.com/search/geocode/v6/forward?q=${encodeURIComponent(query)}` +
        `&proximity=${SI_CENTER[0]},${SI_CENTER[1]}&bbox=-74.3,40.45,-73.65,40.95&limit=1&access_token=${TOKEN}`;
      const res = await fetch(url);
      const json = (await res.json()) as {
        features?: { geometry: { coordinates: [number, number] } }[];
      };
      const hit = json.features?.[0];
      if (!hit) {
        setNotice({ kind: "err", text: "No NYC match — try a street address plus borough." });
        return;
      }
      goToPlace(hit.geometry.coordinates[0], hit.geometry.coordinates[1]);
    } catch {
      setNotice({ kind: "err", text: "Search hiccuped — give it another try." });
    } finally {
      setSearching(false);
    }
  }

  // ---- manual camera controls ---------------------------------------------
  const zoomStep = (dir: 1 | -1) => {
    const map = mapRef.current;
    if (!map) return;
    if (dir === 1) map.zoomIn({ duration: 300 });
    else map.zoomOut({ duration: 300 });
  };
  const flyOverview = () => {
    const map = mapRef.current;
    if (!map) return;
    setNotice(null);
    map.flyTo({ ...RESTING_CAMERA, duration: reduce ? 0 : 2400, essential: true });
  };

  if (!TOKEN || failed) return <>{fallback}</>;

  return (
    <div className="absolute inset-0">
      {/* Map and its controls fade in together as one piece. The container has
          to stay laid out and painting for mapbox to render at all, so this
          gates opacity rather than unmounting or hiding. */}
      <motion.div
        className="absolute inset-0"
        initial={false}
        // Never hidden — only covered. Holding the map at opacity 0 let the
        // compositor skip rasterizing the canvas, so flipping it back to 1 left
        // a blank frame while it repainted (visible as a white flash between
        // loader and map). Painting throughout and simply dissolving the opaque
        // loader off the top removes both that flash and the washed midpoint a
        // two-layer cross-fade produced. Pointer events stay off until settled
        // so nothing is clickable behind the loader.
        animate={{ opacity: 1 }}
        transition={{ duration: 0 }}
        style={{ pointerEvents: settled ? "auto" : "none" }}
      >
        <div ref={containerRef} className="h-full w-full" aria-label="Live map of the Otopair shop network" />

      {/* Glass search bar — now a real address search. Below sm it is the
          phone frame's pill (390:3612): 30 tall, 13 from the top, 8px in,
          frosted white over the map, an 11px glass at left 10, the 8px
          placeholder starting at 28, the arrow (13px, #777169) at the right.
          Figma declares the fill at 20% white, but that is over its white
          artboard where it renders solid; over the real basemap 20% leaves the
          8px placeholder unreadable, so it runs at 70% to match the render.
          The typed value stays 16px there: anything smaller makes iOS zoom
          the page on focus. */}
      <form
        role="search"
        onSubmit={search}
        className="absolute left-4 right-4 top-4 flex h-[54px] items-center gap-3 rounded-[8px] border border-white/60 bg-white/80 px-4 shadow-[0_4px_16px_rgba(20,40,80,0.10)] backdrop-blur-md max-tab:left-2 max-tab:right-2 max-tab:top-[13px] max-tab:h-[30px] max-tab:gap-[7px] max-tab:border-0 max-tab:bg-white/70 max-tab:pl-[10px] max-tab:pr-0 tab:left-8 tab:right-8 tab:top-6"
      >
        <svg
          width={18}
          height={18}
          viewBox="0 0 18 18"
          fill="none"
          className="shrink-0 text-[#1a1a1a] max-tab:h-[11px] max-tab:w-[11px] max-tab:text-[#777169]"
          aria-hidden
        >
          <circle cx="7.5" cy="7.5" r="5.5" stroke="currentColor" strokeWidth="1.4" />
          <path d="M11.6 11.6 L16 16" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setSuggestions([]);
          }}
          placeholder="Find your nearest shop — type any NYC address"
          aria-label="Find your nearest shop — type any NYC address"
          className="h-full flex-1 truncate bg-transparent text-[13px] tracking-[0.05em] text-[#1a1a1a] placeholder:text-[#777169] focus:outline-none max-tab:text-[16px] max-tab:tracking-normal max-tab:placeholder:text-[8px] max-tab:placeholder:tracking-[0.4px]"
        />
        <button
          type="submit"
          aria-label="Search"
          disabled={searching}
          className="text-[20px] font-light leading-none text-[#1a1a1a] transition-transform duration-200 hover:translate-x-0.5 hover:-translate-y-0.5 disabled:opacity-50 max-tab:flex max-tab:h-full max-tab:items-center max-tab:px-[6px] max-tab:text-[13px] max-tab:text-[#777169]"
        >
          {searching ? "…" : "↗"}
        </button>
      </form>

      {/* Live suggestions — shops in the network + street/address matches */}
      {suggestions.length > 0 && (
        <div className="absolute left-4 right-4 top-[74px] z-20 overflow-hidden rounded-[8px] border border-white/60 bg-white/90 shadow-[0_10px_30px_rgba(20,40,80,0.14)] backdrop-blur-md max-tab:left-2 max-tab:right-2 max-tab:top-[47px] tab:left-8 tab:right-8 tab:top-[88px]">
          {suggestions.map((s) =>
            s.kind === "shop" ? (
              <button
                key={`shop:${s.pin.name}`}
                type="button"
                onClick={() => {
                  justPickedRef.current = true;
                  setQ(s.pin.name);
                  flyToShop(s.pin);
                }}
                className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-[#1a1a1a]/[0.06]"
              >
                <span className="h-2.5 w-2.5 shrink-0 rounded-full border-2 border-white bg-[#5299fe] ring-1 ring-[#1a1a1a]/15" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-[#1a1a1a]">{s.pin.name}</span>
                  <span className="block truncate text-[11px] text-[#777169]">
                    {s.pin.city} · {s.pin.verified ? "Verified partner" : "Onboarding"}
                  </span>
                </span>
                <span className="shrink-0 text-[10px] uppercase tracking-[0.08em] text-[#777169]">
                  Shop
                </span>
              </button>
            ) : (
              <button
                key={`place:${s.name}:${s.lng}`}
                type="button"
                onClick={() => {
                  justPickedRef.current = true;
                  setQ(s.sub ? `${s.name}, ${s.sub}` : s.name);
                  goToPlace(s.lng, s.lat);
                }}
                className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-[#1a1a1a]/[0.06]"
              >
                <MapPin className="h-3.5 w-3.5 shrink-0 text-[#777169]" strokeWidth={2} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-[#1a1a1a]">{s.name}</span>
                  {s.sub && <span className="block truncate text-[11px] text-[#777169]">{s.sub}</span>}
                </span>
              </button>
            ),
          )}
        </div>
      )}

      {/* Result / error chip — clickable when it points at a shop */}
      <div aria-live="polite" className="pointer-events-none absolute bottom-4 left-4 right-4 tab:bottom-6 tab:left-8 tab:right-auto">
        {notice &&
          (notice.shop ? (
            <button
              type="button"
              onClick={() => flyToShop(notice.shop!)}
              title={`Fly to ${notice.shop.name}`}
              className="pointer-events-auto inline-flex max-w-full items-center gap-1.5 rounded-[8px] border border-white/60 bg-white/85 px-3.5 py-2 text-[13px] tracking-[0.05em] text-[#1a1a1a] backdrop-blur-md transition-colors hover:bg-white"
            >
              <span className="truncate">{notice.text}</span>
              <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-[#777169]" strokeWidth={2} />
            </button>
          ) : (
            <span
              className={`inline-block max-w-full truncate rounded-[8px] border px-3.5 py-2 text-[13px] tracking-[0.05em] backdrop-blur-md ${
                notice.kind === "ok"
                  ? "border-white/60 bg-white/85 text-[#1a1a1a]"
                  : "border-[#b4432e]/30 bg-white/85 text-[#b4432e]"
              }`}
            >
              {notice.text}
            </span>
          ))}
      </div>

      {/* Camera controls — zoom, and the way back out of a dive. Below sm the
          result chip owns the bottom edge (site audit P2: the two collided),
          so the cluster sits under the search pill instead, loses +/− (pinch
          zooms there) and only shows once the camera has left the resting
          frame — the phone frame's map is bare. */}
      <div
        className={`absolute bottom-8 right-3 z-10 flex flex-col overflow-hidden rounded-[8px] border border-white/60 bg-white/80 shadow-[0_4px_16px_rgba(20,40,80,0.10)] backdrop-blur-md max-tab:top-[51px] max-tab:right-2 max-tab:bottom-auto tab:right-4 ${
          away ? "" : "max-tab:hidden"
        }`}
      >
        <button
          type="button"
          onClick={() => zoomStep(1)}
          aria-label="Zoom in"
          className="flex h-7 w-7 items-center justify-center text-[#1a1a1a] transition-colors hover:bg-[#1a1a1a]/[0.07] max-tab:hidden"
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={2.2} />
        </button>
        <span className="h-px bg-[#1a1a1a]/12 max-tab:hidden" />
        <button
          type="button"
          onClick={() => zoomStep(-1)}
          aria-label="Zoom out"
          className="flex h-7 w-7 items-center justify-center text-[#1a1a1a] transition-colors hover:bg-[#1a1a1a]/[0.07] max-tab:hidden"
        >
          <Minus className="h-3.5 w-3.5" strokeWidth={2.2} />
        </button>
        <span className="h-px bg-[#1a1a1a]/12 max-tab:hidden" />
        <button
          type="button"
          onClick={flyOverview}
          aria-label="Back to full coverage view"
          title="Back to the full coverage view"
          className="flex h-7 w-7 items-center justify-center text-[#1a1a1a] transition-colors hover:bg-[#1a1a1a]/[0.07]"
        >
          <MapIcon className="h-3.5 w-3.5" strokeWidth={2} />
        </button>
      </div>
      </motion.div>

      {/* One continuous loading state, uncovered only once the map reports
          idle — i.e. every tile loaded and drawn, not merely the style parsed. */}
      <AnimatePresence initial={false}>
        {!settled && (
          <motion.div
            key="loading"
            className="absolute inset-0 z-30"
            initial={false}
            exit={{ opacity: 0 }}
            transition={{ duration: reduce ? 0 : 0.55, ease: [0.22, 1, 0.36, 1] }}
          >
            <MapLoading />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
