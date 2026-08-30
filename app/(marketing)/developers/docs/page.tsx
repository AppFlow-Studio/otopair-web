import type { Metadata } from "next";
import { DocsClient } from "./docs-client";

// /developers/docs — the interactive API reference (Scalar), rendered from the
// OpenAPI spec at {CONVEX_SITE}/v1/openapi.json (the single source of truth for
// every /v0 + /v1 endpoint). Live "Try it" console; integrators/SDK generators
// can pull the raw spec from the same URL.

export const metadata: Metadata = {
  title: "API Reference — Otopair Car Data API",
  description:
    "Interactive reference for the Otopair Car Data API: every v0 and v1 endpoint with detailed request/response schemas, real examples, authentication, and a live try-it console. Powered by an OpenAPI 3.1 spec.",
};

export default function DocsPage() {
  return <DocsClient />;
}
