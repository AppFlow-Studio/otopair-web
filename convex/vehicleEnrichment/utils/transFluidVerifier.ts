/**
 * vehicleEnrichment/utils/transFluidVerifier.ts — adversarial transmission /
 * CVT FLUID-FAMILY check, run once at finalize.
 *
 * Why (round-6, batch-7 Jul 2026): the part-fitment verifier reliably catches
 * a wrong spark plug or filter (a real part number from a DIFFERENT vehicle),
 * but it does NOT catch a wrong TRANSMISSION FLUID — and a wrong ATF/CVT fluid
 * is worse than a wrong plug because it destroys the unit. The fluid spec
 * ("Dexron VI", "NS-2", "Mercon LV") lives in the `trans_fluid_type` FIELD, not
 * in an OEM part row, so it never reaches the fitment verifier; and it is a
 * REAL fluid of the right TYPE, so nothing flags it. The failure is a
 * GENERATION / chemistry mismatch inside the correct transmission type that
 * rides in on a wrong-variant identification:
 *   - 2015 Rogue mislabeled the old "Rogue Select" (JF011E) → CVT NS-2 where
 *     the T32 2.5's JF016E (RE0F10H) needs NS-3 (damaging). (Round 9: this KB
 *     row previously said JF017E — that is the larger 3.5L-class Jatco unit,
 *     not the Rogue 2.5's; batch-11 P2-10.)
 *   - 2018 Focus DPS6 DRY dual-clutch got Mercon LV (a WET-auto fluid) — needs
 *     the dry-DCT fluid XT-11-QDC.
 *   - 2022 Tahoe 10L80 10-speed got DEXRON-VI where it needs DEXRON-ULV.
 *
 * This one cheap web-search call identifies the SPECIFIC transmission unit for
 * this exact vehicle+engine+variant, names the OEM-required fluid family for
 * that unit, and — only on POSITIVE evidence (a named unit AND a named correct
 * fluid that differs from the stored one) — corrects the stored spec. Verdict
 * semantics mirror engineCodeLookup / partFitmentVerifier: only an explicit,
 * positively-supported "mismatch" acts; "uncertain" never changes data.
 */

import Anthropic from "@anthropic-ai/sdk";
import { MODEL_HAIKU } from "./batchClient";

let _client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

export interface TransFluidVerdict {
  /** "match" — stored fluid is right for this unit; "mismatch" — the fluid is
   *  the wrong family/generation for this unit; "uncertain" — could not place
   *  the unit or its required fluid with confidence. */
  verdict: "match" | "mismatch" | "uncertain";
  /** The specific transmission unit the checker placed on this vehicle (e.g.
   *  "Jatco JF016E CVT", "GM 10L80", "Ford DPS6 dry dual-clutch"). Null when it
   *  could not name the unit — which forces "uncertain" (no positive evidence). */
  transUnit: string | null;
  /** The OEM-required fluid family/spec for that unit (e.g. "Nissan CVT NS-3",
   *  "DEXRON-ULV", "Ford XT-11-QDC"). Null when unnamed. A correction only
   *  happens when this is present AND differs from the stored value. */
  correctFluid: string | null;
  reason: string;
}

export type TransFluidAction =
  | { action: "keep" }
  | { action: "flag"; suspectUnit: string; claimedCorrect: string; reason: string };

/** Case/whitespace/punctuation-insensitive fluid-spec comparison. "Dexron VI",
 *  "DEXRON-VI" and "dexron vi" are the same spec; only a genuine family/
 *  generation change ("Dexron VI" vs "Dexron ULV") reads as different. */
export function fluidSpecEquivalent(a: string, b: string): boolean {
  const norm = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9]/g, "");
  return norm(a) === norm(b);
}

/**
 * Pure decision: given a verdict and the stored fluid, decide whether to FLAG
 * the value for review. Factored out of the network call so it is unit-testable
 * and so the evidence bar is explicit.
 *
 * ── FLAG-ONLY, never overwrite (batch-8, Jul 21 2026) ──────────────────────
 * The original round-6 design OVERWROTE the stored fluid on a "mismatch". Live
 * validation killed that: batch-8's extraction got all 5 trans fluids RIGHT on
 * its own, and the web-search verifier — asked to "correct" — fell into the
 * SAME unit-misidentification trap it was built to catch and overwrote TWO
 * correct values with damaging wrong ones:
 *   - Corolla: correct ATF WS → wrong Type T-IV (verifier mis-ID'd the U341E as
 *     a U240E and pulled that older unit's fluid).
 *   - Wrangler: correct ZF 8&9 ATF → wrong ATF+4 (verifier swallowed a bad
 *     vPIC "6-speed manual" decode and confabulated an "Aisin AL6 manual").
 * An autonomous LLM verifier is NOT reliable enough to overwrite a
 * damaging-consequence fluid: when it is wrong it destroys a correct value,
 * which is exactly the harm the gate was meant to prevent. So a "mismatch" now
 * only FLAGS for human review (and caps the field's confidence upstream) — it
 * never changes the stored value. The real fix for wrong fluids is upstream
 * variant/decode correctness (P1), not a bolt-on autocorrect.
 *
 * A flag fires ONLY when ALL hold (unchanged positive-evidence bar — keeps the
 * review queue signal-rich rather than noisy):
 *   - verdict is "mismatch" (never on "match"/"uncertain"), AND
 *   - the checker POSITIVELY named the transmission unit, AND
 *   - it POSITIVELY named the required fluid for that unit, AND
 *   - that required fluid is genuinely a different spec than the stored one.
 */
export function decideTransFluidAction(
  verdict: TransFluidVerdict,
  storedFluid: string | null | undefined,
): TransFluidAction {
  if (verdict.verdict !== "mismatch") return { action: "keep" };
  const unit = verdict.transUnit?.trim();
  const correct = verdict.correctFluid?.trim();
  if (!unit || !correct) return { action: "keep" };
  const stored = (storedFluid ?? "").trim();
  // Nothing suspect if the checker's "correct" fluid is the same spec we already
  // stored (guards a hallucinated mismatch that names our own value back at us).
  if (stored && fluidSpecEquivalent(stored, correct)) return { action: "keep" };
  return { action: "flag", suspectUnit: unit, claimedCorrect: correct, reason: verdict.reason };
}

const SYSTEM = `You are an automotive transmission-fluid fact-checker. You are given ONE vehicle and the transmission fluid a pipeline claims it uses. A wrong transmission fluid DESTROYS the unit, and the most common error is a fluid of the RIGHT TYPE but the WRONG GENERATION/CHEMISTRY for this vehicle's specific transmission — so verify against the exact unit, not just "it's a CVT / it's an automatic".

The "claimed family" line below (automatic / CVT / manual / N-speed) comes from a VIN decode that is SOMETIMES WRONG — decoders routinely mis-report automatic-vs-manual and the speed count (e.g. a diesel with a ZF 8-speed automatic that vPIC labels "6-speed manual"). Treat it as a weak hint, NOT ground truth: independently establish the real transmission from the YEAR + MODEL + ENGINE. If your web research contradicts the claimed family, trust your research and say so.

Work in this order and SEARCH THE WEB:
1. Identify the SPECIFIC transmission UNIT fitted to THIS exact year + model + engine + trim/variant. Name the maker's unit code, e.g. "Jatco JF016E CVT", "GM 10L80 10-speed", "Ford DPS6 dry dual-clutch", "ZF 8HP45", "Aisin AWF8F35". Many nameplates have MULTIPLE units in the SAME model year across trims/generations, and unit families split by ENGINE within one model (e.g. a 2015-2017 Nissan Rogue 2.5 is the T32 with the JF016E / RE0F10H, NOT the older "Rogue Select" S35 with a JF011E — and NOT the larger JF017E, which serves the 3.5L-class applications; a 2011 Corolla is the U341E using ATF WS, NOT the older U240E that used Type T-IV) — pin the one that matches THIS vehicle+engine, and do NOT let a superseded/older unit's fluid stand in for the current one.
2. State the OEM-required fluid family/spec for THAT unit (e.g. "Nissan CVT NS-3", "DEXRON-ULV", "Ford XT-11-QDC dry-DCT fluid", "ZF LifeguardFluid 8 / Shell M-1375.4").
3. Compare it to the claimed fluid.

REFUSE these traps (all are "mismatch" when they contradict the unit's real spec):
- A newer/older GENERATION of the same family: NS-2 vs NS-3 (Nissan CVT), DEXRON-VI vs DEXRON-ULV (GM), Mercon LV vs Mercon ULV — same brand, wrong generation, wrong fluid. Subaru CVTs are a known minefield: the TR580 chain CVT moved from CVTF-II to **CVTF-III** for 2021+ applications per Subaru TSB 01-167-08R, while "High Torque CVT Fluid" and "CVT Fluid LV" are **TR690** fluids — a TR580 car specced with HT/LV or the gen-1 blue K0425Y0710 is a mismatch.
- A CHIMERA spec string that mixes manufacturers or families (e.g. "Subaru CVT Fluid TC (CVT-HT-LV)" — "Fluid TC" is a Toyota/Idemitsu spec name welded onto two Subaru TR690 fluid names). A fluid string that does not parse to ONE real spec of ONE family for this unit is a mismatch; name the single correct spec in your answer.
- The reverse direction of the generation trap: do NOT demand a NEWER-era fluid on an OLDER unit that never used it. MERCON LV belongs to Ford's 6R80/6F35 era (2009+); the earlier 4R70W/4R75W/4R75E family (2004-2008 F-150 etc.) is specified MERCON V, and MERCON V and LV are NOT interchangeable in either direction. Calling a correct period fluid "mismatch" because a newer spec exists for LATER transmissions is a false positive (a batch-10 verifier error flagged MERCON V on a 2006 4R75E, expecting LV).
- A WET-auto fluid in a DRY dual-clutch (or vice-versa): a DPS6/DSG dry-clutch needs a dedicated dry-DCT fluid, NOT Mercon LV / Dexron; a wet DCT needs its own DCT fluid, not a torque-converter ATF.
- A geared-automatic ATF in a CVT (or a CVT fluid in a geared automatic) — CVT fluid is NOT interchangeable with ATF.
- When the transmission is built by a different company than the make (e.g. an Allison in a Chevy, a Jatco in a Nissan is still Nissan-spec, but an Aisin/ZF unit follows the unit maker's approved spec), follow the UNIT's approved fluid, not a generic chassis-brand ATF.

Verdict rules:
- "mismatch" REQUIRES that you POSITIVELY name (a) the specific transmission unit on THIS vehicle AND (b) the OEM fluid that unit actually requires, and that (b) is a genuinely different fluid than the claimed one. Put both in your answer.
- If you cannot pin the exact unit, or cannot name its required fluid with confidence, the verdict is "uncertain" — NOT "mismatch". Overwriting a correct fluid is as harmful as leaving a wrong one, so only call "mismatch" on positive evidence.
- "match" when the claimed fluid IS the (or an OEM-approved) fluid for the unit — including a correct supersession (an older spec superseded by the one you found is still a match if it's the current fill).
- Respond with ONLY a JSON object:
{"verdict":"match"|"mismatch"|"uncertain","trans_unit":"<unit or null>","correct_fluid":"<required fluid or null>","reason":"<one short sentence>"}`;

/**
 * Verify the stored transmission fluid against this vehicle's specific
 * transmission unit in ONE web-search call. Never throws — on any failure it
 * returns "uncertain" (verification must not be able to break an enrichment
 * run). Returns "uncertain" immediately when there is no fluid to check.
 */
export async function verifyTransFluid(
  vehicle: {
    year: number;
    make: string;
    model: string;
    trim: string;
    engineCode?: string | null;
    displacement?: string | null;
    aspiration?: string | null;
    /** Canonical transmission family (automatic / CVT / DCT / manual) — seeds
     *  the search; the checker still confirms the exact unit via web search. */
    transmissionType?: string | null;
    /** NHTSA TransmissionStyle / speeds descriptor when available — extra
     *  disambiguation for the same-year multi-unit case (e.g. "10-speed"). */
    transmissionSpeeds?: number | null;
  },
  storedFluid: string | null | undefined,
): Promise<TransFluidVerdict> {
  const uncertain = (reason: string): TransFluidVerdict => ({
    verdict: "uncertain",
    transUnit: null,
    correctFluid: null,
    reason,
  });

  const fluid = (storedFluid ?? "").trim();
  if (!fluid) return uncertain("no_stored_fluid");
  if (!process.env.ANTHROPIC_API_KEY) return uncertain("no_api_key");

  const engineDesc = [
    vehicle.displacement ? `${vehicle.displacement}L` : null,
    vehicle.aspiration && vehicle.aspiration.toLowerCase() !== "naturally aspirated"
      ? vehicle.aspiration
      : null,
    vehicle.engineCode ? `engine code ${vehicle.engineCode}` : null,
  ]
    .filter(Boolean)
    .join(", ");
  const transDesc = [
    vehicle.transmissionType ?? null,
    vehicle.transmissionSpeeds ? `${vehicle.transmissionSpeeds}-speed` : null,
  ]
    .filter(Boolean)
    .join(", ");

  try {
    const response = await getClient().messages.create({
      model: MODEL_HAIKU,
      max_tokens: 1500,
      temperature: 0,
      system: SYSTEM,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 } as any],
      messages: [
        {
          role: "user",
          content:
            `Vehicle: ${vehicle.year} ${vehicle.make} ${vehicle.model} ${vehicle.trim}` +
            `${engineDesc ? ` (${engineDesc})` : ""}` +
            `${transDesc ? `\nTransmission (claimed family): ${transDesc}` : ""}` +
            `\n\nClaimed transmission fluid: ${fluid}`,
        },
      ],
    });

    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b as any).text)
      .join("")
      .trim();
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return uncertain("unparseable_response");

    const obj = JSON.parse(match[0]);
    const v =
      obj?.verdict === "match" || obj?.verdict === "mismatch" ? obj.verdict : "uncertain";
    return {
      verdict: v,
      transUnit: typeof obj?.trans_unit === "string" && obj.trans_unit.trim()
        ? obj.trans_unit.trim().slice(0, 120)
        : null,
      correctFluid: typeof obj?.correct_fluid === "string" && obj.correct_fluid.trim()
        ? obj.correct_fluid.trim().slice(0, 120)
        : null,
      reason: typeof obj?.reason === "string" ? obj.reason.slice(0, 300) : "",
    };
  } catch (e) {
    console.warn("[trans-fluid-verify] call failed (non-fatal):", e);
    return uncertain("verifier_error");
  }
}
