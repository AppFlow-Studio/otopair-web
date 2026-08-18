/**
 * seedTestShops.ts — DEV ONLY, not part of any product surface.
 *
 * Seeds two additional Staten Island shops (2026-08-15, Waleed's ask) so the
 * shop-first booking step (BookServiceComponent Stage 4a, commit 75ffe396)
 * can be tested with a real multi-pin map and cross-shop mechanic filtering.
 * Chelala Service Center was the only row passing the isShopBookable gate,
 * so the map had exactly one pin.
 *
 * Modeled on seedChelalaCopy.ts: the Stripe fields are copied from the
 * existing Chelala row (they satisfy the bookable gate only — never run real
 * payments), as is the logo storage id (same-deployment storage reuse).
 * Coordinates are real Staten Island addresses a few km apart so the map's
 * region-fit shows an actual spread.
 *
 * Run:
 *   npx convex run devOnly/seedTestShops:insert
 *   npx convex run devOnly/seedTestShops:remove     ← reverses everything
 */
import { internalMutation } from "../_generated/server";

const TEST_SHOPS = [
  {
    name: "Bulls Head Auto Works",
    slug: "bulls-head-auto-works",
    address: "1441 Richmond Avenue",
    city: "Staten Island",
    state: "NY",
    zip: "10314",
    phone: "(646) 555-0121",
    lat: 40.6089,
    lng: -74.163,
    labor_rate: 135,
    rating: 4.6,
    review_count: 12,
    offered_slugs: ["oil_change", "tire_replacement", "battery_test"],
    mechanics: [
      { first_name: "Rocky", last_name: "Balboa", rating: 4.8, review_count: 6 },
      { first_name: "Mia", last_name: "Wallace", rating: 4.4, review_count: 4 },
    ],
  },
  {
    name: "Great Kills Garage",
    slug: "great-kills-garage",
    address: "4044 Hylan Boulevard",
    city: "Staten Island",
    state: "NY",
    zip: "10308",
    phone: "(646) 555-0134",
    lat: 40.5541,
    lng: -74.152,
    labor_rate: 110,
    rating: 4.2,
    review_count: 8,
    offered_slugs: ["oil_change", "rotor_replacement"],
    mechanics: [
      { first_name: "Ellen", last_name: "Ripley", rating: 4.9, review_count: 5 },
      { first_name: "Han", last_name: "Solo", rating: 3.9, review_count: 2 },
      { first_name: "Sarah", last_name: "Connor", rating: 0, review_count: 0 },
    ],
  },
];

export const insert = internalMutation({
  args: {},
  handler: async (ctx) => {
    // Stripe + logo fields lifted from the existing bookable shop so the
    // gate treats the seeds identically.
    const chelala = await ctx.db
      .query("shops")
      .withIndex("by_slug", (q) => q.eq("slug", "chelala-service-center"))
      .first();
    if (!chelala) throw new Error("Chelala row not found — seed it first (seedChelalaCopy).");

    const services = await ctx.db.query("services").collect();
    const results: Record<string, string> = {};

    // Weekly hours are REQUIRED for the time step: availability derives from
    // shops_hours rows (lib/timeSlotAvailability getShopHoursForDate) — no
    // rows means "closed every day" and the slot picker comes back empty.
    const DAY_NAMES = [
      "Sunday",
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
    ];
    const ensureHours = async (shopId: any) => {
      const rows = await ctx.db
        .query("shops_hours")
        .withIndex("by_shop_id", (q) => q.eq("shop_id", shopId))
        .collect();
      if (rows.length > 0) return false;
      for (let day = 0; day <= 6; day++) {
        await ctx.db.insert("shops_hours", {
          shop_id: shopId,
          day_of_week: day,
          day_name: DAY_NAMES[day],
          // Sunday closed; Mon-Sat 09:00-18:00.
          ...(day === 0
            ? { is_closed: true }
            : { open_time: "09:00", close_time: "18:00", is_closed: false }),
        });
      }
      return true;
    };

    for (const spec of TEST_SHOPS) {
      const existing = await ctx.db
        .query("shops")
        .withIndex("by_slug", (q) => q.eq("slug", spec.slug))
        .first();
      if (existing) {
        const added = await ensureHours(existing._id);
        results[spec.slug] = `already seeded as ${existing._id}${added ? " (hours added)" : ""}`;
        continue;
      }

      const offeredIds = spec.offered_slugs.map((slug) => {
        const svc = services.find((s) => s.slug === slug);
        if (!svc) throw new Error(`No local service with slug "${slug}"`);
        return svc._id;
      });

      const shopId = await ctx.db.insert("shops", {
        name: spec.name,
        slug: spec.slug,
        address: spec.address,
        city: spec.city,
        state: spec.state,
        zip: spec.zip,
        phone: spec.phone,
        lat: spec.lat,
        lng: spec.lng,
        labor_rate: spec.labor_rate,
        rating: spec.rating,
        review_count: spec.review_count,
        is_active: true,
        logo_storage_id: chelala.logo_storage_id,
        stripe_connect_account_id: chelala.stripe_connect_account_id,
        stripe_charges_enabled: chelala.stripe_charges_enabled,
        stripe_payouts_enabled: chelala.stripe_payouts_enabled,
        stripe_requirements_currently_due: chelala.stripe_requirements_currently_due,
        stripe_onboarding_completed_at: chelala.stripe_onboarding_completed_at,
        onboarding_complete: true,
        timezone: "America/New_York",
        no_show_threshold_minutes: 30,
        overrun_default_extension_percent: 25,
        overrun_extension_floor_minutes: 15,
        overrun_escalation_minutes: 1,
        overrun_auto_apply_minutes: 2,
        buffer_minutes: 20,
        max_bookings_per_mechanic_rolling_hour: 2,
        entity_label_mode: "mechanic",
        appointment_reminder_lead_minutes: 0,
      });

      for (const mech of spec.mechanics) {
        await ctx.db.insert("mechanics", { ...mech, shop_id: shopId, is_active: true });
      }
      for (const serviceId of offeredIds) {
        await ctx.db.insert("shop_services", {
          shop_id: shopId,
          service_id: serviceId,
          is_offered: true,
        });
      }
      await ensureHours(shopId);
      results[spec.slug] = shopId;
    }
    return results;
  },
});

export const remove = internalMutation({
  args: {},
  handler: async (ctx) => {
    const removed: string[] = [];
    for (const spec of TEST_SHOPS) {
      const shop = await ctx.db
        .query("shops")
        .withIndex("by_slug", (q) => q.eq("slug", spec.slug))
        .first();
      if (!shop) continue;
      const mechanics = await ctx.db
        .query("mechanics")
        .filter((q) => q.eq(q.field("shop_id"), shop._id))
        .collect();
      for (const m of mechanics) await ctx.db.delete(m._id);
      const hours = await ctx.db
        .query("shops_hours")
        .withIndex("by_shop_id", (q) => q.eq("shop_id", shop._id))
        .collect();
      for (const h of hours) await ctx.db.delete(h._id);
      const links = await ctx.db
        .query("shop_services")
        .filter((q) => q.eq(q.field("shop_id"), shop._id))
        .collect();
      for (const l of links) await ctx.db.delete(l._id);
      await ctx.db.delete(shop._id);
      removed.push(spec.slug);
    }
    return { removed };
  },
});
