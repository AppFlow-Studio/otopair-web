"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "convex/react";
import { AnimatePresence, motion } from "framer-motion";
import { Search } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { usePortalSidebar } from "../portal-context";
import { useDebouncedValue } from "@/components/customers/shared";
import {
  CustomersTable,
  type CustomerRow,
  type CustomersSort,
} from "@/components/customers/customers-table";
import {
  VehiclesTable,
  type VehicleRow,
  type VehiclesSort,
} from "@/components/customers/vehicles-table";
import { CustomerDetailPanel } from "@/components/customers/customer-detail-panel";
import { VehicleDetailPanel } from "@/components/customers/vehicle-detail-panel";
import { cn } from "@/lib/utils";

type Tab = "customers" | "vehicles";

export default function CustomersPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { setSidebarCompact } = usePortalSidebar();

  const tabParam = searchParams.get("tab");
  const tab: Tab = tabParam === "vehicles" ? "vehicles" : "customers";
  const selectedId = searchParams.get("id");

  const [search, setSearch] = useState("");
  const debouncedSearch = useDebouncedValue(search, 200);
  const [customersSort, setCustomersSort] = useState<CustomersSort>({
    key: "lastVisitMs",
    dir: "desc",
  });
  const [vehiclesSort, setVehiclesSort] = useState<VehiclesSort>({
    key: "lastServicedMs",
    dir: "desc",
  });

  const customers = useQuery(api.shopCustomers.listShopCustomers, {});
  const vehicles = useQuery(api.shopCustomers.listShopVehicles, {});

  const drawerOpen = !!selectedId;

  useEffect(() => {
    setSidebarCompact(drawerOpen);
    return () => setSidebarCompact(false);
  }, [drawerOpen, setSidebarCompact]);

  // Clear search & selection when switching tabs.
  useEffect(() => {
    setSearch("");
  }, [tab]);

  const setTab = (next: Tab) => {
    const params = new URLSearchParams(searchParams.toString());
    if (next === "customers") params.delete("tab");
    else params.set("tab", next);
    params.delete("id");
    router.replace(`/customers${queryString(params)}`, { scroll: false });
  };

  const setSelected = (id: string | null) => {
    const params = new URLSearchParams(searchParams.toString());
    if (id) params.set("id", id);
    else params.delete("id");
    router.replace(`/customers${queryString(params)}`, { scroll: false });
  };

  const filteredCustomers = useMemo<CustomerRow[] | undefined>(() => {
    if (!customers) return customers;
    const q = debouncedSearch.trim().toLowerCase();
    const filtered = q
      ? customers.filter((c) => {
          return (
            c.name.toLowerCase().includes(q) ||
            (c.email ?? "").toLowerCase().includes(q) ||
            (c.phone ?? "").toLowerCase().includes(q)
          );
        })
      : customers;
    return sortCustomers(filtered, customersSort);
  }, [customers, debouncedSearch, customersSort]);

  const filteredVehicles = useMemo<VehicleRow[] | undefined>(() => {
    if (!vehicles) return vehicles;
    const q = debouncedSearch.trim().toLowerCase();
    const filtered = q
      ? vehicles.filter((v) => {
          return (
            (v.year ? String(v.year) : "").includes(q) ||
            (v.make ?? "").toLowerCase().includes(q) ||
            (v.model ?? "").toLowerCase().includes(q) ||
            (v.trim ?? "").toLowerCase().includes(q) ||
            v.vin.toLowerCase().includes(q) ||
            v.ownerName.toLowerCase().includes(q)
          );
        })
      : vehicles;
    return sortVehicles(filtered, vehiclesSort);
  }, [vehicles, debouncedSearch, vehiclesSort]);

  const customersCount = customers?.length;
  const vehiclesCount = vehicles?.length;
  const currentResultCount =
    tab === "customers" ? filteredCustomers?.length : filteredVehicles?.length;

  // Validate selected id against current tab data — if it doesn't resolve,
  // close the drawer rather than render a broken state.
  const selectedCustomerId = useMemo(() => {
    if (tab !== "customers" || !selectedId) return null;
    if (!filteredCustomers) return selectedId as Id<"users">;
    return filteredCustomers.some((r) => r.id === selectedId)
      ? (selectedId as Id<"users">)
      : null;
  }, [tab, selectedId, filteredCustomers]);

  const selectedVehicleId = useMemo(() => {
    if (tab !== "vehicles" || !selectedId) return null;
    if (!filteredVehicles) return selectedId as Id<"vehicles">;
    const row = filteredVehicles.find((r) => r.id === selectedId);
    return row?.vehicleId ? (row.vehicleId as Id<"vehicles">) : null;
  }, [tab, selectedId, filteredVehicles]);

  return (
    <div className="space-y-6 pb-10">
      <header>
        <h1 className="text-2xl font-bold text-gray-900">Customers</h1>
        <p className="mt-1 text-sm text-gray-500">
          Everyone who&apos;s brought a vehicle to your shop — and what you&apos;ve worked on.
        </p>
      </header>

      <div className="inline-flex gap-1 rounded-xl border border-gray-200 bg-white p-1">
        <TabButton
          active={tab === "customers"}
          onClick={() => setTab("customers")}
          label="Customers"
          count={customersCount}
        />
        <TabButton
          active={tab === "vehicles"}
          onClick={() => setTab("vehicles")}
          label="Vehicles"
          count={vehiclesCount}
        />
      </div>

      <div className="flex gap-6">
        <div className="min-w-0 flex-1">
          <section className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
            <div className="flex items-center justify-between gap-3 border-b border-gray-100 px-5 py-3">
              <div className="relative w-72 max-w-full">
                <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={
                    tab === "customers"
                      ? "Search name, email, phone…"
                      : "Search year, make, model, VIN, owner…"
                  }
                  className="w-full rounded-lg border border-gray-200 bg-white py-2 pl-9 pr-3 text-sm placeholder:text-gray-400 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
                />
              </div>
              <div className="text-xs text-gray-500">
                {currentResultCount === undefined ? (
                  <span className="text-gray-400">Loading…</span>
                ) : (
                  <span>
                    {currentResultCount}{" "}
                    {currentResultCount === 1
                      ? tab === "customers"
                        ? "customer"
                        : "vehicle"
                      : tab === "customers"
                        ? "customers"
                        : "vehicles"}
                  </span>
                )}
              </div>
            </div>

            <AnimatePresence mode="wait">
              <motion.div
                key={tab}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.18 }}
              >
                {tab === "customers" ? (
                  <CustomersTable
                    rows={filteredCustomers}
                    search={debouncedSearch}
                    selectedId={selectedId}
                    onSelect={setSelected}
                    sort={customersSort}
                    onSortChange={setCustomersSort}
                    drawerCompact={drawerOpen}
                    onClearFilters={() => setSearch("")}
                    hasActiveFilters={!!debouncedSearch.trim()}
                  />
                ) : (
                  <VehiclesTable
                    rows={filteredVehicles}
                    search={debouncedSearch}
                    selectedId={selectedId}
                    onSelect={setSelected}
                    sort={vehiclesSort}
                    onSortChange={setVehiclesSort}
                    drawerCompact={drawerOpen}
                    onClearFilters={() => setSearch("")}
                    hasActiveFilters={!!debouncedSearch.trim()}
                  />
                )}
              </motion.div>
            </AnimatePresence>
          </section>
        </div>

        <div
          className={cn(
            "hidden shrink-0 overflow-hidden transition-[width] duration-200 ease-out lg:block",
            drawerOpen ? "w-[504px]" : "w-0",
          )}
        >
          <div className="h-[calc(100vh-220px)] min-h-[560px] w-[480px]">
            <AnimatePresence mode="wait">
              {drawerOpen && tab === "customers" && selectedCustomerId ? (
                <CustomerDetailPanel
                  key={`customer-${selectedCustomerId}`}
                  customerId={selectedCustomerId}
                  onClose={() => setSelected(null)}
                />
              ) : drawerOpen && tab === "vehicles" && selectedVehicleId ? (
                <VehicleDetailPanel
                  key={`vehicle-${selectedVehicleId}`}
                  vehicleId={selectedVehicleId}
                  onClose={() => setSelected(null)}
                />
              ) : null}
            </AnimatePresence>
          </div>
        </div>
      </div>

      {/* Mobile drawer */}
      <AnimatePresence>
        {drawerOpen ? (
          <motion.div
            className="fixed inset-0 z-50 bg-white lg:hidden"
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ duration: 0.22, ease: "easeOut" }}
          >
            <div className="h-full overflow-y-auto p-4">
              {tab === "customers" && selectedCustomerId ? (
                <CustomerDetailPanel
                  customerId={selectedCustomerId}
                  onClose={() => setSelected(null)}
                />
              ) : tab === "vehicles" && selectedVehicleId ? (
                <VehicleDetailPanel
                  vehicleId={selectedVehicleId}
                  onClose={() => setSelected(null)}
                />
              ) : null}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number | undefined;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-2 rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors",
        active
          ? "bg-blue-50 text-blue-700"
          : "text-gray-600 hover:bg-gray-50",
      )}
    >
      {label}
      <span
        className={cn(
          "inline-flex min-w-[1.25rem] items-center justify-center rounded-full px-1.5 text-[11px] font-semibold",
          active
            ? "bg-blue-100 text-blue-700"
            : "bg-gray-100 text-gray-500",
        )}
      >
        {count === undefined ? "—" : count}
      </span>
    </button>
  );
}

function queryString(params: URLSearchParams): string {
  const s = params.toString();
  return s ? `?${s}` : "";
}

function sortCustomers(rows: CustomerRow[], sort: CustomersSort): CustomerRow[] {
  const dir = sort.dir === "asc" ? 1 : -1;
  return rows.slice().sort((a, b) => {
    switch (sort.key) {
      case "name":
        return a.name.localeCompare(b.name) * dir;
      case "vehiclesCount":
        return (a.vehiclesCount - b.vehiclesCount) * dir;
      case "totalJobs":
        return (a.totalJobs - b.totalJobs) * dir;
      case "lastVisitMs":
        return ((a.lastVisitMs ?? 0) - (b.lastVisitMs ?? 0)) * dir;
      case "lifetimeSpendCents":
        return (a.lifetimeSpendCents - b.lifetimeSpendCents) * dir;
    }
  });
}

function sortVehicles(rows: VehicleRow[], sort: VehiclesSort): VehicleRow[] {
  const dir = sort.dir === "asc" ? 1 : -1;
  return rows.slice().sort((a, b) => {
    switch (sort.key) {
      case "year":
        return ((a.year ?? 0) - (b.year ?? 0)) * dir;
      case "make":
        return a.make.localeCompare(b.make) * dir;
      case "lastServicedMs":
        return ((a.lastServicedMs ?? 0) - (b.lastServicedMs ?? 0)) * dir;
      case "jobsCount":
        return (a.jobsCount - b.jobsCount) * dir;
    }
  });
}
