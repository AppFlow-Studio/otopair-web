import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { publicQuery } from "./convex-server";
import { neighborhoodSlug, STATEN_ISLAND_NEIGHBORHOODS } from "./coverage";

/**
 * Server-side projection of shop data for the public directory (/shops,
 * /shops/<slug>, /staten-island, /staten-island/<service>).
 *
 * Why a projection and not the raw queries: the existing no-auth Convex
 * queries (shops.list, reviews.getByShopId, mechanics.getByShopId…) return
 * whole documents — Stripe ids, owner ids, contact emails, cancellation
 * knobs, the reviewer's user record. They are called ONLY from the server
 * here, and only the fields below ever reach a page or a JSON-LD node. The
 * landing's convex/landing.ts sets the rule: "no ids, contacts, payout
 * state, or internals". A dedicated `shopsPublic` Convex module is the
 * right long-term home for this (see docs/superpowers/… SEO handoff); until
 * it exists this file is the boundary.
 *
 * Inclusion gate (all must hold):
 *   - bookable      — shops.list already applies lib/bookableShop (Stripe
 *                     charges + payouts enabled, onboarding complete, hours,
 *                     ≥1 active mechanic, ≥1 offered service, labor rate)
 *   - is_active     === true (landing.ts semantics, not the "undefined
 *                     counts as active" bookable-gate semantics)
 *   - is_verified   === true (director-approved; the only "verified" the
 *                     product has — a manual review, not a licence check)
 *   - slug present, and coordinates inside the NYC bounding box, because the
 *     shared dev deployment holds far-away test shops.
 *
 * Ratings: shops.rating / review_count are cached aggregates that seeds can
 * fabricate and hidden reviews inflate. Everything here is recomputed from
 * VISIBLE review rows, and nothing is shown below MIN_REVIEWS_TO_SHOW.
 */

const NYC = { minLat: 40.35, maxLat: 41.05, minLng: -74.6, maxLng: -73.3 };
const MIN_REVIEWS_TO_SHOW = 3;
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export type PublicShopHours = {
  /** 0 = Sunday … 6 = Saturday */
  day: number;
  dayName: string;
  /** "HH:MM" 24h, null when closed */
  open: string | null;
  close: string | null;
};

export type PublicShopService = {
  name: string;
  slug: string;
  description: string | null;
  category: string | null;
};

export type PublicReview = {
  rating: number;
  comment: string | null;
  createdAt: number | null;
  /** "Maria R." — first name + last initial, or "Otopair driver". */
  reviewer: string;
};

export type PublicShopSummary = {
  slug: string;
  name: string;
  address: string | null;
  city: string;
  state: string;
  zip: string | null;
  lat: number | null;
  lng: number | null;
  logoUrl: string | null;
  verified: true;
  /** Nearest Staten Island neighborhood name when the shop is on the island. */
  neighborhood: string | null;
  serviceSlugs: string[];
  serviceCount: number;
};

export type PublicShopProfile = PublicShopSummary & {
  description: string | null;
  website: string | null;
  hours: PublicShopHours[];
  services: PublicShopService[];
  mechanics: { name: string; title: string | null; photoUrl: string | null }[];
  portfolio: { url: string; caption: string | null }[];
  reviews: PublicReview[];
  rating: { average: number; count: number } | null;
};

type RawShop = Record<string, unknown> & {
  _id: Id<"shops">;
  name: string;
  slug?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  lat?: number;
  lng?: number;
  description?: string;
  website?: string;
  is_active?: boolean;
  is_verified?: boolean;
  logoUrl?: string | null;
};

function inNyc(s: RawShop): boolean {
  return (
    typeof s.lat === "number" &&
    typeof s.lng === "number" &&
    s.lat >= NYC.minLat &&
    s.lat <= NYC.maxLat &&
    s.lng >= NYC.minLng &&
    s.lng <= NYC.maxLng
  );
}

function eligible(s: RawShop): s is RawShop & { slug: string } {
  return s.is_active === true && s.is_verified === true && typeof s.slug === "string" && s.slug.length >= 2 && inNyc(s);
}

/** Staten Island neighborhood centroids (approximate, WGS84). Used only to
 *  label a shop with its nearest named neighborhood; the shop's own address
 *  is the source of truth. */
const SI_CENTROIDS: Record<string, [number, number]> = {
  "St. George": [40.6437, -74.0765],
  Tompkinsville: [40.6366, -74.0795],
  Stapleton: [40.6268, -74.0776],
  Clifton: [40.6205, -74.0724],
  Rosebank: [40.6152, -74.0658],
  "New Brighton": [40.6417, -74.0906],
  "West Brighton": [40.6338, -74.1076],
  "Port Richmond": [40.634, -74.1354],
  "Mariners Harbor": [40.6318, -74.1587],
  Graniteville: [40.6212, -74.1548],
  "Bulls Head": [40.6067, -74.1642],
  Westerleigh: [40.6161, -74.1318],
  "Castleton Corners": [40.6134, -74.1198],
  Willowbrook: [40.6031, -74.1385],
  Travis: [40.5906, -74.1878],
  "Todt Hill": [40.5972, -74.1067],
  "Dongan Hills": [40.5885, -74.0964],
  Concord: [40.6086, -74.0842],
  Grasmere: [40.6033, -74.0801],
  Arrochar: [40.5975, -74.0703],
  "South Beach": [40.5867, -74.0743],
  "Midland Beach": [40.5729, -74.0937],
  "New Dorp": [40.5734, -74.116],
  "Grant City": [40.5787, -74.1047],
  Oakwood: [40.5619, -74.1206],
  Richmondtown: [40.5714, -74.1442],
  "New Springville": [40.5893, -74.1633],
  "Heartland Village": [40.5826, -74.1585],
  "Bay Terrace": [40.5559, -74.1391],
  "Great Kills": [40.5543, -74.1515],
  Eltingville: [40.5455, -74.1645],
  Annadale: [40.5398, -74.1783],
  "Arden Heights": [40.5546, -74.1856],
  Huguenot: [40.5343, -74.1907],
  Woodrow: [40.5433, -74.2036],
  Rossville: [40.5556, -74.2126],
  "Prince's Bay": [40.5238, -74.2002],
  "Pleasant Plains": [40.5226, -74.2185],
  Charleston: [40.5343, -74.2371],
  Tottenville: [40.5083, -74.2454],
};

export function nearestNeighborhood(lat: number, lng: number): string | null {
  // Staten Island only — everything else has no neighborhood vocabulary yet.
  if (lat < 40.49 || lat > 40.66 || lng < -74.26 || lng > -74.04) return null;
  let best: string | null = null;
  let bestD = Infinity;
  for (const name of STATEN_ISLAND_NEIGHBORHOODS) {
    const c = SI_CENTROIDS[name];
    if (!c) continue;
    const d = (c[0] - lat) ** 2 + ((c[1] - lng) * Math.cos((lat * Math.PI) / 180)) ** 2;
    if (d < bestD) {
      bestD = d;
      best = name;
    }
  }
  return best;
}

export { neighborhoodSlug };

function reviewerLabel(user: { first_name?: string; last_name?: string } | null | undefined): string {
  const first = user?.first_name?.trim();
  if (!first) return "Otopair driver";
  const initial = user?.last_name?.trim()?.[0];
  return initial ? `${first} ${initial.toUpperCase()}.` : first;
}

type ServiceRow = { _id: Id<"services">; name: string; slug: string; description?: string; is_bookable?: boolean; serviceCategory?: { name: string } | null; display_order?: number };

let serviceCache: { at: number; rows: ServiceRow[] } | null = null;
async function serviceCatalog(): Promise<ServiceRow[]> {
  if (serviceCache && Date.now() - serviceCache.at < 60_000) return serviceCache.rows;
  const rows = ((await publicQuery(api.services.list, {})) ?? []) as unknown as ServiceRow[];
  const bookable = rows.filter((r) => r.is_bookable !== false && r.slug !== "pre_purchase_inspection");
  serviceCache = { at: Date.now(), rows: bookable };
  return bookable;
}

async function offeredServiceIds(shopId: Id<"shops">): Promise<Set<string>> {
  const rows = ((await publicQuery(api.shop_services.getByShopId, { shopId })) ?? []) as { service_id: Id<"services">; is_offered?: boolean }[];
  return new Set(rows.filter((r) => r.is_offered !== false).map((r) => String(r.service_id)));
}

function summarize(s: RawShop & { slug: string }, serviceSlugs: string[]): PublicShopSummary {
  return {
    slug: s.slug,
    name: s.name,
    address: s.address ?? null,
    city: s.city ?? "Staten Island",
    state: s.state ?? "NY",
    zip: s.zip ?? null,
    lat: typeof s.lat === "number" ? s.lat : null,
    lng: typeof s.lng === "number" ? s.lng : null,
    logoUrl: s.logoUrl ?? null,
    verified: true,
    neighborhood: typeof s.lat === "number" && typeof s.lng === "number" ? nearestNeighborhood(s.lat, s.lng) : null,
    serviceSlugs,
    serviceCount: serviceSlugs.length,
  };
}

/** Every shop that passes the gate, with the slugs of the services it
 *  offers. One shops.list read plus one shop_services read per shop. */
export async function listPublicShops(): Promise<PublicShopSummary[]> {
  const raw = ((await publicQuery(api.shops.list, {})) ?? []) as RawShop[];
  const shops = raw.filter(eligible);
  const catalog = await serviceCatalog();
  const byId = new Map(catalog.map((c) => [String(c._id), c]));
  const out = await Promise.all(
    shops.map(async (s) => {
      const ids = await offeredServiceIds(s._id);
      const slugs = [...ids].map((id) => byId.get(id)?.slug).filter((x): x is string => !!x).sort();
      return summarize(s, slugs);
    }),
  );
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Slugs for the sitemap. */
export async function listPublicShopSlugs(): Promise<string[]> {
  return (await listPublicShops()).map((s) => s.slug);
}

/** Full profile for /shops/<slug>; null when the slug is unknown or the shop
 *  fails the gate (so the page can call notFound()). */
export async function getPublicShop(slug: string): Promise<PublicShopProfile | null> {
  const raw = ((await publicQuery(api.shops.list, {})) ?? []) as RawShop[];
  const s = raw.filter(eligible).find((x) => x.slug === slug);
  if (!s) return null;
  const shopId = s._id;

  const [catalog, ids, hoursAll, mechanics, portfolio, reviewsRaw] = await Promise.all([
    serviceCatalog(),
    offeredServiceIds(shopId),
    publicQuery(api.shops_hours.list, {}),
    publicQuery(api.mechanics.getByShopId, { shopId }),
    publicQuery(api.shop_portfolio.listByShopId, { shopId }),
    publicQuery(api.reviews.getByShopId, { shopId }),
  ]);

  const services: PublicShopService[] = catalog
    .filter((c) => ids.has(String(c._id)))
    .sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0))
    .map((c) => ({ name: c.name, slug: c.slug, description: c.description ?? null, category: c.serviceCategory?.name ?? null }));

  const hours: PublicShopHours[] = ((hoursAll ?? []) as { shop_id: Id<"shops">; day_of_week: number; open_time?: string; close_time?: string; is_closed?: boolean }[])
    .filter((h) => String(h.shop_id) === String(shopId))
    .sort((a, b) => a.day_of_week - b.day_of_week)
    .map((h) => ({
      day: h.day_of_week,
      dayName: DAY_NAMES[h.day_of_week] ?? "",
      open: h.is_closed || !h.open_time ? null : h.open_time,
      close: h.is_closed || !h.close_time ? null : h.close_time,
    }));

  const mechs = ((mechanics ?? []) as { first_name?: string; last_name?: string; title?: string; photoUrl?: string | null; is_active?: boolean }[])
    .filter((m) => m.is_active !== false && m.first_name)
    .map((m) => ({
      name: m.last_name ? `${m.first_name} ${m.last_name[0].toUpperCase()}.` : String(m.first_name),
      title: m.title ?? null,
      photoUrl: m.photoUrl ?? null,
    }));

  const photos = ((portfolio ?? []) as { url?: string | null; caption?: string | null }[])
    .filter((p) => !!p.url)
    .map((p) => ({ url: p.url as string, caption: p.caption ?? null }));

  // reviews.submit writes up to TWO rows per booking: the shop review
  // (mechanic_id undefined) and an optional mechanic-tagged row with the same
  // shop_id. Only the shop row is a review OF the shop — counting both would
  // let two bookings clear the 3-review floor and fold a mechanic's rating
  // into the shop's average.
  const visible = ((reviewsRaw ?? []) as { rating: number; comment?: string; created_at?: number; hidden_at?: number; mechanic_id?: unknown; user?: { first_name?: string; last_name?: string } | null; _creationTime?: number }[])
    .filter((r) => r.hidden_at == null && r.mechanic_id == null && typeof r.rating === "number")
    .sort((a, b) => (b.created_at ?? b._creationTime ?? 0) - (a.created_at ?? a._creationTime ?? 0));
  const reviews: PublicReview[] = visible.slice(0, 10).map((r) => ({
    rating: r.rating,
    comment: r.comment?.trim() || null,
    createdAt: r.created_at ?? r._creationTime ?? null,
    reviewer: reviewerLabel(r.user),
  }));
  const rating =
    visible.length >= MIN_REVIEWS_TO_SHOW
      ? { average: Math.round((visible.reduce((a, r) => a + r.rating, 0) / visible.length) * 10) / 10, count: visible.length }
      : null;

  return {
    ...summarize(s, services.map((x) => x.slug)),
    description: s.description?.trim() || null,
    website: s.website?.trim() || null,
    hours,
    services,
    mechanics: mechs,
    portfolio: photos,
    reviews,
    rating,
  };
}

/** Only the shops physically on Staten Island (the live market). The gate
 *  above is the whole NYC box, so a verified Brooklyn shop would otherwise
 *  appear on pages titled "Staten Island". */
export function onStatenIsland(s: PublicShopSummary): boolean {
  return s.neighborhood !== null || /staten island/i.test(s.city);
}

/** Shops on the island offering a given service slug — for the local
 *  service pages. Empty when none, and the page must say so honestly. */
export async function shopsOfferingService(serviceSlug: string): Promise<PublicShopSummary[]> {
  return (await listPublicShops()).filter((s) => onStatenIsland(s) && s.serviceSlugs.includes(serviceSlug));
}

/** "8:00 AM" from "08:00". */
export function formatTime(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  if (Number.isNaN(h)) return hhmm;
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m ?? 0).padStart(2, "0")} ${suffix}`;
}
