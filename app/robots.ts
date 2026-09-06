import type { MetadataRoute } from "next";
import { absoluteUrl } from "@/lib/site";

/**
 * /robots.txt — audit Tier 0 (2026-08-31).
 *
 * Crawler policy is a deliberate decision, not a default (audit §5.6): the
 * marketing site WANTS to be the answer when someone asks an assistant how
 * to get a car fixed in Staten Island, so every AI crawler is allowed here
 * by name. The inverse applies to the future Otoindix data property — that
 * inventory is the licensable asset and must NOT ship this file.
 *
 * Disallowed paths are the authenticated portals and the capability-token
 * pages; they are Clerk-gated anyway, but listing them keeps crawlers from
 * burning budget on sign-in redirects.
 */
const PRIVATE_PATHS = [
  "/api/",
  "/admin",
  "/director",
  "/ops",
  "/dashboard",
  // Owner portal is /shop/…; the public directory is /shops/…. robots rules
  // are prefix matches, so a bare "/shop" would also block "/shops".
  "/shop/",
  "/shop$",
  "/bookings",
  "/my-bookings",
  "/previous-bookings",
  "/schedule",
  "/team",
  "/mechanics",
  "/customers",
  "/notifications",
  "/messages",
  "/settings",
  "/payouts",
  "/receipts/",
  "/t/",
  "/claim/",
  "/invite",
  "/accept-invite",
  "/sign-in",
  "/sign-up",
  "/shop-only",
  "/account-deactivated",
];

const AI_CRAWLERS = [
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "Claude-SearchBot",
  "anthropic-ai",
  "PerplexityBot",
  "Google-Extended",
  "Applebot-Extended",
  "CCBot",
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", allow: "/", disallow: PRIVATE_PATHS },
      // Explicit allow per bot so the policy reads as a choice in the file
      // itself — a bare `*` line looks like nobody decided.
      ...AI_CRAWLERS.map((userAgent) => ({ userAgent, allow: "/", disallow: PRIVATE_PATHS })),
    ],
    sitemap: absoluteUrl("/sitemap.xml"),
  };
}
