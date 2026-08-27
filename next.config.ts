import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  async redirects() {
    return [
      // The internal API console is gone — key management lives in /developers.
      { source: "/data/api-sandbox", destination: "/developers", permanent: false },
      // The internal data portal moved under the director umbrella. `:path+`
      // (one-or-more) keeps the legacy deep-link shims working while letting
      // `/data` itself render the public car-data product landing.
      { source: "/data/:path+", destination: "/director/data/:path*", permanent: false },
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
