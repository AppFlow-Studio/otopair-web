import { query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

/**
 * The Otopair email header logo, uploaded to Convex storage. `storage.getUrl`
 * returns a public (no-auth) URL that email clients can embed, and it's stable
 * for the life of the file.
 *
 * NOTE: storage IDs are per-deployment — this ID must exist on whichever
 * deployment sends mail. Re-upload the asset and swap the ID here if needed.
 */
const EMAIL_LOGO_STORAGE_ID =
  "kg2av70a8sh00tatpsk7q5t0m18c2zdp" as Id<"_storage">;

export const getEmailLogoUrl = query({
  args: {},
  handler: async (ctx) => {
    try {
      return await ctx.storage.getUrl(EMAIL_LOGO_STORAGE_ID);
    } catch {
      // Malformed/absent id on this deployment — caller falls back to the
      // hosted logo so mail is never blocked.
      return null;
    }
  },
});
