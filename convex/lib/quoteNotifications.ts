/**
 * quoteNotifications.ts — Customer-facing "a shop quoted your request" push.
 *
 * When a shop submits a tire or rotor quote (tire_quote_responses.create /
 * rotor_quote_responses.create) the customer who opened the quote request
 * should get an in-app notification + push. Both response tables live behind
 * a quote-stage booking that carries the customer's `user_id`, so we enqueue
 * one `notification_outbox` row scoped to that user.
 *
 * The row rides the shared `enqueueNotificationOutbox` dedupe path, keyed per
 * (booking, shop) so re-fires from the same shop collapse into the one open
 * card while multiple competing shops each get their own. The customer feed
 * (`notifications.getMyNotifications`) surfaces it regardless of delivery
 * status, and the Expo push dispatcher reads `payload.title`/`payload.body`.
 */

import { enqueueNotificationOutbox } from "../bookings";
import { resolveVehicleDisplay } from "./bookingEnrichment";

function formatUsd(total: number): string | null {
  if (!Number.isFinite(total)) return null;
  return `$${total.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Enqueue the "new quote" notification for the customer behind `booking`.
 * No-ops when the booking has no `user_id` (nothing to notify). `kind`
 * selects the tire vs. brake copy; `total` is the quoted grand total.
 */
export async function notifyCustomerQuoteReceived(
  ctx: any,
  {
    booking,
    shopId,
    kind,
    total,
  }: {
    booking: any;
    shopId: any;
    kind: "tire" | "rotor";
    total: number;
  },
): Promise<void> {
  if (!booking?.user_id) return;

  const shop = await ctx.db.get(shopId);
  const shopName = (shop?.name ?? "").trim() || "A shop";

  const vehicle = await resolveVehicleDisplay(ctx, booking.vin);
  const forVehicle = vehicle.ymm ? ` for your ${vehicle.ymm}` : "";

  const price = formatUsd(total);
  const priceTail = price ? ` — ${price}` : "";

  const kindWord = kind === "tire" ? "tire" : "brake";
  const title = kind === "tire" ? "New tire quote" : "New brake quote";
  const body = `${shopName} sent a ${kindWord} quote${forVehicle}${priceTail}. Compare quotes to book.`;

  await enqueueNotificationOutbox(ctx, {
    shopId,
    bookingId: booking._id,
    userId: booking.user_id,
    channel: "push",
    category: "quote_received",
    // One open card per shop per booking. Competing shops don't collapse
    // together; a repeat submit from the same shop is idempotent while the
    // first card is still open.
    dedupeKey: `quote-received:${String(booking._id)}:${String(shopId)}`,
    payload: {
      title,
      body,
      quote_type: kind,
      shopName,
      total,
      // Deep-link hint for the mobile app: open the quotes list for this
      // booking when the notification is tapped.
      data: { bookingId: String(booking._id), quote_type: kind },
    },
  });
}
