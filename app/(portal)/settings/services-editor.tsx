"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { ChevronDown, Loader2, Search, Sliders, Wrench } from "lucide-react";
import FixedPriceTierStrip, {
  FIXED_PRICE_TIERS,
  centsMapToInputs,
  countPricedTiers,
  priceMapToCents,
  type FixedPriceMap,
  type FixedPriceTier,
} from "@/components/shop/fixed-price-tier-strip";

export default function ServicesEditor() {
  const data = useQuery(api.shops.getMyOnboardingData);
  const shopId = data?.shop?._id as Id<"shops"> | undefined;
  const fixedPrices = useQuery(
    api.shopServiceFixedPrices.listForShop,
    shopId ? { shop_id: shopId } : "skip",
  );
  const updateServices = useMutation(api.shops.updateShopOfferedServices);
  const setFixedPrices = useMutation(
    api.shopServiceFixedPrices.setFixedPricesForService,
  );

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [pricingOpen, setPricingOpen] = useState<Set<string>>(new Set());
  const [pricesByService, setPricesByService] = useState<
    Record<string, FixedPriceMap>
  >({});
  const [pricesBaseline, setPricesBaseline] = useState<
    Record<string, FixedPriceMap>
  >({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const initialSelected = useMemo(() => {
    if (!data?.serviceCategories) return null;
    const ids = new Set<string>();
    data.serviceCategories.forEach((c) =>
      c.services.forEach((s) => {
        if (s.isOffered) ids.add(s._id);
      })
    );
    return ids;
  }, [data]);

  useEffect(() => {
    if (initialSelected) setSelected(initialSelected);
  }, [initialSelected]);

  useEffect(() => {
    if (!fixedPrices) return;
    const next: Record<string, FixedPriceMap> = {};
    for (const [serviceId, centsMap] of Object.entries(fixedPrices)) {
      next[serviceId] = centsMapToInputs(centsMap);
    }
    setPricesByService(next);
    setPricesBaseline(next);
  }, [fixedPrices]);

  const declinedTiers = useMemo(
    () => new Set<string>(data?.shop?.declinedTiers ?? []),
    [data],
  );

  const categories = data?.serviceCategories ?? [];

  const filteredCats = useMemo(() => {
    if (!search.trim()) return categories;
    const q = search.toLowerCase();
    return categories
      .map((c) => ({ ...c, services: c.services.filter((s) => s.name.toLowerCase().includes(q)) }))
      .filter((c) => c.services.length > 0);
  }, [categories, search]);

  const allIds = useMemo(
    () => categories.flatMap((c) => c.services.map((s) => s._id)),
    [categories]
  );
  const allSelected = allIds.length > 0 && allIds.every((id) => selected.has(id));

  function toggleService(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function toggleCat(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function togglePricing(serviceId: string) {
    setPricingOpen((prev) => {
      const next = new Set(prev);
      if (next.has(serviceId)) {
        next.delete(serviceId);
      } else {
        next.add(serviceId);
      }
      return next;
    });
  }

  function setServicePrices(serviceId: string, prices: FixedPriceMap) {
    setPricesByService((prev) => ({ ...prev, [serviceId]: prices }));
  }

  function dirtyServiceIds(): string[] {
    const ids: string[] = [];
    for (const serviceId of Object.keys(pricesByService)) {
      const current = pricesByService[serviceId] ?? {};
      const baseline = pricesBaseline[serviceId] ?? {};
      let changed = false;
      for (const tier of FIXED_PRICE_TIERS) {
        if ((current[tier] ?? "") !== (baseline[tier] ?? "")) {
          changed = true;
          break;
        }
      }
      if (changed) ids.push(serviceId);
    }
    return ids;
  }

  async function handleSave() {
    setError(null);
    setMessage(null);
    setSaving(true);
    try {
      await updateServices({
        serviceIds: Array.from(selected) as Id<"services">[],
      });

      if (shopId) {
        const dirty = dirtyServiceIds();
        for (const serviceId of dirty) {
          const patch = priceMapToCents(pricesByService[serviceId] ?? {});
          // Only send tiers that actually changed (set or cleared).
          const baseline = pricesBaseline[serviceId] ?? {};
          const current = pricesByService[serviceId] ?? {};
          const changedTiers: Partial<Record<FixedPriceTier, number | null>> = {};
          for (const tier of FIXED_PRICE_TIERS) {
            if ((current[tier] ?? "") !== (baseline[tier] ?? "")) {
              if (tier in patch) changedTiers[tier] = patch[tier]!;
              else changedTiers[tier] = null;
            }
          }
          if (Object.keys(changedTiers).length === 0) continue;
          await setFixedPrices({
            shop_id: shopId,
            service_id: serviceId as Id<"services">,
            prices: changedTiers,
          });
        }
        setPricesBaseline(pricesByService);
      }

      setMessage("Services saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save your services. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  if (data === undefined) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-500">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading services…
      </div>
    );
  }

  if (!data?.shop) return null;

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide flex items-center gap-2">
          <Wrench className="w-4 h-4" /> Offered Services
        </h2>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setSelected(allSelected ? new Set() : new Set(allIds))}
            className="text-xs font-medium text-blue-600 hover:underline"
          >
            {allSelected ? "Clear all" : "Select all"}
          </button>
          <span className="rounded-md bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700">
            {selected.size} selected
          </span>
        </div>
      </div>

      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" />
        <input
          type="text"
          placeholder="Search services…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full pl-10 pr-3 py-2 border border-gray-200 rounded-lg text-sm outline-none focus:ring-2 focus:ring-blue-500/30"
        />
      </div>

      <div className="space-y-3 max-h-[480px] overflow-y-auto pr-1">
        {filteredCats.length === 0 ? (
          <p className="text-sm text-gray-500 text-center py-6">No services found</p>
        ) : (
          filteredCats.map((cat) => {
            const isOpen = expanded.has(cat.id) || !!search.trim();
            const catIds = cat.services.map((s) => s._id);
            const allInCat = catIds.every((id) => selected.has(id));
            return (
              <div key={cat.id} className="rounded-lg border border-gray-200 overflow-hidden">
                <div className="flex items-center justify-between bg-gray-50 px-3 py-2">
                  <button
                    type="button"
                    onClick={() => toggleCat(cat.id)}
                    className="flex items-center gap-2 text-sm font-semibold text-gray-900"
                  >
                    <ChevronDown
                      className={`w-4 h-4 transition-transform ${isOpen ? "rotate-180" : ""}`}
                    />
                    {cat.name}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setSelected((prev) => {
                        const next = new Set(prev);
                        if (allInCat) catIds.forEach((id) => next.delete(id));
                        else catIds.forEach((id) => next.add(id));
                        return next;
                      })
                    }
                    className="text-xs font-medium text-blue-600 hover:underline"
                  >
                    {allInCat ? "Clear" : "Select all"}
                  </button>
                </div>
                {isOpen && (
                  <div className="divide-y divide-gray-100">
                    {cat.services.map((s) => {
                      const isSelected = selected.has(s._id);
                      const pricesForService = pricesByService[s._id] ?? {};
                      const pricedCount = countPricedTiers(pricesForService);
                      const isPricingOpen = pricingOpen.has(s._id) && isSelected;
                      return (
                        <div key={s._id} className="px-3 py-2.5 hover:bg-gray-50">
                          <div className="flex items-start gap-3">
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => toggleService(s._id)}
                              className="mt-1 w-4 h-4 rounded text-blue-600"
                              aria-label={`Offer ${s.name}`}
                            />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2 flex-wrap">
                                <p className="text-sm font-medium text-gray-900">
                                  {s.name}
                                </p>
                                <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600">
                                  {s.defaultLaborHours} hr
                                </span>
                                {pricedCount > 0 ? (
                                  <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
                                    {pricedCount} fixed
                                  </span>
                                ) : null}
                              </div>
                              {s.description && (
                                <p className="mt-0.5 text-xs text-gray-500 leading-5">
                                  {s.description}
                                </p>
                              )}
                            </div>
                            {isSelected ? (
                              <button
                                type="button"
                                onClick={() => togglePricing(s._id)}
                                className={`mt-0.5 inline-flex items-center gap-1 rounded-md border border-gray-200 px-2 py-1 text-[11px] font-medium transition-colors ${
                                  isPricingOpen
                                    ? "bg-blue-50 text-blue-700 border-blue-200"
                                    : "text-gray-600 hover:bg-gray-100"
                                }`}
                                aria-expanded={isPricingOpen}
                              >
                                <Sliders className="h-3 w-3" />
                                Fixed prices
                              </button>
                            ) : null}
                          </div>
                          {isPricingOpen ? (
                            <div className="mt-2 rounded-md border border-gray-200 bg-gray-50/60">
                              <FixedPriceTierStrip
                                prices={pricesForService}
                                declinedTiers={declinedTiers}
                                onChange={(next) => setServicePrices(s._id, next)}
                              />
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <div className="mt-5 flex items-center justify-between gap-3">
        <div className="text-xs">
          {error && <span className="text-red-600">{error}</span>}
          {message && <span className="text-green-600">{message}</span>}
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition-colors disabled:opacity-50"
        >
          {saving && <Loader2 className="w-4 h-4 animate-spin" />}
          Save Services
        </button>
      </div>
    </div>
  );
}
