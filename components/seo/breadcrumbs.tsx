import Link from "next/link";
import { JsonLd } from "./json-ld";
import { absoluteUrl } from "@/lib/site";

export type Crumb = { name: string; href: string };

/**
 * Breadcrumb trail + BreadcrumbList schema (site audit 2026-08-31, Part 2
 * Medium: "needed as soon as the URL tree in Part 4 exists"). The last crumb
 * is the current page and renders as text. Visually quiet: the landing's
 * caps-eyebrow scale, in the secondary ink, so it sits under the hero
 * eyebrow without competing with it.
 */
export function Breadcrumbs({ items, className }: { items: Crumb[]; className?: string }) {
  return (
    <>
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "BreadcrumbList",
          itemListElement: items.map((c, i) => ({
            "@type": "ListItem",
            position: i + 1,
            name: c.name,
            item: absoluteUrl(c.href),
          })),
        }}
      />
      <nav aria-label="Breadcrumb" className={className}>
        <ol className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-[13px] tracking-[0.05em] text-[#777169]">
          {items.map((c, i) => {
            const last = i === items.length - 1;
            return (
              <li key={c.href} className="flex items-center gap-2">
                {last ? (
                  <span aria-current="page" className="text-[#1a1a1a]">
                    {c.name}
                  </span>
                ) : (
                  <Link href={c.href} className="transition-colors hover:text-[#1a1a1a]">
                    {c.name}
                  </Link>
                )}
                {!last && <span aria-hidden>/</span>}
              </li>
            );
          })}
        </ol>
      </nav>
    </>
  );
}
