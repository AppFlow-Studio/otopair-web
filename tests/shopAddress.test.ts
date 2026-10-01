import { describe, expect, test } from "vitest";
import {
  SHOP_STREET_ADDRESS_REQUIRED,
  addressLineRegionSuffix,
  formatShopAddressLines,
  hasShopCoordinates,
  incoherentShopAddressIssues,
  parseGoogleShopAddress,
  shopAddressChanged,
  shopAddressIssues,
  shopCoordinatesFromArgs,
  storedShopCoordinates,
  type AddressComponent,
} from "../lib/shopAddress";

// Bug #354: a shop's saved location mixed two places ("Jericho, NY" over
// "Austin, TX 78701") because a town-level Google result was accepted and
// City/State/ZIP came from somewhere else.

const component = (types: string[], longText: string, shortText = longText): AddressComponent => ({
  types,
  longText,
  shortText,
});

const jerichoStreet: AddressComponent[] = [
  component(["street_number"], "350"),
  component(["route"], "Jericho Turnpike", "Jericho Tpke"),
  component(["locality", "political"], "Jericho"),
  component(["administrative_area_level_2", "political"], "Nassau County"),
  component(["administrative_area_level_1", "political"], "New York", "NY"),
  component(["postal_code"], "11753"),
];

const jerichoTown: AddressComponent[] = [
  component(["locality", "political"], "Jericho"),
  component(["administrative_area_level_1", "political"], "New York", "NY"),
];

const streetNameOnly: AddressComponent[] = [
  component(["route"], "86th Street", "86th St"),
  component(["sublocality_level_1", "sublocality", "political"], "Brooklyn"),
  component(["administrative_area_level_1", "political"], "New York", "NY"),
];

describe("parseGoogleShopAddress", () => {
  test("a street-level place gives one coherent address with its map location", () => {
    // Places API (New) returns a LatLng with accessor methods.
    const location = {
      _lat: 40.7918,
      _lng: -73.5397,
      lat() {
        return this._lat;
      },
      lng() {
        return this._lng;
      },
    };
    expect(parseGoogleShopAddress(jerichoStreet, location)).toEqual({
      address: "350 Jericho Turnpike",
      city: "Jericho",
      state: "NY",
      zipCode: "11753",
      lat: 40.7918,
      lng: -73.5397,
    });
  });

  test("reads a plain lat/lng literal too", () => {
    const parsed = parseGoogleShopAddress(jerichoStreet, { lat: 40.7918, lng: -73.5397 });
    expect(parsed).toMatchObject({ lat: 40.7918, lng: -73.5397 });
  });

  test("a street-level place with no location still parses, with no coordinates", () => {
    expect(parseGoogleShopAddress(jerichoStreet, undefined)).toMatchObject({
      address: "350 Jericho Turnpike",
      lat: null,
      lng: null,
    });
    expect(parseGoogleShopAddress(jerichoStreet, { lat: 0, lng: 0 })).toMatchObject({
      lat: null,
      lng: null,
    });
  });

  test("a town-level result is refused", () => {
    expect(parseGoogleShopAddress(jerichoTown, { lat: 40.79, lng: -73.54 })).toEqual({
      error: SHOP_STREET_ADDRESS_REQUIRED,
    });
  });

  test("a street name without a building number is refused", () => {
    expect(parseGoogleShopAddress(streetNameOnly, { lat: 40.62, lng: -74.03 })).toEqual({
      error: SHOP_STREET_ADDRESS_REQUIRED,
    });
  });

  test("a street address without a ZIP is refused", () => {
    const noZip = jerichoStreet.filter((part) => !part.types?.includes("postal_code"));
    expect(parseGoogleShopAddress(noZip, { lat: 40.79, lng: -73.54 })).toEqual({
      error: SHOP_STREET_ADDRESS_REQUIRED,
    });
  });

  test("falls back to the borough when Google gives no locality (NYC)", () => {
    const statenIsland: AddressComponent[] = [
      component(["street_number"], "39"),
      component(["route"], "Cameron Avenue", "Cameron Ave"),
      component(["sublocality_level_1", "sublocality", "political"], "Staten Island"),
      component(["administrative_area_level_1", "political"], "New York", "NY"),
      component(["postal_code"], "10305"),
    ];
    expect(parseGoogleShopAddress(statenIsland, { lat: 40.6, lng: -74.07 })).toMatchObject({
      address: "39 Cameron Avenue",
      city: "Staten Island",
      state: "NY",
      zipCode: "10305",
    });
  });
});

describe("formatShopAddressLines", () => {
  test("street line then City, ST ZIP", () => {
    expect(
      formatShopAddressLines({
        address: "350 Jericho Turnpike",
        city: "Jericho",
        state: "NY",
        zip: "11753",
      })
    ).toEqual(["350 Jericho Turnpike", "Jericho, NY 11753"]);
  });

  test("an address-only shop prints one line, no stray ', '", () => {
    expect(formatShopAddressLines({ address: "Jericho, NY" })).toEqual(["Jericho, NY"]);
    expect(
      formatShopAddressLines({ address: "86th St, Brooklyn, NY", city: "", state: null, zip: " " })
    ).toEqual(["86th St, Brooklyn, NY"]);
  });

  test("leaves out whichever part is missing", () => {
    expect(formatShopAddressLines({ address: "1 Main St", state: "NY", zip: "11753" })).toEqual([
      "1 Main St",
      "NY 11753",
    ]);
    expect(formatShopAddressLines({ city: "Jericho", state: "NY" })).toEqual(["Jericho, NY"]);
    expect(formatShopAddressLines({})).toEqual([]);
  });
});

describe("coordinate and address-line checks", () => {
  test("hasShopCoordinates rejects missing, non-finite, off-globe and (0,0)", () => {
    expect(hasShopCoordinates(40.79, -73.54)).toBe(true);
    expect(hasShopCoordinates(null, -73.54)).toBe(false);
    expect(hasShopCoordinates(Number.NaN, -73.54)).toBe(false);
    expect(hasShopCoordinates(91, -73.54)).toBe(false);
    expect(hasShopCoordinates(40.79, -181)).toBe(false);
    expect(hasShopCoordinates(0, 0)).toBe(false);
  });

  test("shopCoordinatesFromArgs: none, a valid pair, or an error", () => {
    expect(shopCoordinatesFromArgs(undefined, undefined)).toBeNull();
    expect(shopCoordinatesFromArgs(40.79, -73.54)).toEqual({ lat: 40.79, lng: -73.54 });
    expect(() => shopCoordinatesFromArgs(40.79, undefined)).toThrow(/map location/);
    expect(() => shopCoordinatesFromArgs(123, -73.54)).toThrow(/map location/);
    expect(() => shopCoordinatesFromArgs(Number.POSITIVE_INFINITY, -73.54)).toThrow();
  });

  test("shopAddressChanged ignores case and surrounding spaces only", () => {
    const current = { address: "350 Jericho Turnpike", city: "Jericho", state: "NY", zip: "11753" };
    expect(
      shopAddressChanged(current, {
        address: " 350 jericho turnpike ",
        city: "JERICHO",
        state: "ny",
        zipCode: "11753",
      })
    ).toBe(false);
    expect(
      shopAddressChanged(current, {
        address: "350 Jericho Turnpike",
        city: "Jericho",
        state: "NY",
        zipCode: "11791",
      })
    ).toBe(true);
    expect(
      shopAddressChanged({ address: "Jericho, NY" }, {
        address: "350 Jericho Turnpike",
        city: "Jericho",
        state: "NY",
        zipCode: "11753",
      })
    ).toBe(true);
  });

  test("addressLineRegionSuffix finds a one-line application address's state/ZIP", () => {
    expect(addressLineRegionSuffix("Jericho, NY")).toEqual({ state: "NY", zip: null });
    expect(addressLineRegionSuffix("39 Cameron Ave, Staten Island, NY 10305")).toEqual({
      state: "NY",
      zip: "10305",
    });
    expect(addressLineRegionSuffix("Jericho, NY, USA")).toEqual({ state: "NY", zip: null });
    expect(addressLineRegionSuffix("350 Jericho Turnpike")).toBeNull();
    expect(addressLineRegionSuffix("12 Main St, Unit 4B")).toBeNull();
    expect(addressLineRegionSuffix("12 Main St, ZZ")).toBeNull();
    expect(addressLineRegionSuffix(undefined)).toBeNull();
  });
});

// The setup wizard's Step 0 gate and its "verified" form state both read this:
// the old wizard trusted any stored address line (Boolean(address)).
describe("storedShopCoordinates", () => {
  const coherent = {
    address: "350 Jericho Turnpike",
    city: "Jericho",
    state: "NY",
    zip: "11753",
    lat: 40.7918,
    lng: -73.5397,
  };

  test("a coherent pinned shop gives its coordinates", () => {
    expect(storedShopCoordinates(coherent)).toEqual({ lat: 40.7918, lng: -73.5397 });
  });

  test("an invite-created shop (one-line application address, nothing else) gives null", () => {
    expect(storedShopCoordinates({ address: "Jericho, NY" })).toBeNull();
    expect(
      storedShopCoordinates({ address: "Jericho, NY", city: undefined, lat: null, lng: null })
    ).toBeNull();
  });

  test("a pin on a record missing city, state or ZIP gives null", () => {
    expect(storedShopCoordinates({ ...coherent, city: "" })).toBeNull();
    expect(storedShopCoordinates({ ...coherent, state: undefined })).toBeNull();
    expect(storedShopCoordinates({ ...coherent, zip: "  " })).toBeNull();
    expect(storedShopCoordinates({ ...coherent, address: "" })).toBeNull();
  });

  test("a pin on a mixed record (application line over typed Austin, TX) gives null", () => {
    const mixed = {
      address: "Jericho, NY",
      city: "Austin",
      state: "TX",
      zip: "78701",
      lat: 30.2672,
      lng: -97.7431,
    };
    expect(storedShopCoordinates(mixed)).toBeNull();
    expect(incoherentShopAddressIssues(mixed)).toEqual(["address_state_mismatch"]);
  });

  test("no pin, or the (0,0) placeholder, gives null", () => {
    expect(storedShopCoordinates({ ...coherent, lat: null, lng: null })).toBeNull();
    expect(storedShopCoordinates({ ...coherent, lat: 0, lng: 0 })).toBeNull();
  });
});

describe("shopAddressIssues", () => {
  test("flags the #354 shape: application line, mismatched state/ZIP, no pin", () => {
    expect(
      shopAddressIssues({
        address: "39 Cameron Ave, Staten Island, NY 10305",
        city: "Autsin",
        state: "TX",
        zip: "23123",
      })
    ).toEqual([
      "address_includes_city_state",
      "address_state_mismatch",
      "address_zip_mismatch",
      "missing_coordinates",
    ]);
  });

  test("a pinless coherent shop is only missing its coordinates — not incoherent", () => {
    const pinless = { address: "350 Jericho Turnpike", city: "Jericho", state: "NY", zip: "11753" };
    expect(shopAddressIssues(pinless)).toEqual(["missing_coordinates"]);
    expect(incoherentShopAddressIssues(pinless)).toEqual([]);
  });

  test("an address-only shop is incoherent (no city/state/ZIP to check it against)", () => {
    expect(incoherentShopAddressIssues({ address: "Jericho, NY" })).toEqual([
      "missing_city",
      "missing_state",
      "missing_zip",
    ]);
  });
});
