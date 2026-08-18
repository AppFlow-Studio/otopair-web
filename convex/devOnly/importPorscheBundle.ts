/**
 * One-off dev seed: copies the 2024 Porsche 911 Turbo S (VIN
 * WP0AD2A9XRS252812) from Temur's dev deployment (ardent-crab-641) into THIS
 * deployment, EXACTLY as it stands there — config, identity, 14 part fitments
 * with their oem_parts + part_prices, the trim_specs fluid/tire package — and
 * makes temursayfutdinov3@gmail.com its owner, so the car is bookable here for
 * testing.
 *
 * The `makes` table shares ids across both dev deployments (common seed), so
 * the Porsche make id is reused verbatim; everything below the make (model /
 * trim / engine / transmission / config / parts / prices / fitments) is created
 * fresh here with local ids and remapped by hand — the source rows' string FKs
 * would dangle otherwise. Part fitments carry the part slug (service_type) and
 * are wired to the freshly-inserted oem_parts by normalized OEM number.
 *
 * Idempotent-by-abort: refuses to run if this VIN or config_key already exists
 * (delete those rows to re-run). Values are lifted verbatim from ardent-crab on
 * 2026-08-17; prices include the estimator_endpoint (non-pooled) battery point,
 * so the "unpriced battery" case reproduces exactly.
 *
 * Run:
 *   npx convex run devOnly/importPorscheBundle:run
 */
import { internalMutation } from "../_generated/server";

// Porsche make — same _id on both dev deployments (shared makes seed).
const PORSCHE_MAKE_ID = "j57f0e0p7njrvn2gh5bgphvxb584g40d";
const VIN = "WP0AD2A9XRS252812";
const CONFIG_KEY =
  "2024_porsche_911_turbo_s_2dr_all_wheel_drive_coupe_automatic_dkha";
const OWNER_EMAIL = "temursayfutdinov3@gmail.com";

// 14 oem_parts, keyed by normalized OEM number (the fitment→part join key).
const PARTS: Array<{
  norm: string;
  oem_part_number: string;
  name: string;
  category: string;
  subcategory: string;
  source_count: number;
}> = [
  { norm: "0PB115466", oem_part_number: "0PB-115-466", name: "Oil Filter", category: "filter", subcategory: "oil_filter", source_count: 2 },
  { norm: "95810380100", oem_part_number: "958-103-801-00", name: "Oil Drain Plug Gasket", category: "gasket", subcategory: "drain_plug_gasket", source_count: 1 },
  { norm: "992819429", oem_part_number: "992-819-429", name: "Cabin Air Filter", category: "filter", subcategory: "cabin_filter", source_count: 2 },
  { norm: "992698151L", oem_part_number: "992-698-151-L", name: "Front Brake Pads", category: "brake", subcategory: "front_brake_pad", source_count: 1 },
  { norm: "992698451L", oem_part_number: "992-698-451-L", name: "Rear Brake Pads", category: "brake", subcategory: "rear_brake_pad", source_count: 1 },
  { norm: "992615601A", oem_part_number: "992615601A", name: "Front Brake Rotor", category: "rotor", subcategory: "front_rotor", source_count: 1 },
  { norm: "0PB903137B", oem_part_number: "0PB-903-137-B", name: "Serpentine Belt", category: "belt", subcategory: "serpentine_belt", source_count: 1 },
  { norm: "992915105A", oem_part_number: "992915105A", name: "Battery", category: "electrical", subcategory: "battery", source_count: 1 },
  { norm: "V04015004AS", oem_part_number: "V04015004AS", name: "Coolant", category: "cooling", subcategory: "coolant", source_count: 1 },
  { norm: "00004330513", oem_part_number: "00004330513", name: "Transmission Fluid (ATF / CVT)", category: "fluid", subcategory: "atf_fluid", source_count: 1 },
  { norm: "00004320671", oem_part_number: "000-043-206-71", name: "Brake Fluid", category: "fluid", subcategory: "brake_fluid", source_count: 1 },
  { norm: "00004321044", oem_part_number: "00004321044", name: "Gear Oil (GL-5 hypoid)", category: "fluid", subcategory: "gear_oil", source_count: 1 },
  { norm: "992612175", oem_part_number: "992-612-175", name: "Brake Wear Sensor (Front)", category: "brake", subcategory: "front_brake_wear_sensor", source_count: 1 },
  { norm: "992612176", oem_part_number: "992-612-176", name: "Brake Wear Sensor (Rear)", category: "brake", subcategory: "rear_brake_wear_sensor", source_count: 1 },
];

// part_prices, keyed by the part's normalized OEM number.
const PRICES: Record<
  string,
  Array<{ price: number; price_type: string; source_domain: string; source_url: string }>
> = {
  "0PB115466": [
    { price: 22.5, price_type: "online_discount", source_domain: "suncoastparts.com", source_url: "https://www.suncoastparts.com/product/PK992OFK.html" },
    { price: 41.54, price_type: "estimator_endpoint", source_domain: "estimator_endpoint", source_url: "internal://estimator/estimate" },
  ],
  "992819429": [
    { price: 11.875, price_type: "online_discount", source_domain: "pelicanparts.com", source_url: "https://www.pelicanparts.com/More_Info/992819429.htm?pn=992-819-429-OEM" },
    { price: 91.38, price_type: "estimator_endpoint", source_domain: "estimator_endpoint", source_url: "internal://estimator/estimate" },
  ],
  "992698151L": [
    { price: 1425.69, price_type: "estimator_endpoint", source_domain: "estimator_endpoint", source_url: "internal://estimator/estimate" },
  ],
  "992615601A": [
    { price: 11461.77, price_type: "estimator_endpoint", source_domain: "estimator_endpoint", source_url: "internal://estimator/estimate" },
  ],
  "992915105A": [
    { price: 1200.43, price_type: "estimator_endpoint", source_domain: "estimator_endpoint", source_url: "internal://estimator/estimate" },
  ],
};

// 14 part_fitments — service slug (service_type) + role + qty + provenance.
const FITMENTS: Array<{
  norm: string;
  service_type: string;
  service_role: string;
  quantity_needed: number;
  confidence: number;
  source_domains: string[];
  position?: string;
}> = [
  { norm: "0PB115466", service_type: "oil_change", service_role: "core", quantity_needed: 1, confidence: 0.95, source_domains: ["design911.com"] },
  { norm: "95810380100", service_type: "oil_change", service_role: "core", quantity_needed: 1, confidence: 0.82, source_domains: ["design911.com"] },
  { norm: "992819429", service_type: "filter_replacement", service_role: "core", quantity_needed: 1, confidence: 0.95, source_domains: ["pelicanparts.com"] },
  { norm: "992698151L", service_type: "brake_pad_replacement", service_role: "core", quantity_needed: 1, confidence: 0.9, source_domains: ["sunsetporscheparts.com"], position: "front" },
  { norm: "992698451L", service_type: "brake_pad_replacement", service_role: "core", quantity_needed: 1, confidence: 0.9, source_domains: ["sunsetporscheparts.com"], position: "rear" },
  { norm: "992615601A", service_type: "rotor_replacement", service_role: "core", quantity_needed: 2, confidence: 0.9, source_domains: ["porsche.oempartsonline.com"], position: "front" },
  { norm: "0PB903137B", service_type: "serpentine_belt", service_role: "core", quantity_needed: 1, confidence: 0.82, source_domains: ["design911.com"] },
  { norm: "992915105A", service_type: "battery_replacement", service_role: "core", quantity_needed: 1, confidence: 0.9, source_domains: ["getporschesilverspringparts.com"] },
  { norm: "V04015004AS", service_type: "coolant_flush", service_role: "core", quantity_needed: 1, confidence: 0.95, source_domains: ["pelicanparts.com"] },
  { norm: "00004330513", service_type: "transmission_service", service_role: "core", quantity_needed: 1, confidence: 0.95, source_domains: ["pelicanparts.com"] },
  { norm: "00004320671", service_type: "brake_fluid_flush", service_role: "core", quantity_needed: 1, confidence: 0.65, source_domains: ["suncoastparts.com"] },
  { norm: "00004321044", service_type: "differential_service", service_role: "core", quantity_needed: 1, confidence: 0.85, source_domains: ["design911.com"] },
  { norm: "992612175", service_type: "brake_pad_replacement", service_role: "as_needed", quantity_needed: 1, confidence: 0.6, source_domains: ["suncoastparts.com"], position: "front" },
  { norm: "992612176", service_type: "brake_pad_replacement", service_role: "as_needed", quantity_needed: 1, confidence: 0.6, source_domains: ["suncoastparts.com"], position: "rear" },
];

export const run = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();

    // ── Abort if already seeded (idempotent-by-abort). ──
    const existingConfig = await ctx.db
      .query("vehicle_configs")
      .withIndex("by_config_key", (q) => q.eq("config_key", CONFIG_KEY))
      .first();
    const existingVehicle = await ctx.db
      .query("vehicles")
      .withIndex("by_vin", (q) => q.eq("vin", VIN))
      .first();
    if (existingConfig || existingVehicle) {
      throw new Error(
        `Already seeded (config=${existingConfig?._id ?? "-"}, vehicle=${existingVehicle?._id ?? "-"}). Delete those rows to re-run.`,
      );
    }

    // ── Make (reused) ──
    let makeId = PORSCHE_MAKE_ID as any;
    const makeDoc = await ctx.db.get(makeId).catch(() => null);
    if (!makeDoc) {
      const bySlug = await ctx.db
        .query("makes")
        .withIndex("by_slug", (q: any) => q.eq("slug", "porsche"))
        .first();
      if (!bySlug) throw new Error("No Porsche make on this deployment.");
      makeId = bySlug._id;
    }

    // ── Identity (created fresh under the make) ──
    const modelId = await ctx.db.insert("models", {
      make_id: makeId,
      name: "911",
    } as any);
    const trimId = await ctx.db.insert("trims", {
      model_id: modelId,
      name: "Turbo S",
      year_start: 2024,
      year_end: 2024,
    } as any);
    const engineId = await ctx.db.insert("engines", {
      make_id: makeId,
      trim_id: trimId,
      engine_code: "DKHA",
      aspiration: "turbo",
      cylinders: 6,
      displacement_l: 3.7,
      displacement_liters: "3.7",
      fuel_injection: "direct",
      fuel_type: "Gasoline",
      timing_system: "chain",
      has_serpentine_belt: true,
      oil_capacity_qts: 8.8,
      oil_viscosity: "0W-40",
      coolant_capacity_qts: 10.6,
      coolant_type: "G13 (OAT, silicate-free)",
      spark_plug_gap_mm: 0.56,
      spark_plug_quantity: 6,
      gvwr_lbs: 5000,
      data_quality: "enriched",
    } as any);
    const transmissionId = await ctx.db.insert("transmissions", {
      trim_id: trimId,
      type: "DCT",
      transmission_type: "Dual-Clutch (DCT)",
      speeds: 8,
      fluid_type:
        "Pentosin FFL-3 (PDK clutch fluid); Mobilube PTX 75W-90 (PDK gear/diff)",
      fluid_capacity_drain_fill_qts: 4.228,
      confidence_score: 0.7,
      data_quality: "enriched",
      created_at: now,
    } as any);

    // ── Vehicle config ──
    const configId = await ctx.db.insert("vehicle_configs", {
      config_key: CONFIG_KEY,
      year: 2024,
      make_id: makeId,
      model_id: modelId,
      engine_id: engineId,
      transmission_id: transmissionId,
      trim_name: "Turbo S 2dr All Wheel Drive Coupe Automatic",
      trim_slug: "turbo-s-2dr-all-wheel-drive-coupe-automatic",
      drivetrain: "AWD",
      brake_fluid_type: "DOT 4",
      brake_fluid_capacity_oz: 33.8,
      has_brake_pad_sensor: true,
      rotor_front_min_quality: "oem_spec_flagged",
      rotor_front_min_thickness_mm: 32,
      rotor_front_nominal_thickness_mm: 40,
      rotor_rear_nominal_thickness_mm: 32,
      packages_available: [
        {
          code: "porsche_pccb",
          confidence: 0.95,
          detected_from: "vdb_optional_options",
          label: "Porsche Ceramic Composite Brakes (PCCB)",
          services_affected: ["brake-pad-replacement", "brake-rotor-replacement"],
        },
      ],
      enrichment_status: "partial",
      enrichment_version: "v8",
      fill_rate: 79,
      confidence_avg: 0.7627652982184343,
      verification_count: 0,
      last_enriched_at: now,
      created_at: now,
    } as any);

    // ── oem_parts (fresh) → map normalized OEM number to the new id ──
    const partIdByNorm: Record<string, any> = {};
    for (const p of PARTS) {
      partIdByNorm[p.norm] = await ctx.db.insert("oem_parts", {
        make_id: makeId,
        name: p.name,
        oem_part_number: p.oem_part_number,
        oem_part_number_normalized: p.norm,
        category: p.category,
        subcategory: p.subcategory,
        source_count: p.source_count,
        data_quality: "scraped",
        is_current: true,
        first_seen_at: now,
        last_confirmed_at: now,
        created_at: now,
      } as any);
    }

    // ── part_prices ──
    let priceCount = 0;
    for (const [norm, rows] of Object.entries(PRICES)) {
      const partId = partIdByNorm[norm];
      if (!partId) continue;
      for (const r of rows) {
        await ctx.db.insert("part_prices", {
          part_id: partId,
          price: r.price,
          price_type: r.price_type,
          source_domain: r.source_domain,
          source_url: r.source_url,
          refreshed_at: now,
          created_at: now,
        } as any);
        priceCount++;
      }
    }

    // ── part_fitments ──
    for (const f of FITMENTS) {
      const partId = partIdByNorm[f.norm];
      if (!partId) throw new Error(`Fitment references unknown part ${f.norm}`);
      await ctx.db.insert("part_fitments", {
        vehicle_config_id: configId,
        part_id: partId,
        service_type: f.service_type,
        service_role: f.service_role,
        quantity_needed: f.quantity_needed,
        confidence: f.confidence,
        source_count: 1,
        source_domains: f.source_domains,
        mechanic_verified: false,
        ...(f.position ? { position: f.position } : {}),
        first_confirmed_at: now,
        last_confirmed_at: now,
        created_at: now,
      } as any);
    }

    // ── trim_specs (fluid / tire / battery package) ──
    await ctx.db.insert("trim_specs", {
      vehicle_config_id: configId,
      trim_id: trimId,
      battery_cca: 850,
      battery_group: "H8 / Group 49",
      battery_location: "front trunk (frunk)",
      battery_type: "AGM",
      is_staggered: true,
      lug_nut_torque_ft_lbs: 118,
      recommended_tire_pressure_front_psi: 38,
      recommended_tire_pressure_rear_psi: 44,
      wiper_blade_driver_size_in: 24,
      wiper_blade_passenger_size_in: 19,
      tire_options: [
        {
          size_front: "255/35R20",
          size_rear: "315/30R21",
          width_mm: 255,
          width_mm_rear: 315,
          aspect_ratio: 35,
          aspect_ratio_rear: 30,
          rim_diameter_in: 20,
          rim_diameter_in_rear: 21,
          load_index: 97,
          load_index_rear: 105,
          speed_rating: "Y",
          speed_rating_rear: "Y",
          wheel_spec: "9Jx20 ET41",
          is_oem_standard: true,
        },
      ],
      tire_options_source: "https://www.wheel-size.com/size/porsche/911/2024/",
      confidence_score: 0.7962500000000001,
      created_at: now,
    } as any);

    // ── Vehicle ──
    const vehicleId = await ctx.db.insert("vehicles", {
      vin: VIN,
      year: 2024,
      engine_id: engineId,
      trim_id: trimId,
      transmission_id: transmissionId,
      vehicle_config_id: configId,
      metadata: { color: "aventurine-green-metallic", make: "Porsche", model: "911" },
      image_url:
        "https://vhr.nyc3.cdn.digitaloceanspaces.com/vehiclemedia/transparent/colors/2024/porsche/911/turbo-s-2dr-all-wheel-drive-coupe-automatic/aventurine-green-metallic.jpg",
      created_at: now,
      updated_at: now,
    } as any);

    // ── Owner (temursayfutdinov3@gmail.com) ──
    let user = await ctx.db
      .query("users")
      .withIndex("by_email", (q: any) => q.eq("email", OWNER_EMAIL))
      .first();
    let userCreated = false;
    if (!user) {
      const userId = await ctx.db.insert("users", {
        email: OWNER_EMAIL,
        first_name: "Temur",
        last_name: "Sayfutdinov",
        role: "shop_mechanic",
        createdAt: now,
      } as any);
      user = await ctx.db.get(userId);
      userCreated = true;
    }

    const ownerId = await ctx.db.insert("vehicle_owners", {
      vin: VIN,
      user_id: user!._id,
      status: "active",
      is_primary: true,
      nickname: "2024 Porsche 911",
      mileage: 1299,
      mileage_tier: "low",
      usage_pattern: "mixed",
      vehicle_age_years: 2,
      added_at: now,
    } as any);

    return {
      configId,
      vehicleId,
      ownerId,
      userId: user!._id,
      userCreated,
      partCount: PARTS.length,
      priceCount,
      fitmentCount: FITMENTS.length,
    };
  },
});
