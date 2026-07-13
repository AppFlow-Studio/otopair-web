"use client";

// Data · API console — "Reference" section: per-endpoint docs cards,
// authentication, error codes, and the data-layer legend. Static content,
// hand-written examples matching convex/dataApi.ts response shapes exactly.

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
  "note": "Empirical values only — measured from completed Otopair jobs. Book-time blends are not served by this API."
}`;

const ERRORS: Array<{ status: string; code: string; meaning: string }> = [
  { status: "400", code: "missing_param", meaning: "No usable identifier was provided (config_key / vin — or year+make+model on /v0/vehicle)." },
  { status: "401", code: "missing / invalid / revoked key", meaning: "No Authorization header, the key doesn't exist, or it has been revoked." },
  { status: "403", code: "insufficient_scope", meaning: "The key is valid but lacks the endpoint's scope (maintenance:read / labor:read)." },
  { status: "404", code: "not_found", meaning: "No vehicle config matched the given config_key or VIN." },
  { status: "409", code: "multiple_matches", meaning: "A /v0/vehicle YMMT lookup matched more than one config — the body lists matches: [{config_key, label}]; re-send with one of those config_keys." },
  { status: "429", code: "rate_limited", meaning: "Per-key per-minute rate limit exceeded. Back off and retry." },
];

function EndpointCard({
  path,
  description,
  params,
  example,
  exampleQuery,
  footnote,
}: {
  path: string;
  description: string;
  params: Param[];
  example: string;
  exampleQuery: string;
  footnote?: ReactNode;
}) {
  const curl = `curl '${baseUrl()}${path}?${exampleQuery}' \\\n  -H 'Authorization: Bearer otp_live_…'`;
  return (
    <div className={CARD}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`${PILL} bg-emerald-50 text-emerald-700`}>GET</span>
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
          description="Empirical labor times measured from completed Otopair jobs — hours, sample size, and the p25–p75 spread per service. Book-time blends (RepairPal / MOTOR / VDB) are internal-only and never served."
          params={LABOR_PARAMS}
          example={LABOR_EXAMPLE}
          exampleQuery="config_key=toyota%7Ccamry%7C2019%7Cle%7C2.5l&service=front-brake-pads"
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
            <li>• Each key has scopes (maintenance:read, labor:read) and its own per-minute rate limit.</li>
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
