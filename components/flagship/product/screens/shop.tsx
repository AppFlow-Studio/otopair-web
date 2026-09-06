"use client";

import { ArrowLeft, Bookmark, Calendar, ChevronRight, MoreVertical, Navigation, Phone, Star, User } from "lucide-react";
import { APP, PhoneShell } from "../device";
import { MapBackdrop } from "./browse";

/**
 * The shop detail page in the app (otopair-1 app/booking/shop/[id]):
 * a map hero 240 tall under the safe area with the shop's dot and a
 * floating back button; the ShopHeroCard overlapping it (logo 56, name
 * 24 bold, ★ rating (count), the address, Call / Directions / Save /
 * Book chips); the Reviews / Mechanics / Portfolio pills; then that
 * tab's content (RatingSummaryCard + ReviewCards, the mechanic cards,
 * the photo grid).
 *
 * Fed ONLY by lib/public-shops.ts's projection, so a real shop's page
 * shows the real shop exactly as a driver sees it. Anything the
 * projection does not carry (distance, phone, per-mechanic ratings) is
 * left off rather than invented.
 */

const INK = "#0F172A";
const HEADER_H = 240 + 59;

export type DetailShop = {
  name: string;
  address: string | null;
  city: string;
  state: string;
  zip?: string | null;
  logoUrl: string | null;
  rating: { average: number; count: number } | null;
  mechanics: { name: string; title: string | null; photoUrl: string | null }[];
  reviews: { reviewer: string; rating: number; comment: string | null; createdAt: number | null }[];
  portfolio: { url: string; caption: string | null }[];
};

export type DetailTab = "reviews" | "mechanics" | "portfolio";

export function Stars({ rating, size = 12, color = "#F59E0B" }: { rating: number; size?: number; color?: string }) {
  const full = Math.max(0, Math.min(5, Math.round(rating)));
  return (
    <span className="inline-flex items-center gap-[2px]">
      {Array.from({ length: 5 }, (_, i) => (
        <Star key={i} style={{ width: size, height: size, color: i < full ? color : "#D1D5DB", fill: i < full ? color : "#D1D5DB" }} strokeWidth={2} />
      ))}
    </span>
  );
}

function timeAgo(ts: number | null): string {
  if (!ts) return "";
  const days = Math.max(0, Math.round((Date.now() - ts) / 86_400_000));
  if (days < 1) return "Today";
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.round(months / 12);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}

function Chip({ icon: Icon, label, primary = false }: { icon: typeof Phone; label: string; primary?: boolean }) {
  return (
    <span className="flex min-h-[56px] flex-1 flex-col items-center justify-center gap-1 rounded-[12px] px-1" style={{ backgroundColor: primary ? APP.blue : "#F1F5F9" }}>
      <Icon className="h-[18px] w-[18px]" style={{ color: primary ? "#fff" : INK }} strokeWidth={2} />
      <span className="text-[12px] font-medium leading-none" style={{ color: primary ? "#fff" : INK }}>
        {label}
      </span>
    </span>
  );
}

function RatingSummary({ shop }: { shop: DetailShop }) {
  const r = shop.rating!;
  const dist = [5, 4, 3, 2, 1].map((s) => {
    const n = shop.reviews.filter((x) => Math.round(x.rating) === s).length;
    return { s, pct: shop.reviews.length ? Math.round((n / shop.reviews.length) * 100) : 0 };
  });
  return (
    <div className="mb-3 flex rounded-[16px] border bg-white p-4" style={{ borderColor: "#F3F4F6" }}>
      <div className="flex flex-1 flex-col gap-1">
        {dist.map((d) => (
          <div key={d.s} className="flex items-center gap-2">
            <span className="w-[8px] text-[11px] font-medium" style={{ color: "#6B7280" }}>
              {d.s}
            </span>
            <span className="h-[6px] flex-1 overflow-hidden rounded-full" style={{ backgroundColor: "#F3F4F6" }}>
              <span className="block h-full rounded-full" style={{ width: `${d.pct}%`, backgroundColor: "#F59E0B" }} />
            </span>
          </div>
        ))}
      </div>
      <div className="flex min-w-[80px] flex-col items-center justify-center pl-4">
        <span className="text-[30px] font-bold leading-none" style={{ color: INK }}>
          {r.average.toFixed(1)}
        </span>
        <span className="mt-1">
          <Stars rating={r.average} size={16} />
        </span>
        <span className="mt-1 text-[12px]" style={{ color: "#9CA3AF" }}>
          {r.count} Reviews
        </span>
      </div>
    </div>
  );
}

function ReviewCard({ r }: { r: DetailShop["reviews"][number] }) {
  return (
    <div className="rounded-[16px] border bg-white p-4" style={{ borderColor: "#F3F4F6" }}>
      <div className="mb-2 flex items-center">
        <span className="mr-2 flex h-[40px] w-[40px] items-center justify-center rounded-full" style={{ backgroundColor: "#F3F4F6" }}>
          <User className="h-[20px] w-[20px]" style={{ color: "#9CA3AF" }} strokeWidth={1.5} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[14px] font-bold" style={{ color: INK }}>
            {r.reviewer}
          </span>
          <span className="flex items-center gap-2">
            <Stars rating={r.rating} />
            <span className="text-[12px]" style={{ color: "#9CA3AF" }}>
              {timeAgo(r.createdAt)}
            </span>
          </span>
        </span>
        <MoreVertical className="h-[18px] w-[18px]" style={{ color: "#9CA3AF" }} />
      </div>
      {r.comment && (
        <p className="text-[14px] leading-[20px]" style={{ color: "#6B7280" }}>
          {r.comment}
        </p>
      )}
    </div>
  );
}

export function ShopDetailScreen({ shop, tab = "reviews", mapSrc = null }: { shop: DetailShop; tab?: DetailTab; mapSrc?: string | null }) {
  const address = shop.address ? `${shop.address}, ${shop.city}, ${shop.state}` : `${shop.city}, ${shop.state}`;
  const tabs: { id: DetailTab; label: string }[] = [
    { id: "reviews", label: "Reviews" },
    { id: "mechanics", label: "Mechanics" },
    { id: "portfolio", label: "Portfolio" },
  ];
  return (
    <PhoneShell bg="#ffffff">
      <div className="flex h-full flex-col">
        {/* map hero */}
        <div className="relative shrink-0" style={{ height: HEADER_H }}>
          <MapBackdrop src={mapSrc}>
            <span className="absolute left-1/2 top-1/2 flex h-[22px] w-[22px] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white" style={{ boxShadow: "0 1px 2px rgba(0,0,0,0.05)" }}>
              <span className="h-[14px] w-[14px] rounded-full" style={{ backgroundColor: APP.blue }} />
            </span>
          </MapBackdrop>
          <span className="absolute left-4 top-[71px] flex h-[40px] w-[40px] items-center justify-center rounded-full bg-white" style={{ boxShadow: "0 2px 4px rgba(0,0,0,0.1)" }}>
            <ArrowLeft className="h-[22px] w-[22px]" style={{ color: INK }} />
          </span>
        </div>

        {/* ShopHeroCard */}
        <div className="relative z-10 -mt-5 mx-4 flex flex-col gap-2 rounded-[20px] bg-white px-5 py-4" style={{ boxShadow: "0 2px 4px rgba(0,0,0,0.1)" }}>
          <div className="flex items-center gap-3">
            <span className="flex h-[56px] w-[56px] shrink-0 items-center justify-center overflow-hidden rounded-[12px]" style={{ backgroundColor: "#F1F5F9" }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={shop.logoUrl ?? "/images/landing/pin-logo.png"} alt="" className={shop.logoUrl ? "h-full w-full object-cover" : "h-[40px] w-[40px] object-contain"} />
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="line-clamp-2 text-[24px] font-bold leading-[1.15]" style={{ color: INK }}>
                {shop.name}
              </span>
              {shop.rating && (
                <span className="flex items-center gap-1">
                  <Star className="h-[14px] w-[14px]" style={{ color: APP.blue, fill: APP.blue }} />
                  <span className="text-[14px] font-semibold" style={{ color: INK }}>
                    {shop.rating.average.toFixed(1)}
                  </span>
                  <span className="text-[12px]" style={{ color: "#6B7280" }}>
                    ({shop.rating.count})
                  </span>
                </span>
              )}
            </span>
          </div>
          <p className="truncate text-[14px]" style={{ color: "#6B7280" }}>
            {address}
          </p>
          <div className="mt-1 flex gap-2">
            <Chip icon={Phone} label="Call" />
            <Chip icon={Navigation} label="Directions" />
            <Chip icon={Bookmark} label="Save" />
            <Chip icon={Calendar} label="Book" primary />
          </div>
        </div>

        {/* tabs */}
        <div className="flex gap-2 px-4 py-3">
          {tabs.map((t) => {
            const on = t.id === tab;
            return (
              <span key={t.id} className="rounded-full border px-4 py-2 text-[14px]" style={on ? { backgroundColor: APP.blue, borderColor: APP.blue, color: "#fff", fontWeight: 600, boxShadow: "0 1px 2px rgba(0,0,0,0.05)" } : { backgroundColor: "#fff", borderColor: "#E5E7EB", color: "#475569", fontWeight: 500 }}>
                {t.label}
              </span>
            );
          })}
        </div>

        {/* tab content */}
        <div className="min-h-0 flex-1 overflow-hidden px-4 pb-6">
          {tab === "reviews" &&
            (shop.rating ? (
              <>
                <RatingSummary shop={shop} />
                <p className="mb-3 mt-2 text-[18px] font-bold" style={{ color: INK }}>
                  Customer Reviews ({shop.reviews.length})
                </p>
                <div className="flex flex-col gap-2">
                  {shop.reviews.slice(0, 3).map((r, i) => (
                    <ReviewCard key={i} r={r} />
                  ))}
                </div>
              </>
            ) : (
              <p className="pt-10 text-center text-[16px] font-medium" style={{ color: "#9CA3AF" }}>
                No reviews yet for this shop
              </p>
            ))}
          {tab === "mechanics" && (
            <>
              <p className="mb-3 text-[18px] font-bold" style={{ color: INK }}>
                Mechanics ({shop.mechanics.length})
              </p>
              <div className="flex flex-col gap-2">
                {shop.mechanics.map((m) => (
                  <div key={m.name} className="flex items-center gap-3 rounded-[16px] border bg-white p-3" style={{ borderColor: "#F3F4F6" }}>
                    <span className="flex h-[48px] w-[48px] shrink-0 items-center justify-center overflow-hidden rounded-full" style={{ backgroundColor: "#F3F4F6" }}>
                      {m.photoUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={m.photoUrl} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <User className="h-[28px] w-[28px]" style={{ color: "#9CA3AF" }} strokeWidth={1.5} />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[16px] font-semibold" style={{ color: INK }}>
                        {m.name}
                      </span>
                      {m.title && (
                        <span className="block text-[12px]" style={{ color: "#6B7280" }}>
                          {m.title}
                        </span>
                      )}
                    </span>
                    <ChevronRight className="h-[20px] w-[20px]" style={{ color: "#9CA3AF" }} />
                  </div>
                ))}
                {shop.mechanics.length === 0 && (
                  <p className="pt-6 text-center text-[16px] font-medium" style={{ color: "#9CA3AF" }}>
                    No mechanics listed yet
                  </p>
                )}
              </div>
            </>
          )}
          {tab === "portfolio" && (
            <div className="grid grid-cols-2 gap-2">
              {shop.portfolio.slice(0, 6).map((p) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={p.url} src={p.url} alt={p.caption ?? ""} className="aspect-[4/3] w-full rounded-[12px] object-cover" />
              ))}
              {shop.portfolio.length === 0 && (
                <p className="col-span-2 pt-6 text-center text-[16px] font-medium" style={{ color: "#9CA3AF" }}>
                  No photos yet
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </PhoneShell>
  );
}
