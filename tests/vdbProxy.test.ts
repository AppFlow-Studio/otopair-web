import { describe, expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import { vdbUrlFor } from "../convex/vdbProxy";
import { identityFor, makeT } from "./helpers";

// Bug #435: the mobile app's VehicleDatabases calls go through this action so
// the key never ships in the bundle. It must not become an open proxy for the
// rest of VDB's (paid) API.

describe("vdbUrlFor", () => {
  test("allows the image, trim and model lookups the app makes", () => {
    expect(vdbUrlFor("/vehicle-images/1HGCM82633A004352")).toBe(
      "https://api.vehicledatabases.com/vehicle-images/1HGCM82633A004352",
    );
    const ymmt =
      "/vehicle-images/2024/Mercedes-Benz/GLE%20350/Base%20GLE%20350%204dr%20All-Wheel%20Drive%204MATIC";
    expect(vdbUrlFor(ymmt)).toBe(`https://api.vehicledatabases.com${ymmt}`);
    expect(vdbUrlFor("/ymm-specs/options/v3/trim/2024/BMW/530")).not.toBeNull();
    expect(vdbUrlFor("/ymm-specs/options/v3/model/2024/BMW")).not.toBeNull();
    // Trims can contain a slash, which the app sends encoded.
    expect(vdbUrlFor("/vehicle-images/2020/Ford/F-150/XL%202.7L%2FV6")).not.toBeNull();
  });

  test("refuses every other VDB endpoint", () => {
    expect(vdbUrlFor("/advanced-vin-decode/v2/1HGCM82633A004352")).toBeNull();
    expect(vdbUrlFor("/vehicle-repairs/v1/1HGCM82633A004352")).toBeNull();
    expect(vdbUrlFor("/ymm-specs/v4/2024/BMW/530")).toBeNull();
    expect(vdbUrlFor("/vehicle-images")).toBeNull();
  });

  test("dot segments can't walk out of an allowed prefix", () => {
    expect(vdbUrlFor("/vehicle-images/../advanced-vin-decode/v2/X")).toBeNull();
    expect(vdbUrlFor("/vehicle-images/%2e%2e/advanced-vin-decode/v2/X")).toBeNull();
    expect(vdbUrlFor("/vehicle-images/%2E%2E/%2e%2e/advanced-vin-decode/v2/X")).toBeNull();
  });

  test("the key can't be sent to another host", () => {
    expect(vdbUrlFor("//evil.example/vehicle-images/X")).toBeNull();
    expect(vdbUrlFor("https://evil.example/vehicle-images/X")).toBeNull();
    expect(vdbUrlFor("vehicle-images/X")).toBeNull();
  });

  test("no query strings or fragments", () => {
    expect(vdbUrlFor("/vehicle-images/X?limit=1000")).toBeNull();
    expect(vdbUrlFor("/vehicle-images/X#frag")).toBeNull();
  });
});

describe("vdbProxy.get", () => {
  test("requires a signed-in caller", async () => {
    const t = makeT();
    await expect(
      t.action(api.vdbProxy.get, { path: "/vehicle-images/1HGCM82633A004352" }),
    ).rejects.toThrow("sign in");
  });

  test("rejects a disallowed path before calling VDB", async () => {
    const t = makeT();
    await expect(
      t.withIdentity(identityFor("clerk_someone")).action(api.vdbProxy.get, {
        path: "/advanced-vin-decode/v2/1HGCM82633A004352",
      }),
    ).rejects.toThrow("Unsupported vehicle lookup.");
  });
});
