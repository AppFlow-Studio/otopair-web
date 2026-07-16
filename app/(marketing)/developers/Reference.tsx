"use client";

// Developers — endpoint "Reference": per-endpoint docs cards, authentication,
// error codes, and the data-layer legend. Static content, hand-written
// examples matching convex/dataApi.ts response shapes exactly.

import type { ReactNode } from "react";
import { LAYER_FORMULA } from "@/convex/lib/dataLayers";
import { CARD, MONO, PILL, TH, CopyButton, LayerChip, baseUrl } from "./shared";

type Param = { name: string; type: string; required: string; description: string };

const VEHICLE_PARAMS: Param[] = [
  {
    name: "vin",
    type: "string",
    required: "mode 1",
    description: "17-char VIN of a vehicle we've seen. The only mode that adds the history section.",
  },
  {
    name: "year",
    type: "number",
    required: "mode 2 (YMMT)",
    description: "Model year, e.g. 2015. Send together with make and model.",
  },
  {
    name: "make",
    type: "string",
    required: "mode 2 (YMMT)",
    description: "Make name — case-insensitive words, e.g. Hyundai.",
  },
  {
    name: "model",
    type: "string",
    required: "mode 2 (YMMT)",
    description: "Model name — case-insensitive words, e.g. Veloster.",
  },
  {
    name: "trim",
    type: "string",
    required: "mode 2 · optional",
    description: "Trim filter to narrow YMMT matches, e.g. Turbo.",
  },
  {
    name: "config_key",
    type: "string",
    required: "mode 3",
    description: "Canonical vehicle-config key — exact and unambiguous. 409 responses hand these back.",
  },
];

const MAINT_PARAMS: Param[] = [
  {
    name: "config_key",
    type: "string",
    required: "one of config_key / vin",
    description: "Canonical vehicle-config key (e.g. toyota|camry|2019|le|2.5l). Use the playground typeahead to find one.",
  },
  {
    name: "vin",
    type: "string",
    required: "one of config_key / vin",
    description: "17-char VIN of a vehicle we've seen; resolved to its config.",
  },
];

const LABOR_PARAMS: Param[] = [
  ...MAINT_PARAMS,
  {
    name: "service",
    type: "string",
    required: "optional",
    description: "Service slug filter (e.g. front-brake-pads). Omit to get every service with empirical data.",
  },
];

const ENRICH_PARAMS: Param[] = [
  {
    name: "vin",
    type: "string",
    required: "required",
    description:
      'POST body {"vin": "…"} — the 17-char VIN to enrich. The GET status poll takes ?vin= or ?config_key= instead.',
  },
];

const HISTORY_PARAMS: Param[] = [
  {
    name: "vin",
    type: "string",
    required: "required",
    description: "17-char VIN. Returns every sanitized service record we hold for it.",
  },
];

const ENRICH_EXAMPLE = `{
  "object": "enrichment",
  "status": "queued",
  "vin": "KMHTC6AE4FU123456",
  "poll": {
    "method": "GET",
    "url": "/v0/enrich?vin=KMHTC6AE4FU123456",
    "interval_seconds": 60,
    "note": "Enrichment typically completes in 7-40 minutes. Fetch the full payload via GET /v0/vehicle?vin=… once complete."
  }
}`;

const HISTORY_EXAMPLE = `{
  "object": "service_history",
  "vin": "KMHTC6AE4FU123456",
  "records": [
    {
      "date": "2026-05-02",
      "mileage": 88410,
      "source": "shop_visit",
      "confidence": "verified",
      "services": ["Oil change", "Front brake pads"],
      "parts": [
        { "name": "Front brake pad set", "oem_number": "58101-2VA10", "brand": "Hyundai", "quantity": 1 }
      ]
    },
    {
      "date": "2025-11-14",
      "mileage": 81200,
      "source": "document",
      "confidence": 0.92,
      "services": ["Oil change"],
      "parts": [{ "name": "Oil filter", "oem_number": null, "brand": "Mobil 1", "quantity": null }]
    },
    {
      "date": "2025-06-01",
      "mileage": 74000,
      "source": "owner_reported",
      "confidence": "self_reported",
      "services": ["tires"],
      "parts": []
    }
  ],
  "meta": {
    "record_count": 3,
    "sanitization": "No PII, costs, shop identity, or free-text notes are served. shop_visit records are shop-verified; owner_reported and document records carry their own confidence.",
    "generated_at": 1784050000000
  }
}`;

const MEDIA_EXAMPLE = `{
  "object": "vehicle_image",
  "config": {
    "config_key": "2021_toyota_camry_le_2_5l_4cyl_gas",
    "year": 2021, "make": "Toyota", "model": "Camry", "trim": "LE"
  },
  "image": {
    "url": "https://…/evox/…_3231303031.jpg",
    "media_source": "vehicle_databases",
    "licensing_note": "Rendered image sourced via the Vehicle Databases vehicle-images API. Self-hosted media (the licensed VD image set) replaces these URLs when it lands; the response shape will not change."
  },
  "meta": { "generated_at": 1784050000000 }
}`;

const VEHICLE_EXAMPLE = `{
  "object": "vehicle",
  "config": {
    "config_key": "2015_hyundai_veloster_turbo_1.6l",
    "year": 2015,
    "make": "Hyundai",
    "model": "Veloster",
    "trim": "Turbo",
    "chassis_code": "FS",
    "drivetrain": "FWD",
    "engine": {
      "label": "1.6L I4 Turbo GDI",
      "code": "G4FJ",
      "cylinders": 4,
      "displacement_l": 1.6,
      "aspiration": "turbo",
      "fuel_injection": "GDI"
    },
    "transmission": "6-speed manual",
    "enrichment": { "status": "enriched", "fill_rate": 0.86, "confidence_avg": 0.91 }
  },
  "specs": [
    {
      "field": "oil_capacity_qt",
      "label": "Oil capacity (qt)",
      "group": "engine",
      "value": "4.9",
      "layer": "A",
      "confidence": 0.97,
      "source_domain": "hyundai.com"
    },
    {
      "field": "oil_viscosity",
      "label": "Oil viscosity",
      "group": "engine",
      "value": "5W-30",
      "layer": "C",
      "confidence": 0.9,
      "source_domain": "veloster.org"
    }
  ],
  "excluded": [
    {
      "field": "coolant_capacity_qt",
      "label": "Coolant capacity (qt)",
      "blocking_layer": "B",
      "reason": "source_type \\"vehicle_databases\\" → structured DB"
    }
  ],
  "tires": {
    "options": [
      {
        "oem_name": "215/40R18",
        "size_front": "215/40R18",
        "size_rear": "215/40R18",
        "pressure_front_psi": 33,
        "pressure_rear_psi": 33,
        "is_oem_standard": true,
        "wheel_spec": "18x7.5J"
      }
    ],
    "front_size": "215/40R18",
    "rear_size": "215/40R18",
    "pressure_front_psi": 33,
    "pressure_rear_psi": 33,
    "is_staggered": false,
    "is_run_flat": false,
    "battery_cca": 550,
    "source": "oem_fitment"
  },
  "intervals": [
    {
      "service": "oil-change",
      "name": "Oil change",
      "interval_miles": 7500,
      "interval_months": 12,
      "display": "7,500 mi / 12 mo",
      "confidence": 0.95,
      "mechanic_verified": true
    }
  ],
  "services": [
    {
      "service": "front-brake-pads",
      "parts": [
        {
          "oem_part_number": "58101-2VA10",
          "name": "Front brake pad set",
          "subcategory": "brake_pads",
          "role": "primary",
          "position": "front",
          "quantity": 1,
          "mechanic_verified": true,
          "confidence": 0.93,
          "price": {
            "amount": 64.5,
            "msrp": 89.0,
            "source_domain": "hyundaiparts.com",
            "as_of": 1752403200000
          }
        }
      ],
      "labor": { "hours": 1.1, "source": "empirical", "confidence": 0.9, "sample_size": 9, "tier_floor_applied": false }
    }
  ],
  "history": {
    "passport": { "mileage": 88410, "last_shop_confirmed_at": 1750588800000, "brakes": null, "tires": null },
    "visits": [
      {
        "date": "2026-05-02",
        "status": "completed",
        "services": ["oil-change", "front-brake-pads"],
        "shop": "Otopair partner shop"
      }
    ]
  },
  "meta": {
    "gate": "A+C+D+E (OEM, web-derived, empirical, human-verified). B (licensed DB) and X (flagged) excluded and listed.",
    "layer_formula": "${LAYER_FORMULA}",
    "generated_at": 1752403200000
  }
}`;

const MAINT_EXAMPLE = `{
  "object": "maintenance_specs",
  "config": {
    "config_key": "toyota|camry|2019|le|2.5l",
    "year": 2019,
    "make": "Toyota",
    "model": "Camry",
    "trim": "LE",
    "engine": "2.5L A25A-FKS",
    "drivetrain": "FWD"
  },
  "fields": [
    {
      "field": "oil_capacity_qt",
      "label": "Oil capacity (qt)",
      "group": "engine",
      "value": "4.8",
      "layer": "A",
      "confidence": 0.97,
      "source_domain": "toyota.com"
    },
    {
      "field": "oil_viscosity",
      "label": "Oil viscosity",
      "group": "engine",
      "value": "0W-16",
      "layer": "C",
      "confidence": 0.88,
      "source_domain": "camryforums.com"
    }
  ],
  "excluded": [
    {
      "field": "cabin_air_filter_part",
      "label": "Cabin air filter part #",
      "blocking_layer": "B",
      "reason": "source_type \\"vehicle_databases\\" → structured DB"
    }
  ],
  "meta": {
    "gate": "A+C+D+E (OEM, web-derived, empirical, human-verified). B (licensed DB) and X (flagged) excluded and listed.",
    "layer_formula": "${LAYER_FORMULA}",
    "generated_at": 1752403200000
  }
}`;

const LABOR_EXAMPLE = `{
  "object": "empirical_labor",
  "config_key": "toyota|camry|2019|le|2.5l",
  "services": [
    {
      "service": "front-brake-pads",
      "name": "Front brake pads",
      "empirical_hours": 1.2,
      "sample_size": 14,
      "p25_hours": 1.0,
      "p75_hours": 1.4
    },
    {
      "service": "oil-change",
      "name": "Oil change",
      "empirical_hours": 0.4,
      "sample_size": 61,
      "p25_hours": 0.3,
      "p75_hours": 0.5
    }
  ],
  "estimates": [
    {
      "service": "front-brake-pads",
      "name": "Front brake pads",
      "estimated_hours": 1.2,
      "estimate_source": "empirical",
      "estimate_confidence": 0.9
    },
    {
      "service": "coolant-flush",
      "name": "Coolant flush",
      "estimated_hours": 1.1,
      "estimate_source": "model_estimate",
      "estimate_confidence": 0.3
    }
  ],
  "tier": "T1",
  "note": "services[] are empirical values measured from completed Otopair jobs. estimates[] blend empirical with our own Camry-anchored tier model (model_estimate). Licensed book-time blends are never served by this API."
}`;

const ERRORS: Array<{ status: string; code: string; meaning: string }> = [
  { status: "400", code: "missing_param", meaning: "No usable identifier was provided (config_key / vin — or year+make+model on /v0/vehicle)." },
  { status: "400", code: "vin_decode_failed", meaning: "POST /v0/enrich: the VIN did not decode against Vehicle Databases or NHTSA." },
  { status: "401", code: "missing / invalid / revoked key", meaning: "No Authorization header, the key doesn't exist, or it has been revoked." },
  { status: "403", code: "insufficient_scope", meaning: "The key is valid but lacks the endpoint's scope (maintenance:read / labor:read / media:read / service_history:read / enrich:write)." },
  { status: "404", code: "not_found", meaning: "No vehicle config matched the given config_key or VIN." },
  { status: "409", code: "multiple_matches", meaning: "A /v0/vehicle YMMT lookup matched more than one config — the body lists matches: [{config_key, label}]; re-send with one of those config_keys." },
  { status: "422", code: "unsupported_vehicle", meaning: "POST /v0/enrich: the VIN decoded but no engine code resolved — the pipeline can't enrich it." },
  { status: "429", code: "rate_limited", meaning: "Per-key per-minute rate limit exceeded. Back off and retry." },
  { status: "429", code: "quota_exceeded", meaning: "POST /v0/enrich: the key's daily quota of scheduled enrichment runs is spent. Cache hits stay free." },
];

function EndpointCard({
  path,
  description,
  params,
  example,
  exampleQuery,
  footnote,
  method = "GET",
  exampleBody,
}: {
  path: string;
  description: string;
  params: Param[];
  example: string;
  exampleQuery: string;
  footnote?: ReactNode;
  method?: "GET" | "POST";
  exampleBody?: string;
}) {
  const curl =
    method === "POST"
      ? `curl -X POST '${baseUrl()}${path}' \\\n  -H 'Authorization: Bearer otp_live_…' \\\n  -H 'Content-Type: application/json' \\\n  -d '${exampleBody ?? "{}"}'`
      : `curl '${baseUrl()}${path}?${exampleQuery}' \\\n  -H 'Authorization: Bearer otp_live_…'`;
  return (
    <div className={CARD}>
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`${PILL} ${method === "POST" ? "bg-sky-50 text-sky-700" : "bg-emerald-50 text-emerald-700"}`}
        >
          {method}
        </span>
        <code className={`${MONO} font-semibold text-slate-900`}>{path}</code>
      </div>
      <p className="mt-2 text-[13px] leading-5 text-slate-600">{description}</p>

      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className={TH}>
              <th className="pb-2 pr-4">Param</th>
              <th className="pb-2 pr-4">Type</th>
              <th className="pb-2 pr-4">Required</th>
              <th className="pb-2">Description</th>
            </tr>
          </thead>
          <tbody>
            {params.map((p) => (
              <tr key={p.name} className="border-b border-slate-50 last:border-0 align-top">
                <td className={`py-2 pr-4 ${MONO} text-slate-900`}>{p.name}</td>
                <td className="py-2 pr-4 text-slate-500">{p.type}</td>
                <td className="py-2 pr-4 text-slate-500">{p.required}</td>
                <td className="py-2 text-slate-600">{p.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {footnote && (
        <div className="mt-3 rounded-lg border border-amber-100 bg-amber-50/60 px-3 py-2 text-[12px] leading-4 text-amber-800">
          {footnote}
        </div>
      )}

      <div className="mt-4">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold text-slate-500">Example request</span>
          <CopyButton text={curl} label="Copy cURL" />
        </div>
        <pre className={`mt-1 overflow-x-auto rounded-lg bg-slate-900 p-3 ${MONO} leading-5 text-slate-100`}>
          {curl}
        </pre>
      </div>

      <details className="mt-3">
        <summary className="cursor-pointer text-[11px] font-semibold text-slate-500 hover:text-slate-700">
          Example 200 response
        </summary>
        <pre className={`mt-2 max-h-96 overflow-auto rounded-lg bg-slate-900 p-3 ${MONO} leading-5 text-emerald-200`}>
          {example}
        </pre>
      </details>
    </div>
  );
}

export function Reference() {
  return (
    <div className="space-y-4">
      <EndpointCard
        path="/v0/vehicle"
        description="The flagship endpoint — everything we hold on one vehicle in a single response: identity + engine config, layer-gated specs (served and excluded), OEM tire fitment, service intervals, priced OEM parts with empirical labor per service, and (for VIN lookups) the vehicle's service history. Identify the vehicle one of three ways: VIN, year + make + model [+ trim], or an exact config_key. Requires the maintenance:read scope."
        params={VEHICLE_PARAMS}
        example={VEHICLE_EXAMPLE}
        exampleQuery="year=2015&make=Hyundai&model=Veloster"
        footnote={
          <>
            <strong>409 disambiguation</strong> — if year+make+model matches more than one config, the
            response is <code className={MONO}>409 {"{"}&quot;error&quot;: &quot;multiple_matches&quot;, &quot;matches&quot;: [{"{"}config_key, label{"}"}]{"}"}</code>;
            re-send using one of the returned config_keys (the playground makes them clickable).
            The <code className={MONO}>history</code> section is returned <strong>only for VIN lookups</strong> (null
            otherwise) and contains no customer identity and no dollar amounts — dates, statuses, service slugs and
            shop names only.
          </>
        }
      />

      <div className="grid gap-4 xl:grid-cols-2">
        <EndpointCard
          path="/v0/maintenance"
          description="Layer-gated maintenance specs for one vehicle config: fluid capacities, filter parts, service intervals and more. Every served field carries its data layer, confidence and source domain; everything the gate excluded is listed alongside with the blocking layer — the gate is visible, not silent."
          params={MAINT_PARAMS}
          example={MAINT_EXAMPLE}
          exampleQuery="config_key=toyota%7Ccamry%7C2019%7Cle%7C2.5l"
        />
        <EndpointCard
          path="/v0/labor"
          description="Labor times per service. services[] holds empirical measurements from completed Otopair jobs — hours, sample size, and the p25–p75 spread. estimates[] adds an estimated_hours answer for every applicable service, sourced either from those measurements ('empirical') or from our own Camry-anchored vehicle-tier model ('model_estimate', with its confidence). Book-time blends (RepairPal / MOTOR / VDB) are internal-only and never served."
          params={LABOR_PARAMS}
          example={LABOR_EXAMPLE}
          exampleQuery="config_key=toyota%7Ccamry%7C2019%7Cle%7C2.5l&service=front-brake-pads"
        />
      </div>

      <EndpointCard
        path="/v0/vehicle-image"
        description="Vehicle media: the exterior render for a config, identified by VIN, year + make + model [+ trim], or config_key. Requires the media:read scope. Cache-first; on a cache miss the API fetches the render live (expect ~6s on that first call) and caches it, so the next lookup is instant. media_source is 'vehicle_databases' today (EVOX renders via the VD vehicle-images API); the licensed VD image folder is inbound, after which the URLs flip to self-hosted media without a response-shape change."
        params={VEHICLE_PARAMS}
        example={MEDIA_EXAMPLE}
        exampleQuery="year=2021&make=Toyota&model=Camry&trim=LE"
        footnote={
          <>
            <strong>Live-fetch cap</strong> — cached lookups are unlimited, but each key gets 10 live
            fetches per day (a live fetch is a paid upstream call). Over the cap, uncached vehicles
            return <code className={MONO}>404 no_image</code> with a cap note until the day rolls over.
          </>
        }
      />

      <div className="grid gap-4 xl:grid-cols-2">
        <EndpointCard
          path="/v0/service-history"
          description="Sanitized service records for a VIN — Carfax-style. Unions three streams: completed Otopair shop visits (verified; dates, mileage, services, parts installed), the owner's self-reported maintenance records, and accepted extractions of uploaded service documents. Requires the service_history:read scope."
          params={HISTORY_PARAMS}
          example={HISTORY_EXAMPLE}
          exampleQuery="vin=KMHTC6AE4FU123456"
          footnote={
            <>
              <strong>Sanitized by contract</strong> — no PII, no dollar amounts, no shop identity, no
              free-text notes. Ever. 404 only when the VIN is entirely unknown; a known VIN with no
              records returns 200 with an empty <code className={MONO}>records</code> array.
            </>
          }
        />
        <EndpointCard
          path="/v0/enrich"
          method="POST"
          description="Enrichment on demand: POST a VIN we haven't seen (or whose data has gone stale) and the full enrichment pipeline runs for it — VIN decode, spec research, parts, intervals, labor. Fresh cache hits return 200 immediately and cost nothing. A scheduled run returns 202; poll GET /v0/enrich?vin=… (free) until status is 'complete', then fetch the payload via /v0/vehicle. Requires the enrich:write scope."
          params={ENRICH_PARAMS}
          example={ENRICH_EXAMPLE}
          exampleQuery="vin=KMHTC6AE4FU123456"
          exampleBody='{"vin": "KMHTC6AE4FU123456"}'
          footnote={
            <>
              <strong>Not on free keys</strong> — enrichment runs cost real compute, so{" "}
              <code className={MONO}>enrich:write</code> is granted separately (contact us). Each key
              gets 5 scheduled runs per day; cache hits and status polls are free and unlimited.
            </>
          }
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        {/* Authentication */}
        <div className={CARD}>
          <h3 className="text-sm font-semibold text-slate-900">Authentication</h3>
          <p className="mt-2 text-[13px] leading-5 text-slate-600">
            Send your key on every request, either as a Bearer token or in an{" "}
            <code className={MONO}>x-api-key</code> header:
          </p>
          <pre className={`mt-3 overflow-x-auto rounded-lg bg-slate-900 p-3 ${MONO} leading-5 text-slate-100`}>
            {"Authorization: Bearer otp_live_4f2a9c…\n# or\nx-api-key: otp_live_4f2a9c…"}
          </pre>
          <ul className="mt-3 space-y-1.5 text-[13px] text-slate-600">
            <li>
              • Keys look like <code className={MONO}>otp_live_</code> + 48 hex chars.
            </li>
            <li>
              • The plaintext is shown <strong>exactly once</strong> at mint time — only its SHA-256
              hash is stored, so it cannot be recovered later. Lose it → rotate.
            </li>
            <li>
              • Each key has scopes and its own per-minute rate limit. Free dev keys carry
              maintenance:read, labor:read, media:read and service_history:read; enrich:write is
              granted separately.
            </li>
          </ul>
        </div>

        {/* Errors */}
        <div className={CARD}>
          <h3 className="text-sm font-semibold text-slate-900">Errors</h3>
          <p className="mt-2 text-[13px] text-slate-600">
            Errors are JSON: <code className={MONO}>{'{"error": "<code>", "message": "…"}'}</code>
          </p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className={TH}>
                  <th className="pb-2 pr-4">Status</th>
                  <th className="pb-2 pr-4">Code</th>
                  <th className="pb-2">Meaning</th>
                </tr>
              </thead>
              <tbody>
                {ERRORS.map((e) => (
                  <tr key={e.status + e.code} className="border-b border-slate-50 last:border-0 align-top">
                    <td className="py-2 pr-4">
                      <span className={`${PILL} bg-red-50 text-red-700`}>{e.status}</span>
                    </td>
                    <td className={`py-2 pr-4 ${MONO} text-slate-700`}>{e.code}</td>
                    <td className="py-2 text-slate-600">{e.meaning}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Data layers legend */}
      <div className={CARD}>
        <h3 className="text-sm font-semibold text-slate-900">Data layers</h3>
        <p className="mt-2 text-[13px] leading-5 text-slate-600">
          Every value in the catalog carries a provenance layer. The API serves{" "}
          <strong>A + C + D + E</strong>; B and X are excluded from responses — and every exclusion
          is listed per response with its blocking layer.
        </p>
        <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {(
            [
              ["A", "OEM / official — owner's manuals and manufacturer data.", true],
              ["B", "Structured DB — licensed Vehicle Databases rows, internal-use only.", false],
              ["C", "Web-derived — our own web-search / scraping enrichment. The product.", true],
              ["D", "Empirical — measured from completed Otopair jobs.", true],
              ["E", "Human-verified — mechanic / director confirmed.", true],
              ["X", "Flagged — anomalies or confidence < 0.4. Never leaves the building.", false],
            ] as const
          ).map(([letter, desc, served]) => (
            <div key={letter} className="flex items-start gap-2 rounded-lg border border-slate-100 px-3 py-2">
              <LayerChip letter={letter} />
              <div className="min-w-0">
                <span
                  className={`${PILL} ${served ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}
                >
                  {served ? "served" : "excluded"}
                </span>
                <p className="mt-1 text-[12px] leading-4 text-slate-600">{desc}</p>
              </div>
            </div>
          ))}
        </div>
        <p className={`mt-3 ${MONO} text-slate-400`}>derivation: {LAYER_FORMULA}</p>
      </div>
    </div>
  );
}
