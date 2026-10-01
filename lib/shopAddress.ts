// Shop address helpers (bug #354). One parser for the Google answer both
// setup-wizard paths get (a Places pick and the save-time geocode), one line
// formatter for every surface that prints a shop's address, and the
// coordinate / address-line checks the server and the repair migration share.
// Pure — imported by the portal, by Convex (convex/shops.ts, shopsGeo.ts,
// migrations/shopAddressRepair.ts) and by vitest. Because convex/ imports it,
// syncing convex/ to the mobile repo must copy this file to its lib/ too.

import { US_STATE_TIMEZONE } from "./shopTimezone";

export type AddressComponent = {
  longText?: string;
  shortText?: string;
  types?: string[];
};

/** A Google `LatLng` (accessor methods) or `LatLngLiteral` (plain numbers). */
export type GoogleLatLng =
  | {
      lat?: number | (() => number);
      lng?: number | (() => number);
    }
  | null
  | undefined;

export type ShopCoordinates = { lat: number; lng: number };

export type ParsedShopAddress = {
  address: string;
  city: string;
  state: string;
  zipCode: string;
  /** Null when Google returned no usable location for the place. */
  lat: number | null;
  lng: number | null;
};

export const SHOP_STREET_ADDRESS_REQUIRED =
  "Pick your shop's street address — a building number and street, not just the town or street name.";

const MISSING_LOCALITY =
  "This address is missing required location details. Choose a different suggestion.";

export function getAddressComponent(
  components: AddressComponent[],
  type: string,
  mode: "long" | "short" = "long"
) {
  const match = components.find((component) => component.types?.includes(type));
  if (!match) return "";
  return mode === "short" ? match.shortText ?? "" : match.longText ?? "";
}

/** Finite, on the globe, and not the (0,0) "never located" placeholder. */
export function hasShopCoordinates(lat: unknown, lng: unknown): boolean {
  return (
    typeof lat === "number" &&
    typeof lng === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180 &&
    !(lat === 0 && lng === 0)
  );
}

export function readLatLng(location: GoogleLatLng): ShopCoordinates | null {
  if (!location) return null;
  // Called as methods so a Maps LatLng keeps its `this`.
  const lat = typeof location.lat === "function" ? location.lat() : location.lat;
  const lng = typeof location.lng === "function" ? location.lng() : location.lng;
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  return hasShopCoordinates(lat, lng) ? { lat, lng } : null;
}

/**
 * The shop's address from one Google result — street line, city, state, ZIP
 * and map location all from the same place, so they can't describe two towns.
 * A town- or street-name-level result ("Jericho, NY", "86th St, Brooklyn, NY")
 * is refused: it has no single spot to drop the shop's pin on.
 */
export function parseGoogleShopAddress(
  components: AddressComponent[],
  location?: GoogleLatLng
): ParsedShopAddress | { error: string } {
  const streetNumber = getAddressComponent(components, "street_number");
  const route = getAddressComponent(components, "route");
  const zipCode = getAddressComponent(components, "postal_code");
  if (!streetNumber || !route || !zipCode) {
    return { error: SHOP_STREET_ADDRESS_REQUIRED };
  }

  const city =
    getAddressComponent(components, "locality") ||
    getAddressComponent(components, "postal_town") ||
    getAddressComponent(components, "sublocality_level_1");
  const state = getAddressComponent(components, "administrative_area_level_1", "short");
  if (!city || !state) {
    return { error: MISSING_LOCALITY };
  }

  const coordinates = readLatLng(location);
  return {
    address: `${streetNumber} ${route}`,
    city,
    state,
    zipCode,
    lat: coordinates?.lat ?? null,
    lng: coordinates?.lng ?? null,
  };
}

/**
 * Display lines for a shop's address: the street line, then "City, ST 12345".
 * Empty parts are left out, so an address-only shop prints one line instead
 * of a stray ", ".
 */
export function formatShopAddressLines(shop: {
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
}): string[] {
  const clean = (value: string | null | undefined) => (value ?? "").trim();
  const region = [clean(shop.state), clean(shop.zip)].filter(Boolean).join(" ");
  const locality = [clean(shop.city), region].filter(Boolean).join(", ");
  return [clean(shop.address), locality].filter(Boolean);
}

/**
 * Coordinates a client sent with a shop save. Null when none were sent;
 * throws on half a pair or an impossible value rather than storing a pin
 * somewhere the shop isn't.
 */
export function shopCoordinatesFromArgs(
  lat: number | undefined,
  lng: number | undefined
): ShopCoordinates | null {
  if (lat === undefined && lng === undefined) return null;
  if (lat === undefined || lng === undefined || !hasShopCoordinates(lat, lng)) {
    throw new Error("The shop's map location is invalid. Pick the street address again.");
  }
  return { lat, lng };
}

function sameAddressPart(a: string | null | undefined, b: string | null | undefined) {
  return (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
}

/** Whether any part a pin is placed from (street, city, state, ZIP) changed. */
export function shopAddressChanged(
  current: {
    address?: string | null;
    city?: string | null;
    state?: string | null;
    zip?: string | null;
  },
  next: { address: string; city: string; state: string; zipCode: string }
): boolean {
  return !(
    sameAddressPart(current.address, next.address) &&
    sameAddressPart(current.city, next.city) &&
    sameAddressPart(current.state, next.state) &&
    sameAddressPart(current.zip, next.zipCode)
  );
}

const ADDRESS_LINE_REGION_SUFFIX = /,\s*([A-Za-z]{2})(?:\s+(\d{5})(?:-\d{4})?)?(?:,\s*USA)?\s*$/;

/**
 * The ", ST" / ", ST 12345" a one-line application address carries at its
 * end ("39 Cameron Ave, Staten Island, NY 10305" → NY / 10305). Null when the
 * line is a bare street line.
 */
export function addressLineRegionSuffix(
  address: string | null | undefined
): { state: string; zip: string | null } | null {
  const match = ADDRESS_LINE_REGION_SUFFIX.exec((address ?? "").trim());
  if (!match) return null;
  const state = match[1].toUpperCase();
  if (!(state in US_STATE_TIMEZONE)) return null;
  return { state, zip: match[2] ?? null };
}

/** A shop row's stored location (the `shops` columns). */
export type StoredShopLocation = {
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  lat?: number | null;
  lng?: number | null;
};

export type ShopAddressIssue =
  /** The address line ends in ", ST[ 12345]" — a one-line application string. */
  | "address_includes_city_state"
  /** …and that ST isn't shops.state. */
  | "address_state_mismatch"
  /** …and its ZIP isn't shops.zip. */
  | "address_zip_mismatch"
  | "missing_city"
  | "missing_state"
  | "missing_zip"
  | "missing_coordinates";

export function shopAddressIssues(shop: StoredShopLocation): ShopAddressIssue[] {
  const issues: ShopAddressIssue[] = [];
  const state = (shop.state ?? "").trim().toUpperCase();
  const zip = (shop.zip ?? "").trim();

  const suffix = addressLineRegionSuffix(shop.address);
  if (suffix) {
    issues.push("address_includes_city_state");
    if (state && suffix.state !== state) issues.push("address_state_mismatch");
    if (zip && suffix.zip && suffix.zip !== zip) issues.push("address_zip_mismatch");
  }
  if (!(shop.city ?? "").trim()) issues.push("missing_city");
  if (!state) issues.push("missing_state");
  if (!zip) issues.push("missing_zip");
  if (!hasShopCoordinates(shop.lat, shop.lng)) issues.push("missing_coordinates");
  return issues;
}

// The issues that mean the stored parts don't describe one place: no pin can
// be trusted on, or geocoded from, such a record until it is repaired.
const INCOHERENT_ADDRESS_ISSUES: ReadonlySet<ShopAddressIssue> = new Set<ShopAddressIssue>([
  "address_state_mismatch",
  "address_zip_mismatch",
  "missing_city",
  "missing_state",
  "missing_zip",
]);

export function incoherentShopAddressIssues(shop: StoredShopLocation): ShopAddressIssue[] {
  return shopAddressIssues(shop).filter((issue) => INCOHERENT_ADDRESS_ISSUES.has(issue));
}

/**
 * The stored pin, when the stored address is one coherent place to trust it
 * on: street line, city, state and ZIP all present and agreeing, plus real
 * coordinates. Null otherwise — the setup wizard then re-checks the address
 * with Google instead of trusting a pin placed from a mixed record.
 */
export function storedShopCoordinates(shop: StoredShopLocation): ShopCoordinates | null {
  if (!(shop.address ?? "").trim()) return null;
  if (incoherentShopAddressIssues(shop).length > 0) return null;
  const { lat, lng } = shop;
  return typeof lat === "number" && typeof lng === "number" && hasShopCoordinates(lat, lng)
    ? { lat, lng }
    : null;
}
