/**
 * buildMechanicCarouselItems — pure util that maps the shop's
 * mechanic availability (from `useNextAvailabilityPerMechanicForShop`)
 * plus the local mechanic-store entries into `MechanicCarouselItem[]`
 * with an "Any" sentinel at index 0.
 *
 * Lifted out of `components/booking-flow/ShopPage.tsx` so the same
 * carousel can ship on `pick-datetime` when the user already picked
 * the shop on shop-detail and we skip Choose Mechanic. Single source
 * of truth for the carousel shape.
 */

import type { MechanicCarouselItem } from "@/components/booking-flow/MechanicCarousel";
import type {
  Mechanic,
  MechanicAvailabilitySlot,
} from "@/stores/types/store.types";

export interface BuildMechanicCarouselItemsArgs {
  /** From `useNextAvailabilityPerMechanicForShop(shopId).slotsByMechanicId`.
   *  Keys are mechanic IDs; values are sorted upcoming slots. */
  slotsByMechanicId: Record<string, readonly MechanicAvailabilitySlot[]>;
  /** From `useMechanicStore(s => s.mechanics)`. Used to hydrate name +
   *  photoUrl + verified badge. */
  mechanicsMap: Record<string, Mechanic>;
  /** True when the shop has any availability at all. Drives the "Any"
   *  card's subtitle ("Earliest" vs "Availability TBD"). Pass
   *  `useNextAvailabilityForShop(shopId, null, 1).slots.length > 0`. */
  shopHasAnySlot: boolean;
}

export function buildMechanicCarouselItems({
  slotsByMechanicId,
  mechanicsMap,
  shopHasAnySlot,
}: BuildMechanicCarouselItemsArgs): MechanicCarouselItem[] {
  const items: MechanicCarouselItem[] = [
    {
      mechanicId: null,
      name: "Any",
      photoUrl: null,
      slotLabel: shopHasAnySlot ? "Earliest" : "Availability TBD",
    },
  ];

  for (const mechId of Object.keys(slotsByMechanicId)) {
    const mech = mechanicsMap[mechId];
    if (!mech) continue;
    const earliest = slotsByMechanicId[mechId]?.[0];
    const slotLabel = earliest
      ? `${earliest.dayOfWeek} ${earliest.time}`
      : "TBD";
    items.push({
      mechanicId: mechId,
      name: mech.name,
      photoUrl: mech.photoUrl,
      slotLabel,
      verified: mech.isVerified,
    });
  }

  return items;
}
