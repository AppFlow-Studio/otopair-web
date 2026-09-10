/**
 * The coverage ladder — one source for the landing's coverage section, the
 * /coverage page, the borough pages, the LocalBusiness `areaServed` and the
 * sitemap. Keep it current: a launch date in the past presented as future
 * reads as abandoned software (site audit 2026-08-31; the June 1 Staten
 * Island date shipped stale for three months).
 *
 * `live` is the only field with product meaning: it gates schema
 * (areaServed), the directory, and whether a borough page shows a waitlist
 * or the shops. `date` is display copy.
 */
export type Borough = {
  slug: string;
  name: string;
  /** Display form for the ladder: "Live now" or a quarter. */
  date: string;
  live: boolean;
  /** One line for cards and metadata. */
  blurb: string;
};

export const BOROUGHS: readonly Borough[] = [
  {
    slug: "staten-island",
    name: "Staten Island",
    date: "Live now",
    live: true,
    blurb: "The first market. Verified shops from St. George to Tottenville, bookable today.",
  },
  {
    slug: "brooklyn",
    name: "Brooklyn",
    date: "Q4 2026",
    live: false,
    blurb: "Next on the ladder. Drivers can join the waitlist now, and shops can apply ahead of opening.",
  },
  {
    slug: "queens",
    name: "Queens",
    date: "Q1 2027",
    live: false,
    blurb: "Opens after Brooklyn. Join the waitlist to hear when the first shops go live.",
  },
  {
    slug: "bronx",
    name: "The Bronx",
    date: "Q2 2027",
    live: false,
    blurb: "Opens after Queens. Join the waitlist to hear when the first shops go live.",
  },
  {
    slug: "manhattan",
    name: "Manhattan",
    date: "Q3 2027",
    live: false,
    blurb: "Last on the ladder. Join the waitlist to hear when the first shops go live.",
  },
] as const;

export const LIVE_BOROUGHS = BOROUGHS.filter((b) => b.live);
export const UPCOMING_BOROUGHS = BOROUGHS.filter((b) => !b.live);

export function boroughBySlug(slug: string): Borough | undefined {
  return BOROUGHS.find((b) => b.slug === slug);
}

/**
 * Staten Island's named neighborhoods, north to south, for the local hub
 * and for matching a shop's address to a neighborhood page. Neighborhood
 * pages exist ONLY where a verified shop serves the neighborhood (audit
 * §3.4) — this list is the vocabulary, not a page list.
 */
export const STATEN_ISLAND_NEIGHBORHOODS: readonly string[] = [
  "St. George",
  "Tompkinsville",
  "Stapleton",
  "Clifton",
  "Rosebank",
  "Shore Acres",
  "Fort Wadsworth",
  "New Brighton",
  "West Brighton",
  "Randall Manor",
  "Silver Lake",
  "Sunnyside",
  "Grymes Hill",
  "Port Richmond",
  "Elm Park",
  "Mariners Harbor",
  "Arlington",
  "Graniteville",
  "Bulls Head",
  "Westerleigh",
  "Castleton Corners",
  "Willowbrook",
  "Travis",
  "Chelsea",
  "Bloomfield",
  "Todt Hill",
  "Emerson Hill",
  "Dongan Hills",
  "Concord",
  "Grasmere",
  "Arrochar",
  "South Beach",
  "Old Town",
  "Midland Beach",
  "New Dorp",
  "Grant City",
  "Oakwood",
  "Richmondtown",
  "Lighthouse Hill",
  "New Springville",
  "Heartland Village",
  "Bay Terrace",
  "Great Kills",
  "Eltingville",
  "Annadale",
  "Arden Heights",
  "Huguenot",
  "Woodrow",
  "Rossville",
  "Prince's Bay",
  "Pleasant Plains",
  "Richmond Valley",
  "Charleston",
  "Tottenville",
] as const;

/** URL slug for a neighborhood name ("Prince's Bay" → "princes-bay"). */
export function neighborhoodSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/['’.]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
