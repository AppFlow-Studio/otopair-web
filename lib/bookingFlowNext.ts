/**
 * bookingFlowNext — the "what comes after Screen 2?" routing fork.
 *
 * Called from every place that today would push the user toward
 * Choose Mechanic (`/(booking-flow)/choose-mechanic`):
 *  - `app/(booking-flow)/category/[tab].tsx` Continue button.
 *  - `components/booking-flow/QuickBookRow.tsx` chip tap.
 *  - `components/booking-flow/HeroCardMostBooked.tsx` hero tap.
 *
 * When the booking store has a `preSelectedShopId` (set on the shop
 * detail page's Book CTA — `app/booking/shop/[id]/index.tsx:226`),
 * we skip Choose Mechanic entirely and jump straight to date/time at
 * that shop. The pick-datetime screen handles its own mechanic
 * selection now (a strip at the top reusing `MechanicCarousel`), so
 * the "confirm shop + swipe nearby shops + pick mechanic" surface is
 * out of the path for users who already picked a shop.
 *
 * When no shop is pinned, behavior is unchanged — Choose Mechanic is
 * still the right surface because the user needs to pick a shop.
 *
 * Centralized so the rule lives in one place. Call sites stay
 * one-liners and the eventual product call to skip Choose Mechanic
 * for the default flow too is a single edit here.
 */

import type { Router } from "expo-router";

export function routeToNextBookingStep(
  router: Router,
  preSelectedShopId: string | null,
): void {
  if (preSelectedShopId) {
    router.push({
      pathname: "/(booking-flow)/pick-datetime",
      params: { shopId: preSelectedShopId, mechanicId: "" },
    });
    return;
  }
  router.push("/(booking-flow)/choose-mechanic");
}
