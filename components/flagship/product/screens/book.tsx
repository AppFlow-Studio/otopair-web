"use client";

import { ArrowLeft, Check, Clock, MapPin, Star, X } from "lucide-react";
import { APP } from "../device";
import { AppButton } from "../ui";
import { BRAKES, ChatScreen, OtoTurn, UserBubble } from "./chat";

/**
 * The Book Service wizard the app renders INSIDE the chat
 * (components/ai-chat/BookServiceComponent.tsx): a sheet on the #EDF2FA
 * canvas with a centered title, "Step n of 5" and a thin blue progress
 * bar, then the step's rows and a full-width blue CTA. Step 3 is the one
 * the marketing pages need most: every shop that can do the job, each
 * with the total it set for this exact car.
 */
const SHEET = "#EDF2FA";

function SheetHeader({ title, sub, step }: { title: string; sub?: string; step: number }) {
  return (
    <div className="relative px-4 pt-4 text-center">
      <ArrowLeft className="absolute left-4 top-4 h-[18px] w-[18px]" style={{ color: APP.meta }} />
      <X className="absolute right-4 top-4 h-[18px] w-[18px]" style={{ color: APP.meta }} />
      <p className="text-[15px] font-bold" style={{ color: APP.ink }}>
        {title}
      </p>
      {sub && (
        <p className="text-[12px]" style={{ color: APP.meta }}>
          {sub}
        </p>
      )}
      <div className="mt-3 text-left">
        <span className="text-[11px] font-medium" style={{ color: APP.ink }}>
          Step {step} of 5
        </span>
        <div className="mt-1 h-[4px] overflow-hidden rounded-full" style={{ backgroundColor: "rgba(0,0,0,0.08)" }}>
          <div className="h-full rounded-full" style={{ backgroundColor: APP.blue, width: `${step * 20}%` }} />
        </div>
      </div>
    </div>
  );
}

export type ShopOffer = { initials: string; name: string; shop: string; rating: string; reviews: string; miles: string; total: string; pick?: boolean; earliest: string };

export const OFFERS: ShopOffer[] = [
  { initials: "MT", name: "Marcus T.", shop: "Eltingville Auto Care", rating: "4.9", reviews: "127", miles: "0.8 mi", total: "$312", pick: true, earliest: "Tue 9:40 AM" },
  { initials: "JR", name: "Joe R.", shop: "Port Richmond Service", rating: "4.7", reviews: "89", miles: "1.6 mi", total: "$298", earliest: "Wed 8:00 AM" },
  { initials: "SV", name: "Sam V.", shop: "Victory Blvd Motors", rating: "4.6", reviews: "54", miles: "2.1 mi", total: "$340", earliest: "Tue 2:15 PM" },
];

export function ShopRow({ o, on = false }: { o: ShopOffer; on?: boolean }) {
  return (
    <div className="relative flex items-center gap-3 rounded-[12px] border bg-white p-3" style={on ? { borderColor: APP.blue, backgroundColor: "#EAF2FF" } : { borderColor: APP.border }}>
      {o.pick && (
        <span className="absolute -top-2.5 right-3 flex items-center gap-1 rounded-full border px-2 py-[2px] text-[10px] font-semibold" style={{ backgroundColor: "#FEF3C7", borderColor: "#FACC15", color: "#92400E" }}>
          <Star className="h-[9px] w-[9px] fill-[#F59E0B] text-[#F59E0B]" />
          Oto&apos;s pick
        </span>
      )}
      <span className="flex h-[36px] w-[36px] shrink-0 items-center justify-center rounded-full text-[12px] font-semibold" style={{ backgroundColor: "#5299FE1A", color: APP.blue }}>
        {o.initials}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-semibold" style={{ color: APP.ink }}>
          {o.name} <span className="font-normal" style={{ color: APP.meta }}>· {o.shop}</span>
        </span>
        <span className="mt-[2px] flex items-center gap-2 text-[11.5px]" style={{ color: APP.meta }}>
          <span className="flex items-center gap-[3px]">
            <Star className="h-[10px] w-[10px] fill-[#F59E0B] text-[#F59E0B]" />
            {o.rating} ({o.reviews})
          </span>
          <span className="flex items-center gap-[3px]">
            <MapPin className="h-[10px] w-[10px]" />
            {o.miles}
          </span>
          <span className="flex items-center gap-[3px]">
            <Clock className="h-[10px] w-[10px]" />
            {o.earliest}
          </span>
        </span>
      </span>
      <span className="text-right">
        <span className="block text-[16px] font-bold tabular-nums" style={{ color: APP.ink }}>
          {o.total}
        </span>
        <span className="block text-[10px] font-medium uppercase tracking-[0.04em]" style={{ color: APP.blue }}>
          Fixed
        </span>
      </span>
      <span className="flex h-[20px] w-[20px] shrink-0 items-center justify-center rounded-full border" style={on ? { backgroundColor: APP.blue, borderColor: APP.blue } : { borderColor: "#D1D5DB" }}>
        {on && <Check className="h-[12px] w-[12px] text-white" strokeWidth={3} />}
      </span>
    </div>
  );
}

/** The wizard sheet on step 3, every shop with its fixed total. */
export function ShopsSheet({ picked = 0 }: { picked?: number }) {
  return (
    <div className="overflow-hidden rounded-[16px]" style={{ backgroundColor: SHEET, boxShadow: "0 4px 14px rgba(20,40,80,0.08)" }}>
      <SheetHeader title="Choose a shop" sub="Front brake pads · 2019 Honda Civic EX" step={3} />
      <div className="flex gap-2 px-4 pt-3">
        {["Closest", "Best rated", "Best price"].map((f) => (
          <span key={f} className="rounded-full border px-3 py-[5px] text-[11.5px] font-medium" style={f === "Best rated" ? { borderColor: APP.blue, color: APP.blue, backgroundColor: "#EAF2FF" } : { borderColor: APP.border, color: APP.meta, backgroundColor: "#fff" }}>
            {f}
          </span>
        ))}
      </div>
      <div className="flex flex-col gap-2 px-4 pt-3">
        {OFFERS.map((o, i) => (
          <ShopRow key={o.name} o={o} on={i === picked} />
        ))}
      </div>
      <p className="px-4 pt-2 text-[11px] leading-[15px]" style={{ color: APP.dim }}>
        Each total is the shop&apos;s own price for this car. It is the most you pay unless you approve more.
      </p>
      <div className="px-4 pb-4 pt-3">
        <AppButton>Continue with {OFFERS[picked].name.split(" ")[0]}</AppButton>
      </div>
    </div>
  );
}

/** The chat with the wizard open on the shops step. */
export function BookShopsScreen({ picked = 0 }: { picked?: number }) {
  return (
    <ChatScreen input="none">
      <UserBubble>{BRAKES.user}</UserBubble>
      <OtoTurn thinking={false}>Three verified shops can take it this week. Each one priced it for your Civic.</OtoTurn>
      <ShopsSheet picked={picked} />
    </ChatScreen>
  );
}
