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
      // The data portal moved under the director umbrella.
      { source: "/data/:path*", destination: "/director/data/:path*", permanent: false },
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
