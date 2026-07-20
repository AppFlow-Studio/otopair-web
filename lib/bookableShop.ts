import type { GenericDatabaseReader } from "convex/server";
import type { DataModel, Doc, Id } from "../convex/_generated/dataModel";

type BookableShop = Pick<
  Doc<"shops">,
  | "_id"
  | "is_active"
  | "onboarding_complete"
  | "stripe_connect_account_id"
  | "stripe_charges_enabled"
  | "stripe_payouts_enabled"
  | "stripe_requirements_currently_due"
  | "labor_rate"
>;

type BookableShopCtx = {
  db: GenericDatabaseReader<DataModel>;
};

function getStripeRequirements(shop: BookableShop | null | undefined): string[] {
  return Array.isArray(shop?.stripe_requirements_currently_due)
    ? shop.stripe_requirements_currently_due
    : [];
}

export function isShopBookable(shop: BookableShop | null | undefined): boolean {
  return (
    shop?.is_active !== false &&
    shop?.onboarding_complete === true &&
    Boolean(shop?.stripe_connect_account_id) &&
    shop?.stripe_charges_enabled === true &&
    shop?.stripe_payouts_enabled === true &&
    getStripeRequirements(shop).length === 0 &&
    Number.isFinite(shop?.labor_rate) &&
    (shop?.labor_rate ?? 0) > 0
  );
}

export async function getBookableShopIds(
  ctx: BookableShopCtx,
  shops: BookableShop[],
): Promise<Set<Id<"shops">>> {
  const readyIds = new Set(shops.filter(isShopBookable).map((shop) => shop._id));
  if (readyIds.size === 0) return readyIds;

  const mechanics = await ctx.db.query("mechanics").collect();
  const shopsWithMechanics = new Set(
    mechanics
      .filter((mechanic) => mechanic.is_active !== false && readyIds.has(mechanic.shop_id))
      .map((mechanic) => mechanic.shop_id),
  );

  const shopServices = await ctx.db.query("shop_services").collect();
  const shopsWithServices = new Set(
    shopServices
      .filter((row) => row.is_offered && readyIds.has(row.shop_id))
      .map((row) => row.shop_id),
  );

  return new Set(
    [...readyIds].filter(
      (shopId) => shopsWithMechanics.has(shopId) && shopsWithServices.has(shopId),
    ),
  );
}
