import type { Metadata } from "next";
import { QuickstartClient } from "./quickstart-client";

// /developers/docs/quickstart — the 60-second mint → call → read → go-granular
// path. Server wrapper for metadata; the interactive copy-buttons live in the
// client half.

export const metadata: Metadata = {
  title: "Quickstart — Otopair Car Data API",
  description:
    "Get real car data in four steps: mint a free key, make your first call by VIN or year/make/model, read the per-field provenance, and pull single data groups with the v1 endpoints.",
};

export default function QuickstartPage() {
  return <QuickstartClient />;
}
