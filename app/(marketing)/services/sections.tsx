"use client";

import Link from "next/link";
import { Walkthrough, type WalkStep } from "@/components/flagship/product/walkthrough";
import { CategoryScreen, SelectServicesScreen, TABS, type TabKey } from "@/components/flagship/product/screens/browse";
import { STATEN_ISLAND_PHONE, staticMapSrc } from "@/lib/static-map";

/**
 * /services: the catalog as a pinned walkthrough. The phone on the right
 * starts on the app's Select Services screen and then shows each
 * category's list as its step scrolls past; the steps carry the
 * crawlable rows (name, what it includes, which cars), each linking to
 * /services/<slug>. Below the desktop breakpoint each step carries its
 * own phone. Data arrives serialised from the server page so this module
 * stays thin.
 */
export type CatalogRow = { slug: string; name: string; description: string; laborOnly: boolean; notes: string[] };
export type CatalogGroup = { tab: TabKey; title: string; body: string; services: CatalogRow[] };

const MAP = staticMapSrc(STATEN_ISLAND_PHONE, 390, 844);

function Rows({ services }: { services: CatalogRow[] }) {
  return (
    <ul className="flex flex-col divide-y divide-[#1a1a1a]/10 border-y border-[#1a1a1a]/10">
      {services.map((s) => (
        <li key={s.slug} className="py-4">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <Link href={`/services/${s.slug}`} className="serif-text text-[19px] leading-[1.25] text-[#1a1a1a] transition-colors duration-300 hover:text-[#4B82A5]">
              {s.name}
            </Link>
            <span className="text-[11px] tracking-[0.12em] text-[#777169]">{s.laborOnly ? "LABOR ONLY" : "PARTS INCLUDED"}</span>
          </div>
          <p className="mt-1 text-[14.5px] leading-[1.55] text-[#4c5661]">{s.description}.</p>
          {s.notes.length > 0 && (
            <p className="mt-1.5 flex flex-wrap gap-1.5">
              {s.notes.map((n) => (
                <span key={n} className="inline-flex items-center rounded-full border border-[#1a1a1a]/12 bg-[#f7f6f3] px-2.5 py-[3px] text-[12px] leading-none tracking-[0.02em] text-[#4c5661]">
                  {n}
                </span>
              ))}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

export function ServicesWalkthrough({ groups, closest }: { groups: CatalogGroup[]; closest: string | null }) {
  const steps: WalkStep[] = [
    {
      id: "start",
      title: "Start from the list, or just ask Oto.",
      body: "The app opens on four lists, the shop nearest you and the jobs people book most. Oto's answer to a symptom is the same catalog, narrowed to your car.",
      screen: <SelectServicesScreen closest={closest ? { name: closest } : null} mapSrc={MAP} />,
    },
    ...groups.map((g) => ({
      id: TABS.find((t) => t.key === g.tab)!.key.replace("_", "-"),
      title: g.title,
      body: g.body,
      screen: <CategoryScreen tab={g.tab} mapSrc={MAP} />,
      extra: <Rows services={g.services} />,
    })),
  ];
  return <Walkthrough steps={steps} />;
}
