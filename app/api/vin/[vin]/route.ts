import { NextResponse } from "next/server";
import { composeVehicleLabel } from "@/components/flagship/oto-flow";

// Makes that should stay uppercase rather than title-cased ("BMW", not "Bmw").
const ACRONYM_MAKES = new Set(["BMW", "GMC", "RAM", "MINI"]);

/**
 * Decode a VIN via NHTSA vPIC (free, no key). Mirrors the mechanic walk-in
 * decode in app/(portal)/schedule/create-booking-drawer.tsx so the flagship
 * hero gets the same year/make/model/trim shape.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ vin: string }> }
) {
  const { vin } = await params;
  const clean = (vin ?? "").trim().toUpperCase();

  // VINs are 17 chars (no I/O/Q); accept 11–17 to be forgiving on partials.
  if (!/^[A-HJ-NPR-Z0-9]{11,17}$/.test(clean)) {
    return NextResponse.json({ error: "Invalid VIN" }, { status: 400 });
  }

  try {
    const res = await fetch(
      `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValuesExtended/${encodeURIComponent(clean)}?format=json`,
      { cache: "no-store" }
    );
    if (!res.ok) {
      return NextResponse.json({ error: "NHTSA request failed" }, { status: 502 });
    }
    const data = await res.json();
    const row = data?.Results?.[0];

    if (!row || row.ErrorCode === "11" || (!row.Make && !row.Model && !row.ModelYear)) {
      return NextResponse.json({ error: "Could not decode VIN" }, { status: 422 });
    }

    const year = row.ModelYear ? Number(row.ModelYear) : undefined;
    const makeUpper = (row.Make ?? "").toUpperCase();
    const make = row.Make
      ? ACRONYM_MAKES.has(makeUpper)
        ? makeUpper
        : titleCase(row.Make)
      : undefined;
    const model = row.Model || undefined;
    const trim = row.Trim || row.Series || undefined;

    // Raw engine fields — passed through so the backend can build the canonical
    // vehicle_configs.nhtsa_vin_key for an instant cache lookup.
    const displacementL =
      row.DisplacementL && Number.isFinite(Number(row.DisplacementL))
        ? Number(row.DisplacementL)
        : undefined;
    const cylinders =
      row.EngineCylinders && Number.isFinite(Number(row.EngineCylinders))
        ? Number(row.EngineCylinders)
        : undefined;
    const fuelType = row.FuelTypePrimary || undefined;

    // Compose a short engine summary for display.
    const engineParts: string[] = [];
    if (displacementL) engineParts.push(`${displacementL.toFixed(1)}L`);
    if (cylinders) engineParts.push(`${cylinders}-cyl`);
    if (fuelType && !/gasoline/i.test(fuelType)) engineParts.push(fuelType);
    const engine = engineParts.length ? engineParts.join(" ") : undefined;

    return NextResponse.json({
      vin: clean,
      year,
      make,
      model,
      trim,
      engine,
      displacementL,
      cylinders,
      fuelType,
      bodyClass: row.BodyClass || undefined,
      label: composeVehicleLabel({ year, make, model, trim }),
    });
  } catch (err) {
    return NextResponse.json(
      { error: "VIN decode failed", detail: String(err) },
      { status: 500 }
    );
  }
}

function titleCase(s: string) {
  return s
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
