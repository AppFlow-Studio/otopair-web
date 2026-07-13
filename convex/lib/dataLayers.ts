// Data-layer model (Data spec §4B / §12) — ONE derivation shared by the
// catalog workspace UI and the external data API's sellability gate.
//
//   A  OEM/official        sellable
//   B  structured DB       NOT sellable (Vehicle Databases rows are licensed
//                          for internal use; NHTSA is public but rides in B
//                          until provenance splits them)
//   C  web/model-derived   NOT sellable (default layer)
//   D  empirical           sellable — measured from our own jobs
//   E  human-verified      sellable — mechanic/director verified, ours
//   X  flagged             never leaves the building
//
// Pure module: no server imports, safe for client bundles.

export type LayerLetter = "A" | "B" | "C" | "D" | "E" | "X";

export type Layer = { letter: LayerLetter; reason: string };

export function deriveLayer(sourceType: string | null, confidence: number | null): Layer {
  const st = (sourceType ?? "").toLowerCase();
  if (st === "anomaly_detection" || (confidence != null && confidence < 0.4))
    return {
      letter: "X",
      reason:
        st === "anomaly_detection"
          ? 'source_type "anomaly_detection" → flagged'
          : `confidence ${confidence} < 0.4 → flagged`,
    };
  if (st === "mechanic" || st === "director_verified")
    return { letter: "E", reason: `source_type "${st}" → human-verified` };
  if (st.includes("empirical") || st.includes("job_actual"))
    return { letter: "D", reason: `source_type "${st}" → empirical` };
  if (st.includes("oem") || st.includes("owners_manual"))
    return { letter: "A", reason: `source_type "${st}" → OEM/official` };
  if (st === "nhtsa" || st.includes("vehicle_databases") || st === "vdb")
    return { letter: "B", reason: `source_type "${st}" → structured DB` };
  return { letter: "C", reason: `source_type "${st || "unknown"}" → web/model-derived (default layer)` };
}

/** The layers the external API may serve (spec §12's "A+D gate"; E is our own
 *  human verification and is unambiguously ours, so it ships too). */
export const SELLABLE_LAYERS: ReadonlySet<LayerLetter> = new Set(["A", "D", "E"]);

export const LAYER_FORMULA =
  "anomaly/conf<0.4→X · mechanic/director→E · empirical→D · oem→A · nhtsa/vdb→B · else→C";
