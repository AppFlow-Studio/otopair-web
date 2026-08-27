"use client";

// /developers/docs (client half) — the interactive API reference, rendered by
// Scalar from our OpenAPI spec (served at {CONVEX_SITE}/v1/openapi.json). Scalar
// gives a live "Try it" console; the spec's server URL is that same deployment,
// and every /v0 + /v1 route sends CORS *, so requests fire straight from the
// browser. Loaded client-only (ssr:false) — Scalar touches window on mount.

import dynamic from "next/dynamic";
import Link from "next/link";
import "@scalar/api-reference-react/style.css";
import { baseUrl } from "../shared";

const ApiReferenceReact = dynamic(
  () => import("@scalar/api-reference-react").then((m) => m.ApiReferenceReact),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-[60vh] items-center justify-center text-[15px] text-[#6b655d]">
        Loading the interactive reference…
      </div>
    ),
  },
);

export function DocsClient() {
  const specUrl = `${baseUrl()}/v1/openapi.json`;
  return (
    <div className="min-h-screen bg-white">
      {/* Slim brand bar above Scalar's own chrome (marketing navbar is hidden here). */}
      <div className="sticky top-0 z-20 flex items-center gap-4 border-b border-slate-200 bg-[#eceae6] px-5 py-3">
        <Link href="/developers" className="text-[14px] font-semibold hover:opacity-70" style={{ color: "#1a1a1a" }}>
          ← Otopair Car Data API
        </Link>
        <div className="ml-auto flex gap-4 text-[14px] font-semibold">
          <Link href="/developers/docs/quickstart" className="hover:opacity-70" style={{ color: "#2f7bff" }}>
            Quickstart
          </Link>
          <Link href="/developers" className="hover:opacity-70" style={{ color: "#1a1a1a" }}>
            Get a key
          </Link>
          <a href={specUrl} target="_blank" rel="noreferrer" className="hover:opacity-70" style={{ color: "#1a1a1a" }}>
            openapi.json
          </a>
        </div>
      </div>

      <ApiReferenceReact configuration={{ url: specUrl, theme: "default", hideModels: false }} />
    </div>
  );
}
