"use client";

// Data · Passport detail — /data/vehicle-id/:vin (Data spec §10.2).
// Layer 1: slate lock card, AI-enriched identity, ZERO edit affordances by
// construction (the backing module exposes no passport writes). Layer 2:
// white "living" card — shop truth per section with last-shop-touch chips and
// the hierarchy ladder as a static diagram (no per-field provenance is
// stored; honest descope). Below: recent multi-point inspections.

import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { usePortalSession } from "@/app/(portals)/portal-session";

const pill = "inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold";
const fmtDate = (ms: number | null) => (ms == null ? "—" : new Date(ms).toLocaleDateString());

type Tires = {
  brand?: string | null;
  model?: string | null;
  size_front?: string | null;
  size_rear?: string | null;
  run_flat?: boolean | null;
  overall_condition?: string | null;
  front_condition?: string | null;
  rear_condition?: string | null;
  tread_depths?: Record<string, { reported_min_32nds?: number | null } | undefined> | null;
  last_verified_at?: number | null;
} | null;
type Fluids = {
  oil_viscosity?: string | null;
  oil_capacity_qts?: number | null;
  oil_type?: string | null;
  coolant_type?: string | null;
  brake_fluid_type?: string | null;
  transmission_fluid_type?: string | null;
  confirmation_status?: string | null;
} | null;
type Brakes = {
  pad_brand?: string | null;
  front_pad_mm?: number | null;
  rear_pad_mm?: number | null;
  rotor_condition?: string | null;
  rotor_thickness?: Record<
    string,
    { entered_value: number; entered_unit: string; normalized_um: number } | undefined
  > | null;
} | null;
type Inspection = {
  looks_current?: boolean | null;
  expires_at?: string | null;
  status?: string | null;
} | null;
type Mods = { has_mods?: boolean; notes?: string | null; affected_systems?: string[] } | null;

const CORNERS = ["front_left", "front_right", "rear_left", "rear_right"] as const;
const cornerLabel: Record<(typeof CORNERS)[number], string> = {
  front_left: "FL",
  front_right: "FR",
  rear_left: "RL",
  rear_right: "RR",
};

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 border-b border-slate-100/70 py-1.5 text-[13px] last:border-0">
      <span className="w-40 shrink-0 text-slate-500">{label}</span>
      <span className="font-medium text-slate-800">{value ?? "—"}</span>
    </div>
  );
}

function HierarchyLadder({ order }: { order: string[] }) {
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-slate-400">
      {order.map((step, i) => (
        <span key={step} className="inline-flex items-center gap-1">
          {i > 0 && <span>&gt;</span>}
          <span className={i === 0 ? "text-emerald-600" : ""}>{step}</span>
        </span>
      ))}
    </span>
  );
}

export default function PassportDetailPage() {
  const { token } = usePortalSession();
  const params = useParams<{ vin: string }>();
  const vin = decodeURIComponent(params.vin ?? "");

  const detail = useQuery(api.dataPassports.passportDetail, { token, vin });

  if (detail === undefined) {
    return (
      <div className="space-y-3">
        <div className="h-8 w-72 animate-pulse rounded-lg bg-slate-100" />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="h-72 animate-pulse rounded-xl bg-slate-100" />
          <div className="h-72 animate-pulse rounded-xl bg-slate-100" />
        </div>
      </div>
    );
  }
  if (detail === null) {
    return (
      <div className="rounded-xl border border-red-200 bg-white p-6 text-sm text-red-700">
        No passport exists for VIN <span className="font-mono">{vin}</span>.{" "}
        <Link href="/director/data/vehicle-id" className="font-medium text-blue-600 hover:underline">
          Back to passports
        </Link>
        .
      </div>
    );
  }

  const tires = detail.layer2.tires as Tires;
  const fluids = detail.layer2.fluids as Fluids;
  const brakes = detail.layer2.brakes as Brakes;
  const inspection = detail.layer2.inspection as Inspection;
  const mods = detail.layer2.modifications as Mods;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-mono text-xl font-semibold text-slate-900">{detail.vin}</h1>
        {detail.layer1.config && (
          <Link
            href={`/director/data/catalog/${detail.layer1.config.id}`}
            className={`${pill} bg-blue-50 text-blue-700 hover:bg-blue-100`}
          >
            {detail.layer1.config.config_key} →
          </Link>
        )}
        <Link
          href={`/director/data/vins/${detail.vin}`}
          className={`${pill} bg-slate-100 text-slate-600 hover:bg-slate-200`}
        >
          VIN Explorer →
        </Link>
        {detail.missing_required.length > 0 && (
          <span className={`${pill} bg-amber-50 text-amber-700`}>
            missing required: {detail.missing_required.join(", ")}
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Layer 1 — static, read-only BY CONSTRUCTION */}
        <div className="rounded-xl border border-slate-300 bg-[#F8FAFC] p-5">
          <div className="flex items-center gap-2">
            <span className="text-base">🔒</span>
            <h2 className="text-sm font-semibold text-slate-900">
              Layer 1 — Static · AI-enriched
            </h2>
          </div>
          <p className="mt-1 text-[12px] text-slate-500">
            Shops cannot edit this layer (Apr 18 p.m. — protects against mechanic error).
            Edit affordances don&apos;t exist here by construction.
          </p>
          <div className="mt-3">
            <Row label="VIN" value={<span className="font-mono">{detail.vin}</span>} />
            <Row label="Year" value={detail.layer1.year} />
            <Row label="Make" value={detail.layer1.make} />
            <Row label="Model" value={detail.layer1.model} />
            <Row label="Trim" value={detail.layer1.trim} />
            <Row label="Engine" value={detail.layer1.engine} />
            <Row label="Drivetrain" value={detail.layer1.drivetrain} />
          </div>
        </div>

        {/* Layer 2 — living shop truth */}
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="text-sm font-semibold text-slate-900">Layer 2 — Living · shop truth</h2>
          <p className="mt-1 text-[12px] text-slate-500">
            First shop touch {fmtDate(detail.layer2.first_shop_confirmed_at)} · last{" "}
            {fmtDate(detail.layer2.last_shop_confirmed_at)}. Per-field setter/history isn&apos;t
            stored yet — chips are per section; the ×2–3 consistency override renders as an
            event once per-field history exists.
          </p>

          <div className="mt-3 space-y-4">
            {/* Mileage */}
            <section>
              <div className="flex items-center gap-2">
                <h3 className="text-[12px] font-bold uppercase tracking-wide text-slate-400">
                  Mileage
                </h3>
                <HierarchyLadder order={["shop", "user", "AI"]} />
              </div>
              <Row
                label="Odometer"
                value={
                  detail.layer2.mileage != null
                    ? `${detail.layer2.mileage.toLocaleString("en-US")} mi`
                    : "—"
                }
              />
              {detail.layer2.mileage_velocity != null && (
                <Row
                  label="Velocity"
                  value={`~${Math.round(detail.layer2.mileage_velocity)} mi/day`}
                />
              )}
            </section>

            {/* Tires */}
            <section>
              <div className="flex items-center gap-2">
                <h3 className="text-[12px] font-bold uppercase tracking-wide text-slate-400">
                  Tires
                </h3>
                <HierarchyLadder order={["shop", "AI", "user"]} />
                {tires?.last_verified_at != null && (
                  <span className={`${pill} bg-emerald-50 text-emerald-700`}>
                    verified {fmtDate(tires.last_verified_at)}
                  </span>
                )}
              </div>
              {tires == null ? (
                <p className="py-1.5 text-[13px] text-slate-400">no shop data yet</p>
              ) : (
                <>
                  <Row
                    label="Brand / model"
                    value={[tires.brand, tires.model].filter(Boolean).join(" ") || "—"}
                  />
                  <Row
                    label="Size"
                    value={
                      tires.size_front
                        ? `${tires.size_front}${tires.size_rear && tires.size_rear !== tires.size_front ? ` / R ${tires.size_rear}` : ""}`
                        : "—"
                    }
                  />
                  <Row label="Condition" value={tires.overall_condition ?? "—"} />
                  {tires.tread_depths && (
                    <div className="mt-1.5">
                      <span className="text-[12px] text-slate-500">Tread (32nds, per corner)</span>
                      <div className="mt-1 grid w-40 grid-cols-2 gap-1">
                        {CORNERS.map((c) => {
                          const depth = tires.tread_depths?.[c]?.reported_min_32nds;
                          return (
                            <div
                              key={c}
                              className="rounded-md border border-slate-200 px-2 py-1 text-center text-[11px]"
                            >
                              <span className="text-slate-400">{cornerLabel[c]}</span>{" "}
                              <span className="font-semibold text-slate-800">
                                {depth != null ? `${depth}/32` : "—"}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </>
              )}
            </section>

            {/* Fluids */}
            <section>
              <div className="flex items-center gap-2">
                <h3 className="text-[12px] font-bold uppercase tracking-wide text-slate-400">
                  Fluids
                </h3>
                <HierarchyLadder order={["shop", "AI", "user"]} />
                {fluids?.confirmation_status && (
                  <span className={`${pill} bg-slate-100 text-slate-600`}>
                    {fluids.confirmation_status}
                  </span>
                )}
              </div>
              {fluids == null ? (
                <p className="py-1.5 text-[13px] text-slate-400">no shop data yet</p>
              ) : (
                <>
                  <Row
                    label="Oil"
                    value={
                      [fluids.oil_viscosity, fluids.oil_type].filter(Boolean).join(" · ") || "—"
                    }
                  />
                  <Row
                    label="Oil capacity"
                    value={fluids.oil_capacity_qts != null ? `${fluids.oil_capacity_qts} qt` : "—"}
                  />
                  <Row label="Coolant" value={fluids.coolant_type ?? "—"} />
                  <Row label="Brake fluid" value={fluids.brake_fluid_type ?? "—"} />
                  <Row label="Trans fluid" value={fluids.transmission_fluid_type ?? "—"} />
                </>
              )}
            </section>

            {/* Brakes */}
            <section>
              <div className="flex items-center gap-2">
                <h3 className="text-[12px] font-bold uppercase tracking-wide text-slate-400">
                  Brakes
                </h3>
                <HierarchyLadder order={["shop", "AI", "user"]} />
              </div>
              {brakes == null ? (
                <p className="py-1.5 text-[13px] text-slate-400">no shop data yet</p>
              ) : (
                <>
                  <Row label="Pad brand" value={brakes.pad_brand ?? "—"} />
                  <Row
                    label="Pad thickness"
                    value={
                      brakes.front_pad_mm != null || brakes.rear_pad_mm != null
                        ? `F ${brakes.front_pad_mm ?? "—"}mm · R ${brakes.rear_pad_mm ?? "—"}mm`
                        : "—"
                    }
                  />
                  <Row label="Rotor condition" value={brakes.rotor_condition ?? "—"} />
                  {brakes.rotor_thickness && (
                    <div className="mt-1.5">
                      <span className="text-[12px] text-slate-500">
                        Rotor thickness (normalized µm)
                      </span>
                      <div className="mt-1 grid w-56 grid-cols-2 gap-1">
                        {CORNERS.map((c) => {
                          const r = brakes.rotor_thickness?.[c];
                          return (
                            <div
                              key={c}
                              className="rounded-md border border-slate-200 px-2 py-1 text-center text-[11px]"
                            >
                              <span className="text-slate-400">{cornerLabel[c]}</span>{" "}
                              <span className="font-semibold text-slate-800">
                                {r
                                  ? `${r.entered_value}${r.entered_unit} (${Math.round(r.normalized_um)}µm)`
                                  : "—"}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </>
              )}
            </section>

            {/* Inspection + Mods */}
            <section>
              <div className="flex items-center gap-2">
                <h3 className="text-[12px] font-bold uppercase tracking-wide text-slate-400">
                  Inspection & Mods
                </h3>
                <HierarchyLadder order={["shop", "user", "AI"]} />
              </div>
              <Row
                label="State inspection"
                value={
                  inspection?.status ??
                  (inspection?.looks_current != null
                    ? inspection.looks_current
                      ? "looks current"
                      : "not current"
                    : "—")
                }
              />
              <Row
                label="Modifications"
                value={
                  mods == null
                    ? "—"
                    : mods.has_mods
                      ? `yes${mods.affected_systems?.length ? ` (${mods.affected_systems.join(", ")})` : ""}${mods.notes ? ` — ${mods.notes}` : ""}`
                      : "none reported"
                }
              />
            </section>
          </div>
        </div>
      </div>

      {/* Inspections */}
      <div className="rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-slate-900">
          Multi-point inspections{" "}
          <span className="font-normal text-slate-400">(Jun 19 instrumentation)</span>
        </h2>
        {detail.inspections.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">No inspections recorded for this VIN.</p>
        ) : (
          <div className="mt-3 space-y-2">
            {detail.inspections.map(
              (i: {
                id: string;
                template_version: string;
                zones_done: number;
                zones_total: number;
                attention: { label: string; zone: string }[];
                monitor: { label: string; zone: string }[];
                at: number;
              }) => (
                <div key={i.id} className="rounded-lg border border-slate-100 px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2 text-[13px]">
                    <span className="font-medium text-slate-800">
                      {i.zones_done}/{i.zones_total} zones
                    </span>
                    <span className={`${pill} bg-slate-100 text-slate-500`}>
                      template {i.template_version}
                    </span>
                    <span className="ml-auto text-[12px] text-slate-400">{fmtDate(i.at)}</span>
                  </div>
                  {(i.attention.length > 0 || i.monitor.length > 0) && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {i.attention.map((f, idx) => (
                        <span key={idx} className={`${pill} bg-red-50 text-red-700`}>
                          ⚠ {f.label} ({f.zone})
                        </span>
                      ))}
                      {i.monitor.map((f, idx) => (
                        <span key={idx} className={`${pill} bg-amber-50 text-amber-700`}>
                          👁 {f.label} ({f.zone})
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ),
            )}
          </div>
        )}
      </div>
    </div>
  );
}
