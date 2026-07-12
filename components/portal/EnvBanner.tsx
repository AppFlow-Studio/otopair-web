"use client";

// Environment banner (Ops spec §3A / DoD): every non-production deployment
// shows a colored strip with the Convex deployment slug; production shows
// nothing. The slug is derived from NEXT_PUBLIC_CONVEX_URL at build time.

const PROD_SLUGS = ["mellow-cat-431"]; // the Convex project's production deployment (verified via function-spec --prod, Jul 2026)

function deploymentSlug(): string {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL ?? "";
  const m = url.match(/https:\/\/([a-z0-9-]+)\.convex\.cloud/);
  return m ? m[1] : "unknown";
}

export function EnvBanner() {
  const slug = deploymentSlug();
  if (PROD_SLUGS.includes(slug)) return null;
  return (
    <div className="sticky top-0 z-50 flex h-6 items-center justify-center gap-2 bg-amber-500 text-xs font-semibold tracking-wide text-amber-950">
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-950" />
      NON-PRODUCTION — {slug}
    </div>
  );
}
