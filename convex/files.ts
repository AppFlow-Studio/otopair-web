import { query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

/**
 * The Otopair email header logo, uploaded to Convex storage. `storage.getUrl`
 * returns a public (no-auth) URL that email clients can embed, and it's stable
 * for the life of the file.
 *
 * Storage IDs are PER-DEPLOYMENT: the same asset uploaded to two deployments
 * gets two different ids. `getEmailLogoUrl` therefore tries every known id and
 * returns the first that resolves on THIS deployment (a missing id resolves to
 * null), so one codebase serves the correct logo everywhere. After uploading
 * the asset to a new deployment, add its id to EMAIL_LOGO_STORAGE_IDS. A
 * per-deployment `EMAIL_LOGO_STORAGE_ID` env var takes priority when set.
 */
const EMAIL_LOGO_STORAGE_IDS: string[] = [
  "kg25mxr4h9snmvyh7a2jnc3r518c6p4t", // ardent-crab-641 (preview / prod)
  "kg2av70a8sh00tatpsk7q5t0m18c2zdp", // third-bird-914 (dev)
];

export const getEmailLogoUrl = query({
  args: {},
  handler: async (ctx) => {
    const envId = process.env.EMAIL_LOGO_STORAGE_ID;
    const candidates = envId
      ? [envId, ...EMAIL_LOGO_STORAGE_IDS]
      : EMAIL_LOGO_STORAGE_IDS;
    for (const id of candidates) {
      try {
        const url = await ctx.storage.getUrl(id as Id<"_storage">);
        if (url) return url;
      } catch {
        // Malformed/absent id on this deployment — try the next candidate.
      }
    }
    // None resolved — caller falls back to the hosted logo so mail is never blocked.
    return null;
  },
});
