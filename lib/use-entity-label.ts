"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";

/**
 * Returns the user-visible label for the shop's bookable entity.
 * Driven by `shops.entity_label_mode` ("mechanic" | "bay"). Defaults to "mechanic".
 */
export function useEntityLabel() {
  const shops = useQuery(api.shops.getMyShops, {} as any) as any[] | undefined;
  const mode = shops?.[0]?.entity_label_mode ?? "mechanic";
  const isBay = mode === "bay";
  return {
    mode: mode as "mechanic" | "bay",
    singular: isBay ? "Bay" : "Mechanic",
    plural: isBay ? "Bays" : "Mechanics",
    anyLabel: isBay ? "Any bay" : "Any mechanic",
  };
}
