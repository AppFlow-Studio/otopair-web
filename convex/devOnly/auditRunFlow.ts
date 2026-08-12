/**
 * devOnly/auditRunFlow.ts — one read-only call that reconstructs everything a
 * single enrichment produced, so a live run can be audited end to end without
 * hand-writing twenty queries.
 *
 * Built for the post-change validation runs of 2026-07-30. A great deal moved
 * that day (structured outputs, new web tools, prompt caching, the P0.1 routing
 * fixes, rotor persistence, sibling inheritance, NHTSA/EPA joins), and the only
 * honest way to confirm any of it is to look at what a real VIN produced.
 *
 * Read-only by construction: this file contains queries and nothing else.
 *
 *   npx convex run devOnly/auditRunFlow:auditByVin '{"vin":"..."}'
 *   npx convex run devOnly/auditRunFlow:auditByConfig '{"configId":"..."}'
 */

import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
// The SAME deterministic reconciler the pipeline uses, so the audit can never
// report a different verdict than the one the data was written under.
import { reconcileClaims } from "../vehicleEnrichment/sourceAdapters/claimLedger";

/** Tag-prefix tally over the run's mixed errors[] channel. */
function tallyTags(errors: string[] | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of errors ?? []) {
    const tag = String(e).split(":")[0].trim();
    out[tag] = (out[tag] ?? 0) + 1;
  }
  return out;
}

function pct(n: number, d: number): string {
  return d === 0 ? "n/a" : `${Math.round((n / d) * 100)}%`;
}

async function buildAudit(ctx: any, configId: Id<"vehicle_configs">) {
  const cfg: any = await ctx.db.get(configId);
  if (!cfg) return { error: "config_not_found", configId };

  const [make, model, engine, trans] = await Promise.all([
    cfg.make_id ? ctx.db.get(cfg.make_id) : null,
    cfg.model_id ? ctx.db.get(cfg.model_id) : null,
    cfg.engine_id ? ctx.db.get(cfg.engine_id) : null,
    cfg.transmission_id ? ctx.db.get(cfg.transmission_id) : null,
  ]);

  // ── The run ──────────────────────────────────────────────────────────────
  const runs = await ctx.db
    .query("enrichment_runs")
    .withIndex("by_vehicle_config", (q: any) => q.eq("vehicle_config_id", configId))
    .collect()
    .catch(async () => {
      // index name differs across branches; fall back to a scan of recent runs
      const all = await ctx.db.query("enrichment_runs").order("desc").take(200);
      return all.filter((r: any) => r.vehicle_config_id === configId);
    });
  const run: any = [...runs].sort(
    (a: any, b: any) => (b.created_at ?? b._creationTime) - (a.created_at ?? a._creationTime),
  )[0];

  // ── Parts triangle: fitment ⇒ verified ⇒ trusted price ────────────────────
  const fitments = await ctx.db
    .query("part_fitments")
    .withIndex("by_vehicle_config", (q: any) => q.eq("vehicle_config_id", configId))
    .collect();

  const POISON = new Set(["online_discount", "you_save", "unverified"]);
  const parts: any[] = [];
  for (const f of fitments) {
    const p: any = await ctx.db.get(f.part_id);
    const prices = await ctx.db
      .query("part_prices")
      .withIndex("by_part", (q: any) => q.eq("part_id", f.part_id))
      .collect();
    const trusted = prices.filter((r: any) => !POISON.has(r.price_type));
    parts.push({
      role: p?.subcategory ?? p?.category ?? null,
      service: f.service_type,
      service_role: f.service_role ?? null,
      oem: p?.oem_part_number ?? null,
      scraped_name: p?.scraped_name ?? null, // component-identity evidence (R12)
      confidence: f.confidence ?? null,
      source_count: f.source_count ?? null,
      source_domains: f.source_domains ?? null,
      refute_flagged: f.refute_flagged ?? false,
      mechanic_verified: f.mechanic_verified ?? false,
      data_quality: f.data_quality ?? p?.data_quality ?? null,
      price_rows: prices.length,
      trusted_price_rows: trusted.length,
      best_price: trusted.length ? Math.min(...trusted.map((r: any) => r.price)) : null,
      price_domains: [...new Set(trusted.map((r: any) => r.source_domain))],
      // The triangle: any false leg means the role cannot be quoted honestly.
      triangle_ok: !!p?.oem_part_number && trusted.length > 0 && !f.refute_flagged,
    });
  }
  parts.sort((a, b) => String(a.role).localeCompare(String(b.role)));

  // ── Intervals + provenance ───────────────────────────────────────────────
  const intervals = await ctx.db
    .query("service_intervals")
    .withIndex("by_vehicle_config", (q: any) => q.eq("vehicle_config_id", configId))
    .collect();
  const intervalRows: any[] = [];
  for (const i of intervals) {
    const svc: any = i.service_id ? await ctx.db.get(i.service_id) : null;
    intervalRows.push({
      service: svc?.slug ?? String(i.service_id),
      bookable: svc?.is_bookable !== false,
      miles: i.interval_miles ?? null,
      months: i.interval_months ?? null,
      status: i.status ?? null,
      provenance: i.data_quality ?? null,
    });
  }
  intervalRows.sort((a, b) => String(a.service).localeCompare(String(b.service)));

  // ── Labor ────────────────────────────────────────────────────────────────
  const labor = await ctx.db
    .query("labor_times")
    .withIndex("by_vehicle_config", (q: any) => q.eq("vehicle_config_id", configId))
    .collect()
    .catch(() => [] as any[]);
  const laborRows: any[] = [];
  for (const l of labor) {
    const svc: any = l.service_id ? await ctx.db.get(l.service_id) : null;
    laborRows.push({
      service: svc?.slug ?? String(l.service_id),
      hours: l.book_hours ?? null,
      source: l.source ?? null,
    });
  }

  // ── The new joins (P0.5 / P0.1 / P2) ─────────────────────────────────────
  const [epa, reliability, recalls] = await Promise.all([
    ctx.db.query("config_epa_economy")
      .withIndex("by_config", (q: any) => q.eq("vehicle_config_id", configId)).first()
      .catch(() => null),
    ctx.db.query("config_reliability_signals")
      .withIndex("by_config", (q: any) => q.eq("vehicle_config_id", configId)).first()
      .catch(() => null),
    ctx.db.query("vehicle_recalls")
      .withIndex("by_config", (q: any) => q.eq("vehicle_config_id", configId)).collect()
      .catch(() => [] as any[]),
  ]);

  const manual = make && model
    ? await ctx.db.query("vehicle_manuals")
        .withIndex("by_ymm", (q: any) =>
          q.eq("make", String(make.name ?? "").toLowerCase())
           .eq("model", String(model.name ?? "").toLowerCase())
           .eq("year", cfg.year))
        .first()
        .catch(() => null)
    : null;

  // ── Gate + flag surface ──────────────────────────────────────────────────
  const sanityFlags: any[] = run?.sanity_flags ?? [];
  const byStage: Record<string, number> = {};
  for (const f of sanityFlags) {
    const k = f.stage ?? "(pre-finalize)";
    byStage[k] = (byStage[k] ?? 0) + 1;
  }

  const triangleBroken = parts.filter((p) => !p.triangle_ok);
  const corroborated = parts.filter((p) => (p.source_count ?? 1) >= 2).length;

  // ── Field-level corroboration (claim ledger) ─────────────────────────────
  // The `corroboration` figure above counts PART FITMENTS with 2+ attesting
  // sources, and the pipeline writes exactly one fitment per part per run with
  // source_count 1 — so on any single fresh run it is arithmetically pinned at
  // 0% regardless of data quality. Reading it as "nothing is corroborated" was
  // wrong; it never measured what its name suggests.
  //
  // This is the honest counterpart: real multi-source agreement over FIELDS,
  // computed from the claim ledger. `families >= 2` is the number that matters
  // — two storefronts of one operator are one voice, and reconcileClaims has
  // already collapsed them. Ties are reported separately because a tie is not
  // a failure to find data, it is a refusal to guess between two sources.
  const claims = await ctx.db
    .query("field_claims")
    .withIndex("by_config", (q: any) => q.eq("vehicle_config_id", configId))
    .collect()
    .catch(() => [] as any[]);
  const claimsByField = new Map<string, any[]>();
  for (const c of claims) {
    const list = claimsByField.get(c.field_key) ?? [];
    list.push(c);
    claimsByField.set(c.field_key, list);
  }
  // Corroboration is AGREEMENT, not participation. Counting fields where two
  // families merely both spoke would score a field as corroborated when the
  // two families flatly CONTRADICT each other and the stronger one won — the
  // exact present-but-wrong shape this pipeline forbids. So the count comes
  // from the reconciler's own winner: `families.length >= 2` means two
  // independent families backed the SAME value.
  let fieldsAgreed = 0;
  let fieldsContested = 0;
  let fieldsSingleSource = 0;
  let fieldsTied = 0;
  for (const [fieldKey, list] of claimsByField.entries()) {
    const verdict = reconcileClaims(fieldKey, list as any);
    if (verdict.outcome === "conflict_tie") {
      fieldsTied++;
    } else if (verdict.families.length >= 2) {
      fieldsAgreed++;
    } else {
      fieldsSingleSource++;
    }
    // A field where more than one distinct value was claimed at all.
    if (new Set((list as any[]).map((c) => c.value)).size > 1) fieldsContested++;
  }
  const claimLedger = {
    claim_rows: claims.length,
    fields_with_claims: claimsByField.size,
    /** Two or more independent families backing the SAME value. */
    fields_multi_family_agreement: fieldsAgreed,
    /** One family only — evidence on file, but nothing to corroborate it. */
    fields_single_source: fieldsSingleSource,
    /** Sources disagreed and the ledger refused to pick: no value at all. */
    fields_conflict_tie: fieldsTied,
    /** More than one distinct value claimed, however it resolved. */
    fields_contested: fieldsContested,
    adapters_seen: [...new Set(claims.map((c: any) => c.adapter).filter(Boolean))].sort(),
    families_seen: [...new Set(claims.map((c: any) => c.source_family))].sort(),
  };

  return {
    vehicle: {
      configId,
      config_key: cfg.config_key,
      year: cfg.year,
      make: make?.name ?? null,
      model: model?.name ?? null,
      trim: cfg.trim_name ?? null,
      chassis_code: cfg.chassis_code ?? null,
      drivetrain: cfg.drivetrain ?? null,
      enrichment_status: cfg.enrichment_status ?? null,
      fill_rate: cfg.fill_rate ?? null,
      confidence_avg: cfg.confidence_avg ?? null,
      verified_fields: cfg.verified_fields ?? [],
      na_role_keys: cfg.na_role_keys ?? [],
      last_enriched_at: cfg.last_enriched_at ?? null,
    },
    identity_coherence: {
      engine_code: engine?.engine_code ?? null,
      cylinders: engine?.cylinders ?? null,
      displacement_l: engine?.displacement_l ?? null,
      spark_plug_quantity: engine?.spark_plug_quantity ?? null,
      // The concern that started this: a 4-cyl must want 4 plugs (dual-plug
      // engines are the documented exception, not a mismatch).
      plugs_match_cylinders:
        engine?.cylinders != null && engine?.spark_plug_quantity != null
          ? engine.spark_plug_quantity === engine.cylinders ||
            engine.spark_plug_quantity === engine.cylinders * 2
          : null,
      fuel_type: engine?.fuel_type ?? null,
      aspiration: engine?.aspiration ?? null,
      timing_system: engine?.timing_system ?? null,
      transmission_type: trans?.type ?? trans?.transmission_type ?? null,
      trans_fluid_type: trans?.fluid_type ?? null,
      epa_says: epa
        ? { cylinders: epa.epa_cylinders, displacement_l: epa.epa_displacement_l,
            turbo: epa.epa_turbo, fuel: epa.epa_fuel_type,
            mismatch: epa.coherence_mismatch ?? null }
        : null,
    },
    fluids_and_capacities: {
      oil_viscosity: engine?.oil_viscosity ?? null,
      oil_capacity_qts: engine?.oil_capacity_qts ?? null,
      coolant_type: engine?.coolant_type ?? null,
      coolant_capacity_qts: engine?.coolant_capacity_qts ?? null,
      brake_fluid_type: cfg.brake_fluid_type ?? null,
      brake_fluid_capacity_oz: cfg.brake_fluid_capacity_oz ?? null,
      ps_fluid_type: cfg.ps_fluid_type ?? null,
      ps_fluid_capacity_oz: cfg.ps_fluid_capacity_oz ?? null,
      trans_fluid_capacity_qts: trans?.fluid_capacity_drain_fill_qts ?? null,
    },
    rotor: {
      front_min_mm: cfg.rotor_front_min_thickness_mm ?? null,
      rear_min_mm: cfg.rotor_rear_min_thickness_mm ?? null,
      front_nominal_mm: cfg.rotor_front_nominal_thickness_mm ?? null,
      rear_nominal_mm: cfg.rotor_rear_nominal_thickness_mm ?? null,
      front_quality: cfg.rotor_front_min_quality ?? null,
      rear_quality: cfg.rotor_rear_min_quality ?? null,
      front_label: cfg.rotor_front_min_observed_label ?? null,
      rear_label: cfg.rotor_rear_min_observed_label ?? null,
      source_url: cfg.rotor_min_source_url ?? null,
    },
    parts: {
      total: parts.length,
      triangle_ok: parts.length - triangleBroken.length,
      triangle_broken: triangleBroken.map((p) => ({
        role: p.role, oem: p.oem, why: !p.oem ? "no_part_number"
          : p.refute_flagged ? "refute_flagged" : "no_trusted_price",
      })),
      corroborated_2plus_sources: corroborated,
      corroboration_rate: pct(corroborated, parts.length),
      with_observed_title: parts.filter((p) => !!p.scraped_name).length,
      rows: parts,
    },
    intervals: {
      total: intervalRows.length,
      with_miles: intervalRows.filter((i) => i.miles != null).length,
      with_months: intervalRows.filter((i) => i.months != null).length,
      months_fill: pct(intervalRows.filter((i) => i.months != null).length, intervalRows.length),
      by_provenance: intervalRows.reduce((acc: Record<string, number>, i) => {
        const k = i.provenance ?? "(none)";
        acc[k] = (acc[k] ?? 0) + 1;
        return acc;
      }, {}),
      rows: intervalRows,
    },
    labor: {
      total: laborRows.length,
      by_source: laborRows.reduce((acc: Record<string, number>, l) => {
        const k = l.source ?? "(none)";
        acc[k] = (acc[k] ?? 0) + 1;
        return acc;
      }, {}),
      rows: laborRows,
    },
    external_joins: {
      epa: epa ? { mpg: [epa.mpg_city, epa.mpg_highway, epa.mpg_combined],
                   fuel_cost_yr: epa.fuel_cost_per_year_usd, co2: epa.co2_gpm } : null,
      recalls_open: recalls.length,
      complaint_signal: reliability
        ? { total: reliability.complaint_total, top: reliability.top_component }
        : null,
      manual: manual
        ? { kind: manual.doc_kind, oem: manual.is_oem_domain,
            file_id: manual.file_id ?? null, pages: manual.page_count ?? null,
            url: manual.source_url }
        : null,
    },
    run: run
      ? {
          runId: run._id,
          status: run.status,
          version: run.version,
          trigger: run.trigger,
          duration_min: run.duration_ms ? Math.round(run.duration_ms / 6000) / 10 : null,
          tokens_in: run.total_tokens_in ?? null,
          tokens_out: run.total_tokens_out ?? null,
          web_searches: run.total_web_searches ?? null,
          fill_rate: run.fill_rate ?? null,
          applicable_fill_rate: run.applicable_fill_rate ?? null,
          quotability: run.quotability ?? null,
          error_tags: tallyTags(run.errors),
          sanity_flags_by_stage: byStage,
          sanity_flag_count: sanityFlags.length,
          field_gap_count: (run.field_gaps ?? []).length,
        }
      : null,
    claim_ledger: claimLedger,
    // ── Shippability gate (round 18) ────────────────────────────────────
    //
    // Until now "is this config good enough to serve?" was answered by a human
    // reading these numbers. That does not scale past a handful of vehicles and
    // it is not reproducible, so every round has been judged by eye.
    //
    // The criteria are CORRECTNESS-first, deliberately inverting the coverage
    // KPIs that industry enrichment guides recommend (match rate >85%, coverage
    // >90%). Those come from lead/CRM enrichment, where a missing phone number
    // is a nuisance. Here a wrong brake pad is a safety defect, so a config
    // with fewer parts and no wrong ones OUTRANKS a fuller one carrying a
    // refuted part — and "quotable" already requires an OEM number, a trusted
    // price, and no refute flag.
    //
    // Blockers make a config unservable. Warnings are quality debt that should
    // be visible without gating a launch test.
    shippable: (() => {
      const blockers: string[] = [];
      const warnings: string[] = [];

      // ROLES, not rows. `parts_quotable` counts fitment ROWS, and a role
      // legitimately carries several candidates (the rival mechanism) — so a
      // row count reads as coverage while actually measuring rivalry. The
      // round-19 F-150's "25/25" was 13 roles with 8 of them rivalled, and the
      // Altima's "36/36" was 25 roles. Coverage is how many ROLES can be
      // quoted; the selector picks one winner per role.
      const rolesAll = new Set(parts.map((p) => String(p.role)));
      const rolesQuotable = new Set(parts.filter((p) => p.triangle_ok).map((p) => String(p.role)));
      const quotable = rolesQuotable.size;
      // A config that cannot quote anything cannot serve a customer at all.
      if (quotable === 0) blockers.push("no_quotable_roles");

      // Exact duplicates — same role AND same part number, twice. Rivals are
      // legitimate; an identical repeat is not, and it inflates every
      // row-based metric. Observed on the round-19 Altima (2 rows).
      const seenPairs = new Set<string>();
      let dupRows = 0;
      for (const p of parts) {
        const k = `${p.role}|${p.oem}`;
        if (seenPairs.has(k)) dupRows++;
        else seenPairs.add(k);
      }
      if (dupRows > 0) warnings.push(`duplicate_part_rows:${dupRows}`);
      // The three headline services a launch test will actually exercise.
      const coreSlugs = ["oil_change", "brake_pad_replacement", "filter_replacement"];
      const q: any = run?.quotability;
      for (const slug of coreSlugs) {
        const svc = (q?.services ?? []).find((s: any) => s.slug === slug);
        if (svc && (svc.core_with_price ?? 0) < (svc.core_total ?? 0)) {
          warnings.push(`incomplete_service:${slug}`);
        }
      }
      // Correctness. A refuted part is NOT automatically a blocker: it carries
      // triangle_ok:false and the selector demotes it, so it cannot reach a
      // quote while an unflagged rival exists. Blocking on mere presence
      // (round 19's first cut) failed two otherwise-strong configs — the BMW
      // at 23 roles and the Outback at 10 — over one already-excluded row.
      //
      // What DOES block is a refuted part that is the ONLY candidate for its
      // role: the role has no correct answer, and a sole flagged candidate is
      // exactly the "demoted-wrong-winner" shape the rival mechanism exists to
      // catch. That role is dead, not merely demoted.
      const flagged = parts.filter((p) => p.refute_flagged);
      if (flagged.length > 0) {
        const soleFlagged = [...new Set(flagged.map((p) => String(p.role)))].filter(
          (role) => !parts.some((p) => String(p.role) === role && !p.refute_flagged && p.triangle_ok),
        );
        if (soleFlagged.length > 0) {
          blockers.push(`role_has_only_refuted_candidate:${soleFlagged.join(",")}`);
        } else {
          warnings.push(`refuted_parts_demoted:${flagged.length}`);
        }
      }
      // A part with no observed title has no component-identity evidence — the
      // signal that caught the battery-cable-as-battery class.
      const untitled = parts.filter((p) => !p.scraped_name);
      if (untitled.length > 0) warnings.push(`parts_without_observed_title:${untitled.length}`);

      // Run health: a run that failed, timed out, or never searched did not
      // actually do the work, whatever its stored numbers say.
      if (run && run.status !== "complete") blockers.push(`run_${run.status}`);
      const tags = tallyTags(run?.errors);
      for (const t of Object.keys(tags)) {
        if (t.endsWith("_errored") || t === "batch1_submission_failed") {
          blockers.push(`api_failure:${t}`);
        }
      }
      if ((run?.total_web_searches ?? 0) === 0 && run?.trigger !== "cache") {
        warnings.push("zero_web_searches");
      }
      // Known-unfixed systemic issues surface as warnings so a launch test is
      // not blocked on them, but nobody can claim they were unknown.
      if (tags["applicable_services_empty_fallback_used"] ||
          tags["applicable_services_structural_fallback_used"] ||
          tags["applicable_services_unknown"]) {
        warnings.push("batch2_returned_no_applicable_services");
      }
      if (!cfg.rotor_front_min_thickness_mm && !cfg.rotor_rear_min_thickness_mm) {
        warnings.push("no_rotor_minimums");
      }
      if (!epa) warnings.push("no_epa_join");

      return {
        ready: blockers.length === 0,
        blockers,
        warnings,
        quotable_roles: quotable,
        total_roles: rolesAll.size,
        // Kept alongside so the row-vs-role gap stays visible rather than
        // being quietly corrected away.
        quotable_rows: parts.length - triangleBroken.length,
        criteria:
          "correctness-first: a config with fewer parts and none refuted outranks " +
          "a fuller one carrying a condemned part",
      };
    })(),
    // Everything a reviewer should eyeball first.
    headline: {
      status: cfg.enrichment_status ?? null,
      parts_quotable: `${parts.length - triangleBroken.length}/${parts.length}`,
      // RENAMED to say what it actually measures. It counts part FITMENTS with
      // 2+ attesting sources and is structurally 0% on a single fresh run —
      // keeping the name "corroboration" made it read as a verdict on the
      // whole dataset when it was only ever a statement about fitment
      // re-observation.
      fitment_multi_source: pct(corroborated, parts.length),
      // What "is this field backed by more than one independent source"
      // actually resolves to, from the claim ledger. Agreement, not
      // participation — two families that contradict each other corroborate
      // nothing.
      field_corroboration: pct(
        claimLedger.fields_multi_family_agreement,
        claimLedger.fields_with_claims,
      ),
      fields_with_claims: claimLedger.fields_with_claims,
      months_fill: pct(intervalRows.filter((i) => i.months != null).length, intervalRows.length),
      rotor_minimums: [cfg.rotor_front_min_thickness_mm, cfg.rotor_rear_min_thickness_mm]
        .filter((x) => x != null).length,
      has_manual: !!manual?.file_id,
      epa_joined: !!epa,
    },
  };
}

export const auditByConfig = internalQuery({
  args: { configId: v.id("vehicle_configs") },
  handler: async (ctx, args) => buildAudit(ctx, args.configId),
});

export const auditByVin = internalQuery({
  args: { vin: v.string() },
  handler: async (ctx, args) => {
    const vin = args.vin.trim().toUpperCase();
    const vehicles = await ctx.db.query("vehicles").order("desc").take(500);
    const vehicle: any = vehicles.find(
      (x: any) => String(x.vin ?? "").toUpperCase() === vin,
    );
    if (!vehicle) return { error: "vin_not_found", vin };
    if (!vehicle.vehicle_config_id) {
      return { error: "vin_has_no_config", vin, vehicleId: vehicle._id };
    }
    return buildAudit(ctx, vehicle.vehicle_config_id);
  },
});

/** All runs for a VIN's config, newest first — status + raw errors[] so a
 *  specific (re-)run can be picked out before pulling its step trace. */
export const runsForVin = internalQuery({
  args: { vin: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const vin = args.vin.trim().toUpperCase();
    const vehicles = await ctx.db.query("vehicles").order("desc").take(500);
    const vehicle: any = vehicles.find(
      (x: any) => String(x.vin ?? "").toUpperCase() === vin,
    );
    if (!vehicle?.vehicle_config_id) return { error: "vin_not_found_or_no_config", vin };
    const runs = await ctx.db
      .query("enrichment_runs")
      .withIndex("by_vehicle_config", (q: any) => q.eq("vehicle_config_id", vehicle.vehicle_config_id))
      .order("desc")
      .take(args.limit ?? 10);
    return runs.map((r: any) => ({
      runId: r._id,
      created_at: new Date(r._creationTime).toISOString(),
      status: r.status,
      trigger: r.trigger ?? null,
      version: r.version ?? null,
      web_searches: r.total_web_searches ?? null,
      errors: r.errors ?? [],
    }));
  },
});

/** Distilled batch step trace for one run. The stored response_text is the
 *  JSON.stringify of getBatchResults' map (data + rawText + stopReason +
 *  error per request) and can be 200K chars with `error` at the END — so a
 *  naive char-slice hides exactly the evidence this exists to surface.
 *  Parse server-side and return the distilled verdict per request instead. */
export const stepTraceForRun = internalQuery({
  args: {
    runId: v.id("enrichment_runs"),
    step: v.optional(v.string()),
    rawSample: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("enrichment_run_steps")
      .withIndex("by_run", (q: any) => q.eq("enrichment_run_id", args.runId))
      .collect();
    const sample = args.rawSample ?? 1500;
    return rows
      .filter((r: any) => !args.step || r.step === args.step)
      .sort((a: any, b: any) => a.seq - b.seq)
      .map((r: any) => {
        const text = r.response_text ?? "";
        let requests: any = null;
        let parseNote: string | null = null;
        try {
          const obj = JSON.parse(text);
          if (obj && typeof obj === "object" && !Array.isArray(obj)) {
            requests = Object.fromEntries(
              Object.entries(obj).map(([cid, entry]: [string, any]) => {
                const data = entry?.data ?? null;
                const services = Array.isArray(data?.services) ? data.services : null;
                return [cid, {
                  error: entry?.error ?? null,
                  stop_reason: entry?.stopReason ?? null,
                  usage: entry?.usage ?? null,
                  raw_text_len: (entry?.rawText ?? "").length,
                  data_keys: data && typeof data === "object" ? Object.keys(data) : null,
                  fields_rows: Array.isArray(data?.fields) ? data.fields.length : null,
                  gap_fields_keys: data?.gap_fields && typeof data.gap_fields === "object"
                    ? Object.keys(data.gap_fields).length : null,
                  services_count: services ? services.length : null,
                  services_applicable: services
                    ? services.filter((s: any) => s?.is_applicable !== false).length : null,
                  service_names: services
                    ? services.slice(0, 30).map((s: any) => `${s?.service_name}${s?.is_applicable === false ? " (n/a)" : ""}`)
                    : null,
                  raw_tail: (entry?.rawText ?? "").slice(-sample),
                }];
              }),
            );
          }
        } catch (e) {
          parseNote = `response_text not JSON (truncated=${r.truncated ?? false}): head+tail returned`;
        }
        return {
          step: r.step,
          seq: r.seq,
          status: r.status ?? null,
          summary: r.summary ?? null,
          tokens_in: r.tokens_in ?? null,
          tokens_out: r.tokens_out ?? null,
          web_searches: r.web_searches ?? null,
          truncated: r.truncated ?? false,
          response_len: text.length,
          parse_note: parseNote,
          requests,
          ...(parseNote
            ? { raw_head: text.slice(0, sample), raw_tail: text.slice(-sample) }
            : {}),
        };
      });
  },
});

/** Fleet-level snapshot: how the whole deployment looks after a batch. */
export const auditFleetSnapshot = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const configs = await ctx.db.query("vehicle_configs").order("desc").take(args.limit ?? 100);
    const byStatus: Record<string, number> = {};
    let rotorMins = 0;
    for (const c of configs) {
      const k = (c as any).enrichment_status ?? "(none)";
      byStatus[k] = (byStatus[k] ?? 0) + 1;
      if ((c as any).rotor_front_min_thickness_mm != null) rotorMins++;
    }
    return { sampled: configs.length, by_status: byStatus, configs_with_front_rotor_min: rotorMins };
  },
});
