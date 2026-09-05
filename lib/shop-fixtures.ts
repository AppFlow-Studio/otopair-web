import type { PublicShopProfile, PublicShopSummary } from "./public-shops";
import { SERVICES } from "./service-catalog";

/**
 * DEV-ONLY fixture shops for previewing the populated states of the local
 * pages (/shops, /shops/<slug>, /staten-island, /staten-island/<service>)
 * while the shared development deployment has no verified shop.
 *
 * The pages are designed for release, so `next dev` shows them populated:
 * lib/public-shops.ts falls back to these whenever the live list is empty
 * and NODE_ENV is "development". A production build never reads them, so
 * none of these names can reach a real visitor; set SHOP_FIXTURES=0 in
 * .env.local to see the honest empty states in development. The shops,
 * people and reviews are invented for layout; coordinates sit near real
 * Staten Island neighborhoods so the map pins land where a shop plausibly
 * would.
 */
export function devFixturesEnabled(): boolean {
  return process.env.NODE_ENV === "development" && process.env.SHOP_FIXTURES !== "0";
}

const DAY = 86_400_000;
const NOW = Date.now();

const HOURS_WEEKDAYS = (open: string, close: string, sat: [string, string] | null = ["08:00", "14:00"]) =>
  [0, 1, 2, 3, 4, 5, 6].map((day) => {
    const name = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][day];
    if (day === 0) return { day, dayName: name, open: null, close: null };
    if (day === 6) return { day, dayName: name, open: sat ? sat[0] : null, close: sat ? sat[1] : null };
    return { day, dayName: name, open, close };
  });

type Seed = Omit<PublicShopProfile, "verified" | "serviceCount" | "openToday" | "state" | "city"> & { city?: string };

const SEEDS: Seed[] = [
  {
    slug: "hylan-boulevard-auto",
    name: "Hylan Boulevard Auto",
    address: "2140 Hylan Blvd",
    zip: "10306",
    lat: 40.5786,
    lng: -74.1027,
    logoUrl: null,
    neighborhood: "Grant City",
    serviceSlugs: ["oil_change", "brake_pad_replacement", "rotor_replacement", "state_inspection", "tire_rotation", "battery_replacement", "check_engine_light", "diagnostic_scan"],
    description: "Family-run since 2004. Two lifts, a dyno bay, and a waiting room with real coffee.",
    website: null,
    hours: HOURS_WEEKDAYS("08:00", "18:00"),
    services: [],
    mechanics: [
      { name: "Marcus T.", title: "Lead technician", photoUrl: null },
      { name: "Dee A.", title: "Technician", photoUrl: null },
      { name: "Sal R.", title: "Inspections", photoUrl: null },
    ],
    portfolio: [],
    reviews: [
      { rating: 5, comment: "Quoted the number in the app and that was the number. In and out in under two hours.", createdAt: NOW - 12 * DAY, reviewer: "Maria R." },
      { rating: 4, comment: "Front pads done. They asked about a rotor mid-job and I approved it in the app, no phone tag.", createdAt: NOW - 40 * DAY, reviewer: "Sam K." },
      { rating: 5, comment: null, createdAt: NOW - 90 * DAY, reviewer: "Otopair driver" },
      { rating: 5, comment: "State inspection on a Saturday morning. Done before my coffee was.", createdAt: NOW - 130 * DAY, reviewer: "Jordan P." },
    ],
    rating: { average: 4.8, count: 4 },
  },
  {
    slug: "port-richmond-service-center",
    name: "Port Richmond Service Center",
    address: "1450 Forest Ave",
    zip: "10302",
    lat: 40.6315,
    lng: -74.132,
    logoUrl: null,
    neighborhood: "Port Richmond",
    serviceSlugs: ["oil_change", "battery_replacement", "battery_test", "filter_replacement", "tire_rotation", "wheel_alignment"],
    description: null,
    website: null,
    hours: HOURS_WEEKDAYS("07:30", "17:30", null),
    services: [],
    mechanics: [{ name: "Joe R.", title: "Owner, technician", photoUrl: null }],
    portfolio: [],
    reviews: [],
    rating: null,
  },
  {
    slug: "tottenville-tire-and-brake",
    name: "Tottenville Tire & Brake",
    address: "7001 Amboy Rd",
    zip: "10307",
    lat: 40.5105,
    lng: -74.2402,
    logoUrl: null,
    neighborhood: "Tottenville",
    serviceSlugs: ["tire_rotation", "tire_balance", "wheel_alignment", "tire_replacement", "brake_pad_replacement", "rotor_replacement", "brake_fluid_flush"],
    description: "Tires and brakes only, and we like it that way.",
    website: null,
    hours: HOURS_WEEKDAYS("08:00", "17:00", ["09:00", "13:00"]),
    services: [],
    mechanics: [
      { name: "Sam V.", title: "Technician", photoUrl: null },
      { name: "Priya N.", title: "Technician", photoUrl: null },
    ],
    portfolio: [],
    reviews: [
      { rating: 5, comment: "Four tires, balanced, aligned. Price matched the quote to the cent.", createdAt: NOW - 8 * DAY, reviewer: "Chris D." },
      { rating: 4, comment: "Brake fluid flush. Quick, and they showed me the old fluid.", createdAt: NOW - 55 * DAY, reviewer: "Lena M." },
      { rating: 5, comment: null, createdAt: NOW - 70 * DAY, reviewer: "Otopair driver" },
    ],
    rating: { average: 4.7, count: 3 },
  },
  {
    slug: "bay-street-motors",
    name: "Bay Street Motors",
    address: "580 Bay St",
    zip: "10304",
    lat: 40.6238,
    lng: -74.0745,
    logoUrl: null,
    neighborhood: "Stapleton",
    serviceSlugs: ["oil_change", "spark_plugs", "coolant_flush", "transmission_service", "check_engine_light", "diagnostic_scan", "state_inspection", "emissions_test"],
    description: "Diagnostics and scheduled service. Closest verified shop to the ferry.",
    website: null,
    hours: HOURS_WEEKDAYS("08:00", "18:30"),
    services: [],
    mechanics: [
      { name: "Twunna S.", title: "Master technician", photoUrl: null },
      { name: "Andre L.", title: "Technician", photoUrl: null },
    ],
    portfolio: [],
    reviews: [
      { rating: 5, comment: "Check engine light. They found a loose gas cap sensor, charged the diagnosis and nothing else.", createdAt: NOW - 20 * DAY, reviewer: "Nadia F." },
      { rating: 4, comment: null, createdAt: NOW - 60 * DAY, reviewer: "Otopair driver" },
      { rating: 5, comment: "Transmission service on a 2016 Highlander. Done in the window they said.", createdAt: NOW - 100 * DAY, reviewer: "Omar H." },
    ],
    rating: { average: 4.7, count: 3 },
  },
  {
    slug: "victory-blvd-auto-repair",
    name: "Victory Blvd Auto Repair",
    address: "2455 Victory Blvd",
    zip: "10314",
    lat: 40.6052,
    lng: -74.1568,
    logoUrl: null,
    neighborhood: "Bulls Head",
    serviceSlugs: ["oil_change", "brake_pad_replacement", "battery_replacement", "tire_rotation", "state_inspection", "filter_replacement", "timing_belt", "power_steering_flush"],
    description: null,
    website: null,
    hours: HOURS_WEEKDAYS("07:00", "19:00", ["08:00", "16:00"]),
    services: [],
    mechanics: [{ name: "Luis C.", title: "Technician", photoUrl: null }, { name: "Ben O.", title: "Technician", photoUrl: null }],
    portfolio: [],
    reviews: [],
    rating: null,
  },
  {
    slug: "great-kills-garage",
    name: "Great Kills Garage",
    address: "4040 Hylan Blvd",
    zip: "10308",
    lat: 40.5538,
    lng: -74.1512,
    logoUrl: null,
    neighborhood: "Great Kills",
    serviceSlugs: ["oil_change", "brake_pad_replacement", "rotor_replacement", "tire_rotation", "tire_balance", "battery_test", "battery_replacement"],
    description: "Open late on Thursdays.",
    website: null,
    hours: HOURS_WEEKDAYS("08:00", "17:00"),
    services: [],
    mechanics: [{ name: "Gina P.", title: "Owner, technician", photoUrl: null }],
    portfolio: [],
    reviews: [
      { rating: 5, comment: "Oil change and rotation. Reminder for the next one landed in the app.", createdAt: NOW - 15 * DAY, reviewer: "Tom W." },
      { rating: 5, comment: null, createdAt: NOW - 45 * DAY, reviewer: "Otopair driver" },
      { rating: 4, comment: "Rear pads. Fair and quick.", createdAt: NOW - 80 * DAY, reviewer: "Ari S." },
    ],
    rating: { average: 4.7, count: 3 },
  },
  {
    slug: "new-dorp-automotive",
    name: "New Dorp Automotive",
    address: "255 New Dorp Ln",
    zip: "10306",
    lat: 40.5731,
    lng: -74.1163,
    logoUrl: null,
    neighborhood: "New Dorp",
    serviceSlugs: ["oil_change", "state_inspection", "emissions_test", "diagnostic_scan", "check_engine_light", "coolant_flush"],
    description: null,
    website: null,
    hours: HOURS_WEEKDAYS("08:30", "17:30", null),
    services: [],
    mechanics: [{ name: "Ray D.", title: "Inspections", photoUrl: null }],
    portfolio: [],
    reviews: [],
    rating: null,
  },
];

/** Today's hours for a fixture, matching lib/public-shops semantics. */
function openToday(hours: PublicShopProfile["hours"]): PublicShopSummary["openToday"] {
  const short = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "America/New_York" }).format(new Date());
  const day = Math.max(0, ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(short));
  const h = hours.find((x) => x.day === day);
  return h && h.open && h.close ? { open: h.open, close: h.close } : null;
}

export const FIXTURE_SHOPS: PublicShopProfile[] = SEEDS.map((s) => ({
  ...s,
  city: s.city ?? "Staten Island",
  state: "NY",
  verified: true as const,
  serviceCount: s.serviceSlugs.length,
  openToday: openToday(s.hours),
  services: SERVICES.filter((c) => s.serviceSlugs.includes(c.slug)).map((c) => ({ name: c.name, slug: c.slug, description: c.description, category: c.category })),
})).sort((a, b) => a.name.localeCompare(b.name));

export function fixtureShop(slug: string): PublicShopProfile | null {
  return FIXTURE_SHOPS.find((s) => s.slug === slug) ?? null;
}
