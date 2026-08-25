/**
 * Vehicle Data Pipeline — Convex Actions
 *
 * Stage 2: NHTSA VIN Decode + AI Normalization
 *   VIN → NHTSA raw → (optional) Claude normalizes model/trim/drivetrain/engine_code → makes, models, trims, engines, chassis_variants
 *
 * Stage 3: AI Enrichment (Claude ~$0.02/vehicle)
 *   engine → engine_specs, vehicle_specs, trim_specs, oem_parts
 *
 * Mutations/queries live in vehicle_mutations.ts to avoid circular
 * type inference (TS7022) when actions reference their own module
 * through `internal.*`.
 */

import { v } from "convex/values";
import { action, internalAction } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import Anthropic from "@anthropic-ai/sdk";
import { searchAndFetch } from "./vehicleEnrichment/firecrawl";
import { advancedVinDecode, extractVDBFields } from "./lib/vehicleDatabases";
import { findHaloVariant } from "./lib/haloVariantRules";
import { canonicalizeTransmissionType } from "./lib/transmissionTypeInference";
import { buildEngineKey, buildNhtsaVinKey } from "./vehicleEnrichment/types";
import {
  contradictsDecodedEngine,
  isSyntheticEngineCode,
  lookupKnownEngineCode,
} from "./vehicleEnrichment/utils/engineLookup";
import { reconcileDrivetrain } from "./vehicleEnrichment/drivetrainReconcile";
import { sanitizeCylinders } from "./vehicleEnrichment/cylindersRepair";
import { acceptNormalizedModel, acceptNormalizedTrim } from "./vehicleEnrichment/identityResolution";
import { parseGvwrUpperLbs } from "./vehicleEnrichment/validation/sanityChecks";
import { assembleVariantFingerprint, type TransmissionFamily } from "./vehicleEnrichment/variantFingerprint";
import { resolveFuelClass } from "./vehicleEnrichment/fuelTypeResolver";
import { resolveBuildSource } from "./vehicleEnrichment/buildSourceResolver";
import { reconcilePerformanceVariant } from "./vehicleEnrichment/variantDecodeReconcile";

const NHTSA_API = "https://vpic.nhtsa.dot.gov/api/vehicles/decodevinvaluesextended/";

// ============================================
// STAGE 2: NHTSA VIN DECODE
// ============================================

/**
 * Process a VIN through NHTSA decode → upsert makes/models/trims/engines.
 * Returns the resolved IDs for linking to vehicle records.
 */
type ProcessVinResult = {
  makeId: Id<"makes">;
  modelId: Id<"models">;
  trimId: Id<"trims">;
  engineId: Id<"engines">;
  transmissionId: Id<"transmissions"> | null;
  make: string;
  model: string;
  year: number;
  trim: string;
  engineCode: string;
  cylinders: number;
  displacement: string;
  fuelType: string;
  drivetrain: string;
  /** Variant fingerprint (P0/P1) — consolidated, confidence-scored identity.
   *  Observe-only for now (logged; not yet anchoring extraction). */
  variantFingerprint?: import("./vehicleEnrichment/variantFingerprint").VariantFingerprintV1;
  /** Merged body class (NHTSA "BodyClass" preferred, VDB bodyType fallback).
   *  Surfaced to the review screen so the loading-state silhouette can
   *  pick SUV vs sedan. */
  bodyClass: string;
  /** NHTSA "VehicleType" — high-level category (PASSENGER CAR,
   *  MULTIPURPOSE PASSENGER VEHICLE (MPV), TRUCK, MOTORCYCLE, BUS,
   *  TRAILER, INCOMPLETE VEHICLE, LOW SPEED VEHICLE (LSV)). Surfaced
   *  so the client can gate add-vehicle on supported types. */
  vehicleType: string;
  nhtsaVinKey: string;
  // Raw NHTSA decode passthrough — downstream VDB image/color lookups
  // use these to discover the catalog's canonical model designation.
  nhtsaModel: string;
  nhtsaSeries: string;
  nhtsaTrim: string;
  // Raw VDB decode fields — used to build the YMMT combo matrix for
  // `vehicle-images` discovery when the VIN endpoint 404s.
  vdbDecodedModel: string;
  vdbDecodedStyle: string;
  vdbDecodedTrimAndStyle: string;
  // Review-screen Specs card fields. Flat (not nested under vdbTrimData)
  // so router params can forward them directly.
  horsepower: number | null;
  engineDisplacementLiters: number | null;
  cylindersConfiguration: string | null;
  mpgCity: number | null;
  mpgHighway: number | null;
  mpgCombined: number | null;
  frontTireSize: string | null;
  rearTireSize: string | null;
  frontTirePressure: number | null;
  rearTirePressure: number | null;
  transType: string | null;
  transSpeeds: number | null;
  vdbTrimData: {
    frontTireSize: string | null;
    rearTireSize: string | null;
    frontTirePressure: number | null;
    rearTirePressure: number | null;
    wheelTorque: number | null;
    cca: number | null;
  } | null;
};

export const processVin = internalAction({
  args: { vin: v.string() },
  handler: async (ctx, args): Promise<ProcessVinResult | null> => {
    try {
      // ════════════════════════════════════════════════════════════
      // SOURCE 1: Vehicle Databases API (primary — paid, structured)
      // ════════════════════════════════════════════════════════════
      const vdbRaw = await advancedVinDecode(args.vin);
      const vdb = vdbRaw ? extractVDBFields(vdbRaw) : null;

      if (vdb) {
        console.log(`[decode] VDB: ${vdb.year} ${vdb.make} ${vdb.model} ${vdb.trim}`);
        console.log(`[decode] VDB engine: ${vdb.engineDescription ?? "?"} | code=${vdb.engineCode ?? "none"}`);
        console.log(`[decode] VDB trans: ${vdb.transType ?? "?"} ${vdb.transSpeeds ?? "?"}spd`);
        console.log(`[decode] VDB tires: ${vdb.frontTireSize ?? "?"} / ${vdb.rearTireSize ?? "?"} @ ${vdb.frontTirePressure ?? "?"}/${vdb.rearTirePressure ?? "?"} PSI`);
        console.log(`[decode] VDB battery: ${vdb.cca ?? "?"} CCA | torque: ${vdb.wheelTorque ?? "?"} lb-ft | drive: ${vdb.drivetrain ?? "?"}`);
      } else {
        console.log("[decode] VDB unavailable — NHTSA only");
      }

      // ════════════════════════════════════════════════════════════
      // SOURCE 2: NHTSA vPIC (fallback — free, always available)
      // ════════════════════════════════════════════════════════════
      // 15s cap: vPIC normally answers in ~1s; a hung socket otherwise eats
      // the whole decode action. The enclosing try/catch fails open (null →
      // caller reports decode_failed) — no retry, NHTSA is free to re-hit.
      const nhtsaResp = await fetch(`${NHTSA_API}/${args.vin}?format=json`, {
        signal: AbortSignal.timeout(15_000),
      });
      const nhtsaData = await nhtsaResp.json();

      const errorCode = getValue(nhtsaData, "ErrorCode");
      const errorCodes = errorCode.split(",").map((c: string) => c.trim());
      if (!errorCodes.includes("0")) {
        console.warn("NHTSA decode non-zero error:", errorCode, getValue(nhtsaData, "ErrorText"));
        // Batch-6 fix: a non-zero error code is NOT automatically fatal. Codes
        // like 4 (VIN auto-corrected one position), 5/14 (incomplete manufacturer
        // submission), and 8 (no detailed data) still yield Make/Year/Engine —
        // the 2009 Escalade returns "4,14" with a blank Model but valid make/year/
        // engine. Bail ONLY when the decode is truly unusable (no Make AND no VDB);
        // otherwise proceed and let the model fallback + the make/model/year gate
        // below recover it. (Previously any non-zero code with VDB down hard-failed
        // a real vehicle.)
        const nhtsaMake = getValue(nhtsaData, "Make");
        if (!nhtsaMake && !vdb) return null; // both sources genuinely dead
      }

      const nhtsa = {
        make: getValue(nhtsaData, "Make"),
        model: getValue(nhtsaData, "Model"),
        year: getValue(nhtsaData, "ModelYear"),
        trim: getValue(nhtsaData, "Trim"),
        trim2: getValue(nhtsaData, "Trim2"),
        series: getValue(nhtsaData, "Series"),
        series2: getValue(nhtsaData, "Series2"),
        bodyClass: getValue(nhtsaData, "BodyClass"),
        doors: getValue(nhtsaData, "Doors"),
        vehicleType: getValue(nhtsaData, "VehicleType"),
        engineModel: getValue(nhtsaData, "EngineModel"),
        cylinders: getValue(nhtsaData, "EngineCylinders"),
        displacementL: getValue(nhtsaData, "DisplacementL"),
        engineConfig: getValue(nhtsaData, "EngineConfiguration"),
        fuelType: getValue(nhtsaData, "FuelTypePrimary"),
        turbo: getValue(nhtsaData, "Turbo"),
        valveTrain: getValue(nhtsaData, "ValveTrainDesign"),
        fuelInjection: getValue(nhtsaData, "FuelInjectionType"),
        engineHP: getValue(nhtsaData, "EngineHP"),
        otherEngineInfo: getValue(nhtsaData, "OtherEngineInfo"),
        transStyle: getValue(nhtsaData, "TransmissionStyle"),
        transSpeeds: getValue(nhtsaData, "TransmissionSpeeds"),
        driveType: getValue(nhtsaData, "DriveType"),
        gvwr: getValue(nhtsaData, "GVWR"),
        engineManufacturer: getValue(nhtsaData, "EngineManufacturer"),
      };

      // ════════════════════════════════════════════════════════════
      // NHTSA-ONLY BASE KEY — computed from raw vPIC fields, BEFORE
      // Claude normalization or VDB merging. This is the dedup key
      // used by confirmVehicleForUser to short-circuit re-enrichment.
      // Deterministic per VIN: NHTSA is free + always available, so
      // this works even when VDB is down (403s). See types.ts.
      // ════════════════════════════════════════════════════════════
      const nhtsaYearNum = parseInt(nhtsa.year || "0");
      const nhtsaVinKey = nhtsa.make && nhtsa.model && nhtsaYearNum
        ? buildNhtsaVinKey({
            year: nhtsaYearNum,
            make: nhtsa.make,
            model: nhtsa.model,
            trim: nhtsa.trim,
            displacementL: nhtsa.displacementL,
            cylinders: nhtsa.cylinders,
            fuelType: nhtsa.fuelType,
          })
        : "";
      if (nhtsaVinKey) {
        console.log(`[decode] NHTSA base key: ${nhtsaVinKey}`);
      }

      // ════════════════════════════════════════════════════════════
      // YMMT validation: VDB occasionally returns the wrong basic vehicle
      // identity for a VIN. Trust NHTSA for year/make/model/trim when the
      // two disagree, while still using VDB for deep specs.
      const fuzzyMatch = (
        a: string | undefined | null,
        b: string | undefined | null,
      ) => {
        const norm = (s: string | undefined | null) =>
          (s ?? "").toLowerCase().replace(/[\s_-]+/g, " ").trim();
        const A = norm(a);
        const B = norm(b);
        if (!A || !B) return true;
        return A.includes(B) || B.includes(A);
      };
      const ymmtAgrees = (() => {
        if (!vdb || !nhtsa.make || !nhtsa.model) return true;
        const yearOk =
          !vdb.year ||
          !nhtsa.year ||
          vdb.year === parseInt(nhtsa.year);
        return (
          yearOk &&
          fuzzyMatch(vdb.make, nhtsa.make) &&
          fuzzyMatch(vdb.model, nhtsa.model)
        );
      })();
      const trustVdbYmmt = ymmtAgrees;
      if (vdb && !trustVdbYmmt) {
        console.warn(
          `[decode] VDB/NHTSA YMMT MISMATCH — VIN ${args.vin} → ` +
            `VDB="${vdb.year} ${vdb.make} ${vdb.model}" vs ` +
            `NHTSA="${nhtsa.year} ${nhtsa.make} ${nhtsa.model}". ` +
            `Preferring NHTSA's YMMT; keeping VDB's deep specs.`,
        );
      }

      // MERGE: VDB wins for basic identity only when it agrees with NHTSA;
      // deep specs stay VDB-first, NHTSA fills gaps.
      // ════════════════════════════════════════════════════════════
      const merged = {
        make: trustVdbYmmt
          ? (vdb?.make || nhtsa.make || "")
          : (nhtsa.make || vdb?.make || ""),
        model: trustVdbYmmt
          ? (vdb?.model || nhtsa.model || "")
          : (nhtsa.model || vdb?.model || ""),
        year: trustVdbYmmt
          ? (vdb?.year || parseInt(nhtsa.year || "0"))
          : (parseInt(nhtsa.year || "0") || vdb?.year || 0),
        // Round 10 (batch-11 F-150, 2nd recurrence): the round-8 trim guard
        // only gated the LLM-normalizer branch — a wrong trim arriving from
        // the DECODE MERGE itself ("FX4 SuperCrew" from VDB while NHTSA's
        // series positively says Lariat) flowed through unchecked. Apply the
        // same token-overlap philosophy here: when VDB's trim shares no
        // token with NHTSA's trim/series evidence AND NHTSA positively named
        // one, prefer NHTSA's (the regulatory decode over the aggregator).
        trim: (() => {
          const vdbTrim = vdb?.trim ?? "";
          const nhtsaEvidence = [nhtsa.trim, nhtsa.series, nhtsa.trim2, nhtsa.series2]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
          if (trustVdbYmmt && vdbTrim && nhtsaEvidence) {
            const vdbTokens = vdbTrim.toLowerCase().split(/[\s/_-]+/).filter((t: string) => t.length >= 2);
            const overlaps = vdbTokens.some((t: string) => nhtsaEvidence.includes(t));
            if (!overlaps && (nhtsa.trim || nhtsa.series)) {
              const preferred = nhtsa.trim || nhtsa.series;
              console.warn(
                `[decode] TRIM PRECEDENCE — VDB trim "${vdbTrim}" shares no token with NHTSA evidence "${nhtsaEvidence}"; using NHTSA "${preferred}"`,
              );
              return preferred;
            }
          }
          return trustVdbYmmt ? (vdbTrim || nhtsa.trim || "Base") : (nhtsa.trim || "Base");
        })(),
        trim2: nhtsa.trim2 || "",
        series: nhtsa.series || "",
        series2: nhtsa.series2 || "",
        bodyClass: nhtsa.bodyClass || vdb?.bodyType || "",
        doors: vdb?.doors || (parseInt(nhtsa.doors || "0") || null),
        vehicleType: nhtsa.vehicleType || "",
        // NHTSA-only, regulatory: GVWR class + engine manufacturer (batch-5).
        gvwr: nhtsa.gvwr || "",
        engineManufacturer: nhtsa.engineManufacturer || "",

        // Engine — VDB wins, NHTSA fills gaps
        // Cylinders is the exception: NHTSA's EngineCylinders is the
        // regulatory source and authoritative. VDB's cylinder extraction has
        // historically confused itself with displacement (engine_size). Use
        // NHTSA first; VDB only fills the gap when NHTSA is empty. Log a
        // warning on disagreement so we can audit future drift.
        cylinders: (() => {
          // Wave-1 guard (Aug 2026): the historical corruption class —
          // cylinders holding the displacement float ("3.5l_3.5cyl") — enters
          // through exactly this seam. sanitizeCylinders admits only integers
          // 2-16, and a VDB value equal to the displacement is rejected
          // outright (no 2-cyl 2.0L / 4-cyl 4.0L exists in the fleet; losing
          // a hypothetical legit match just leaves the unknown sentinel,
          // which is null-over-guess doctrine).
          const dispNum =
            parseFloat((vdb?.displacement ? String(vdb.displacement) : "") || nhtsa.displacementL || "") || null;
          const nhtsaCyl = sanitizeCylinders(parseFloat(nhtsa.cylinders || "0") || null) ?? null;
          const vdbRaw = vdb?.cylinders ?? null;
          const vdbMirrors =
            vdbRaw != null && dispNum != null && dispNum >= 2 && Math.abs(vdbRaw - dispNum) < 0.05;
          const vdbCyl = vdbMirrors ? null : sanitizeCylinders(vdbRaw) ?? null;
          if (vdbMirrors) {
            console.warn(
              `[decode] VDB cylinders=${vdbRaw} mirrors displacement ${dispNum}L — rejected as corruption.`,
            );
          }
          if (nhtsaCyl && vdbCyl && nhtsaCyl !== vdbCyl) {
            console.warn(
              `[decode] cylinders disagreement — NHTSA=${nhtsaCyl}, VDB=${vdbCyl}. Using NHTSA.`,
            );
          }
          return nhtsaCyl ?? vdbCyl ?? 0;
        })(),
        displacement: (vdb?.displacement ? String(vdb.displacement) : "") || nhtsa.displacementL || "",
        fuelType: vdb?.fuelType || nhtsa.fuelType || "Gasoline",
        turbo: nhtsa.turbo === "Yes",
        engineConfiguration: vdb?.blockType || nhtsa.engineConfig || null,
        fuelInjection: nhtsa.fuelInjection || null,
        valveTrain: vdb?.camType || nhtsa.valveTrain || null,
        engineHP: nhtsa.engineHP ? parseFloat(nhtsa.engineHP) : null,
        otherEngineInfo: nhtsa.otherEngineInfo || null,

        // Transmission — VDB wins
        transStyle: vdb?.transType || nhtsa.transStyle || "",
        transSpeeds: vdb?.transSpeeds || (nhtsa.transSpeeds ? parseInt(nhtsa.transSpeeds) : null),
        transDescription: vdb?.transDescription || null,

        // Drivetrain — VDB wins
        driveType: vdb?.drivetrain || nhtsa.driveType || "",

        // VDB-only trim specs (NHTSA never has these)
        frontTireSize: vdb?.frontTireSize || null,
        rearTireSize: vdb?.rearTireSize || null,
        frontTirePressure: vdb?.frontTirePressure || null,
        rearTirePressure: vdb?.rearTirePressure || null,
        wheelTorque: vdb?.wheelTorque || null,
        cca: vdb?.cca || null,
        steeringType: vdb?.steeringType || null,
      };

      // Round 10 (batch-11 Grand Highlander): the substring YMMT agreement
      // lets the SHORTER nameplate win the merge — vPIC's "Highlander"
      // collapsed VDB's "Grand Highlander", and because both models share the
      // A25A-FXS every model-divergent field then resolved to the wrong
      // sibling at high confidence with no catchable contradiction. When both
      // decoders name a model and one is a whole-word extension of the other,
      // the LONGER (more specific) name wins: decoders drop tokens, they
      // don't invent them. The performance-halo reconcile below still demotes
      // over-claimed halo tokens (WRX/SS/…) after this.
      {
        const normM = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, " ").trim();
        const a = normM(vdb?.model ?? "");
        const b = normM(nhtsa.model ?? "");
        if (a && b && a !== b && merged.model) {
          const longerRaw = a.length >= b.length ? (vdb?.model ?? "") : (nhtsa.model ?? "");
          const longerN = normM(longerRaw);
          const shorterN = a.length >= b.length ? b : a;
          const wholeWordExtension =
            longerN.startsWith(shorterN + " ") ||
            longerN.endsWith(" " + shorterN) ||
            longerN.includes(" " + shorterN + " ");
          if (wholeWordExtension && normM(merged.model) === shorterN) {
            console.warn(
              `[decode] MODEL SPECIFICITY — "${merged.model}" → "${longerRaw}" (longer decoder nameplate wins over prefix collapse)`,
            );
            merged.model = longerRaw;
          }
        }
      }

      // Variant mis-decode reconciliation (batch-9): VDB occasionally decodes a
      // non-performance vehicle as its performance halo — a 2003 Impreza Outback
      // (2.5 NA) read as an "Impreza WRX" (2.0T) — and the fuzzy YMMT match lets
      // it win because "Impreza WRX" ⊇ "Impreza". That wrong model then misleads
      // the engine-code resolver to the turbo engine + wrong parts. When VDB
      // adds a performance-halo token NHTSA lacks AND NHTSA positively decoded a
      // different variant, prefer NHTSA's base model.
      if (trustVdbYmmt && (vdb?.model || vdb?.trim) && nhtsa.model) {
        // VDB records the halo in either the model ("Impreza WRX") or the TRIM
        // ("Impreza" + trim "WRX") — scan both.
        const vdbFull = `${vdb?.model ?? ""} ${vdb?.trim ?? ""}`.trim();
        const nhtsaVariantText = [nhtsa.series, nhtsa.trim, nhtsa.series2, nhtsa.trim2]
          .filter(Boolean)
          .join(" ");
        const vr = reconcilePerformanceVariant(vdbFull, nhtsa.model, nhtsaVariantText);
        if (vr.demote) {
          const demotedTrim = nhtsa.trim || nhtsa.series || "Base";
          console.warn(
            `[decode] VARIANT RECONCILE — ${vr.reason}; "${merged.model} ${merged.trim}" → NHTSA "${nhtsa.model} ${demotedTrim}"`,
          );
          merged.model = nhtsa.model;
          merged.trim = demotedTrim;
        }
      }

      // Batch-6 fix: NHTSA sometimes omits the Model for a VALID VIN (the 2009
      // Escalade: ErrorCode 4,14 "manufacturer did not submit some fields")
      // while Make + Year + Engine decode fine — and VDB may also be down/blank.
      // Rather than hard-fail a real vehicle, resolve the model from the VIN via
      // web search before giving up. Only fires when make+year are known but
      // model is missing (rare), so it adds no cost to the normal path.
      if (merged.make && merged.year && !merged.model) {
        console.log(`[decode] Model blank for ${merged.year} ${merged.make} — attempting VIN web lookup fallback`);
        const recovered = await resolveModelFromVin(
          args.vin, merged.make, merged.year, nhtsa.series, nhtsa.bodyClass,
          {
            code: nhtsa.engineModel,
            displacement: merged.displacement,
            cylinders: merged.cylinders,
            hp: nhtsa.engineHP,
          },
        );
        console.log(`[decode] Model VIN lookup returned: ${recovered ? `"${recovered}"` : "null"}`);
        if (recovered) {
          console.log(`[decode] Model recovered via VIN web lookup: "${recovered}" (NHTSA+VDB were blank)`);
          merged.model = recovered;
        }
      }

      if (!merged.make || !merged.model || !merged.year) {
        console.error("Decode: Missing critical fields", { make: merged.make, model: merged.model, year: merged.year });
        return null;
      }

      // ── Identity consistency: trim vs engine (batch-2 audit, Jul 2026) ──
      // The cross-source merge can build a chimera: VDB's trim string embeds
      // an engine qualifier that contradicts the engine NHTSA won (a real
      // 3.6L Atlas decoded as trim "2.0T SE" + engine 3.6 FSI, and the
      // contradiction then poisoned the config key, the trim label users
      // see, and the engine-code verifier's input). When the trim's embedded
      // displacement or cylinder token disagrees with the merged engine,
      // strip the token — the rest of the trim ("SE") is still right.
      {
        const dispNum = parseFloat(merged.displacement || "");
        const cyl = merged.cylinders || 0;
        let trim = merged.trim;
        const dispTok = trim.match(/(\d\.\d)\s*T?(?:SI|FSI|DI)?L?\b/i);
        if (dispTok && dispNum && Math.abs(parseFloat(dispTok[1]) - dispNum) > 0.15) {
          trim = trim.replace(dispTok[0], "").replace(/\s{2,}/g, " ").trim();
          console.warn(
            `[decode] Trim/engine contradiction — trim "${merged.trim}" embeds ${dispTok[1]}L but engine is ${dispNum}L; using trim "${trim || "Base"}"`,
          );
        }
        const cylTok = trim.match(/\b[VvIiHh](\d{1,2})\b/);
        if (cylTok && cyl && parseInt(cylTok[1]) !== cyl) {
          trim = trim.replace(cylTok[0], "").replace(/\s{2,}/g, " ").trim();
          console.warn(
            `[decode] Trim/engine contradiction — trim "${merged.trim}" says ${cylTok[0]} but engine has ${cyl} cylinders; using trim "${trim || "Base"}"`,
          );
        }
        merged.trim = trim || "Base";
      }

      // ════════════════════════════════════════════════════════════
      // ENGINE CODE RESOLUTION
      // Priority: VDB code → NHTSA code (filtered) → Claude norm → web search + Haiku → synthetic
      // ════════════════════════════════════════════════════════════

      // Marketing/synthetic codes are filtered by the shared classifier
      // (utils/engineLookup.isSyntheticEngineCode) — previously only the NHTSA
      // code was screened (against a drifted local copy) and VDB codes passed
      // through unfiltered, which is how "TFSI" got stored as the 2012 Audi A4
      // engine_code and poisoned every engine-pinned downstream query.
      const nhtsaEngineRaw = nhtsa.engineModel?.trim() || "";
      const nhtsaEngineClean = isSyntheticEngineCode(nhtsaEngineRaw) ? "" : nhtsaEngineRaw;
      if (nhtsaEngineRaw && !nhtsaEngineClean) {
        console.log(`[decode] NHTSA EngineModel "${nhtsaEngineRaw}" is marketing term — ignored`);
      }

      // VDB placeholder codes that aren't real engine codes
      const VDB_PLACEHOLDER_CODES = new Set([
        "STDEN", "STD", "STDE", "STDN", "BASE", "STANDARD", "N/A", "NA", "NONE",
      ]);
      const vdbCode =
        vdb?.engineCode &&
        !VDB_PLACEHOLDER_CODES.has(vdb.engineCode.toUpperCase()) &&
        !isSyntheticEngineCode(vdb.engineCode)
          ? vdb.engineCode
          : "";
      if (vdb?.engineCode && !vdbCode) {
        console.log(`[decode] VDB engine code "${vdb.engineCode}" is a placeholder/marketing term — ignored`);
      }

      // ── Engine-spec gate (round 3, Aug 2026) ──
      // A decoder can hand back a REAL code for the WRONG engine in the same
      // lineup: the 2022 Macan (vPIC: 2.0L, 4-cyl, 261 hp — an EA888) was
      // stored as EA839, the 2.9L V6 of the Macan S/GTS/Turbo, because VDB
      // decoded the trim as "S". Format checks cannot see this (EA839 is a
      // real Porsche code in real code shape) and adversarial web search
      // cannot refute it (EA839 genuinely exists on a 2022 Macan). Physical
      // facts can. Fail-open: unknown codes and undecoded engines pass.
      const decodedEngine = {
        displacementL: merged.displacement,
        cylinders: merged.cylinders,
      };
      const gateEngineCode = (code: string, source: string): string => {
        if (!code) return "";
        const verdict = contradictsDecodedEngine(code, decodedEngine);
        if (verdict.known && verdict.contradicts) {
          console.warn(`[decode] ENGINE SPEC GATE (${source}) — ${verdict.reason}; rejected`);
          return "";
        }
        return code;
      };

      // Gated once, up front: downstream conditions test whether VDB supplied a
      // code, and a code the facts contradict must not count as "supplied" —
      // otherwise rejecting it would also silently block the normalizer's
      // replacement below (`!vdbCode`), leaving the vehicle with no code at all.
      const vdbCodeOk = gateEngineCode(vdbCode, "vdb");
      const nhtsaCodeOk = gateEngineCode(nhtsaEngineClean, "nhtsa");

      let finalEngineCode = vdbCodeOk || nhtsaCodeOk || "";
      const engineCodeSource = vdbCodeOk ? "vdb" : nhtsaCodeOk ? "nhtsa" : "none";
      console.log(`[decode] Engine code after merge: "${finalEngineCode}" (from ${engineCodeSource})`);

      // AI normalization (fix NHTSA model/trim/drivetrain mislabeling)
      let finalModel = merged.model;
      let finalTrim = merged.trim;
      let drivetrainType: string | undefined;

      const anthropicKey = process.env.ANTHROPIC_API_KEY;
      if (anthropicKey) {
        const normalized = await normalizeNhtsaWithClaude(anthropicKey, {
          make: merged.make,
          year: merged.year,
          nhtsaModel: merged.model,
          nhtsaTrim: merged.trim,
          nhtsaTrim2: merged.trim2,
          nhtsaSeries: merged.series,
          nhtsaSeries2: merged.series2,
          bodyClass: merged.bodyClass,
          driveType: merged.driveType,
          engineModel: finalEngineCode || nhtsaEngineRaw,
        });
        if (normalized) {
          // Round 3 (Aug 2026): the model was applied unconditionally here and
          // a 2022 Outlander was stored as an "Outlander Sport" — a different
          // vehicle — though neither decoder ever said "Sport". Same
          // evidence-overlap philosophy as the trim gate below.
          if (normalized.model) {
            if (
              // NAMEPLATE evidence only. bodyClass is deliberately excluded:
              // vPIC returns "Sport Utility Vehicle [SUV]/..." for this VIN,
              // which would corroborate "Sport" on any SUV.
              acceptNormalizedModel(normalized.model, merged.model, [
                merged.model,
                merged.trim,
                merged.trim2,
                merged.series,
                merged.series2,
                vdb?.model,
                vdb?.trim,
              ])
            ) {
              finalModel = normalized.model;
            } else {
              console.warn(
                `[decode] Normalizer model "${normalized.model}" rejected — extends decoded nameplate "${merged.model}" with a token no decoder produced (kept "${finalModel}")`,
              );
            }
          }
          // Round 8 (batch-10): accept the LLM's trim only when it overlaps the
          // decode evidence — the unconditional override stored a Lariat F-150
          // as "FX4 SuperCrew" and a 745Li as "745i" (trims no decoder produced).
          if (normalized.trim) {
            if (
              acceptNormalizedTrim(normalized.trim, [
                merged.trim,
                merged.trim2,
                merged.series,
                merged.series2,
              ])
            ) {
              finalTrim = normalized.trim;
            } else {
              console.log(
                `[decode] Normalizer trim "${normalized.trim}" rejected — no token overlap with decode evidence (kept "${finalTrim}")`,
              );
            }
          }
          if (normalized.engine_code && !vdbCodeOk && !isSyntheticEngineCode(normalized.engine_code)) {
            const accepted = gateEngineCode(normalized.engine_code, "normalizer");
            if (accepted) finalEngineCode = accepted;
          }
          if (normalized.drivetrain_type) drivetrainType = normalized.drivetrain_type;
        }
      }

      // ────────────────────────────────────────────────────────────────────
      // Halo-variant model promotion (BMW M, AMG, RS, Type R, Blackwing,
      // Hellcat, Trackhawk, Shelby, STI, GR, Lexus F, Corvette Z06, etc.)
      //
      // VDB (and often Claude) return model="3 Series" / trim="M3 Competition"
      // for halo trims. Every external spec source (wheel-size.com, OEM parts
      // catalogs, Bilstein, etc.) treats halos as separate model lines.
      // Promote per the curated table in lib/haloVariantRules.ts so downstream
      // lookups hit the right rows. Data-driven — extend the table to cover a
      // new halo without touching this file.
      // ────────────────────────────────────────────────────────────────────
      const halo = findHaloVariant(merged.make, finalModel, finalTrim);
      if (halo && halo.promotedModel.toLowerCase() !== finalModel.toLowerCase()) {
        console.log(
          `[decode] Halo variant promoted: model "${finalModel}" → "${halo.promotedModel}" (rule=${halo.ruleId}, trim="${finalTrim}")`
        );
        finalModel = halo.promotedModel;
      }

      // ── Deterministic year-pinned engine code (round 3, Aug 2026) ──
      // The generation-aware rule ("the 2019+ Altima 2.5 is PR25DD, not the
      // older QR25DE") existed only as advice inside the search prompt below.
      // The 2022 Outlander resolved NO code at all and shipped the descriptor
      // "2.5l_4cyl", though its engine IS that same Nissan-shared PR25DD.
      // Where make+model+year+displacement pin the engine as a public fact,
      // answer from the table and skip the search entirely.
      if (!finalEngineCode || isSyntheticEngineCode(finalEngineCode)) {
        const known = lookupKnownEngineCode(merged.make, finalModel, merged.year, decodedEngine);
        if (known) {
          console.log(
            `[decode] Engine code from year-pinned table: "${known.code}" (${known.note}) — was "${finalEngineCode}"`,
          );
          finalEngineCode = known.code;
        }
      }

      // Web search + Haiku fallback when still no real engine code
      if (
        (!finalEngineCode || finalEngineCode.includes("_") || isSyntheticEngineCode(finalEngineCode)) &&
        merged.cylinders && merged.displacement
      ) {
        try {
          const desc = vdb?.engineDescription ?? "";
          const query = desc
            ? `${merged.year} ${merged.make} ${finalModel} ${finalTrim} "${desc}" engine code`
            : `${merged.year} ${merged.make} ${finalModel} ${finalTrim} engine code ${merged.displacement}L ${merged.cylinders} cylinder`;
          const results = await searchAndFetch(query, 3);

          let searchContent = "";
          for (const r of results) {
            if (r.markdown && r.markdown.length > 100) {
              searchContent += r.markdown.slice(0, 5000) + "\n\n";
            }
          }

          if (searchContent.length > 0) {
            const haiku = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
            const resp = await haiku.messages.create({
              model: "claude-haiku-4-5-20251001",
              max_tokens: 50,
              temperature: 0,
              messages: [{
                role: "user",
                content: `Based on the following search results, what is the FULL manufacturer engine code including the complete variant suffix for a ${merged.year} ${merged.make} ${finalModel} ${finalTrim} with ${merged.cylinders} cylinders and ${merged.displacement}L displacement? For example, BMW uses codes like B48B20M2 or N63B44O2, not just B48 or N63. Mercedes uses M176DE40 not just M176. Include the full displacement and variant designation.\n\nCRITICAL — model generation: the SAME model name often carries a DIFFERENT engine across generations even at the same displacement (the 2019+ Nissan Altima 2.5 is PR25DD, NOT the 2007-2018 QR25DE). Return the code used in the ${merged.year} model year specifically; if the results only show a code from another generation and you cannot confirm it applies to ${merged.year}, reply null.\n\nSearch results:\n${searchContent.slice(0, 15000)}\n\nReply with ONLY the engine code (or null). Nothing else.`,
              }],
            });
            const code = (resp.content[0]?.type === "text" ? resp.content[0].text.trim() : "")
              .replace(/[^a-zA-Z0-9\-_.]/g, "");
            // Round 10 (batch-11 Crosstrek): "NA" (naturally aspirated) passed
            // the length filter and was keyed as the engine code. Reject
            // aspiration/architecture descriptors — they are answers to a
            // different question, never codes.
            const DESCRIPTOR_ANSWERS = new Set([
              "na", "n-a", "turbo", "turbocharged", "supercharged", "dohc",
              "sohc", "ohv", "vtec", "gdi", "mpi", "diesel", "hybrid", "ev",
              "i4", "v6", "v8", "h4", "boxer",
            ]);
            if (
              code &&
              code.toLowerCase() !== "null" &&
              !DESCRIPTOR_ANSWERS.has(code.toLowerCase()) &&
              code.length >= 2 &&
              code.length <= 20
            ) {
              // Search can surface the right-format code for the wrong sibling
              // engine (the S/GTS V6 on a base four). Physical facts decide.
              const accepted = gateEngineCode(code, "search+haiku");
              if (accepted) {
                console.log(`[decode] Search + Haiku resolved engine code: ${code} (was "${finalEngineCode}")`);
                finalEngineCode = accepted;
              }
            } else if (code && DESCRIPTOR_ANSWERS.has(code.toLowerCase())) {
              console.log(`[decode] Search + Haiku returned descriptor "${code}", not an engine code — ignored`);
            }
          }
        } catch (err) {
          console.log(`[decode] Engine code search failed: ${err}`);
        }
      }

      // LAST RESORT: synthetic from numeric fields ONLY
      if (!finalEngineCode || finalEngineCode.includes("_")) {
        finalEngineCode = `${merged.displacement || "unknown"}l_${merged.cylinders || "unknown"}cyl`;
        console.log(`[decode] Using synthetic engine code: ${finalEngineCode}`);
      }

      // ════════════════════════════════════════════════════════════
      // WRITE TO DATABASE
      // ════════════════════════════════════════════════════════════
      const makeId: Id<"makes"> = await ctx.runMutation(internal.vehicle_mutations.upsertMake, { name: merged.make });
      const modelId: Id<"models"> = await ctx.runMutation(internal.vehicle_mutations.upsertModel, { makeId, name: finalModel });
      const trimId: Id<"trims"> = await ctx.runMutation(internal.vehicle_mutations.upsertTrim, {
        modelId, name: finalTrim, year: merged.year,
      });

      // Drivetrain: NHTSA VIN-decoded axle count is authoritative (2WD vs 4WD);
      // the AI only refines within that class. Prevents the batch-3 failure
      // where a "4x2" VIN (dropped by the old mapNhtsaDriveType) let the LLM's
      // AWD guess win and phantom transfer-case/diff services shipped.
      const aiCanonicalDrivetrain = drivetrainType
        ? toCanonicalDrivetrain(drivetrainType)
        : undefined;
      const canonicalDrivetrain =
        reconcileDrivetrain(merged.driveType, aiCanonicalDrivetrain, merged.bodyClass) ??
        mapNhtsaDriveType(merged.driveType);
      if (canonicalDrivetrain && canonicalDrivetrain !== "unknown") {
        await ctx.runMutation(api.chassis_variants.upsertChassisVariant, {
          trim_id: trimId,
          drivetrain_type: canonicalDrivetrain,
          confidence_score: drivetrainType ? 0.85 : 0.70,
        });
      }

      // Engine
      const engineId: Id<"engines"> = await ctx.runMutation(internal.vehicle_mutations.upsertEngine, {
        trimId, engineCode: finalEngineCode,
        cylinders: merged.cylinders, displacement: merged.displacement,
        fuelType: merged.fuelType,
      });

      // Engine extras
      const enginePatch: Record<string, unknown> = { make_id: makeId };
      // GVWR (upper-bound lbs, drives duty-class sanity bands) + engine
      // manufacturer (engine-maker fluid specs in the fitment verifier). Batch-5.
      const gvwrLbs = parseGvwrUpperLbs(merged.gvwr);
      if (gvwrLbs != null) enginePatch.gvwr_lbs = gvwrLbs;
      if (merged.engineManufacturer) enginePatch.engine_manufacturer = merged.engineManufacturer;
      const cfg = merged.engineConfiguration?.toLowerCase() ?? "";
      if (cfg.includes("v")) enginePatch.configuration = "V";
      else if (cfg.includes("in-line") || cfg.includes("inline")) enginePatch.configuration = "inline";
      else if (cfg.includes("flat")) enginePatch.configuration = "flat";
      if (merged.turbo) enginePatch.aspiration = "turbo";
      const fi = merged.fuelInjection?.toLowerCase() ?? "";
      if (fi.includes("direct")) enginePatch.fuel_injection = "direct";
      else if (fi.includes("port")) enginePatch.fuel_injection = "port";
      if (merged.displacement) enginePatch.displacement_l = parseFloat(merged.displacement) || undefined;

      const cleanPatch: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(enginePatch)) { if (val !== undefined) cleanPatch[k] = val; }
      if (Object.keys(cleanPatch).length > 0) {
        await ctx.runMutation(internal.vehicleEnrichment.v3mutations.updateEngineSpecs, {
          engine_id: engineId, ...cleanPatch,
        } as any);
      }

      // Transmission — always create
      const transType = merged.transStyle || "unknown";
      const transDoc: { _id: Id<"transmissions"> } | null = await ctx.runMutation(api.transmissions.upsertTransmission, {
        trim_id: trimId,
        transmission_type: transType,
        confidence_score: transType !== "unknown" ? 0.70 : 0.1,
      });
      const transmissionId: Id<"transmissions"> | null = transDoc?._id ?? null;

      if (transmissionId) {
        const tp: Record<string, unknown> = {};
        if (merged.transSpeeds) tp.speeds = merged.transSpeeds;
        // Canonicalize whatever NHTSA / VDB returned (PDK, DSG, Tiptronic,
        // "Direct Shift Gearbox (DSG)", "Automated Manual", "Single-Speed
        // Reduction Gear", etc.) into one of automatic|manual|CVT|DCT via
        // Haiku with in-memory caching. No hardcoded marketing-term whitelist.
        const mapped = await canonicalizeTransmissionType(transType);
        if (mapped) tp.type = mapped;
        if (Object.keys(tp).length > 0) {
          await ctx.runMutation(internal.vehicleEnrichment.v3mutations.updateTransmissionSpecs, {
            transmission_id: transmissionId, ...tp,
          } as any);
        }
      }

      console.log(
        `[processVin] ${merged.year} ${merged.make} ${finalModel} ${finalTrim} | ` +
        `engine=${finalEngineCode} (${engineCodeSource}) | trans=${transType} | drive=${canonicalDrivetrain ?? "unknown"} | ` +
        `vdb=${vdb ? "yes" : "no"}`,
      );

      // Specs-card fields. VDB-first, NHTSA fallback where applicable.
      // Returned at top level (rather than nested under vdbTrimData) so
      // the review screen reads them as plain router params.
      const specsForCard = {
        horsepower:
          vdb?.horsepower ??
          (nhtsa.engineHP ? parseFloat(nhtsa.engineHP) : null),
        engineDisplacementLiters: vdb?.engineDisplacementLiters ?? null,
        cylindersConfiguration:
          vdb?.cylindersConfiguration ?? nhtsa.engineConfig ?? null,
        mpgCity: vdb?.mpgCity ?? null,
        mpgHighway: vdb?.mpgHighway ?? null,
        mpgCombined: vdb?.mpgCombined ?? null,
        frontTireSize: vdb?.frontTireSize ?? null,
        rearTireSize: vdb?.rearTireSize ?? null,
        frontTirePressure: vdb?.frontTirePressure ?? null,
        rearTirePressure: vdb?.rearTirePressure ?? null,
        transType:
          vdb?.transType ?? (nhtsa.transStyle || null),
        transSpeeds:
          vdb?.transSpeeds ??
          (nhtsa.transSpeeds ? parseInt(nhtsa.transSpeeds) : null),
      };

      // ── Variant fingerprint (P0/P1) ──────────────────────────────
      // Consolidate the decode signals just resolved above (engine code,
      // reconciled drivetrain, canonicalized transmission, GVWR duty class) plus
      // an AUTHORITATIVE fuel-class resolution (P1: cross-checks the fuel field
      // against the engine — a Cummins/EcoDiesel/TDI engine is diesel no matter
      // what the fuel field says) into one confidence-scored record. Currently
      // OBSERVE-ONLY: produced + logged + returned, not yet anchoring extraction
      // (that's P5). Fail-open — a null facet changes nothing downstream.
      const fuelResolution = resolveFuelClass({
        nhtsa_fuel_type: nhtsa.fuelType || null,
        vdb_fuel_type: vdb?.fuelType ?? null,
        engine_code: finalEngineCode,
        engine_manufacturer: merged.engineManufacturer || null,
        engine_description: vdb?.engineDescription ?? null,
      });
      const canonTransRaw = (await canonicalizeTransmissionType(transType))?.toLowerCase();
      const canonTransFamily: TransmissionFamily | null =
        canonTransRaw === "automatic" || canonTransRaw === "cvt" ||
        canonTransRaw === "dct" || canonTransRaw === "manual"
          ? (canonTransRaw as TransmissionFamily)
          : null;
      const buildSource = resolveBuildSource({
        make: merged.make,
        model: finalModel,
        model_year: merged.year,
        engine_manufacturer: merged.engineManufacturer || null,
      });
      const variantFingerprint = assembleVariantFingerprint({
        make: merged.make,
        model: finalModel,
        model_year: merged.year,
        engine_code:
          finalEngineCode && !finalEngineCode.includes("_") ? finalEngineCode : null,
        raw_fuel_type: merged.fuelType || null,
        aspiration: merged.turbo ? "turbo" : null,
        displacement_l: merged.displacement ? parseFloat(merged.displacement) || null : null,
        cylinders: merged.cylinders ?? null,
        engine_manufacturer: merged.engineManufacturer || null,
        transmission_family: canonTransFamily,
        speeds: merged.transSpeeds ?? null,
        drivetrain:
          canonicalDrivetrain && canonicalDrivetrain !== "unknown"
            ? (canonicalDrivetrain as "FWD" | "RWD" | "AWD" | "4WD")
            : null,
        gvwr_lbs: gvwrLbs,
        resolved_fuel: {
          fuel_class: fuelResolution.fuel_class,
          confidence: fuelResolution.confidence,
          source: fuelResolution.source,
        },
        resolved_build_source: {
          build_source_make: buildSource.build_source_make,
          confidence: buildSource.confidence,
          source: buildSource.source,
        },
      });
      console.log(
        `[fingerprint] ${merged.year} ${merged.make} ${finalModel} | ` +
          `fuel=${variantFingerprint.fuel_class.value ?? "?"}(${fuelResolution.source}` +
          `${fuelResolution.conflict ? ",CONFLICT" : ""}) | ` +
          `engine=${variantFingerprint.engine_code.value ?? "?"} | ` +
          `trans=${variantFingerprint.transmission_family.value ?? "?"} | ` +
          `drive=${variantFingerprint.drivetrain.value ?? "?"} | ` +
          `duty=${variantFingerprint.duty_class.value ?? "?"} | ` +
          `buildSrc=${variantFingerprint.build_source_make.value ?? "-"} | ` +
          `idConf=${variantFingerprint.overall_identity_confidence.toFixed(2)}`,
      );

      return {
        makeId, modelId, trimId, engineId, transmissionId,
        make: merged.make, model: finalModel, year: merged.year, trim: finalTrim,
        engineCode: finalEngineCode,
        variantFingerprint,
        cylinders: merged.cylinders, displacement: merged.displacement,
        fuelType: merged.fuelType,
        drivetrain: canonicalDrivetrain ?? "unknown",
        bodyClass: merged.bodyClass || "",
        vehicleType: merged.vehicleType || "",
        // Specs-card fields (flat, for router param forwarding).
        ...specsForCard,
        // NHTSA-only base key (deterministic per VIN, computed before
        // Claude normalization). Used for dedup in confirmVehicleForUser.
        nhtsaVinKey,
        // Raw NHTSA series/trim/MODEL — passed downstream so VDB
        // image/color lookups can discover the catalog's canonical
        // model. NHTSA often returns the specific designation
        // (e.g. "530i") in `Model`, which is exactly what VDB's
        // catalog needs.
        nhtsaModel: nhtsa.model || "",
        nhtsaSeries: nhtsa.series || nhtsa.series2 || "",
        nhtsaTrim: nhtsa.trim || nhtsa.trim2 || "",
        // Raw VDB decode fields — used to build the YMMT combo matrix
        // for `vehicle-images` discovery when the VIN endpoint 404s.
        vdbDecodedModel: vdb?.model || "",
        vdbDecodedStyle: (vdb as any)?.style || "",
        vdbDecodedTrimAndStyle: (vdb as any)?.trimAndStyle || "",
        // VDB trim data for pre-population
        vdbTrimData: vdb ? {
          frontTireSize: vdb.frontTireSize,
          rearTireSize: vdb.rearTireSize,
          frontTirePressure: vdb.frontTirePressure,
          rearTirePressure: vdb.rearTirePressure,
          wheelTorque: vdb.wheelTorque,
          cca: vdb.cca,
        } : null,
      };
    } catch (error) {
      console.error("VIN pipeline error:", error);
      return null;
    }
  },
});

// ============================================
// STAGE 3: AI ENRICHMENT (Claude)
// ============================================

/**
 * Use Claude to research vehicle specs that NHTSA doesn't provide:
 *   - Oil type, capacity, viscosity
 *   - OEM part numbers (filters, brake pads, spark plugs)
 *   - Maintenance intervals
 *   - Tire specs, brake specs
 *
 * Stores results in engine_specs, vehicle_specs, trim_specs.
 * Creates ai_enrichment_logs for audit trail.
 */
export const enrichVehicleSpecs = internalAction({
  args: {
    engineId: v.id("engines"),
    make: v.string(),
    model: v.string(),
    year: v.float64(),
    trim: v.string(),
    engineCode: v.string(),
    displacement: v.string(),
    cylinders: v.float64(),
    fuelType: v.string(),
  },
  handler: async (ctx, args) => {
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) {
      console.error("ANTHROPIC_API_KEY not set — skipping enrichment");
      return;
    }

    // ── Re-enrichment guard ──
    const existingSpecs = await ctx.runQuery(internal.vehicle_mutations.getEngineSpecs, { engineId: args.engineId });
    const existingSvcSpecsCount = await ctx.runQuery(internal.vehicle_mutations.getServiceVehicleSpecsCount, {
      engineId: args.engineId,
    });

    const needsBaseSpecs = !existingSpecs;
    const needsPricing = existingSvcSpecsCount === 0;

    if (!needsBaseSpecs && !needsPricing) {
      console.log(`Specs and pricing already exist for engine ${args.engineId}`);
      return;
    }

    // ── Step 0: Resolve engine code ──
    let effectiveEngineCode = args.engineCode?.trim() ?? "";
    if (!effectiveEngineCode) {
      const engine = await ctx.runQuery(internal.vehicle_mutations.getEngine, { engineId: args.engineId });
      if (engine?.trim_id) {
        const trimEngines = await ctx.runQuery(internal.vehicle_mutations.getEnginesByTrim, {
          trimId: engine.trim_id,
        });
        if (trimEngines && trimEngines.length === 1 && trimEngines[0].engine_code) {
          effectiveEngineCode = trimEngines[0].engine_code;
          await ctx.runMutation(internal.vehicle_mutations.updateEngineCode, {
            engineId: args.engineId,
            engineCode: effectiveEngineCode,
          });
        }
      }
      if (!effectiveEngineCode) {
        const inferred = await inferEngineCodeFromVehicle(anthropicKey, {
          make: args.make,
          model: args.model,
          trim: args.trim,
          year: args.year,
          displacement: args.displacement,
          cylinders: args.cylinders,
          fuelType: args.fuelType,
        });
        if (inferred) {
          await ctx.runMutation(internal.vehicle_mutations.updateEngineCode, {
            engineId: args.engineId,
            engineCode: inferred,
          });
          effectiveEngineCode = inferred;
        }
      }
      await delay(5_000);
    }

    const vehicleDesc = `${args.year} ${args.make} ${args.model} ${args.trim} (${args.displacement}L ${args.cylinders}-cylinder ${args.fuelType}, engine code: ${effectiveEngineCode})`;

    // ── State passed between calls ──
    let oilViscosity = "N/A";
    let oilCapacityQts = 0;
    let confidenceScore = 0.75;
    let flatVehicleSpecs: Record<string, any> = {};
    let fieldConfidences: Record<string, number> = {};
    let nullFields: string[] = [];
    let vehicleAttributes: VehicleAttributes = {
      power_steering_type: null,
      timing_system: null,
      has_turbocharger: null,
      fuel_injection_type: null,
      transmission_type: null,
      drivetrain_type: null,
    };

    // ============================================================
    // CALL 1A — Fluids, Intervals & Vehicle Attributes
    // ============================================================
    if (needsBaseSpecs) {
      console.log(`[Call 1A] Fluids & intervals: ${vehicleDesc}`);
      const fluidsPrompt = buildFluidsPrompt(vehicleDesc, args, effectiveEngineCode);
      try {
        const response = await fetchAnthropicWithRetry(anthropicKey, {
          model: "claude-sonnet-4-5-20250929",
          messages: [{ role: "user", content: fluidsPrompt }],
          max_tokens: 8000,
          temperature: 0.1,
          tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }],
        });
        if (!response.ok) {
          console.error("Claude API error (fluids):", await response.text());
          return;
        }
        const result = await response.json();
        const specs = extractJsonFromContentBlocks(result.content || []);
        confidenceScore = specs.confidence_score ?? 0.75;

        if (specs.engine_specs) {
          oilViscosity = specs.engine_specs.oil_viscosity || "N/A";
          oilCapacityQts = parseFloat(specs.engine_specs.oil_capacity_qts) || 0;
          await ctx.runMutation(internal.vehicle_mutations.storeEngineSpecs, {
            engineId: args.engineId,
            specs: specs.engine_specs,
            confidenceScore,
          });

          // Store timing_type on engines table
          const timingType = specs.engine_specs.timing_type;
          if (timingType && timingType !== "N/A") {
            await ctx.runMutation(internal.vehicle_mutations.patchEngine, {
              engineId: args.engineId,
              timingType,
            });
          }

          // Store steering_type on trims table (per spec: timing→engines, steering→trims)
          const steeringType = specs.engine_specs.steering_type;
          if (steeringType && steeringType !== "N/A") {
            const engine = await ctx.runQuery(
              internal.vehicle_mutations.getEngine,
              { engineId: args.engineId }
            );
            if (engine?.trim_id) {
              await ctx.runMutation(internal.vehicle_mutations.patchTrim, {
                trimId: engine.trim_id,
                steeringType,
              });
            }
          }
        }
        if (specs.vehicle_attributes) {
          vehicleAttributes = { ...vehicleAttributes, ...specs.vehicle_attributes };
          await ctx.runMutation(internal.vehicle_mutations.updateEngineAttributes, {
            engineId: args.engineId,
            attributes: specs.vehicle_attributes,
          });
        }
        await ctx.runMutation(internal.vehicle_mutations.logEnrichment, {
          engineId: args.engineId,
          confidenceScore,
          source: "claude-sonnet-fluids",
        });
        console.log(`[Call 1A] Done — confidence: ${confidenceScore}`);
      } catch (error) {
        console.error("AI enrichment error (fluids):", error);
        await ctx.runMutation(internal.vehicle_mutations.logEnrichment, {
          engineId: args.engineId,
          confidenceScore: 0,
          source: "claude-sonnet-fluids-failed",
        });
        if (!existingSpecs) return;
      }
      await delay(10_000);

      // ============================================================
      // CALL 1B — OEM Part Numbers + Trim Specs
      // ============================================================
      console.log(`[Call 1B] Part numbers: ${vehicleDesc}`);
      const partsPrompt = buildPartsPrompt(vehicleDesc, args, effectiveEngineCode, vehicleAttributes);
      try {
        const response = await fetchAnthropicWithRetry(anthropicKey, {
          model: "claude-sonnet-4-5-20250929",
          messages: [{ role: "user", content: partsPrompt }],
          max_tokens: 8000,
          temperature: 0.1,
          tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 10 }],
        });
        if (!response.ok) {
          console.error("Claude API error (parts):", await response.text());
        } else {
          const result = await response.json();
          const specs = extractJsonFromContentBlocks(result.content || []);
          if (specs.vehicle_specs) {
            const { flat, confidences, nulls } = flattenPerFieldSpecs(specs.vehicle_specs);
            flatVehicleSpecs = flat;
            fieldConfidences = confidences;
            nullFields = nulls;

            const validatedSpecs = { ...flat };
            const oemFields = [
              "oil_filter_oem", "oil_drain_plug_gasket_oem", "engine_air_filter_oem", "cabin_air_filter_oem",
              "front_brake_pad_oem", "rear_brake_pad_oem", "front_brake_rotor_oem", "rear_brake_rotor_oem",
              "spark_plug_oem", "serpentine_belt_oem",
            ] as const;
            for (const field of oemFields) {
              const partNum = flat[field];
              if (!partNum || partNum === "N/A" || partNum === "" || partNum === 0) continue;
              const validation = await validateOEMPart(ctx, String(partNum), args.engineId, args.make);
              if (!validation.valid) {
                console.warn(`[Validate] ${field} "${partNum}": ${validation.reason}`);
                (validatedSpecs as any)[field] = "N/A";
              }
            }
            await ctx.runMutation(internal.vehicle_mutations.storeVehicleSpecs, {
              engineId: args.engineId,
              specs: validatedSpecs,
              confidenceScore: specs.overall_confidence ?? 0.70,
              make: args.make,
            });
            flatVehicleSpecs = validatedSpecs;
          }
          if (specs.trim_specs) {
            const { flat: trimFlat } = flattenPerFieldSpecs(specs.trim_specs);
            const engine = await ctx.runQuery(internal.vehicle_mutations.getEngine, { engineId: args.engineId });
            if (engine?.trim_id) {
              await ctx.runMutation(internal.vehicle_mutations.storeTrimSpecs, {
                trimId: engine.trim_id,
                specs: trimFlat,
                confidenceScore: specs.overall_confidence ?? 0.70,
              });
            }
          }
          console.log(`[Call 1B] Done — ${nullFields.length} null fields`);
        }
      } catch (error) {
        console.error("AI enrichment error (parts):", error);
      }
      await delay(10_000);

      // ============================================================
      // GAP FILL — Cross-reference siblings, then targeted AI retry
      // ============================================================
      const lowConfFields = Object.entries(fieldConfidences)
        .filter(([, conf]) => conf < 0.70)
        .map(([f]) => f);
      const fieldsToRetry = [...new Set([...nullFields, ...lowConfFields])];
      if (fieldsToRetry.length > 0 && effectiveEngineCode) {
        console.log(`[Gap Fill] ${fieldsToRetry.length} fields need attention`);
        const crossRefResults = await crossReferenceFromSiblings(
          ctx,
          effectiveEngineCode,
          args.engineId,
          fieldsToRetry,
        );
        const crossRefUpdates: Record<string, any> = {};
        const remainingFields: string[] = [];
        for (const field of fieldsToRetry) {
          if (crossRefResults[field]) {
            crossRefUpdates[field] = crossRefResults[field].value;
            fieldConfidences[field] = crossRefResults[field].confidence;
            flatVehicleSpecs[field] = crossRefResults[field].value;
          } else {
            remainingFields.push(field);
          }
        }
        if (Object.keys(crossRefUpdates).length > 0) {
          await ctx.runMutation(internal.vehicle_mutations.updateVehicleSpecs, {
            engineId: args.engineId,
            updates: crossRefUpdates,
          });
          console.log(`[Gap Fill] Cross-referenced ${Object.keys(crossRefUpdates).length} fields from siblings`);
        }
        if (remainingFields.length > 0 && remainingFields.length <= 8) {
          console.log(`[Gap Fill] AI retry for ${remainingFields.length} remaining fields`);
          const gapPrompt = buildGapFillPrompt(vehicleDesc, args, effectiveEngineCode, remainingFields);
          try {
            await delay(10_000);
            const response = await fetchAnthropicWithRetry(anthropicKey, {
              model: "claude-sonnet-4-5-20250929",
              messages: [{ role: "user", content: gapPrompt }],
              max_tokens: 4000,
              temperature: 0.1,
              tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
            });
            if (response.ok) {
              const result = await response.json();
              const gapData = extractJsonFromContentBlocks(result.content || []);
              const gapUpdates: Record<string, any> = {};
              for (const [field, data] of Object.entries(gapData)) {
                const d = data as { value?: any; confidence?: number } | null;
                if (d && typeof d === "object" && "value" in d && d.value != null && (d.confidence ?? 0) >= 0.60) {
                  gapUpdates[field] = d.value;
                  fieldConfidences[field] = d.confidence ?? 0.65;
                  flatVehicleSpecs[field] = d.value;
                }
              }
              if (Object.keys(gapUpdates).length > 0) {
                await ctx.runMutation(internal.vehicle_mutations.updateVehicleSpecs, {
                  engineId: args.engineId,
                  updates: gapUpdates,
                });
                console.log(`[Gap Fill] AI filled ${Object.keys(gapUpdates).length} fields`);
              }
            }
          } catch (error) {
            console.error("Gap fill error:", error);
          }
        }
      }
    } else {
      // Base specs already exist — pull values for pricing prompt context
      oilViscosity = existingSpecs.oil_viscosity || "N/A";
      oilCapacityQts = existingSpecs.oil_capacity_qts || 0;
      // engines docs don't store a confidence score — use the same default the
      // fresh-enrichment path falls back to.
      confidenceScore = 0.75;
      // Reverse of updateEngineAttributes' column mapping: has_turbocharger is
      // persisted as `aspiration`, fuel_injection_type as `fuel_injection`;
      // power_steering / transmission / drivetrain are not stored on engines.
      vehicleAttributes = {
        power_steering_type: null,
        timing_system: existingSpecs.timing_system ?? null,
        has_turbocharger:
          existingSpecs.aspiration != null
            ? existingSpecs.aspiration === "turbocharged"
            : null,
        fuel_injection_type: existingSpecs.fuel_injection ?? null,
        transmission_type: null,
        drivetrain_type: null,
      };
      const existingVehicleSpecs = await ctx.runQuery(internal.vehicle_mutations.getVehicleSpecs, {
        engineId: args.engineId,
      });
      if (existingVehicleSpecs) {
        flatVehicleSpecs = existingVehicleSpecs;
      }
    }

    // ============================================================
    // CLAUDE CALL #2 — Service pricing (service_vehicle_specs)
    // ============================================================
    if (needsPricing) {
      try {
        // Fetch all services
        const services = await ctx.runQuery(internal.vehicle_mutations.listAllServices, {});

        if (!services || services.length === 0) {
          console.log("No services found — skipping pricing enrichment");
          return;
        }

        // Build service list for the prompt
        const serviceList = services
          .map(
            (s: any) =>
              `- "${s.name}" (slug: ${s.slug}, default_labor: ${s.default_labor_hours}h, labor_only: ${s.is_labor_only})`,
          )
          .join("\n");

        const knownParts = Object.entries(flatVehicleSpecs)
          .filter(([k, v]) => k.endsWith("_oem") && v && v !== "N/A" && String(v).trim())
          .map(([field, value]) => `  - ${field}: ${value}`)
          .join("\n");

        const attrLines: string[] = [];
        if (vehicleAttributes.power_steering_type)
          attrLines.push(`- Power steering: ${vehicleAttributes.power_steering_type}`);
        if (vehicleAttributes.timing_system) attrLines.push(`- Timing: ${vehicleAttributes.timing_system}`);
        if (vehicleAttributes.has_turbocharger != null)
          attrLines.push(`- Turbocharger: ${vehicleAttributes.has_turbocharger ? "yes" : "no"}`);
        if (vehicleAttributes.transmission_type)
          attrLines.push(`- Transmission: ${vehicleAttributes.transmission_type}`);
        if (vehicleAttributes.drivetrain_type)
          attrLines.push(`- Drivetrain: ${vehicleAttributes.drivetrain_type}`);

        const pricingPrompt = `You are an automotive service pricing specialist.

          Vehicle: ${vehicleDesc}

          Known specs (use these):
          - Oil viscosity: ${oilViscosity}
          - Oil capacity (qts): ${oilCapacityQts}
          - Engine: ${args.displacement}L ${args.cylinders}-cyl ${args.fuelType}
          - Engine code: ${effectiveEngineCode}

          VEHICLE ATTRIBUTES (use to mark N/A services):
          ${attrLines.length ? attrLines.join("\n") : "  (none)"}

          KNOWN OEM PART NUMBERS (search for actual MSRP/dealer retail when pricing — use parts_cost_high as the quote buffer):
          ${knownParts || "  (none available — estimate from vehicle class)"}

          Services to price (include ALL of them):
          ${serviceList}

          SERVICE APPLICABILITY — Mark is_applicable: false when:
          - Power steering flush → electric power steering
          - Differential service → FWD (no rear differential)
          - Timing belt replacement → timing chain
          For N/A services: labor_hours=0, parts_cost=0, tech_notes="NOT APPLICABLE: <reason>".

          GOAL
          For EACH service slug, return labor_hours and parts_cost_low/high for THIS vehicle.
          Use web research. Prefer primary/commercial sources over opinions.

          ALLOWED SOURCE TYPES
          - Dealer parts sites / OEM parts catalogs (pricing references)
          - Major parts retailers (pricing references)
          - Reputable shop menus/quotes/estimates (labor references)
          - Publicly visible labor-time references (if available)

          NOT ALLOWED
          - Estimator
          - Forums as a primary source (forums may only sanity-check; never "verify")

          CRITICAL RULES
          1) LABOR-ONLY services: parts_cost_low=0, parts_cost_high=0, parts_list=[]
          2) Do NOT invent OEM part numbers. If unconfirmed, omit part numbers.
          3) If exact trim data is missing, use the fallback ladder and widen ranges.

          FALLBACK LADDER
          1) Exact vehicle/trim
          2) Same generation/platform
          3) Same engine code (M176) in closest Mercedes model
          4) Generic luxury performance car estimate
          When using fallback, widen ranges and state fallback in tech_notes.

          PER-SERVICE LIMITS (must follow)
          - tech_notes: max 120 characters
          - sources: max 2 items
          - parts_list: max 4 items

          CONFIDENCE SCORING (evidence-based)
          - 0.90+ = labor AND parts both supported by sources (2 sources total is fine)
          - 0.70–0.89 = one of labor/parts supported, other inferred via fallback ladder
          - <=0.69 = mostly inferred/estimated (must say why in tech_notes)

          EXAMPLE FORMAT (placeholders only; do not reuse values)
          [
            {
              "slug": "oil-change",
              "is_applicable": true,
              "not_applicable_reason": null,
              "labor_hours": 0,
              "parts_cost_low": 0,
              "parts_cost_high": 0,
              "confidence_score": 0,
              "parts_list": [
                { "item": "engine oil", "qty": 0, "price_low": 0, "price_high": 0 },
                { "item": "oil filter", "qty": 0, "price_low": 0, "price_high": 0 }
              ],
              "tech_notes": "",
              "sources": []
            }
          ]

          RETURN ONLY valid JSON array (no extra text). Each element:
          [
            {
              "slug": string,
              "is_applicable": true | false,
              "not_applicable_reason": string | null,
              "labor_hours": number,
              "parts_cost_low": number,
              "parts_cost_high": number,
              "confidence_score": number,
              "parts_list": Array<{ "item": string, "qty": number, "price_low": number, "price_high": number }>,
              "tech_notes": string,
              "sources": string[]
            }
          ]`;

        // Spread tokens across rate-limit window: wait before pricing so we don't burst with base specs.
        await delay(15_000);

        const pricingResponse = await fetchAnthropicWithRetry(anthropicKey, {
          model: "claude-sonnet-4-5-20250929",
          max_tokens: 16000,
          temperature: 0.1,
          messages: [{ role: "user", content: pricingPrompt }],
          tools: [
            {
              type: "web_search_20250305",
              name: "web_search",
              max_uses: 5,
            },
          ],
        });

        if (!pricingResponse.ok) {
          console.error("Claude API error (pricing):", await pricingResponse.text());
          return;
        }

        const pricingResult = await pricingResponse.json();
        const pricingData: any[] = extractJsonFromContentBlocks(pricingResult.content || []);

        // Build slug → service ID map
        const slugToService = new Map<string, any>();
        for (const svc of services) {
          if (svc.slug) slugToService.set(svc.slug, svc);
        }

        // Loop through results and upsert
        for (const item of pricingData) {
          const svc = slugToService.get(item.slug);
          if (!svc) {
            console.log(`Unknown service slug "${item.slug}" — skipping`);
            continue;
          }

          const isApplicable = item.is_applicable !== false;
          const laborHours = parseFloat(item.labor_hours) || svc.default_labor_hours;
          const partsCostLow = isApplicable ? (parseFloat(item.parts_cost_low) || 0) : 0;
          const partsCostHigh = isApplicable ? (parseFloat(item.parts_cost_high) || 0) : 0;
          const itemConfidence = parseFloat(item.confidence_score) || 0.6;
          const techNotes = item.is_applicable === false
            ? `NOT APPLICABLE: ${item.not_applicable_reason || ""}`
            : (item.tech_notes || "");

          await ctx.runMutation(internal.vehicle_mutations.upsertServiceVehicleSpec, {
            engineId: args.engineId,
            serviceId: svc._id,
            laborHours,
            partsCostLow,
            partsCostHigh,
            confidenceScore: isApplicable ? itemConfidence : 0.90,
            techNotes,
            oemIntervalMiles: item.oem_interval_miles ?? undefined,
            oemIntervalMonths: item.oem_interval_months ?? undefined,
            oemIntervalNote: item.oem_interval_note ?? undefined,
            partsRequired: item.parts_required
              ? JSON.stringify(item.parts_required)
              : undefined,
            isApplicable: item.is_applicable !== false ? undefined : false,
            exclusionReason: item.exclusion_reason ?? item.not_applicable_reason ?? undefined,
          });

          await ctx.runMutation(internal.vehicle_mutations.logServiceEnrichment, {
            engineId: args.engineId,
            serviceId: svc._id,
            source: "claude-sonnet-pricing",
            confidenceScore: itemConfidence,
            enrichedData: {
              labor_hours: laborHours,
              parts_cost_low: partsCostLow,
              parts_cost_high: partsCostHigh,
              tech_notes: techNotes,
            },
          });
        }

        console.log(`Enriched service pricing for ${vehicleDesc} (${pricingData.length} services)`);
      } catch (error) {
        console.error("AI enrichment error (pricing):", error);
        // Pricing failure does not lose base specs — they were already stored
      }
    }
  },
});

// ============================================
// PUBLIC ACTIONS (called from client)
// ============================================

/**
 * Decode a VIN via NHTSA and upsert makes/models/trims/engines.
 * Returns decoded vehicle info for the review screen.
 */
type DecodeVinResult =
  | { success: false; error: string }
  | {
      success: true;
      vin: string;
      makeId: Id<"makes">;
      modelId: Id<"models">;
      trimId: Id<"trims">;
      engineId: Id<"engines">;
      make: string;
      model: string;
      year: number;
      trim: string;
      engineCode: string;
      cylinders: number;
      displacement: string;
      fuelType: string;
      nhtsaVinKey: string;
      // Raw NHTSA decode passthrough — picker uses these for VDB model
      // discovery (NHTSA's Model is often the specific designation,
      // e.g. "530i", while the merged result may have been normalized).
      nhtsaModel: string;
      nhtsaSeries: string;
      nhtsaTrim: string;
      // Raw VDB decode fields — picker builds the YMMT combo matrix
      // for `vehicle-images` direct probes when the VIN URL 404s.
      vdbDecodedModel: string;
      vdbDecodedStyle: string;
      vdbDecodedTrimAndStyle: string;
      // Review-screen Specs card fields. Flat for router param forwarding.
      horsepower: number | null;
      engineDisplacementLiters: number | null;
      cylindersConfiguration: string | null;
      mpgCity: number | null;
      mpgHighway: number | null;
      mpgCombined: number | null;
      frontTireSize: string | null;
      rearTireSize: string | null;
      frontTirePressure: number | null;
      rearTirePressure: number | null;
      transType: string | null;
      transSpeeds: number | null;
      drivetrain: string;
      /** Merged body class string (e.g. "Sport Utility Vehicle (SUV)/Multi-Purpose Vehicle (MPV)",
       *  "Sedan/Saloon"). Used by the review screen's loading-state
       *  silhouette to pick SUV vs sedan. */
      bodyClass: string;
      /** NHTSA "VehicleType" — high-level class. Used by the client's
       *  eligibility gate (we don't service motorcycles, semis,
       *  buses, trailers). */
      vehicleType: string;
    };

export const decodeVin = action({
  args: { vin: v.string() },
  handler: async (ctx, args): Promise<DecodeVinResult> => {
    const vin = args.vin.toUpperCase().trim();

    if (vin.length !== 17) {
      return { success: false as const, error: "VIN must be exactly 17 characters" };
    }

    const result: ProcessVinResult | null = await ctx.runAction(internal.vehicle_pipeline.processVin, { vin });

    if (!result) {
      return { success: false as const, error: "Could not decode this VIN. Please check and try again." };
    }

    return {
      success: true as const,
      vin,
      makeId: result.makeId,
      modelId: result.modelId,
      trimId: result.trimId,
      engineId: result.engineId,
      make: result.make,
      model: result.model,
      year: result.year,
      trim: result.trim,
      engineCode: result.engineCode,
      cylinders: result.cylinders,
      displacement: result.displacement,
      fuelType: result.fuelType,
      // NHTSA-only base key — pass back to the client so confirmVehicleForUser
      // can use it for cache lookups even if Claude rewrote the trim/model
      // between decode and confirm.
      nhtsaVinKey: result.nhtsaVinKey,
      // Raw NHTSA model/series/trim — forwarded to the picker so it
      // can do VDB model discovery. For BMW VINs NHTSA's model is
      // often "530i" (exactly what VDB needs) while the merged
      // result has been overwritten to "5 Series" by VDB or AI norm.
      nhtsaModel: result.nhtsaModel,
      nhtsaSeries: result.nhtsaSeries,
      nhtsaTrim: result.nhtsaTrim,
      // Raw VDB decode — picker uses these to build the YMMT combo
      // matrix for `vehicle-images` direct probes when the VIN URL
      // returns no record.
      vdbDecodedModel: result.vdbDecodedModel,
      vdbDecodedStyle: result.vdbDecodedStyle,
      vdbDecodedTrimAndStyle: result.vdbDecodedTrimAndStyle,
      // Specs-card fields for the review screen.
      horsepower: result.horsepower,
      engineDisplacementLiters: result.engineDisplacementLiters,
      cylindersConfiguration: result.cylindersConfiguration,
      mpgCity: result.mpgCity,
      mpgHighway: result.mpgHighway,
      mpgCombined: result.mpgCombined,
      frontTireSize: result.frontTireSize,
      rearTireSize: result.rearTireSize,
      frontTirePressure: result.frontTirePressure,
      rearTirePressure: result.rearTirePressure,
      transType: result.transType,
      transSpeeds: result.transSpeeds,
      drivetrain: result.drivetrain,
      bodyClass: result.bodyClass,
      vehicleType: result.vehicleType,
    };
  },
});

/**
 * Confirm a decoded vehicle for the current user.
 * Creates vehicle + owner records and schedules AI enrichment.
 */
export const confirmVehicleForUser = action({
  args: {
    vin: v.string(),
    trimId: v.id("trims"),
    engineId: v.id("engines"),
    transmissionId: v.optional(v.id("transmissions")),
    year: v.float64(),
    make: v.string(),
    model: v.string(),
    trim: v.string(),
    engineCode: v.string(),
    displacement: v.string(),
    cylinders: v.float64(),
    fuelType: v.string(),
    color: v.optional(v.string()),
    drivetrain: v.optional(v.string()),
    // NHTSA-only base key returned by decodeVin. When present, this is the
    // PRIMARY dedup key — works even before Haiku has resolved synthetic
    // engine codes (e.g. "1.4 TSI" → "EA211"). config_key is a secondary
    // lookup for legacy paths that don't pass the NHTSA key.
    nhtsaVinKey: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<
    | { success: false; error: string }
    | {
        success: true;
        vehicleOwnerId: Id<"vehicle_owners">;
        cache_hit: boolean;
        cache_hit_source: "nhtsa_vin_key" | "config_key" | "none";
        enrichment_scheduled: boolean;
      }
  > => {
    // Resolve current user from auth
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return { success: false as const, error: "Not authenticated" };
    }

    const user: { _id: Id<"users"> } | null = await ctx.runQuery(internal.vehicle_mutations.getUserByClerkId, {
      clerkUserId: identity.subject,
    });
    if (!user) {
      return { success: false as const, error: "User not found" };
    }

    const vin = args.vin.toUpperCase().trim();

    // Upsert vehicle catalog record
    const vehicle: { _id: Id<"vehicles"> } | null = await ctx.runMutation(api.vehicles.upsertVehicle, {
      vin,
      trim_id: args.trimId,
      engine_id: args.engineId,
      transmission_id: args.transmissionId,
      year: args.year,
      metadata: {
        make: args.make,
        model: args.model,
        color: args.color || "",
      },
    });

    // Link vehicle to user
    const vehicleOwnerId: Id<"vehicle_owners"> = await ctx.runMutation(api.vehicles.addOwner, {
      vin,
      userId: user._id,
      nickname: `${args.year} ${args.make} ${args.model}`,
    });

    // Early dedup. If a vehicle_configs row already exists for this VIN's
    // make/model/trim/engine fingerprint and is fresh, skip-attach the new
    // vehicle to it instead of running the full enrichment action.
    //
    // Lookup priority:
    //   1. nhtsa_vin_key  — works BEFORE Haiku engine-code resolution.
    //                       Critical for makes that emit descriptors like
    //                       VW "1.4 TSI", Ford "EcoBoost", Hyundai "Smartstream".
    //   2. config_key     — fallback for legacy/manual paths that don't
    //                       have a NHTSA-decoded VIN handy.
    //
    // The pipeline's STAGE 0 cache check would catch this anyway, but doing it
    // here saves ~2-3 sec of scheduler overhead per duplicate add.
    let cacheHit = false;
    let scheduledEnrichment = false;
    let dedupSource: "nhtsa_vin_key" | "config_key" | "none" = "none";

    if (vehicle?._id) {
      let existingConfig = null as any;

      // Primary: NHTSA-only base key
      if (args.nhtsaVinKey) {
        existingConfig = await ctx.runQuery(
          internal.vehicleEnrichment.v3queries.getVehicleConfigByNhtsaVinKey,
          { nhtsaVinKey: args.nhtsaVinKey },
        );
        if (existingConfig) dedupSource = "nhtsa_vin_key";
      }

      // Secondary: post-resolution config_key
      let configKey = "";
      if (!existingConfig && args.engineCode) {
        configKey = buildEngineKey({
          vehicleId: vehicle._id as any,
          year: args.year,
          make: args.make,
          model: args.model,
          trim: args.trim,
          engineCode: args.engineCode,
          displacement: args.displacement,
        });
        existingConfig = await ctx.runQuery(
          internal.vehicleEnrichment.v3queries.getVehicleConfigByKey,
          { configKey },
        );
        if (existingConfig) dedupSource = "config_key";
      }

      const STALE_MS = 180 * 24 * 60 * 60 * 1000;
      const status = existingConfig?.enrichment_status;
      const fresh =
        existingConfig &&
        (status === "complete" || status === "verified") &&
        (existingConfig.last_enriched_at ?? 0) >= Date.now() - STALE_MS;

      if (fresh && existingConfig?._id) {
        // Skip-attach. The vehicle row gets pointed at the existing definition
        // — no Claude calls, no scheduler delay.
        await ctx.runMutation(
          internal.vehicleEnrichment.v3mutations.attachVehicleConfig,
          { vehicle_id: vehicle._id, vehicle_config_id: existingConfig._id },
        );
        cacheHit = true;
        console.log(
          `[confirmVehicleForUser] cache_hit: attached vehicle ${vehicle._id} to ` +
          `existing vehicle_configs ${existingConfig._id} ` +
          `(via=${dedupSource}, nhtsaVinKey=${args.nhtsaVinKey ?? "none"})`,
        );
      } else {
        // No fresh definition — run the full enrichment pipeline. Pass through
        // the nhtsa_vin_key so STAGE 4 stamps it onto the new vehicle_configs row.
        await ctx.scheduler.runAfter(0, internal.vehicleEnrichment.v3pipeline.enrichVehicleBatchV3, {
          vehicleId: vehicle._id,
          year: args.year,
          make: args.make,
          model: args.model,
          trim: args.trim,
          engineCode: args.engineCode,
          displacement: args.displacement,
          drivetrain: args.drivetrain,
          nhtsaVinKey: args.nhtsaVinKey,
        });
        scheduledEnrichment = true;
        console.log(
          `[confirmVehicleForUser] scheduled enrichment for vehicle ${vehicle._id} ` +
          `(nhtsaVinKey=${args.nhtsaVinKey ?? "none"}, configKey=${configKey || "n/a"}, ` +
          `existing=${existingConfig ? status : "none"})`,
        );
      }
    }

    // Schedule tire price scraping in parallel with enrichment
    await ctx.scheduler.runAfter(0, api.tires.scrapeVehicleTires, {
      year: args.year,
      make: args.make,
      model: args.model,
      trim: args.trim,
      displacementL: args.displacement ? parseFloat(args.displacement) : undefined,
    });

    return {
      success: true as const,
      vehicleOwnerId,
      cache_hit: cacheHit,
      cache_hit_source: dedupSource,
      enrichment_scheduled: scheduledEnrichment,
    };
  },
});

/**
 * Shop-scoped sibling of confirmVehicleForUser: attaches the decoded vehicle
 * to a walk-in booking's stub customer, NOT to the caller. Auth is via
 * shopAuth against the booking's shop, plus a walk-in-source guard. Same
 * downstream: upsertVehicle → addOwner → dedup/enrichment schedule.
 *
 * Called from the shop portal's walkin/new page immediately after
 * createByShop lands. The customer's Cars page shows the car the moment
 * they claim the booking, without needing a separate app-side add flow.
 */
export const confirmVehicleForShopCustomer = action({
  args: {
    bookingId: v.id("bookings"),
    vin: v.string(),
    trimId: v.id("trims"),
    engineId: v.id("engines"),
    transmissionId: v.optional(v.id("transmissions")),
    year: v.float64(),
    make: v.string(),
    model: v.string(),
    trim: v.string(),
    engineCode: v.string(),
    displacement: v.string(),
    cylinders: v.float64(),
    fuelType: v.string(),
    color: v.optional(v.string()),
    drivetrain: v.optional(v.string()),
    nhtsaVinKey: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<
    | { success: false; error: string }
    | {
        success: true;
        vehicleOwnerId: Id<"vehicle_owners">;
        cache_hit: boolean;
        cache_hit_source: "nhtsa_vin_key" | "config_key" | "none";
        enrichment_scheduled: boolean;
      }
  > => {
    const { userId }: { userId: Id<"users"> } = await ctx.runQuery(
      internal.walkin_claims._walkinBookingCustomerForShopStaff,
      { bookingId: args.bookingId },
    );

    const vin = args.vin.toUpperCase().trim();

    const vehicle: { _id: Id<"vehicles"> } | null = await ctx.runMutation(api.vehicles.upsertVehicle, {
      vin,
      trim_id: args.trimId,
      engine_id: args.engineId,
      transmission_id: args.transmissionId,
      year: args.year,
      metadata: {
        make: args.make,
        model: args.model,
        color: args.color || "",
      },
    });

    const vehicleOwnerId: Id<"vehicle_owners"> = await ctx.runMutation(api.vehicles.addOwner, {
      vin,
      userId,
      nickname: `${args.year} ${args.make} ${args.model}`,
    });

    let cacheHit = false;
    let scheduledEnrichment = false;
    let dedupSource: "nhtsa_vin_key" | "config_key" | "none" = "none";

    if (vehicle?._id) {
      let existingConfig = null as any;

      if (args.nhtsaVinKey) {
        existingConfig = await ctx.runQuery(
          internal.vehicleEnrichment.v3queries.getVehicleConfigByNhtsaVinKey,
          { nhtsaVinKey: args.nhtsaVinKey },
        );
        if (existingConfig) dedupSource = "nhtsa_vin_key";
      }

      let configKey = "";
      if (!existingConfig && args.engineCode) {
        configKey = buildEngineKey({
          vehicleId: vehicle._id as any,
          year: args.year,
          make: args.make,
          model: args.model,
          trim: args.trim,
          engineCode: args.engineCode,
          displacement: args.displacement,
        });
        existingConfig = await ctx.runQuery(
          internal.vehicleEnrichment.v3queries.getVehicleConfigByKey,
          { configKey },
        );
        if (existingConfig) dedupSource = "config_key";
      }

      const STALE_MS = 180 * 24 * 60 * 60 * 1000;
      const status = existingConfig?.enrichment_status;
      const fresh =
        existingConfig &&
        (status === "complete" || status === "verified") &&
        (existingConfig.last_enriched_at ?? 0) >= Date.now() - STALE_MS;

      if (fresh && existingConfig?._id) {
        await ctx.runMutation(
          internal.vehicleEnrichment.v3mutations.attachVehicleConfig,
          { vehicle_id: vehicle._id, vehicle_config_id: existingConfig._id },
        );
        cacheHit = true;
      } else {
        await ctx.scheduler.runAfter(0, internal.vehicleEnrichment.v3pipeline.enrichVehicleBatchV3, {
          vehicleId: vehicle._id,
          year: args.year,
          make: args.make,
          model: args.model,
          trim: args.trim,
          engineCode: args.engineCode,
          displacement: args.displacement,
          drivetrain: args.drivetrain,
          nhtsaVinKey: args.nhtsaVinKey,
        });
        scheduledEnrichment = true;
      }
    }

    await ctx.scheduler.runAfter(0, api.tires.scrapeVehicleTires, {
      year: args.year,
      make: args.make,
      model: args.model,
      trim: args.trim,
      displacementL: args.displacement ? parseFloat(args.displacement) : undefined,
    });

    return {
      success: true as const,
      vehicleOwnerId,
      cache_hit: cacheHit,
      cache_hit_source: dedupSource,
      enrichment_scheduled: scheduledEnrichment,
    };
  },
});

// ============================================
// HELPERS
// ============================================

/** Delay for ms milliseconds (used to spread Claude calls and respect rate limits). */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Call Anthropic Messages API with retry on 429 (rate limit).
 * Waits 60s and retries up to maxRetries times to stay within 30k input tokens/min.
 */
async function fetchAnthropicWithRetry(
  anthropicKey: string,
  body: Record<string, unknown>,
  maxRetries = 2,
): Promise<Response> {
  const url = "https://api.anthropic.com/v1/messages";
  let lastResponse: Response | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      // Dead-socket bound only — web_search generations legitimately run
      // minutes, so this must sit above any plausible completion time. The
      // abort throws into each caller's existing fail-open try/catch.
      signal: AbortSignal.timeout(300_000),
    });
    lastResponse = response;
    if (response.status === 429) {
      const text = await response.text();
      const waitMs = 60_000; // 1 minute to align with org limit window
      if (attempt < maxRetries) {
        console.warn(`Claude rate limit (429), waiting ${waitMs / 1000}s before retry (${attempt + 1}/${maxRetries})`);
        await delay(waitMs);
        continue;
      }
      console.error("Claude API rate limit after retries:", text);
      return response;
    }
    return response;
  }
  return lastResponse!;
}

/** Normalize AI drivetrain label to schema value: fwd | rwd | awd | 4wd */
function toCanonicalDrivetrain(value: string): "fwd" | "rwd" | "awd" | "4wd" | undefined {
  const v = value.toLowerCase().trim();
  if (v === "fwd" || v === "rwd" || v === "awd" || v === "4wd") return v as "fwd" | "rwd" | "awd" | "4wd";
  if (v === "xdrive" || v === "4matic" || v === "quattro" || v === "4motion") return "awd";
  if (v === "sdrive") return "rwd";
  return undefined;
}

/** Map NHTSA DriveType string to canonical drivetrain value. */
function mapNhtsaDriveType(driveType: string): string | undefined {
  if (!driveType) return undefined;
  const d = driveType.toLowerCase();
  if (d.includes("4wd") || d.includes("4-wheel") || d.includes("4x4")) return "4WD";
  if (d.includes("awd") || d.includes("all-wheel") || d.includes("all wheel")) return "AWD";
  if (d.includes("fwd") || d.includes("front-wheel") || d.includes("front wheel")) return "FWD";
  if (d.includes("rwd") || d.includes("rear-wheel") || d.includes("rear wheel")) return "RWD";
  return undefined;
}

/** Map NHTSA TransmissionStyle to v3 type. */
// Transmission style canonicalization moved to lib/transmissionTypeInference.ts
// (Haiku-based with in-memory cache). No hardcoded marketing-term whitelist —
// new transmission marketing names land automatically without code changes.

/**
 * Batch-6 fallback: when NHTSA (and VDB) can't supply the Model for an
 * otherwise-valid VIN, resolve it from the VIN via a web-search Haiku call.
 * The VIN's VDS uniquely encodes the model, so a search on "VIN <vin>" plus
 * make/year/series reliably recovers it (e.g. the 2009 Escalade ESV whose
 * NHTSA decode returned a blank Model). Returns null when it can't confirm one.
 */
async function resolveModelFromVin(
  vin: string,
  make: string,
  year: number,
  series?: string,
  bodyClass?: string,
  engine?: { code?: string; displacement?: string; cylinders?: number | string; hp?: string },
): Promise<string | null> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  try {
    const haiku = new Anthropic({ apiKey: key });
    const ctx = [
      series ? `series "${series}"` : null,
      bodyClass ? `body "${bodyClass}"` : null,
      engine?.code ? `engine code ${engine.code}` : null,
      engine?.displacement ? `${engine.displacement}L` : null,
      engine?.cylinders ? `${engine.cylinders}-cyl` : null,
      engine?.hp ? `${engine.hp} hp` : null,
    ].filter(Boolean).join(", ");
    const resp = await haiku.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 512,
      temperature: 0,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 } as any],
      messages: [{
        role: "user",
        content: `NHTSA could not decode the MODEL for VIN ${vin} — a ${year} ${make}${ctx ? ` (${ctx})` : ""}. Identify the exact model line. Two approaches: (1) search VIN decoders/dealer listings for this VIN; (2) if that fails, INFER it from the make + year + engine — the engine code and displacement often uniquely identify one model line (e.g. the GM "L9H" 6.2L V8 in a 2009 Cadillac is the Escalade). Include any body sub-designation if known (e.g. "Escalade ESV", "Silverado 1500"). Respond with ONLY a JSON object on one line: {"model": "<model line>"} — use {"model": "unknown"} only if make+year+engine still don't identify a model.`,
      }],
    });
    const text = resp.content
      .filter((b) => b.type === "text")
      .map((b) => (b as any).text)
      .join("")
      .trim();
    console.log(`[decode] model VIN-lookup raw: ${text.slice(0, 200)}`);
    // Prefer JSON; fall back to a bare-line if the model didn't wrap it.
    let model = "";
    const j = text.match(/\{[\s\S]*?\}/);
    if (j) {
      try { model = String(JSON.parse(j[0]).model ?? "").trim(); } catch { /* fall through */ }
    }
    if (!model) model = text.replace(/^["']+|["']+$/g, "").split("\n").pop()!.trim();
    if (model && model.toLowerCase() !== "unknown" && model.length >= 2 && model.length <= 40) {
      return model;
    }
  } catch (e) {
    console.warn("[decode] model VIN-lookup failed (non-fatal):", e);
  }
  return null;
}

/**
 * Call Claude to normalize NHTSA model/trim/drivetrain/engine_code into canonical OEM naming.
 * Returns null on failure or missing key; otherwise { model?, trim?, drivetrain_type?, engine_code? }.
 */
async function normalizeNhtsaWithClaude(
  anthropicKey: string,
  nhtsa: {
    make: string;
    year: number;
    nhtsaModel: string;
    nhtsaTrim: string;
    nhtsaTrim2: string;
    nhtsaSeries: string;
    nhtsaSeries2: string;
    bodyClass: string;
    driveType: string;
    engineModel: string;
  },
): Promise<{ model?: string; trim?: string; drivetrain_type?: string; engine_code?: string } | null> {
  const prompt = `You are an automotive data normalizer. NHTSA VIN decode often mislabels model vs trim vs drivetrain (e.g. BMW M550i xDrive: Model="M550i", Trim="xdrive" — but model should be "5 Series", trim "M550i", drivetrain "awd").

Input from NHTSA:
- Make: ${nhtsa.make}
- Year: ${nhtsa.year}
- NHTSA Model: ${nhtsa.nhtsaModel}
- NHTSA Trim: ${nhtsa.nhtsaTrim}
- NHTSA Trim2: ${nhtsa.nhtsaTrim2}
- NHTSA Series: ${nhtsa.nhtsaSeries}
- NHTSA Series2: ${nhtsa.nhtsaSeries2}
- BodyClass: ${nhtsa.bodyClass}
- DriveType: ${nhtsa.driveType}
- EngineModel: ${nhtsa.engineModel}

Output ONLY valid JSON (no markdown, no comments) with this exact shape:
{
  "model": "<canonical model line, e.g. 5 Series, 3 Series, Civic>",
  "trim": "<canonical trim/submodel, e.g. M550i, 330i, EX-L>",
  "drivetrain_type": "<one of: fwd, rwd, awd, 4wd — or empty string if unknown>",
  "engine_code": "<OEM engine code if known, e.g. N63B44O2, or empty string to keep NHTSA>"
}

Rules:
- model = the model line (e.g. "5 Series"), not the trim (e.g. "M550i").
- trim = the trim/submodel name; if NHTSA put drivetrain in Trim (e.g. "xdrive"), use the actual trim from NHTSA Model or infer (e.g. "M550i").
- drivetrain_type: infer from Trim/DriveType (xDrive, sDrive, 4matic, quattro → awd/rwd). Use only fwd, rwd, awd, 4wd or "".
- engine_code: fill if you know the OEM code and NHTSA is empty/wrong; otherwise "".
- If a field is truly unknown, use "".
- Output ONLY the JSON object.`;

  try {
    const response = await fetchAnthropicWithRetry(anthropicKey, {
      model: "claude-sonnet-4-5-20250929",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 4096,
      temperature: 0.1,
    });

    if (!response.ok) {
      console.error("Claude normalization API error:", await response.text());
      return null;
    }

    const result = await response.json();
    const content = result.content ?? [];
    const parsed = extractJsonFromContentBlocks(Array.isArray(content) ? content : [content]);
    if (!parsed || typeof parsed !== "object") return null;

    return {
      model: typeof parsed.model === "string" ? parsed.model.trim() || undefined : undefined,
      trim: typeof parsed.trim === "string" ? parsed.trim.trim() || undefined : undefined,
      drivetrain_type:
        typeof parsed.drivetrain_type === "string" ? parsed.drivetrain_type.trim() || undefined : undefined,
      engine_code: typeof parsed.engine_code === "string" ? parsed.engine_code.trim() || undefined : undefined,
    };
  } catch (e) {
    console.error("Claude normalization error:", e);
    return null;
  }
}

/**
 * Infer OEM engine code from make + model + trim + year (and optional displacement/cylinders/fuel).
 * Used when NHTSA did not provide engine code so enrichment can run with correct context.
 */
async function inferEngineCodeFromVehicle(
  anthropicKey: string,
  vehicle: {
    make: string;
    model: string;
    trim: string;
    year: number;
    displacement: string;
    cylinders: number;
    fuelType: string;
  },
): Promise<string> {
  const prompt = `You are an automotive expert. Given this vehicle, return ONLY the OEM engine code (e.g. N63B44O2, B58B30M1, K20C1). No explanation.

Vehicle: ${vehicle.year} ${vehicle.make} ${vehicle.model} ${vehicle.trim}
Displacement: ${vehicle.displacement}L, ${vehicle.cylinders} cylinders, ${vehicle.fuelType}

Output a single line with only the engine code, or "unknown" if you cannot determine it.`;

  try {
    const response = await fetchAnthropicWithRetry(anthropicKey, {
      model: "claude-sonnet-4-5-20250929",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 128,
      temperature: 0,
    });

    if (!response.ok) return "";

    const result = await response.json();
    const content = result.content ?? [];
    const text = (Array.isArray(content) ? content : [content])
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join(" ")
      .trim();
    const code = text.replace(/^["']|["']$/g, "").trim();
    if (code && code.toLowerCase() !== "unknown") return code;
    return "";
  } catch (e) {
    console.error("Engine code inference error:", e);
    return "";
  }
}

// ---------------------------------------------------------------------------
// Prompt builders & helpers (Call 1A, 1B, Gap Fill)
// ---------------------------------------------------------------------------

interface VehicleAttributes {
  power_steering_type: string | null;
  timing_system: string | null;
  has_turbocharger: boolean | null;
  fuel_injection_type: string | null;
  transmission_type: string | null;
  drivetrain_type: string | null;
}

function buildFluidsPrompt(
  vehicleDesc: string,
  args: { make: string; model: string; year: number; trim: string; displacement: string },
  engineCode: string,
): string {
  return `You are an automotive maintenance specialist. Extract fluid specs, maintenance intervals, and vehicle mechanical attributes.

Vehicle: ${vehicleDesc}

TASK: Extract engine_specs (fluids, intervals) and vehicle_attributes. Use 8 web searches.

SEARCH STRATEGY:
1. "${args.year} ${args.make} ${args.model} owner's manual maintenance schedule"
2. "${args.make} ${engineCode || args.displacement + "L"} oil type capacity"
3. "${args.year} ${args.make} ${args.model} ${args.trim} service intervals"
4. "${args.year} ${args.make} ${args.model} power steering type timing chain or belt"
5-8. Fill remaining gaps.

For intervals: provide display string AND structured fields (_miles, _months, _status).
- interval_status: "scheduled" | "not_applicable" | "conditional_severe" | "lifetime" | "inspect_only" | "data_unavailable"

vehicle_attributes (from general knowledge or search): power_steering_type, timing_system, has_turbocharger, fuel_injection_type, transmission_type, drivetrain_type.

Return ONLY valid JSON:
{
  "engine_specs": {
    "oil_viscosity": "", "oil_capacity_qts": 0,
    "oil_change_interval": "", "oil_change_interval_miles": null, "oil_change_interval_months": null, "oil_change_interval_status": "scheduled",
    "coolant_type": "", "coolant_capacity_qts": 0, "coolant_interval": "", "coolant_interval_miles": null, "coolant_interval_months": null, "coolant_interval_status": "scheduled",
    "brake_fluid_type": "", "brake_fluid_interval": "", "brake_fluid_interval_miles": null, "brake_fluid_interval_months": null, "brake_fluid_interval_status": "scheduled",
    "tire_rotation_interval": "", "tire_rotation_interval_miles": null, "tire_rotation_interval_months": null, "tire_rotation_interval_status": "scheduled",
    "engine_air_filter_interval": "", "engine_air_filter_interval_miles": null, "engine_air_filter_interval_months": null, "engine_air_filter_interval_status": "scheduled",
    "cabin_air_filter_interval": "", "cabin_air_filter_interval_miles": null, "cabin_air_filter_interval_months": null, "cabin_air_filter_interval_status": "scheduled",
    "spark_plug_interval": "", "spark_plug_interval_miles": null, "spark_plug_interval_months": null, "spark_plug_interval_status": "scheduled",
    "serpentine_belt_interval": "", "serpentine_belt_interval_miles": null, "serpentine_belt_interval_months": null, "serpentine_belt_interval_status": "scheduled",
    "transmission_fluid_interval": "", "transmission_fluid_interval_miles": null, "transmission_fluid_interval_months": null, "transmission_fluid_interval_status": "scheduled",
    "transmission_fluid_severe_interval_miles": null, "transmission_fluid_severe_note": null
  },
  "vehicle_attributes": {
    "power_steering_type": null, "timing_system": null, "has_turbocharger": null,
    "fuel_injection_type": null, "transmission_type": null, "drivetrain_type": null
  },
  "confidence_score": 0
}`;
}

function buildPartsPrompt(
  vehicleDesc: string,
  args: { make: string; model: string; year: number; trim: string },
  engineCode: string,
  attributes: VehicleAttributes,
): string {
  const year = Math.round(args.year);
  const skips: string[] = [];
  if (attributes.power_steering_type === "electric") skips.push("SKIP power steering parts");
  if (attributes.timing_system === "chain") skips.push("SKIP timing belt");
  const skipBlock = skips.length ? `\nPARTS TO SKIP: ${skips.join("; ")}\n` : "";

  return `You are an OEM automotive parts specialist. Find exact manufacturer part numbers.

Vehicle: ${vehicleDesc}${skipBlock}

CRITICAL: Parts MUST be verified for model year ${year}. If unverified for ${year}, set confidence ≤ 0.5.

For each field: { "value": "... or null", "confidence": 0.0-1.0, "source": "..." }.
0.9+ = OEM catalog, 0.7-0.89 = cross-ref, 0.5-0.69 = same engine/platform, ≤0.5 = unverified.

Return ONLY valid JSON:
{
  "vehicle_specs": {
    "oil_filter_oem": { "value": null, "confidence": 0, "source": null },
    "oil_drain_plug_gasket_oem": { "value": null, "confidence": 0, "source": null },
    "engine_air_filter_oem": { "value": null, "confidence": 0, "source": null },
    "cabin_air_filter_oem": { "value": null, "confidence": 0, "source": null },
    "front_brake_pad_oem": { "value": null, "confidence": 0, "source": null },
    "rear_brake_pad_oem": { "value": null, "confidence": 0, "source": null },
    "front_brake_rotor_oem": { "value": null, "confidence": 0, "source": null },
    "rear_brake_rotor_oem": { "value": null, "confidence": 0, "source": null },
    "spark_plug_oem": { "value": null, "confidence": 0, "source": null },
    "spark_plug_quantity": { "value": 4, "confidence": 0.95 },
    "spark_plug_gap_mm": { "value": null, "confidence": 0 },
    "serpentine_belt_oem": { "value": null, "confidence": 0, "source": null },
    "battery_group": { "value": null, "confidence": 0 },
    "battery_cca": { "value": null, "confidence": 0 },
    "parking_brake_type": { "value": null, "confidence": 0 }
  },
  "trim_specs": {
    "tire_size_front": { "value": null, "confidence": 0 }, "tire_size_rear": { "value": null, "confidence": 0 },
    "recommended_tire_pressure_front_psi": { "value": null, "confidence": 0 },
    "recommended_tire_pressure_rear_psi": { "value": null, "confidence": 0 },
    "lug_nut_torque_ft_lbs": { "value": null, "confidence": 0 },
    "wiper_blade_driver_size_in": { "value": null, "confidence": 0 },
    "wiper_blade_passenger_size_in": { "value": null, "confidence": 0 }
  },
  "overall_confidence": 0
}`;
}

function buildGapFillPrompt(
  vehicleDesc: string,
  args: { make: string; model: string; year: number },
  engineCode: string,
  missingFields: string[],
): string {
  const desc: Record<string, string> = {
    oil_filter_oem: "OEM oil filter part number",
    oil_drain_plug_gasket_oem: "OEM drain plug gasket",
    engine_air_filter_oem: "OEM engine air filter",
    cabin_air_filter_oem: "OEM cabin air filter",
    front_brake_pad_oem: "OEM front brake pad set",
    rear_brake_pad_oem: "OEM rear brake pad set",
    front_brake_rotor_oem: "OEM front brake rotor",
    rear_brake_rotor_oem: "OEM rear brake rotor",
    spark_plug_oem: "OEM spark plug part number",
    spark_plug_quantity: "Number of spark plugs",
    spark_plug_gap_mm: "Spark plug gap mm",
    serpentine_belt_oem: "OEM serpentine belt",
    battery_group: "Battery group size",
    battery_cca: "Cold cranking amps",
  };
  const list = missingFields.map((f) => `- ${f}: ${desc[f] || f}`).join("\n");
  const genRange = getGenerationRange(args.year, args.make, args.model);
  return `Fill SPECIFIC missing data for: ${vehicleDesc}

MISSING FIELDS: ${list}

Search "${args.make} ${args.model} ${args.year} [part]" for each. If not found, try engine ${engineCode} in other ${args.make} models or ${genRange}.
Return null if unverified. null is better than wrong part number.

Return JSON: { "field_name": { "value": "..." | null, "confidence": 0.0-1.0, "source": "..." }, ... }`;
}

function flattenPerFieldSpecs(specs: Record<string, any>): {
  flat: Record<string, any>;
  confidences: Record<string, number>;
  nulls: string[];
} {
  const flat: Record<string, any> = {};
  const confidences: Record<string, number> = {};
  const nulls: string[] = [];
  for (const [field, data] of Object.entries(specs)) {
    if (data && typeof data === "object" && "value" in data) {
      flat[field] = (data as { value: any }).value;
      confidences[field] = (data as { confidence?: number }).confidence ?? 0;
      const v = (data as { value: any }).value;
      if (v === null || v === undefined || v === "" || v === "N/A") nulls.push(field);
    } else {
      flat[field] = data;
      confidences[field] = 0.70;
      if (data == null || data === "" || data === "N/A") nulls.push(field);
    }
  }
  return { flat, confidences, nulls };
}

const CROSS_REF_SAFE = new Set([
  "oil_filter_oem", "oil_drain_plug_gasket_oem", "engine_air_filter_oem",
  "spark_plug_oem", "spark_plug_quantity", "spark_plug_gap_mm", "serpentine_belt_oem",
]);

async function crossReferenceFromSiblings(
  ctx: { runQuery: (ref: any, args: any) => Promise<any> },
  engineCode: string,
  currentEngineId: string,
  missingFields: string[],
): Promise<Record<string, { value: any; confidence: number; source: string }>> {
  const found: Record<string, { value: any; confidence: number; source: string }> = {};
  const toCheck = missingFields.filter((f) => CROSS_REF_SAFE.has(f));
  if (toCheck.length === 0) return found;
  const siblings = await ctx.runQuery(internal.vehicle_mutations.getEnginesByCode, { engineCode });
  for (const sibling of siblings) {
    if (sibling._id === currentEngineId) continue;
    const specs = await ctx.runQuery(internal.vehicle_mutations.getVehicleSpecs, { engineId: sibling._id });
    if (!specs) continue;
    for (const field of toCheck) {
      if (found[field]) continue;
      const val = (specs as Record<string, any>)[field];
      if (val && val !== "N/A" && val !== "" && val !== 0) {
        found[field] = { value: val, confidence: 0.80, source: `cross_ref_engine_${sibling._id}` };
      }
    }
    if (toCheck.every((f) => found[f])) break;
  }
  return found;
}

function getGenerationRange(year: number, make: string, model: string): string {
  const gens: Record<string, [number, number][]> = {
    "Honda CR-V": [[2012, 2016], [2017, 2022], [2023, 2027]],
    "Honda Accord": [[2013, 2017], [2018, 2022], [2023, 2027]],
    "Honda Civic": [[2012, 2015], [2016, 2021], [2022, 2027]],
    "Toyota Camry": [[2012, 2017], [2018, 2024], [2025, 2027]],
    "Toyota RAV4": [[2013, 2018], [2019, 2025]],
    "BMW 3 Series": [[2012, 2018], [2019, 2027]],
    "BMW 5 Series": [[2011, 2016], [2017, 2023], [2024, 2027]],
  };
  const key = `${make} ${model}`;
  const list = gens[key];
  if (!list) return `${year - 2} to ${year + 2}`;
  const match = list.find(([a, b]) => year >= a && year <= b);
  return match ? `${match[0]}–${match[1]} ${make} ${model}` : `${year - 2} to ${year + 2}`;
}

// ---------------------------------------------------------------------------
// Part number validation (Layer 3)
// ---------------------------------------------------------------------------

/** OEM part number format patterns by make (relaxed — some OEMs vary). */
const PART_NUMBER_PATTERNS: Record<string, RegExp[]> = {
  Honda: [/^[A-Z0-9]{3,4}-[A-Z0-9]{3,6}-[A-Z0-9]{2,4}$/i, /^[0-9]{8}-[A-Z0-9]{3}$/i],
  Toyota: [/^[0-9]{5}-[0-9]{5}$/, /^[0-9]{10}$/, /^9[0-9]{9}$/],
  Nissan: [/^[0-9]{5}-[A-Z0-9]{2}[A-Z0-9]{2,4}$/i, /^[0-9]{10}$/],
  BMW: [/^[0-9]{2}\s[0-9]\s[0-9]\s[0-9]{3}\s[0-9]{3}$/, /^[0-9]{11}$/],
  Mercedes: [/^[A-Z]{3}[0-9]{8}$/i],
  Ford: [/^[A-Z0-9]{2}[A-Z0-9]{2}-[0-9]{4}[A-Z]$/i, /^[0-9]{4}[A-Z0-9]{4}$/i],
  Chevrolet: [/^[0-9]{8}$/, /^[0-9]{10}$/],
  Hyundai: [/^[0-9]{5}-[A-Z0-9]{5}$/i],
  Kia: [/^[0-9]{5}-[A-Z0-9]{5}$/i],
  Subaru: [/^[0-9]{5}-[A-Z0-9]{5}$/i],
  Mazda: [/^[A-Z0-9]{4}-[0-9]{2}-[0-9]{3}[A-Z]?$/i],
  Volkswagen: [/^[0-9]{3}\s[0-9]{3}\s[0-9]{3}[A-Z]?$/i, /^[0-9]{9}[A-Z]?$/i],
  Audi: [/^[0-9]{3}\s[0-9]{3}\s[0-9]{3}[A-Z]?$/i],
};

function validatePartNumberFormat(partNumber: string, make: string): boolean {
  const normalized = partNumber.trim();
  if (!normalized || normalized === "N/A") return true; // Skip empty
  if (normalized.length < 4 || normalized.length > 24) return false;

  const makeKey = make.trim();
  const patterns = PART_NUMBER_PATTERNS[makeKey];
  if (patterns) {
    return patterns.some((p) => p.test(normalized));
  }
  // Unknown make: accept alphanumeric with common separators (-, space)
  return /^[A-Z0-9\s\-\.]+$/i.test(normalized);
}

export type ValidateOEMPartResult =
  | { valid: true }
  | { valid: false; reason: string; flag?: "year_mismatch" | "format_invalid" };

/**
 * Validate an OEM part before saving.
 * - Check 1: Part already mapped to different model year (same model) = suspicious
 * - Check 2: OEM part number format validation (brand-specific patterns)
 */
async function validateOEMPart(
  ctx: { runQuery: (ref: any, args: any) => Promise<any> },
  partNumber: string,
  engineId: import("./_generated/dataModel").Id<"engines">,
  make: string,
): Promise<ValidateOEMPartResult> {
  const normalized = partNumber.trim();
  if (!normalized || normalized === "N/A") return { valid: true };

  const formatValid = validatePartNumberFormat(partNumber, make);
  if (!formatValid) {
    return { valid: false, reason: "Part number format invalid for make", flag: "format_invalid" };
  }

  const engineContext = await ctx.runQuery(internal.vehicle_mutations.getEngineWithTrimModel, { engineId });
  if (!engineContext?.trim || !engineContext?.model) return { valid: true }; // Can't validate, allow

  const currentYear = engineContext.trim.year_start; // Use trim year range
  const currentModel = engineContext.model.name;

  const existingFitments = await ctx.runQuery(internal.vehicle_mutations.getOtherEnginesWithPartNumber, {
    partNumber: normalized,
    excludeEngineId: engineId,
  });

  for (const fitment of existingFitments) {
    if (fitment.model_name === currentModel) {
      const otherYearRange = fitment.year_start;
      if (otherYearRange !== currentYear) {
        return {
          valid: false,
          reason: "Part already mapped to different model year",
          flag: "year_mismatch",
        };
      }
    }
  }

  return { valid: true };
}

/**
 * Extract a field from NHTSA DecodeVinValuesExtended response.
 * The endpoint returns Results as an array with a single flat object
 * where keys are field names (e.g. { Make: "HONDA", Model: "Civic", ... }).
 */
function getValue(nhtsaData: any, variable: string): string {
  const row = nhtsaData?.Results?.[0];
  if (!row) return "";
  const val = row[variable];
  return typeof val === "string" ? val.trim() : "";
}

/**
 * Extract JSON from Claude API response content blocks.
 *
 * When Claude uses web_search, the response contains mixed block types:
 *   - "text" blocks (conversational preamble + actual JSON)
 *   - "server_tool_use" blocks (search queries)
 *   - "web_search_tool_result" blocks (search results)
 *
 * This helper:
 *   1. Filters for "text" blocks only
 *   2. Concatenates their text
 *   3. Strips markdown fences
 *   4. Finds the outermost JSON object ({…}) or array ([…]) in the text
 *   5. Parses and returns it
 *
 * This is necessary because Claude often wraps JSON in conversational text
 * like "Based on the search results, here is the data:" before the actual JSON.
 */
function extractJsonFromContentBlocks(content: any[]): any {
  const textParts = content
    .filter((block: any) => block.type === "text")
    .map((block: any) => block.text)
    .join("\n");

  const stripped = textParts
    .replace(/```json\n?/g, "")
    .replace(/```\n?/g, "")
    .trim();

  // Try direct parse first (ideal case — response is pure JSON)
  try {
    return JSON.parse(stripped);
  } catch {
    // Fall through to bracket-matching extraction
  }

  // Find the outermost JSON structure (object or array) in the text.
  // Scan for the first '{' or '[' and find its matching closer.
  const startObj = stripped.indexOf("{");
  const startArr = stripped.indexOf("[");

  let startIdx: number;
  let openChar: string;
  let closeChar: string;

  if (startObj === -1 && startArr === -1) {
    throw new Error("No JSON object or array found in Claude response");
  } else if (startArr === -1 || (startObj !== -1 && startObj < startArr)) {
    startIdx = startObj;
    openChar = "{";
    closeChar = "}";
  } else {
    startIdx = startArr;
    openChar = "[";
    closeChar = "]";
  }

  // Walk forward counting braces/brackets, respecting strings
  let depth = 0;
  let inString = false;
  let escape = false;
  let endIdx = -1;

  for (let i = startIdx; i < stripped.length; i++) {
    const ch = stripped[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === "\\") {
      escape = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === openChar) depth++;
    if (ch === closeChar) depth--;

    if (depth === 0) {
      endIdx = i;
      break;
    }
  }

  if (endIdx === -1) {
    throw new Error("Unbalanced JSON structure in Claude response");
  }

  return JSON.parse(stripped.slice(startIdx, endIdx + 1));
}
