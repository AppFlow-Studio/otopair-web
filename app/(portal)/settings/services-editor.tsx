"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { ChevronDown, Loader2, Search, Sliders, Wrench } from "lucide-react";
import ServicePriceTierStrip, {
  clearInactivePricingDraft,
  countPricedServiceGroups,
  emptyServicePricingDraft,
  pricingRecordToDraft,
  servicePricingDraftToCents,
  type SavedServicePricing,
  type ServicePricingDraft,
} from "@/components/shop/service-price-tier-strip";
import Tooltip from "@/components/ui/tooltip";
import { useRegisterSaveable } from "@/components/settings/save-manager";
import ShopShortcutsManager from "@/components/settings/shop-shortcuts-manager";

export default function ServicesEditor() {
  const data = useQuery(api.shops.getMyOnboardingData);
  const shopId = data?.shop?._id as Id<"shops"> | undefined;
  const servicePricing = useQuery(
    api.shopServiceFixedPrices.listPricingForShop,
    shopId ? { shop_id: shopId } : "skip",
  );
  const updateServices = useMutation(api.shops.updateShopOfferedServices);
  const replacePricing = useMutation(
    api.shopServiceFixedPrices.replacePricingForService,
  );

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [pricingOpen, setPricingOpen] = useState<Set<string>>(new Set());
  const [pricingByService, setPricingByService] = useState<
    Record<string, ServicePricingDraft>
  >({});
  const [pricingBaseline, setPricingBaseline] = useState<
    Record<string, ServicePricingDraft>
  >({});

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
    if (!servicePricing) return;
    const next: Record<string, ServicePricingDraft> = {};
    for (const [serviceId, saved] of Object.entries(servicePricing)) {
      next[serviceId] = pricingRecordToDraft(saved as SavedServicePricing);
    }
    setPricingByService(next);
    setPricingBaseline(next);
  }, [servicePricing]);

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

  function setServicePricing(serviceId: string, pricing: ServicePricingDraft) {
    setPricingByService((prev) => ({ ...prev, [serviceId]: pricing }));
  }

  function dirtyServiceIds(): string[] {
    const ids: string[] = [];
    const serviceIds = new Set([
      ...Object.keys(pricingByService),
      ...Object.keys(pricingBaseline),
    ]);
    for (const serviceId of serviceIds) {
      const current = pricingByService[serviceId] ?? emptyServicePricingDraft();
      const baseline = pricingBaseline[serviceId] ?? emptyServicePricingDraft();
      if (JSON.stringify(current) !== JSON.stringify(baseline)) ids.push(serviceId);
    }
    return ids;
  }

  const selectionDirty =
    !!initialSelected &&
    (selected.size !== initialSelected.size ||
      Array.from(selected).some((id) => !initialSelected.has(id)));
  const dirty = selectionDirty || dirtyServiceIds().length > 0;

  const save = useCallback(async () => {
    const pricingWrites = dirtyServiceIds().map((serviceId) => ({
      serviceId,
      ...servicePricingDraftToCents(
        pricingByService[serviceId] ?? emptyServicePricingDraft(),
      ),
    }));

    await updateServices({
      serviceIds: Array.from(selected) as Id<"services">[],
    });

    if (shopId) {
      for (const write of pricingWrites) {
        await replacePricing({
          shop_id: shopId,
          service_id: write.serviceId as Id<"services">,
          mode: write.mode,
          prices: write.prices,
        });
      }
      const savedPricing = { ...pricingByService };
      for (const write of pricingWrites) {
        savedPricing[write.serviceId] = clearInactivePricingDraft(
          pricingByService[write.serviceId] ?? emptyServicePricingDraft(),
        );
      }
      setPricingByService(savedPricing);
      setPricingBaseline(savedPricing);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updateServices, selected, shopId, pricingByService, pricingBaseline, replacePricing]);

  const reset = useCallback(() => {
    if (initialSelected) setSelected(new Set(initialSelected));
    setPricingByService(pricingBaseline);
  }, [initialSelected, pricingBaseline]);

  useRegisterSaveable("services", "Services", dirty, save, reset);

  if (data === undefined) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading services…
      </div>
    );
  }

  if (!data?.shop) return null;

  return (
    <div className="rounded-xl border border-border bg-card p-6 shadow-sm sm:p-8">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-base font-semibold text-foreground flex items-center gap-2">
          <Wrench className="w-4 h-4" /> Offered Services
        </h2>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setSelected(allSelected ? new Set() : new Set(allIds))}
            className="text-xs font-medium text-primary hover:underline"
          >
            {allSelected ? "Clear all" : "Select all"}
          </button>
          <span className="rounded-md bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">
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
          className="w-full pl-10 pr-3 py-2 border border-border rounded-lg text-sm outline-none focus:ring-2 focus:ring-ring/30"
        />
      </div>

      <div className="space-y-3 max-h-[480px] overflow-y-auto pr-1">
        {filteredCats.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-6">No services found</p>
        ) : (
          filteredCats.map((cat) => {
            const isOpen = expanded.has(cat.id) || !!search.trim();
            const catIds = cat.services.map((s) => s._id);
            const allInCat = catIds.every((id) => selected.has(id));
            return (
              <div key={cat.id} className="rounded-lg border border-border overflow-hidden">
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => toggleCat(cat.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      toggleCat(cat.id);
                    }
                  }}
                  aria-expanded={isOpen}
                  className="flex cursor-pointer select-none items-center justify-between gap-2 bg-muted px-3 py-2.5 transition-colors hover:bg-muted/70"
                >
                  <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <ChevronDown
                      className={`w-4 h-4 transition-transform ${isOpen ? "rotate-180" : ""}`}
                    />
                    {cat.name}
                  </span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelected((prev) => {
                        const next = new Set(prev);
                        if (allInCat) catIds.forEach((id) => next.delete(id));
                        else catIds.forEach((id) => next.add(id));
                        return next;
                      });
                    }}
                    className="text-xs font-medium text-primary hover:underline"
                  >
                    {allInCat ? "Clear" : "Select all"}
                  </button>
                </div>
                {isOpen && (
                  <div className="divide-y divide-gray-100">
                    {cat.services.map((s) => {
                      const isSelected = selected.has(s._id);
                      const pricingForService =
                        pricingByService[s._id] ?? emptyServicePricingDraft();
                      const pricedCount = countPricedServiceGroups(pricingForService);
                      const isPricingOpen = pricingOpen.has(s._id) && isSelected;
                      return (
                        <div key={s._id} className="px-3 py-2.5 hover:bg-muted">
                          <div className="flex items-start gap-3">
                            <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-3">
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => toggleService(s._id)}
                                className="mt-1 w-4 h-4 rounded text-primary"
                                aria-label={`Offer ${s.name}`}
                              />
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <p className="text-sm font-medium text-foreground">
                                    {s.name}
                                  </p>
                                  <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                                    {s.defaultLaborHours} hr
                                  </span>
                                  {pricedCount > 0 ? (
                                    <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
                                      {pricedCount}{" "}
                                      {pricingForService.mode === "range"
                                        ? "range"
                                        : "fixed"}
                                    </span>
                                  ) : null}
                                </div>
                                {s.description && (
                                  <p className="mt-0.5 text-xs text-muted-foreground leading-5">
                                    {s.description}
                                  </p>
                                )}
                              </div>
                            </label>
                            {isSelected ? (
                              <Tooltip
                                className="mt-0.5 shrink-0"
                                content="Choose a fixed price or price range for this service by vehicle group. Leave a group blank to use the standard estimate."
                              >
                                <button
                                  type="button"
                                  onClick={() => togglePricing(s._id)}
                                  className={`inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] font-medium transition-colors ${
                                    isPricingOpen
                                      ? "bg-primary/10 text-primary border-primary/20"
                                      : "text-muted-foreground hover:bg-muted"
                                  }`}
                                  aria-expanded={isPricingOpen}
                                >
                                  <Sliders className="h-3 w-3" />
                                  Pricing
                                </button>
                              </Tooltip>
                            ) : null}
                          </div>
                          {isPricingOpen ? (
                            <div className="mt-2 rounded-md border border-border bg-gray-50/60">
                              <ServicePriceTierStrip
                                serviceId={s._id}
                                draft={pricingForService}
                                declinedTiers={declinedTiers}
                                onChange={(next) => setServicePricing(s._id, next)}
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

      {/* Off-catalog shortcuts the shop reuses (Off-Catalog Work spec, §3).
          Creatable from the booking drawer; this is the only place they can be
          edited or retired. */}
      <ShopShortcutsManager shopId={shopId} />
    </div>
  );
}
