/**
 * inspections_node.ts — Node-only render side for the multi-point inspection
 * sheet. Split from inspections.ts because @react-pdf/renderer needs the Node
 * runtime. Mirrors invoices_node.ts: assemble in V8 (runQuery), render here,
 * store to Convex file storage, return a URL the mechanic can open.
 */
"use node";

import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action } from "./_generated/server";
import {
  renderInspectionToBuffer,
  type InspectionPdfData,
} from "./inspections/template";

export const generateInspectionPdf = action({
  args: { bookingId: v.id("bookings") },
  handler: async (ctx, { bookingId }): Promise<{ url: string | null }> => {
    const allowed: boolean = await ctx.runQuery(
      internal.inspections._isCallerAuthorizedShopUser,
      { bookingId },
    );
    if (!allowed) throw new Error("forbidden");

    const data = (await ctx.runQuery(
      internal.inspections._assembleInspectionData,
      { bookingId },
    )) as (InspectionPdfData & { inspectionId: any }) | null;
    if (!data) throw new Error("No inspection found for this booking.");

    const buffer = await renderInspectionToBuffer({
      vehicleLabel: data.vehicleLabel,
      vin: data.vin,
      odometer: data.odometer,
      shopName: data.shopName,
      mechanicName: data.mechanicName,
      generatedAtMs: data.generatedAtMs,
      zones: data.zones,
      ownerRows: data.ownerRows,
      findingsAttention: data.findingsAttention,
      findingsMonitor: data.findingsMonitor,
    });

    const blob = new Blob([new Uint8Array(buffer)], {
      type: "application/pdf",
    });
    const storageId = await ctx.storage.store(blob);

    await ctx.runMutation(internal.inspections._patchInspectionPdf, {
      inspectionId: data.inspectionId,
      pdfStorageId: storageId,
    });

    const url = await ctx.storage.getUrl(storageId);
    return { url };
  },
});
