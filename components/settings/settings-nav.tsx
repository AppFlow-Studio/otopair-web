"use client";

/**
 * Grouped settings side-rail. Items are either in-page tabs (swap the content
 * pane via `onSelect`) or links to other routes (`href`). Matches the flat
 * design: an active tab is a white pill with a border, primary-tinted icon,
 * and bold label.
 */

import Link from "next/link";
import type { ComponentType } from "react";
import { ArrowUpRight } from "lucide-react";

export type SettingsNavItem = {
  id: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  /** When set, the item is a link to another route instead of an in-page tab. */
  href?: string;
  badge?: string;
};

export type SettingsNavGroup = {
  heading: string;
  items: SettingsNavItem[];
};

export function SettingsNav({
  groups,
  active,
  onSelect,
}: {
  groups: SettingsNavGroup[];
  active: string;
  onSelect: (id: string) => void;
}) {
  return (
    <nav className="md:w-56 md:shrink-0">
      <p className="px-3 pb-4 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        Settings
      </p>
      <div className="space-y-6">
        {groups.map((group) => (
          <div key={group.heading}>
            <p className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/70">
              {group.heading}
            </p>
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const isActive = !item.href && active === item.id;
                const Icon = item.icon;
                const base =
                  "group flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors";
                const state = isActive
                  ? "border border-border bg-card font-semibold text-foreground shadow-sm"
                  : "border border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground";
                const iconCls = `h-4 w-4 shrink-0 ${
                  isActive ? "text-primary" : "text-muted-foreground group-hover:text-foreground"
                }`;
                const badge = item.badge ? (
                  <span className="ml-auto rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700">
                    {item.badge}
                  </span>
                ) : null;

                if (item.href) {
                  return (
                    <li key={item.id}>
                      <Link href={item.href} className={`${base} ${state}`}>
                        <Icon className={iconCls} />
                        <span className="truncate">{item.label}</span>
                        {badge}
                        <ArrowUpRight className="ml-auto h-3.5 w-3.5 text-muted-foreground/50 group-hover:text-muted-foreground" />
                      </Link>
                    </li>
                  );
                }

                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => onSelect(item.id)}
                      aria-current={isActive ? "page" : undefined}
                      className={`${base} ${state}`}
                    >
                      <Icon className={iconCls} />
                      <span className="truncate">{item.label}</span>
                      {badge}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </nav>
  );
}
