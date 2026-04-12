/**
 * lib/vehicleDatabases.ts — Vehicle Databases API client
 *
 * Primary VIN decode source. Returns structured vehicle specs including
 * engine code, tire sizes, pressures, battery CCA, brake dimensions,
 * transmission details — data NHTSA doesn't provide.
 *
 * Confidence: 0.90 (paid structured source)
 * Fallback: NHTSA (free, always available)
 */

const VDB_BASE = "https://api.vehicledatabases.com";

export async function advancedVinDecode(vin: string): Promise<any | null> {
  // Check local cache first (saves credits, works when quota exhausted)
  const { VDB_CACHE } = await import("./vdbCache");
  const cached = VDB_CACHE[vin.toUpperCase()];
  if (cached) {
    console.log(`[vdb] Cache hit for ${vin}`);
    return cached;
  }

  const apiKey = process.env.VEHICLE_DATABASES_API_KEY;
  if (!apiKey) {
    console.log("[vdb] No API key, falling back to NHTSA only");
    return null;
  }

  try {
    const response = await fetch(`${VDB_BASE}/advanced-vin-decode/v2/${vin}`, {
      headers: { "x-AuthKey": apiKey },
    });

    if (!response.ok) {
      console.log(`[vdb] API error: ${response.status} — falling back to NHTSA`);
      return null;
    }

    const json = await response.json();
    if (json.status !== "success") {
      console.log(`[vdb] Decode failed: ${json.status}`);
      return null;
    }

    return json.data;
  } catch (err) {
    console.log(`[vdb] Failed: ${err}`);
    return null;
  }
}

// ─── VDB Repair Estimates API ────────────────────────────────────────────────
// Returns labor hours per service type for a vehicle via /repair-estimates/{vin}.
// We ONLY extract type + time_required_hours. Cost data is ignored.
// Mileage interval structure is flattened — enrichment handles intervals separately.

export async function fetchVDBLaborHours(vin: string): Promise<Map<string, number> | null> {
  const apiKey = process.env.VEHICLE_DATABASES_API_KEY;
  if (!apiKey) {
    console.log("[vdb-repair] No API key, skipping repair estimates");
    return null;
  }

  try {
    // Correct endpoint: /repair-estimates/{vin}
    const url = `${VDB_BASE}/repair-estimates/${vin}`;
    console.log(`[vdb-repair] Fetching: ${url}`);

    const response = await fetch(url, {
      headers: { "x-AuthKey": apiKey },
    });

    if (!response.ok) {
      console.log(`[vdb-repair] API error: ${response.status}`);
      return null;
    }

    const json = await response.json();

    if (json.status !== "success" || !json.data) {
      console.log(`[vdb-repair] API returned status=${json.status}, no data for ${vin}`);
      return null;
    }

    // VDB nests labor inside mileage groups — we ignore the mileage structure
    // entirely and just extract every unique labor type + hours.
    const rawBlocks = json.data.data;
    if (!Array.isArray(rawBlocks) || rawBlocks.length === 0) {
      console.log(`[vdb-repair] No data for ${vin}. keys: ${Object.keys(json.data).join(", ")}`);
      console.log(`[vdb-repair] Raw sample: ${JSON.stringify(json).slice(0, 1500)}`);
      return null;
    }

    // Flatten all labor items across the entire response.
    // Only extract type + time_required_hours. Ignore cost, mileage, everything else.
    const laborByType = new Map<string, number>();

    for (const block of rawBlocks) {
      const itemSets = Array.isArray(block.items) ? block.items : [block.items];
      for (const itemSet of itemSets) {
        const laborItems = itemSet?.labor;
        if (!Array.isArray(laborItems)) continue;

        for (const l of laborItems) {
          const hours = l.time_required_hours;
          if (hours == null || hours <= 0) continue;
          const type = l.type as string;
          if (!type) continue;
          if (!laborByType.has(type)) {
            laborByType.set(type, hours);
          }
        }
      }
    }

    console.log(`[vdb-repair] Got ${laborByType.size} unique labor types for ${vin}`);
    return laborByType;
  } catch (err) {
    console.log(`[vdb-repair] Failed: ${err}`);
    return null;
  }
}

/**
 * Maps VDB labor type strings to Otopair service slugs.
 * VDB types use "Action - Component" format (e.g. "Change - Engine oil").
 * Returns null for services we don't track or inspections we don't charge for.
 */
const VDB_TO_SERVICE_SLUG: Record<string, string> = {
  // Oil & filters
  "Change - Engine oil": "oil_change",
  "Replace - Oil filter": "oil_change", // bundled with oil change
  "Replace - Cabin air filter": "filter_replacement",
  "Replace - Engine air filter": "filter_replacement",
  // Brakes
  "Flush/replace - Brake fluid": "brake_fluid_flush",
  "Replace - Front brake pads": "brake_pad_replacement",
  "Replace - Rear brake pads": "brake_pad_replacement",
  "Replace - Front brake rotors": "rotor_replacement",
  "Replace - Rear brake rotors": "rotor_replacement",
  // Cooling
  "Flush/replace - Coolant": "coolant_flush",
  "Replace - Coolant": "coolant_flush",
  // Transmission
  "Change - Transmission fluid": "transmission_service",
  "Flush/replace - Transmission fluid": "transmission_service",
  // Tires & wheels
  "Rotate/adjust air pressure - Wheels & tires": "tire_rotation",
  "Balance - Tires": "tire_balance",
  // Spark plugs
  "Replace - Spark plugs": "spark_plugs",
  // Battery
  "Inspect - Battery": "battery_test",
  "Replace - Battery": "battery_replacement",
  // Power steering
  "Flush/replace - Power steering fluid": "power_steering_flush",
  "Check level - Power steering fluid": "power_steering_flush",
  // Differential
  "Change - Rear differential fluid": "differential_service",
  "Check level - Rear differential fluid": "differential_service",
  "Change - Front differential fluid": "differential_service",
  // Timing belt
  "Replace - Timing belt": "timing_belt",
  // Fuel
  "Clean - Fuel injection system": "fuel_system_cleaning",
};

/**
 * Maps raw VDB labor type strings to Otopair service slugs.
 * Returns a Map<serviceSlug, hours>.
 */
export function mapVDBLaborToSlugs(
  laborByType: Map<string, number>,
): Map<string, number> {
  const laborBySlug = new Map<string, number>();

  for (const [type, hours] of laborByType) {
    const slug = VDB_TO_SERVICE_SLUG[type];
    if (!slug) continue;
    if (laborBySlug.has(slug)) continue; // first match wins
    laborBySlug.set(slug, hours);
  }

  return laborBySlug;
}

export function extractVDBFields(data: any) {
  const specs = data.specifications || [];

  const findSpec = (title: string) => {
    const found = specs.find((s: any) => Object.keys(s)[0] === title);
    return found ? found[title] : {};
  };

  const dims = data.dimensions || [];

  const engineSpec = findSpec("engine");
  const tireSpec = findSpec("tires");
  const brakingSpec = findSpec("braking");
  const electricalSpec = findSpec("electrical");
  const steeringSpec = findSpec("steering");
  const fuelSpec = findSpec("fuel");

  const wheelDims = dims.find((d: any) => d.wheels)?.wheels || [];
  const brakingDims = dims.find((d: any) => d.braking)?.braking || [];

  const getWheelVal = (key: string) => {
    const entry = wheelDims.find((w: any) => w[key]);
    return entry?.[key]?.[0]?.value || null;
  };

  const getBrakeVal = (key: string) => {
    const entry = brakingDims.find((b: any) => b[key]);
    return entry?.[key]?.[0]?.value || null;
  };

  // Engine description from standard options
  const engineDescription =
    data.standard_options?.find((o: any) => o.name === "Engine")?.description || null;

  // Cylinders from dimensions
  const engineDims = dims.find((d: any) => d.engine)?.engine || [];
  const cylindersRaw = engineDims.find((e: any) => e.engine_size)?.engine_size?.[0]?.value;

  return {
    // Identity
    year: data.year ? parseInt(data.year) : null,
    make: data.make || null,
    model: data.model || null,
    trim: data.trim || null,
    bodyType: data.vehicle?.body_type || null,
    doors: data.vehicle?.doors ? parseInt(data.vehicle.doors) : null,

    // Engine
    engineCode: engineSpec.code || null,
    engineDescription,
    cylinders: cylindersRaw ? parseFloat(cylindersRaw) : null,
    displacement: engineSpec.displacement ? engineSpec.displacement / 1000 : null,
    camType: engineSpec.cam_type || null,
    blockType: engineSpec.block_type || null,
    drivetrain: engineSpec.drivetype || null,
    fuelType: fuelSpec?.type || null,

    // Transmission
    transType: data.transmission?.type || null,
    transSpeeds: data.transmission?.number_of_speeds
      ? parseInt(data.transmission.number_of_speeds)
      : null,
    transDescription: data.transmission?.description || null,

    // Tires
    frontTireSize: tireSpec.front_tire_size || null,
    rearTireSize: tireSpec.rear_tire_size || null,
    frontTirePressure: tireSpec.front_tire_pressure_psi
      ? parseInt(tireSpec.front_tire_pressure_psi)
      : null,
    rearTirePressure: tireSpec.rear_tire_pressure_psi
      ? parseInt(tireSpec.rear_tire_pressure_psi)
      : null,

    // Wheels
    wheelTorque: getWheelVal("wheel_torque")
      ? parseFloat(getWheelVal("wheel_torque"))
      : null,

    // Battery
    cca: electricalSpec.cold_cranking_capacity_amps
      ? parseInt(electricalSpec.cold_cranking_capacity_amps)
      : null,

    // Brakes
    frontRotorDia: getBrakeVal("front_brake_rotor_dia")
      ? parseFloat(getBrakeVal("front_brake_rotor_dia"))
      : null,
    rearRotorDia: getBrakeVal("rear_brake_rotor_dia")
      ? parseFloat(getBrakeVal("rear_brake_rotor_dia"))
      : null,
    brakeType: brakingSpec.type || null,

    // Steering
    steeringType: steeringSpec?.type || null,
  };
}
