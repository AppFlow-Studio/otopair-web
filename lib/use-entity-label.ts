"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";

/**
 * Returns the user-visible label for the shop's bookable entities.
 * Derived from whether the shop has any active bay (`mechanics.entity_type
 * === "bay"`) — mechanics and bays can coexist, so this is additive
 * ("Mechanic" → "Mechanic or bay"), not a shop-wide swap.
 */
export function useEntityLabel() {
  const shops = useQuery(api.shops.getMyShops, {} as any) as any[] | undefined;
  const shopId = shops?.[0]?._id;
  const mechanics = useQuery(
    api.mechanics.getByShop,
    shopId ? { shopId } : "skip"
  ) as any[] | undefined;
  const hasBay = (mechanics ?? []).some(
    (m) => m.entity_type === "bay" && m.is_active !== false
  );

  return {
    singular: hasBay ? "Mechanic or bay" : "Mechanic",
    plural: hasBay ? "Mechanics & bays" : "Mechanics",
    anyLabel: hasBay ? "Any mechanic or bay" : "Any mechanic",
  };
}
