/**
 * email-provider.ts — Resend send shim. Lives in a Node-only module
 * because the Resend SDK is not Convex-V8-compatible.
 */
"use node";

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction } from "../_generated/server";

// Mobile repo stub. The real Resend-backed implementations live in
// otopair-web/email/send.ts. The mobile repo does not deploy convex, so this
// action is never invoked here — but the bundler still needs the import to
// resolve for `npx convex dev`. Keep these signatures in sync with
// otopair-web/email/send.ts.
async function sendBookingUpdateEmail(
  _args: { to: string; category: string; payload: Record<string, unknown> }
): Promise<{ success: boolean; error?: string }> {
  return {
    success: false,
    error: "email not configured: mobile repo does not deploy convex",
  };
}
async function sendWalkinClaimEmail(
  _args: { to: string; payload: Record<string, unknown>; claimUrl: string | null }
): Promise<{ success: boolean; error?: string }> {
  return {
    success: false,
    error: "email not configured: mobile repo does not deploy convex",
  };
}

export const sendWalkinUpdate = internalAction({
  args: {
    to: v.string(),
    category: v.string(),
    payload: v.any(),
  },
  handler: async (ctx, args) => {
    try {
      if (args.category === "walkin_completed_claim") {
        const claimUrl: string | null = args.payload?.claimUrl ?? null;
        // Self-heal the vehicle hero image — if the enqueue-time cache
        // lookup came back null, hit VDB now (Node action can do HTTP),
        // persist on success, and pass the URL into the template.
        let payload = args.payload ?? {};
        if (!payload.vehicleImageUrl && payload.vin) {
          const resolved: string | null = await ctx.runAction(
            (internal as any).lib.vehicle_image.resolveVehicleImage,
            {
              vin: payload.vin,
              year: payload.vehicleYear ?? undefined,
              make: payload.vehicleMake ?? undefined,
              model: payload.vehicleModel ?? undefined,
              trim: payload.vehicleTrim ?? undefined,
            },
          );
          if (resolved) {
            payload = { ...payload, vehicleImageUrl: resolved };
          }
        }
        const result = await sendWalkinClaimEmail({
          to: args.to,
          payload,
          claimUrl,
        });
        return result.success
          ? { status: "sent" as const }
          : {
              status: "failed" as const,
              error: String((result as any).error ?? "send failed"),
            };
      }
      if (
        args.category === "walkin_booking_confirmed" ||
        args.category === "walkin_vehicle_at_shop" ||
        args.category === "walkin_prejob_complete"
      ) {
        const result = await sendBookingUpdateEmail({
          to: args.to,
          category: args.category as any,
          payload: args.payload ?? {},
        });
        return result.success
          ? { status: "sent" as const }
          : {
              status: "failed" as const,
              error: String((result as any).error ?? "send failed"),
            };
      }
      return {
        status: "failed" as const,
        error: `no email template for category: ${args.category}`,
      };
    } catch (err) {
      return {
        status: "failed" as const,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
});
