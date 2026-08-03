/**
 * vehicleEnrichment/utils/partFitmentVerifier.ts — adversarial fitment check
 * for core-role OEM parts, run once at finalize.
 *
 * Why: the Jul 2026 5-VIN test showed the extraction's dominant failure mode
 * is PLAUSIBLE-but-wrong parts from a sibling model or engine variant — a
 * 5.7L HEMI oil filter on a 3.6L Durango, Golf pads on an Atlas, a Duratec
 * filter on a Vulcan Taurus, Seltos/Niro parts on a Soul. These pass format
 * sanitization (they are real part numbers) and ship into quotes. One cheap
 * web-search call per run cross-examines the highest-consequence parts; a
 * refuted part's fitment is deleted so the role either falls to its universal
 * fallback or reads as an honest gap.
 *
 * Verdict semantics mirror engineCodeLookup's verifier: only an explicit
 * "refuted" acts — "uncertain" never deletes data.
 */

import Anthropic from "@anthropic-ai/sdk";
import { MODEL_HAIKU } from "./batchClient";

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

/** Highest-consequence roles, checked first when the per-run cap bites —
 *  the parts that drive the most common services and caused the 5-VIN P0s.
 *  Batch-3 audit added the rotor roles: rotors were wrong on ALL THREE
 *  vehicles that had them (truck rotor on the Traverse, Impreza-era on the
 *  Crosstrek, Ranger/Bronco rotors on the F-150) because the priority set
 *  covered pads but never rotors, so the cap frequently cut them. */
export const VERIFY_PRIORITY_ROLE_KEYS = new Set([
  "oil_filter",
  "air_filter",
  "cabin_filter",
  "front_brake_pad",
  "rear_brake_pad",
  "front_rotor",
  "rear_rotor",
  "spark_plug",
  "coolant",
  "atf_fluid",
  "trans_filter",
  "engine_oil",
  // Batch-10: same-platform/wrong-engine parts shipped on 3 of 5 vehicles in
  // exactly these roles (4.2L belt + 4.6L intake gasket + Duratec thermostat
  // on a 5.4L F-150; Cruze-family coil + filter hardware on a Cobalt; a
  // 2017+ Colorado belt on a 2014 SRX) because the cap cut the non-priority
  // roles before they were ever sampled.
  "serpentine_belt",
  "thermostat",
  "intake_manifold_gasket",
  "ignition_coil",
  // Round 12 (batch-12 Equinox): battery was NEVER a priority role, so under
  // the cap it was rarely sampled — 84257919, a battery ground-extension
  // CABLE, held the battery role through eleven rounds of gates. Battery is
  // a headline service; the cable class is exactly what the component-type
  // clause below exists to catch.
  "battery",
]);

/** Batch-2 audit: a wrong-model o-ring (Genesis V6 part on a Soul) shipped
 *  because only the priority roles were sampled. Every priced non-universal
 *  part is now eligible, priority roles first, up to this cap. Raised 14→16
 *  in batch-3 to fit the added rotor/trans-filter priority roles, 16→24 in
 *  batch-10 so the four added same-platform-risk roles never evict the base
 *  consumables on parts-dense vehicles, 24→25 in round 12 for the added
 *  battery priority role (same never-evict-base rationale). */
export const VERIFY_MAX_PARTS = 25;

/** Back-compat alias (v3pipeline imported this name in round 1). */
export const VERIFY_ROLE_KEYS = VERIFY_PRIORITY_ROLE_KEYS;

export interface FitmentToVerify {
  roleKey: string;
  oem: string;
  name: string;
  /** For spark plugs and other per-cylinder parts: the stored total quantity,
   *  so the verifier can judge dual-plug engines (2× cylinders). */
  quantity?: number | null;
  /** Round 12: the source page's listing title (oem_parts.scraped_name) —
   *  without it the checker only ever saw the generic role label ("Battery")
   *  and the component-type clause had nothing to fire on. */
  observedTitle?: string | null;
}

export interface FitmentVerdict {
  roleKey: string;
  oem: string;
  verdict: "confirmed" | "refuted" | "uncertain";
  reason: string;
}

/** Axle position a role key claims, so the verifier can catch a front part
 *  stored under the rear role (batch-10: a FRONT 7-lug F-150 rotor shipped as
 *  the rear rotor — the part was real and model-correct, only the position was
 *  wrong). Pure; exported for tests. */
export function positionForRoleKey(roleKey: string): "front" | "rear" | null {
  const k = roleKey.toLowerCase();
  if (k.startsWith("front_") || k.includes("_front")) return "front";
  if (k.startsWith("rear_") || k.includes("_rear")) return "rear";
  return null;
}

const SYSTEM = `You are an automotive parts fact-checker. You will be given a vehicle and a list of OEM part numbers a pipeline claims fit it. Search the web and try to REFUTE each claim.

A claim is REFUTED when the part number belongs to:
- **a different ENGINE within the same year+model — this is a top failure mode.** Same displacement is NOT enough: a naturally-aspirated engine and a turbocharged engine of the same litres take different plugs/thermostats/intake gaskets/filters (e.g. a 3.2L NA-FSI spark plug on a 3.0T turbo, a supercharged-engine thermostat on the turbo engine of a later generation). Check ASPIRATION (turbo vs supercharged vs naturally-aspirated) and the exact engine code/family, not just the litres. A part whose catalog ties it to a different engine family — even same make, same displacement — is REFUTED.
- **a different TRANSMISSION family — also a top failure mode.** A dual-clutch (DCT / S-tronic / DSG / PDK) filter or pan part does NOT fit a torque-converter automatic (ZF 8HP, 6R80, 6T75, Aisin) and vice-versa; a CVT part does not fit a geared automatic. If the vehicle's transmission is stated, any trans part (filter, pan gasket, internal/external filter) that a source ties to a DIFFERENT transmission type/family is REFUTED — even if it contradicts another trans part in the same list.
- a different engine variant of the same model (e.g. the V8 oil filter on the V6, a spin-on filter on a cartridge-filter engine),
- a different model or platform from the same manufacturer (e.g. Golf pads listed for an Atlas, a Seltos air filter listed for a Soul, a full-size-TRUCK rotor/sensor listed for a crossover),
- **a different GENERATION or year range of the SAME nameplate** — this is the sneakiest failure: the part number looks right because the model name matches, but its catalog fitment range ends before (or **starts after**) this model year. It fails in BOTH directions: an OLDER-generation part on a newer car (pad kit 26296SC011 fits Subaru "WRX" only through 2014 — wrong on a 2015 VA-chassis WRX), AND a NEWER-generation part on an older car (a 2012+ Skyactiv spin-on oil filter listed for "Mazda3" does NOT fit a 2008 Mazda3, whose MZR engine uses a cartridge filter). This includes generation splits WITHIN one engine name (a "Gen-2 3.5 EcoBoost" plug on a Gen-1 3.5 EcoBoost truck). ALWAYS check the exact fitment YEAR RANGE against this vehicle's model year — "same model name" is not confirmation.
- the wrong axle or position (a front-axle pad set claimed as rear pads, a FRONT rotor part number claimed as the REAR rotor — check the position stated on each part line, and where the platform has lug-count or heavy-duty rotor variants, that the variant matches this vehicle's configuration),
- a fluid spec the vehicle must not use (e.g. an older-generation coolant on a car requiring the newer chemistry),
- **an engine oil / fluid PRODUCT whose viscosity or spec grade differs from this vehicle's stated requirement** (e.g. a 5W-20 synthetic-blend product attached to an engine that requires 0W-20 full synthetic — the product is real and the brand is right, but the grade is wrong: REFUTED; name the product's actual grade in your reason).

**A dealer/OEM catalog page for the right MODEL is NOT confirmation.** Genuine-brand catalog pages list parts for EVERY engine, trim, axle, and generation of that nameplate — the single most common false confirmation in this pipeline is a real part, on a trusted dealer domain, for the right truck, but keyed to a DIFFERENT engine option (a 4.2L V6 belt on the 5.4L V8), a different position (front rotor as rear), or a different generation. Confirmation requires the listing's engine/position/year qualifiers to match THIS vehicle, not just the model name.

**Launch-overlap years: pin the RIGHT generation before judging.** Redesigns launch mid-calendar-year, so for a model year that is the FINAL year of an outgoing generation (e.g. a 2021 Hyundai Tucson — the old 2016-2021 TL generation, while the redesigned 2022 model was already on sale in 2021), search results mix BOTH generations. First establish which generation THIS model year belongs to, then judge parts against THAT generation: refuting a correct old-generation part because next-generation results dominate the search — or confirming a next-generation part on the outgoing car — are both failures. When in doubt about which generation the model year is, verdict "uncertain", never "refuted".

**A year-band PAGE TITLE is not a fitment range.** Dealer/retail pages are often titled with a broad make-level band ("2012-2018 Toyota …", "Fits 2014-2020 Nissan …") that spans MANY models whose individual fitment windows differ — a part sold on a "2012-2018 Toyota" page may fit RAV4 only from 2013 (the band came from Camry). Judge the part's model-specific fitment years, never the page-title band; a part whose model-specific fitment starts after (or ends before) this model year is REFUTED even when the page title's band contains the year.

**Wrong COMPONENT TYPE under a role is REFUTED.** The part must be the component itself, not adjacent hardware or an accessory FOR it: a thermostat HOUSING / water outlet claimed as the thermostat, a filter housing or cap claimed as the filter, a sensor bracket claimed as the sensor — and for the battery role, a battery CABLE, ground strap/extension, terminal, hold-down, tray, bracket, vent tube, heat blanket, or current sensor claimed as the 12V starter battery (as are telematics/DCM/auxiliary/key-fob batteries). Fitting the vehicle is IRRELEVANT here — a genuine, fitment-correct cable is still not a battery. When a part line includes a [listed as: "…"] title and that title names a DIFFERENT component than the role claims, that title is decisive evidence: verdict "refuted", and begin your reason with "role_identity: " followed by what the part actually is.

A part is a phantom (REFUTED) when the vehicle's platform does not have that component at all (e.g. an electronic brake-pad WEAR SENSOR part on a platform that uses only mechanical wear indicators).

**A NONEXISTENT part number is REFUTED.** The rule that "refuted requires placing the part on a different vehicle" applies to REAL numbers; a claimed OEM number with ZERO catalog or retail existence anywhere after searching (no OEM catalog row, no retailer listing, no cross-reference) is a fabrication — verdict "refuted", say "phantom" in your reason. (Distinguish from a real-but-obscure dealer-only number, which is "uncertain".)

**Engine GASKETS carry their engine family in the part number — check it.** OEM gasket/seal numbers encode the engine family (Honda: -5A2-/-R40- are K-series, -6A0-/-59B- are L15 1.5T; a 17115-5A2 intake gasket cannot fit an L15BE). When a gasket/seal/o-ring's family code contradicts this vehicle's engine family, REFUTED — this class has survived three consecutive audit waves by being "a real Honda part on a real Honda page".

**When the ENGINE or TRANSMISSION is built by a different company than the vehicle make, component-specific consumables follow the COMPONENT maker's spec, not the chassis brand.** E.g. a medium-duty Ford truck with a Cummins engine takes a Cummins-spec (Fleetguard) coolant/oil filter, NOT a Ford Motorcraft one; an Allison transmission takes Allison TES-spec fluid, not the chassis brand's ATF. If an engine/trans/coolant part is a chassis-brand part but the engine or transmission is a third-party unit, that is grounds for REFUTED.

For a SPARK-PLUG line, also judge the QUANTITY. Some engines fire TWO plugs per cylinder (e.g. Chrysler HEMI, some twin-spark designs) — for those the correct total is 2× the cylinder count, not 1×. If the stated quantity equals the cylinder count but the engine is a known dual-plug design, the quantity is wrong (REFUTED) even if the part number itself is right; say the correct total in your reason.

Rules:
- Budget your searches: check the parts most likely to be wrong first; mark anything you could not check as "uncertain".
- **"refuted" requires POSITIVELY placing the part on a DIFFERENT vehicle.** You must be able to name the specific other model / generation / engine / year-range the part actually fits. If you cannot name what it DOES fit — if your only signal is a fuzzy or gapped catalog year range, or the part number merely "looks off" — the verdict is "uncertain", NOT "refuted". Deleting a correct part is worse than keeping a suspect one, so refute only on positive evidence of misfit. Put the alternative fitment in your reason (e.g. "fits 2019-2024 X, not this 2013").
- **Supersession is NOT misfit.** A part whose catalog year range skips this exact year, or that is the current replacement for an older number, or whose range spans years both before and after this vehicle, is almost always a supersession/consolidation artifact — treat as CONFIRMED or "uncertain", never "refuted". An older superseded number that still physically fits is CONFIRMED.
- Only mark "confirmed" when a source ties the part to this exact vehicle — model AND year within the part's fitment range, AND (for engine/trans parts) the matching engine family / transmission family. A listing that names the model but whose year range or engine/transmission excludes this vehicle is grounds for refuted, not confirmed.
- Respond with ONLY a JSON array, one object per input part, same order:
[{"idx": 1, "verdict": "confirmed" | "refuted" | "uncertain", "reason": "<one short sentence>"}]`;

/**
 * Verify up to ~8 core-role parts in ONE web-search call. Never throws —
 * on any failure every part comes back "uncertain" (verification must not
 * be able to break an enrichment run).
 */
export async function verifyPartFitments(
  vehicle: {
    year: number;
    make: string;
    model: string;
    trim: string;
    engineCode?: string | null;
    displacement?: string | null;
    aspiration?: string | null;
    transmissionType?: string | null;
    /** NHTSA EngineManufacturer — surfaced so the checker can apply
     *  engine-maker fluid/filter specs when it differs from the make
     *  (batch-5: Cummins engine in a Ford F-650 → Cummins-spec coolant). */
    engineManufacturer?: string | null;
    /** Cylinder count — lets the checker judge spark-plug quantity for
     *  dual-plug engines (correct total = 2× cylinders). */
    cylinders?: number | null;
    /** The vehicle's required oil viscosity (e.g. "0W-20") — batch-10: a
     *  5W-20 blend product shipped on an 0W-20 engine with no gate; the
     *  verifier refutes fluid products whose grade differs from this. */
    oilViscosity?: string | null;
  },
  parts: FitmentToVerify[],
): Promise<FitmentVerdict[]> {
  const uncertainAll = (reason: string): FitmentVerdict[] =>
    parts.map((p) => ({ roleKey: p.roleKey, oem: p.oem, verdict: "uncertain" as const, reason }));

  if (parts.length === 0) return [];
  if (!process.env.ANTHROPIC_API_KEY) return uncertainAll("no_api_key");

  // Aspiration + transmission family are load-bearing for the batch-3 failure
  // modes (NA plug on a turbo, DCT filter on a torque-converter auto). Surface
  // them explicitly so the checker keys on family, not just displacement.
  const engineDesc = [
    vehicle.displacement ? `${vehicle.displacement}L` : null,
    vehicle.cylinders ? `${vehicle.cylinders}-cyl` : null,
    vehicle.aspiration && vehicle.aspiration.toLowerCase() !== "naturally aspirated"
      ? vehicle.aspiration
      : null,
    vehicle.engineCode ? `engine code ${vehicle.engineCode}` : null,
    vehicle.engineManufacturer &&
    vehicle.engineManufacturer.toLowerCase() !== vehicle.make.toLowerCase()
      ? `engine built by ${vehicle.engineManufacturer}`
      : null,
  ].filter(Boolean).join(", ");
  const transDesc = vehicle.transmissionType
    ? `\nTransmission: ${vehicle.transmissionType}`
    : "";
  const oilDesc = vehicle.oilViscosity
    ? `\nRequired engine oil viscosity: ${vehicle.oilViscosity}`
    : "";

  const partLines = parts
    .map((p, i) => {
      const qty = p.quantity != null && p.quantity > 1 ? ` [stored qty: ${p.quantity}]` : "";
      const pos = positionForRoleKey(p.roleKey);
      const posNote = pos ? ` [claimed position: ${pos.toUpperCase()} axle]` : "";
      const listed =
        p.observedTitle && p.observedTitle.trim()
          ? ` [listed as: "${p.observedTitle.trim().slice(0, 120)}"]`
          : "";
      return `${i + 1}. ${p.roleKey}: ${p.oem} (${p.name})${qty}${posNote}${listed}`;
    })
    .join("\n");

  try {
    const response = await getClient().messages.create({
      model: MODEL_HAIKU,
      max_tokens: 3000,
      temperature: 0,
      system: SYSTEM,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 12 } as any],
      messages: [{
        role: "user",
        content: `Vehicle: ${vehicle.year} ${vehicle.make} ${vehicle.model} ${vehicle.trim}${engineDesc ? ` (${engineDesc})` : ""}${transDesc}${oilDesc}\n\nClaimed parts:\n${partLines}`,
      }],
    });

    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b as any).text)
      .join("")
      .trim();
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return uncertainAll("unparseable_response");

    const arr = JSON.parse(match[0]);
    if (!Array.isArray(arr)) return uncertainAll("unparseable_response");

    return parts.map((p, i) => {
      const row = arr.find((r: any) => r?.idx === i + 1) ?? arr[i];
      const verdict =
        row?.verdict === "confirmed" || row?.verdict === "refuted" ? row.verdict : "uncertain";
      return {
        roleKey: p.roleKey,
        oem: p.oem,
        verdict,
        reason: typeof row?.reason === "string" ? row.reason.slice(0, 300) : "",
      };
    });
  } catch (e) {
    console.warn("[fitment-verify] call failed (non-fatal):", e);
    return uncertainAll("verifier_error");
  }
}
