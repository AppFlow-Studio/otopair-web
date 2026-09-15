import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  async redirects() {
    return [
      // The internal API console is gone; the public car-data lookup is the
      // nearest thing that still exists here.
      { source: "/data/api-sandbox", destination: "/car-data", permanent: false },
      // /developers was retired (2026-09-05): the car-data API is its own
      // product, OtoIndex, on its own origin. Anything still pointing here
      // goes there rather than to a 404. Same env var as lib/otoindex.ts.
      {
        source: "/developers",
        destination:
          process.env.NEXT_PUBLIC_OTOINDEX_URL ||
          (process.env.NODE_ENV === "development" ? "http://localhost:3100" : "https://vinspeclookup.com"),
        permanent: false,
      },
      // The data portal moved under the director umbrella.
      { source: "/data/:path*", destination: "/director/data/:path*", permanent: false },
      // Counsel's Site Policy Pages (2026-09-15) replace three pages that
      // stated different policies — a 14-day dispute window where counsel
      // says 7 days, "Otopair does not verify insurance" where counsel lists
      // insurance as a check. Two live pages stating different policies is
      // the risk counsel warns about, so each old URL now lands on its
      // replacement for good (308), and only the new page exists.
      { source: "/cancellation-policy", destination: "/cancellation", permanent: true },
      { source: "/warranty", destination: "/warranties", permanent: true },
      { source: "/how-shops-are-verified", destination: "/trust", permanent: true },
    ];
  },
  images: {
    domains: ["images.unsplash.com", "images.pexels.com"],
    remotePatterns: [
      {
        protocol: "https",
        hostname: "images.unsplash.com",
        pathname: "/**",
      },

      {
        protocol: "https",
        hostname: "images.pexels.com",
        pathname: "/**",
      },
    ]
  },
};

export default nextConfig;
