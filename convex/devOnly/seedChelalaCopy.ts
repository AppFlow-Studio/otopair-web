/**
 * One-off dev seed (2026-07-20): copies "Chelala Service Center" from
 * Daniel's dev deployment (shiny-marlin-314) into this deployment, so the
 * app's map/browse carousel has a shop that passes the isShopBookable gate
 * AND carries a logo. Without it, no local shop clears the Stripe checks
 * and shops.list returns [] (empty carousel).
 *
 * Shop fields are lifted verbatim from his shops row; mechanics are his 4
 * active ones; shop_services are his 4 offered rows remapped to this
 * deployment's service ids by taxonomy slug; the logo file is re-uploaded
 * here first (storage ids don't cross deployments). The Stripe account id
 * satisfies the bookable gate only — don't run real payments against it.
 *
 * Run:
 *   npx convex run devOnly/seedChelalaCopy:generateUploadUrl
 *   curl -X POST -H "Content-Type: image/png" --data-binary @chelala_logo.png <url>
 *   npx convex run devOnly/seedChelalaCopy:insert '{"storageId":"<id>"}'
 */
import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

export const generateUploadUrl = internalMutation({
  args: {},
  handler: async (ctx) => ctx.storage.generateUploadUrl(),
});

const SHOP_SLUG = "chelala-service-center";

// Offered services on the source shop, keyed by taxonomy slug (the
// cross-deployment-stable key; ids are looked up locally at run time).
const OFFERED_SERVICE_SLUGS = [
  "tire_replacement",
  "rotor_replacement",
  "battery_test",
  "oil_change",
];

const ACTIVE_MECHANICS = [
  { first_name: "Dean", last_name: "Martin", rating: 0, review_count: 0 },
  { first_name: "Anakin", last_name: "Skywalker", rating: 0, review_count: 0 },
  { first_name: "James", last_name: "Bond", rating: 5, review_count: 1 },
  { first_name: "Luke", last_name: "Skywalker", rating: 0, review_count: 0 },
];

export const insert = internalMutation({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, { storageId }) => {
    const existing = await ctx.db
      .query("shops")
      .withIndex("by_slug", (q) => q.eq("slug", SHOP_SLUG))
      .first();
    if (existing) {
      throw new Error(`Already seeded as ${existing._id} — delete that row first to re-run.`);
    }

    const services = await ctx.db.query("services").collect();
    const offeredIds = OFFERED_SERVICE_SLUGS.map((slug) => {
      const svc = services.find((s) => s.slug === slug);
      if (!svc) throw new Error(`No local service with slug "${slug}"`);
      return svc._id;
    });

    const shopId = await ctx.db.insert("shops", {
      name: "Chelala Service Center",
      slug: SHOP_SLUG,
      address: "2800 Victory Boulevard",
      city: "Staten Island",
      state: "NY",
      zip: "10314",
      phone: "(646) 555-0105",
      // Source row has no lat/lng (his app geocodes client-side); baked here
      // so the pin drops immediately. ~2800 Victory Blvd, Staten Island.
      lat: 40.6027,
      lng: -74.1568,
      labor_rate: 150,
      rating: 5,
      review_count: 3,
      is_active: true,
      logo_storage_id: storageId,
      stripe_connect_account_id: "acct_1TO8vQFKL3FjCjzk",
      stripe_charges_enabled: true,
      stripe_payouts_enabled: true,
      stripe_requirements_currently_due: [],
      stripe_onboarding_completed_at: 1777148806918,
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

    for (const mech of ACTIVE_MECHANICS) {
      await ctx.db.insert("mechanics", { ...mech, shop_id: shopId, is_active: true });
    }
    for (const serviceId of offeredIds) {
      await ctx.db.insert("shop_services", {
        shop_id: shopId,
        service_id: serviceId,
        is_offered: true,
      });
    }

    return shopId;
  },
});
