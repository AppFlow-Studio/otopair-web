// Shops whose saved location mixes two places (bug #354), plus a one-shop
// repair for ops to run once the real street address is confirmed with the
// owner.
//
// Before the fix, an invite-created shop's one-line application address
// ("Jericho, NY") was saved unchecked beside whatever the owner typed into
// City/State/ZIP — the wizard's placeholders were seed shop #1's
// "Austin, TX 78701" — and nothing stored a pin, so the phone geocoded the
// joined string and landed in whichever town the geocoder preferred.
//
// Internal only; nothing here runs on deploy. Read-only report first:
//   npx convex run migrations/shopAddressRepair:report '{}'
//   npx convex run --prod migrations/shopAddressRepair:report '{}'
//
// Then per shop, dry run before executing. `address` is the street line ONLY
// (the city/state/ZIP suffix of an application string goes in its own field):
//   npx convex run migrations/shopAddressRepair:repairShopAddress \
//     '{"shopId":"<id>","address":"<street line>","city":"Jericho","state":"NY","zipCode":"11753","lat":40.79,"lng":-73.54,"dryRun":true}'
//   …then the same with "dryRun":false
//
// The repair never re-derives the timezone on its own: a live shop's schedule
// and "today" boundaries follow it, so pass `timezone` explicitly (the dry run
// shows the current value next to the new state's default). The dry run also
// counts open bookings — capture recomputes tax from the shop's state/ZIP, so
// a state change moves what those bookings are charged.
import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { TERMINAL_BOOKING_STATUSES } from "../lib/bookingGuards";
import {
  addressLineRegionSuffix,
  hasShopCoordinates,
  shopAddressChanged,
  shopAddressIssues,
  shopCoordinatesFromArgs,
} from "../../lib/shopAddress";
import { detectTimezoneFromState, US_STATE_TIMEZONE } from "../../lib/shopTimezone";

type ShopLocation = Pick<Doc<"shops">, "address" | "city" | "state" | "zip" | "lat" | "lng">;

function locationOf(shop: ShopLocation & Pick<Doc<"shops">, "timezone">) {
  return {
    address: shop.address ?? null,
    city: shop.city ?? null,
    state: shop.state ?? null,
    zip: shop.zip ?? null,
    lat: shop.lat ?? null,
    lng: shop.lng ?? null,
    timezone: shop.timezone ?? null,
  };
}

export const report = internalQuery({
  args: {},
  handler: async (ctx) => {
    // The shops table is small; one pass.
    const shops = await ctx.db.query("shops").collect();
    const flagged = shops
      .map((shop) => ({ shop, issues: shopAddressIssues(shop) }))
      .filter(({ issues }) => issues.length > 0)
      .map(({ shop, issues }) => ({
        shopId: shop._id,
        name: shop.name,
        slug: shop.slug ?? null,
        status: shop.status ?? null,
        onboardingComplete: shop.onboarding_complete === true,
        ...locationOf(shop),
        /** The automatic timezone for the stored state, to compare with `timezone`. */
        stateTimezone: detectTimezoneFromState(shop.state),
        issues,
      }));
    return { totalShops: shops.length, flaggedCount: flagged.length, flagged };
  },
});

function isKnownTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export const repairShopAddress = internalMutation({
  args: {
    shopId: v.id("shops"),
    address: v.string(),
    city: v.string(),
    state: v.string(),
    zipCode: v.string(),
    lat: v.optional(v.number()),
    lng: v.optional(v.number()),
    timezone: v.optional(v.string()),
    dryRun: v.boolean(),
  },
  handler: async (ctx, args) => {
    const shop = await ctx.db.get(args.shopId);
    if (!shop) throw new Error(`Shop ${args.shopId} not found.`);

    const next = {
      address: args.address.trim(),
      city: args.city.trim(),
      state: args.state.trim().toUpperCase(),
      zipCode: args.zipCode.trim(),
    };
    if (!next.address) throw new Error("`address` is required (the street line).");
    if (addressLineRegionSuffix(next.address)) {
      throw new Error(
        "Pass only the street line in `address` — city, state and ZIP go in their own fields."
      );
    }
    if (!next.city) throw new Error("`city` is required.");
    if (!(next.state in US_STATE_TIMEZONE)) {
      throw new Error(`"${args.state}" is not a US state code.`);
    }
    if (!/^\d{5}$/.test(next.zipCode)) throw new Error("`zipCode` must be 5 digits.");
    if (args.timezone !== undefined && !isKnownTimezone(args.timezone)) {
      throw new Error(`"${args.timezone}" is not a known IANA timezone.`);
    }
    const coordinates = shopCoordinatesFromArgs(args.lat, args.lng);

    // Same pin rule as upsertOnboardingShopDetails: sent coordinates are
    // written; otherwise a changed address drops the old pin.
    const addressChanged = shopAddressChanged(shop, next);
    const patch = {
      address: next.address,
      city: next.city,
      state: next.state,
      zip: next.zipCode,
      ...(coordinates
        ? { lat: coordinates.lat, lng: coordinates.lng }
        : addressChanged
          ? { lat: undefined, lng: undefined }
          : {}),
      ...(args.timezone !== undefined ? { timezone: args.timezone } : {}),
    };

    const openBookingCount = (
      await ctx.db
        .query("bookings")
        .withIndex("by_shop_id", (q) => q.eq("shop_id", shop._id))
        .collect()
    ).filter((booking) => !TERMINAL_BOOKING_STATUSES.has(booking.status)).length;

    const before = locationOf(shop);
    const after = locationOf({ ...shop, ...patch });
    const notes: string[] = [];
    if (!hasShopCoordinates(after.lat, after.lng)) {
      notes.push("No lat/lng after this repair — the shop has no map pin until one is stored.");
    }
    const stateTimezone = detectTimezoneFromState(next.state);
    if (args.timezone === undefined && stateTimezone && after.timezone !== stateTimezone) {
      notes.push(
        `Timezone stays ${after.timezone ?? "unset"}; ${next.state}'s default is ${stateTimezone}. Pass \`timezone\` to change it.`
      );
    }
    if (openBookingCount > 0 && (shop.state ?? "") !== next.state) {
      notes.push(
        `${openBookingCount} open booking(s): capture recomputes tax from the new state/ZIP.`
      );
    }

    const result = {
      dryRun: args.dryRun,
      shopId: shop._id,
      name: shop.name,
      addressChanged,
      before,
      after,
      stateTimezone,
      openBookingCount,
      notes,
    };
    if (args.dryRun) return result;

    await ctx.db.patch(shop._id, patch);
    await ctx.db.insert("audit_log", {
      entity_type: "shops",
      entity_id: String(shop._id),
      action: "repair_shop_address",
      actor: "system:shopAddressRepair",
      detail: JSON.stringify({ before, after }),
      created_at: Date.now(),
    });
    return result;
  },
});
