/**
 * Mapbox Static Images helpers for the local pages: one request per
 * image, the API logo and attribution off (so the © credit is drawn by
 * the caller), light-v11 to match the live network map. Every helper
 * returns null without a token so callers fall back to a flat wash.
 *
 * `project` places a coordinate on a static image in CSS pixels
 * (Web Mercator, Mapbox's 512px tiles), so real shop locations can be
 * pinned over the image inside the phone screens.
 */
const TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? "";

export type MapCenter = { lat: number; lng: number; zoom: number };

/** The island, framed for a 390×844 phone screen. */
export const STATEN_ISLAND_PHONE: MapCenter = { lat: 40.5795, lng: -74.1502, zoom: 10.6 };

export function hasMapToken(): boolean {
  return TOKEN.length > 0;
}

/**
 * A plain static map (no pin) at `w`×`h` CSS px, requested at @2x.
 * Mapbox caps a side at 1280 physical px, so tall phone images are
 * requested at 1x above 640 tall.
 */
export function staticMapSrc(c: MapCenter, w: number, h: number): string | null {
  if (!TOKEN) return null;
  const at = `${c.lng.toFixed(5)},${c.lat.toFixed(5)}`;
  const retina = w * 2 <= 1280 && h * 2 <= 1280 ? "@2x" : "";
  return `https://api.mapbox.com/styles/v1/mapbox/light-v11/static/${at},${c.zoom},0/${w}x${h}${retina}?logo=false&attribution=false&access_token=${TOKEN}`;
}

/** A static map with the site-blue pin at the centre (shop profiles). */
export function staticPinMapSrc(lat: number, lng: number, w = 720, h = 360, zoom = 14.2): string | null {
  if (!TOKEN) return null;
  const at = `${lng.toFixed(5)},${lat.toFixed(5)}`;
  return `https://api.mapbox.com/styles/v1/mapbox/light-v11/static/pin-s+4b82a5(${at})/${at},${zoom},0/${w}x${h}@2x?logo=false&attribution=false&access_token=${TOKEN}`;
}

/** Where (lat, lng) lands on a `w`×`h` image centred on `c`, in CSS px. */
export function project(lat: number, lng: number, c: MapCenter, w: number, h: number): { x: number; y: number } {
  const scale = 512 * Math.pow(2, c.zoom);
  const toX = (l: number) => ((l + 180) / 360) * scale;
  const toY = (la: number) => {
    const s = Math.sin((la * Math.PI) / 180);
    return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale;
  };
  return { x: w / 2 + (toX(lng) - toX(c.lng)), y: h / 2 + (toY(lat) - toY(c.lat)) };
}

/** Real shops as pins on the 390×844 phone map; the first one is the
 *  selected pin. Anything outside the visible glass is dropped. */
export function phonePins(shops: { name: string; lat: number | null; lng: number | null }[]) {
  return shops
    .filter((s) => s.lat != null && s.lng != null)
    .map((s, i) => {
      const { x, y } = project(s.lat!, s.lng!, STATEN_ISLAND_PHONE, 390, 844);
      return { name: s.name, rating: null as string | null, x, y, selected: i === 0 };
    })
    .filter((p) => p.x > 24 && p.x < 366 && p.y > 90 && p.y < 800);
}
