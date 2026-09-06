"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Search, X } from "lucide-react";
import type { PublicShopSummary } from "@/lib/public-shops";
import { SERVICES } from "@/lib/service-catalog";
import { DirectoryWithMap, type DirectoryGroup } from "@/components/flagship/product/local";

/**
 * The shop finder (/shops, design pass 2026-09-05): a search bar in the
 * hero and the directory below it, kept in step through the URL. Typing
 * writes `?q=` (debounced, no scroll, no history entry) and the directory
 * reads it back, so a filtered view is a link you can share and the two
 * halves never need a shared store. Matching is plain and forgiving:
 * every word typed must appear in the shop's name, neighborhood, address
 * or one of its services.
 */
const NAME_BY_SLUG = new Map(SERVICES.map((s) => [s.slug, s.name]));

function haystack(s: PublicShopSummary): string {
  return [s.name, s.neighborhood ?? "", s.city, s.address ?? "", s.zip ?? "", ...s.serviceSlugs.map((x) => NAME_BY_SLUG.get(x) ?? x)].join(" ").toLowerCase();
}

export function matchShops(shops: PublicShopSummary[], q: string): PublicShopSummary[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return shops;
  return shops.filter((s) => {
    const h = haystack(s);
    return words.every((w) => h.includes(w));
  });
}

/* ------------------------------------------------------------------ */
/* The search bar (hero)                                               */
/* ------------------------------------------------------------------ */

/* Deliberately un-animated: it is a form field, and it is rendered into
   PageShell's `hero` slot, which the shell already reveals. */

function SearchInner({ count }: { count: number }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const initial = params.get("q") ?? "";
  const [value, setValue] = useState(initial);
  const timer = useRef<number | null>(null);

  // Keep the field in step when the URL changes from elsewhere (back button).
  useEffect(() => {
    setValue(initial);
  }, [initial]);

  const push = (q: string) => {
    const next = new URLSearchParams(params.toString());
    if (q.trim()) next.set("q", q.trim());
    else next.delete("q");
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  const onChange = (q: string) => {
    setValue(q);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => push(q), 160);
  };

  return (
    <form
      role="search"
      className="w-full max-w-[560px]"
      onSubmit={(e) => {
        e.preventDefault();
        if (timer.current) window.clearTimeout(timer.current);
        push(value);
        document.getElementById("directory")?.scrollIntoView({ behavior: "smooth", block: "start" });
      }}
    >
      <label htmlFor="shop-search" className="sr-only">
        Search verified shops by name, neighborhood, address or service
      </label>
      <div className="flex h-14 items-center gap-3 rounded-full border border-[#1a1a1a]/12 bg-white pl-5 pr-2 shadow-[0_10px_30px_-14px_rgba(75,130,165,0.45)] transition-colors focus-within:border-[#4B82A5] focus-within:ring-2 focus-within:ring-[#4B82A5]/30">
        <Search className="h-[18px] w-[18px] shrink-0 text-[#4c5661]" strokeWidth={2} aria-hidden />
        <input
          id="shop-search"
          type="search"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={count > 0 ? `Search ${count} verified shops: name, neighborhood, service` : "Search by name, neighborhood or service"}
          autoComplete="off"
          enterKeyHint="search"
          className="h-full min-w-0 flex-1 bg-transparent text-[16px] text-[#1a1a1a] outline-none placeholder:text-[#8f8a82] [&::-webkit-search-cancel-button]:hidden"
        />
        {value && (
          <button
            type="button"
            onClick={() => onChange("")}
            aria-label="Clear search"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[#4c5661] transition-colors hover:bg-[#1a1a1a]/[0.06] hover:text-[#1a1a1a]"
          >
            <X className="h-4 w-4" strokeWidth={2} />
          </button>
        )}
        <button type="submit" className="flex h-10 shrink-0 items-center justify-center rounded-full bg-[#1a1a1a] px-5 text-[14px] font-medium text-white transition-transform duration-300 hover:-translate-y-px">
          Find
        </button>
      </div>
      <p className="mt-3 text-[13px] text-[#4c5661]">
        Try a neighborhood like <button type="button" onClick={() => onChange("Great Kills")} className="text-[#4B82A5] underline decoration-[#4B82A5]/40 underline-offset-[3px] hover:decoration-[#4B82A5]">Great Kills</button>, or a job like{" "}
        <button type="button" onClick={() => onChange("brake")} className="text-[#4B82A5] underline decoration-[#4B82A5]/40 underline-offset-[3px] hover:decoration-[#4B82A5]">brake</button>.
      </p>
    </form>
  );
}

export function ShopSearch({ count }: { count: number }) {
  return (
    <Suspense fallback={<div className="h-14 w-full max-w-[560px] rounded-full border border-[#1a1a1a]/12 bg-white" aria-hidden />}>
      <SearchInner count={count} />
    </Suspense>
  );
}

/* ------------------------------------------------------------------ */
/* The directory, filtered by the URL                                  */
/* ------------------------------------------------------------------ */

const H2 = "serif-display max-w-[16ch] text-[32px] leading-[1.04] tracking-[-0.01em] text-[#1a1a1a] [text-wrap:balance] tab:text-[38px]";
const PROSE = "max-w-[62ch] text-[17px] leading-[1.65] text-[#4c5661] [text-wrap:pretty] [&_a]:text-[#4B82A5] [&_a]:underline [&_a]:decoration-[#4B82A5]/40 [&_a]:underline-offset-[3px] [&_a:hover]:decoration-[#4B82A5]";

function DirectoryInner({ shops, groups }: { shops: PublicShopSummary[]; groups: DirectoryGroup[] | null }) {
  const params = useSearchParams();
  const q = (params.get("q") ?? "").trim();
  const matched = useMemo(() => matchShops(shops, q), [shops, q]);
  const matchedSlugs = useMemo(() => new Set(matched.map((s) => s.slug)), [matched]);
  const shownGroups = useMemo(
    () => (groups ? groups.map((g) => ({ ...g, shops: g.shops.filter((s) => matchedSlugs.has(s.slug)) })).filter((g) => g.shops.length > 0) : null),
    [groups, matchedSlugs],
  );
  const total = shops.length;
  const n = matched.length;

  const heading = !q
    ? total === 1
      ? "One verified shop, bookable today."
      : `${total} verified shops, bookable today.`
    : n === 0
      ? `No shop matches “${q}”.`
      : n === 1
        ? `One shop matches “${q}”.`
        : `${n} shops match “${q}”.`;

  return (
    <>
      {/* No entrance here, on purpose. Every layer above this one already
          animates: /shops wraps <ShopDirectory> in a Reveal, and
          DirectoryWithMap Reveals its map and Staggers its cards. A Reveal
          on this heading would be the third fade on the same scroll and
          would compound another 26px of travel onto the block. It would
          also fire late: DirectoryInner sits behind a <Suspense> (it reads
          useSearchParams), so it mounts after hydration and a whileInView
          here would pop in front of a reader already looking at it. The
          heading is an aria-live region whose text is rewritten on every
          keystroke, and leaving it static is what keeps a filtered result
          from re-animating under the cursor. */}
      <h2 className={H2} aria-live="polite">
        {heading}
      </h2>
      {!q ? (
        <p className={`mt-6 ${PROSE}`}>
          Each card is the shop as the app shows it, and leads to the shop&rsquo;s own page: the services it has switched
          on, its hours for all seven days, and where it is. The list is live.
        </p>
      ) : n === 0 ? (
        <p className={`mt-6 ${PROSE}`}>
          Try a shop&rsquo;s name, a Staten Island neighborhood, a street, or a service such as &ldquo;oil change&rdquo;
          or &ldquo;state inspection&rdquo;. Or <Link href="/shops">show every verified shop</Link>.
        </p>
      ) : (
        <p className={`mt-6 ${PROSE}`}>
          Matching on name, neighborhood, address and the services each shop has switched on.{" "}
          <Link href="/shops">Show all {total}</Link>.
        </p>
      )}

      {n > 0 && (
        <div className="mt-10">
          {/* Static on purpose. It is a jump rail, and it only exists while
              the query is empty: a Stagger here would replay every time the
              reader cleared the search box. */}
          {!q && shownGroups && (
            <nav aria-label="Neighborhoods" className="mb-8">
              <ul className="flex flex-wrap gap-2">
                {shownGroups.map((g) => (
                  <li key={g.id}>
                    <a href={`#${g.id}`} className="inline-flex h-9 items-center gap-2 rounded-full border border-[#1a1a1a]/10 bg-white px-4 text-[14px] text-[#1a1a1a] transition-colors hover:border-[#4B82A5]/50">
                      {g.label}
                      <span className="text-[12px] text-[#777169]">{g.shops.length}</span>
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          )}
          {/* A filtered result reads as one flat list; the neighborhood
              headings only help when the whole directory is showing. */}
          <DirectoryWithMap shops={matched} groups={q ? undefined : (shownGroups ?? undefined)} />
        </div>
      )}
    </>
  );
}

export function ShopDirectory({ shops, groups }: { shops: PublicShopSummary[]; groups: DirectoryGroup[] | null }) {
  return (
    <Suspense fallback={<DirectoryWithMap shops={shops} groups={groups ?? undefined} />}>
      <DirectoryInner shops={shops} groups={groups} />
    </Suspense>
  );
}
