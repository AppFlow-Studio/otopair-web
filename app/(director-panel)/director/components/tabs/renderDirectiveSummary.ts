// =============================================================================
// summarizeRenderDirectives — Oto-Sim render-directive → display rows
// =============================================================================
//
// A real Oto turn returns text PLUS whichever render directive fired (the
// mobile app keys off these to draw a card/button). The director sim only
// showed text + quickReplies, so a fired render tool produced no visible
// component — making it look like "Oto said it's doing X but nothing happened."
//
// This pure helper maps the turn result's render fields onto human-readable
// rows the sim renders as small cards under the assistant bubble, so a
// director can SEE that Oto actually fired render_book_service /
// render_record_confirmation / render_vehicle_update / render_link_button /
// render_booking_card / render_bookings_list / render_reasoning / render_sources.
// quickReplies are intentionally excluded — the sim already renders those as
// tappable chips.
//
// A CATCH-ALL surfaces any OTHER render directive the result carries (e.g. a
// render tool added after this file was written) instead of silently dropping
// it — the exact failure mode showVehicleUpdate had before it was pulled
// through. So every render component Oto can emit is always visible in the sim.
//
// Field names mirror the chat.ts SendMessageResult contract.
// =============================================================================

// Result keys that are NOT render directives (don't surface them as cards).
// quickReplies is rendered separately as tappable chips.
const NON_RENDER_KEYS = new Set(["text", "error_kind", "trace", "quickReplies"]);

// Render-directive keys handled explicitly above the catch-all (so the loop
// doesn't double-render them).
const EXPLICIT_RENDER_KEYS = new Set([
  "bookService",
  "showRecordConfirmation",
  "showVehicleUpdate",
  "linkButton",
  "bookingCard",
  "bookingsList",
  "reasoning",
  "sources",
]);

export type RenderDirectiveRow = {
  /** Stable directive key (matches the result field name). */
  key: string;
  /** Short human label for the card header. */
  label: string;
  /** One-line summary of the directive's payload. */
  detail: string;
  /** Raw directive value — so an interactive card (e.g. the vehicle-update
   *  confirm) can act on the exact payload the mobile app would. */
  payload: unknown;
};

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export function summarizeRenderDirectives(
  result: Record<string, unknown> | null | undefined,
): RenderDirectiveRow[] {
  if (!result || typeof result !== "object") return [];
  const r = result as Record<string, any>;
  const rows: RenderDirectiveRow[] = [];

  if (r.bookService) {
    const b = r.bookService;
    const slugs = arr(b.service_slugs).join(", ") || "—";
    const diag = b.diagnostic_system ? ` · diagnostic: ${b.diagnostic_system}` : "";
    const notes = b.customer_notes ? " · has notes" : "";
    rows.push({ key: "bookService", label: "Booking flow", detail: `${slugs}${diag}${notes}`, payload: b });
  }

  if (r.showRecordConfirmation) {
    const c = r.showRecordConfirmation;
    rows.push({
      key: "showRecordConfirmation",
      label: "Record confirmation card",
      detail: c.maintenance_type ? String(c.maintenance_type) : "—",
      payload: c,
    });
  }

  if (r.showVehicleUpdate) {
    const u = r.showVehicleUpdate;
    const parts: string[] = [];
    if (u.mileage !== undefined && u.mileage !== null) parts.push(`mileage ${u.mileage}`);
    const claims = arr(u.service_claims);
    if (claims.length) {
      parts.push(
        claims
          .map((sc: any) => `${sc.service_slug}${sc.kind ? ` (${sc.kind})` : ""}`)
          .join(", "),
      );
    }
    const lights = arr(u.fault_lights);
    if (lights.length) parts.push(`lights: ${lights.join(", ")}`);
    rows.push({
      key: "showVehicleUpdate",
      label: "Vehicle update card",
      detail: parts.join(" · ") || "—",
      payload: u,
    });
  }

  if (r.linkButton) {
    const l = r.linkButton;
    rows.push({
      key: "linkButton",
      label: "Link button",
      detail: l.label ? `${l.destination} (“${l.label}”)` : String(l.destination ?? "—"),
      payload: l,
    });
  }

  if (r.bookingCard) {
    rows.push({
      key: "bookingCard",
      label: "Booking card",
      detail: String(r.bookingCard.booking_id ?? "—"),
      payload: r.bookingCard,
    });
  }

  if (r.bookingsList) {
    const ids = arr(r.bookingsList.booking_ids);
    rows.push({
      key: "bookingsList",
      label: "Bookings list",
      detail: `${ids.length} booking${ids.length === 1 ? "" : "s"}`,
      payload: r.bookingsList,
    });
  }

  if (r.reasoning !== undefined) {
    rows.push({ key: "reasoning", label: "Reasoning", detail: "attached", payload: r.reasoning });
  }
  if (r.sources !== undefined) {
    const n = arr(r.sources).length;
    rows.push({ key: "sources", label: "Sources", detail: n ? `${n} source${n === 1 ? "" : "s"}` : "attached", payload: r.sources });
  }

  // Catch-all: any other present render directive (a render tool added later)
  // still shows up — never silently dropped.
  for (const key of Object.keys(r)) {
    if (NON_RENDER_KEYS.has(key) || EXPLICIT_RENDER_KEYS.has(key)) continue;
    const val = r[key];
    if (val === undefined || val === null) continue;
    let detail: string;
    try {
      detail = typeof val === "object" ? JSON.stringify(val) : String(val);
    } catch {
      detail = "(unserializable)";
    }
    if (detail.length > 140) detail = detail.slice(0, 140) + "…";
    rows.push({ key, label: `Render: ${key}`, detail, payload: val });
  }

  return rows;
}
