"use client";

// ShopsMap — the whole network pinned on one Leaflet map (OSM tiles).
// Client-only: import via next/dynamic with ssr:false (see ShopsMapCard).
// Pins are divIcons (no image assets): emerald = active + Stripe-ready,
// blue = active, slate = inactive. Popups deep-link to the shop detail.

import { useEffect, useMemo, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { ShopPin } from "@/convex/portalSeries";
import { stashGoto } from "@/app/(director-panel)/director/components/directorNav";

function pinColor(p: ShopPin): string {
  if (!p.is_active) return "#94a3b8"; // slate-400
  return p.stripe_ready ? "#059669" : "#3b82f6"; // emerald-600 / blue-500
}

function pinIcon(p: ShopPin): L.DivIcon {
  const c = pinColor(p);
  return L.divIcon({
    className: "",
    iconSize: [18, 18],
    iconAnchor: [9, 9],
    html: `<span style="display:block;width:18px;height:18px;border-radius:9999px;background:${c};border:3px solid #fff;box-shadow:0 1px 4px rgba(2,6,23,.4)"></span>`,
  });
}

export default function ShopsMap({
  pins,
  height = 380,
  stats,
}: {
  pins: ShopPin[];
  height?: number;
  /** optional per-shop 30d stats keyed by shop id, shown in popups */
  stats?: Record<string, { bookings: number; revenue: number }>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);

  const bounds = useMemo(() => {
    if (pins.length === 0) return null;
    return L.latLngBounds(pins.map((p) => [p.lat, p.lng] as [number, number]));
  }, [pins]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, {
      scrollWheelZoom: false,
      attributionControl: true,
    });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    map.setView([39.5, -98.35], 4); // continental US fallback
    mapRef.current = map;
    layerRef.current = L.layerGroup().addTo(map);
    return () => {
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
    for (const p of pins) {
      const s = stats?.[p.id];
      const marker = L.marker([p.lat, p.lng], { icon: pinIcon(p) });
      const esc = (v: string) =>
        v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      marker.bindPopup(
        `<div style="font:12px/1.5 Inter,system-ui,sans-serif;min-width:190px">
           <b style="font-size:13px">${esc(p.name)}</b><br/>
           <span style="color:#64748b">${esc(p.city)}</span><br/>
           ${p.address ? `<span style="color:#64748b">${esc(p.address)}</span><br/>` : ""}
           ${p.phone ? `<a href="tel:${esc(p.phone)}" style="color:#2563eb">${esc(p.phone)}</a><br/>` : ""}
           <span style="color:#334155">${p.mechanics} mechanic${p.mechanics === 1 ? "" : "s"}</span>
           ${p.rating != null ? ` · ★ ${p.rating.toFixed(1)} (${p.review_count})` : ""}<br/>
           ${
             s
               ? `<span style="color:#334155">${s.bookings} bookings · $${Math.round(s.revenue).toLocaleString()} · 30d</span><br/>`
               : ""
           }
           <span style="color:${p.is_active ? "#059669" : "#94a3b8"}">${p.is_active ? "active" : "inactive"}</span>
           ${p.stripe_ready ? ` · <span style="color:#059669">stripe ready</span>` : ` · <span style="color:#b45309">no stripe</span>`}<br/>
           <a href="/director#shops" data-open-shop="${esc(String(p.id))}" style="color:#2563eb;font-weight:600">Open shop →</a>
         </div>`,
      );
      // /shops/all/<id> merged into /director#shops — stash the id when the
      // popup link is clicked so the Shops tab opens this shop on arrival.
      marker.on("popupopen", (e) => {
        const a = e.popup.getElement()?.querySelector<HTMLAnchorElement>("a[data-open-shop]");
        a?.addEventListener("click", () => stashGoto("shops", String(p.id)));
      });
      marker.addTo(layer);
    }
    if (bounds) map.fitBounds(bounds.pad(0.25), { maxZoom: 11 });
  }, [pins, stats, bounds]);

  return <div ref={containerRef} style={{ height }} className="z-0 w-full rounded-lg" />;
}
