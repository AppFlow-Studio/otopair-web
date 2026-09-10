"use client";

import { Calendar, Car, ChevronRight, FileText, Info, ShieldCheck } from "lucide-react";
import { APP, PhoneShell } from "../device";
import { AppButton, AppCard, Avatar, Divider, KV, ScreenHeader } from "../ui";

/**
 * Review & Pay (otopair-1 app/booking/mechanic/[id]/payment.tsx): the
 * dedicated screen Book & Pay opens. Mechanic card with rating, appointment
 * and vehicle, the Service Breakdown card, notes, then the wallet-first
 * footer (a black wallet button and "Pay with card").
 *
 * Numbers are examples. The lines are the app's own: "Labor (X min)",
 * "Parts, fixed", "Tax + service fee", "Fixed price". No fee rate is
 * printed anywhere and the tax + fee figure includes NY sales tax on the
 * parts, so no single rate can be read back out of it.
 */
export type PayLine = { k: string; v: string; sub?: boolean };

export const BRAKE_JOB = {
  service: "Front brake pads",
  vehicle: "2019 Honda Civic EX",
  shop: "Eltingville Auto Care",
  mechanic: "Marcus T.",
  initials: "MT",
  rating: "4.9",
  when: "Tue, Sep 9 · 9:40 AM",
  lines: [
    { k: "Labor (1 h 20 min)", v: "$176.00" },
    { k: "Parts, fixed", v: "$104.00" },
    { k: "Tax + service fee", v: "$32.00", sub: true },
  ] as PayLine[],
  total: "$312.00",
};

export function ReviewPayScreen({
  job = BRAKE_JOB,
  pressing = false,
  compact = false,
}: {
  job?: typeof BRAKE_JOB;
  pressing?: boolean;
  /** Drops the notes card so the breakdown sits higher (for crops). */
  compact?: boolean;
}) {
  return (
    <PhoneShell>
      <div className="flex h-full flex-col">
        <ScreenHeader title="Review & Pay" />
        <div className="flex min-h-0 flex-1 flex-col gap-3 px-5 pt-4">
          <AppCard>
            <div className="flex items-center gap-3">
              <Avatar initials={job.initials} rating={job.rating} />
              <span className="min-w-0 flex-1">
                <span className="block text-[15px] font-bold" style={{ color: APP.ink }}>
                  {job.mechanic}
                </span>
                <span className="block text-[13px]" style={{ color: APP.meta }}>
                  {job.shop}
                </span>
              </span>
              <span className="flex items-center gap-1 rounded-full px-[10px] py-[5px] text-[11px] font-semibold" style={{ backgroundColor: APP.greenLight, color: "#047857" }}>
                <ShieldCheck className="h-[12px] w-[12px]" strokeWidth={2.2} />
                Verified shop
              </span>
            </div>
            <Divider className="my-3" />
            <p className="text-[11px] font-bold uppercase tracking-[0.06em]" style={{ color: APP.blue }}>
              Appointment
            </p>
            <p className="mt-1 flex items-center gap-2 text-[14px]" style={{ color: APP.body }}>
              <Calendar className="h-[15px] w-[15px]" style={{ color: APP.meta }} />
              {job.when}
            </p>
            <p className="mt-3 text-[11px] font-bold uppercase tracking-[0.06em]" style={{ color: APP.blue }}>
              Vehicle
            </p>
            <p className="mt-1 flex items-center gap-2 text-[14px]" style={{ color: APP.body }}>
              <Car className="h-[15px] w-[15px]" style={{ color: APP.meta }} />
              {job.vehicle}
            </p>
          </AppCard>

          <AppCard>
            <div className="flex items-center justify-between">
              <span className="text-[15px] font-bold" style={{ color: APP.ink }}>
                Service Breakdown
              </span>
              <FileText className="h-[16px] w-[16px]" style={{ color: APP.meta }} />
            </div>
            <Divider className="my-3" />
            <p className="text-[14px] font-semibold" style={{ color: APP.ink }}>
              {job.service}
            </p>
            <div className="mt-2 flex flex-col gap-[7px]">
              {job.lines.map((l) => (
                <KV key={l.k} k={l.k} v={l.v} sub={l.sub} />
              ))}
            </div>
            <Divider className="my-3" />
            <div className="flex items-baseline justify-between">
              <span className="text-[14px] font-bold" style={{ color: APP.ink }}>
                Fixed price
              </span>
              <span className="text-[24px] font-extrabold tabular-nums tracking-[-0.01em]" style={{ color: APP.blue }}>
                {job.total}
              </span>
            </div>
            <div className="mt-3 flex items-start gap-2 rounded-[10px] border p-[10px]" style={{ backgroundColor: "#EAF2FE", borderColor: "#BFDBFE" }}>
              <Info className="mt-[2px] h-[14px] w-[14px] shrink-0" style={{ color: APP.blue }} />
              <span className="text-[12.5px] leading-[17px]" style={{ color: "#334155" }}>
                $20 hold today. Charged only after the shop inspects the car.
              </span>
            </div>
          </AppCard>

          {!compact && (
            <AppCard>
              <span className="flex items-center gap-2 text-[14px] font-bold" style={{ color: APP.ink }}>
                <FileText className="h-[14px] w-[14px]" style={{ color: APP.meta }} />
                Notes for the mechanic
              </span>
              <div className="mt-2 rounded-[10px] border p-[10px] text-[13px]" style={{ borderColor: APP.border, backgroundColor: "#FAFBFC", color: APP.dim }}>
                e.g. wheel lock is in the glovebox
              </div>
            </AppCard>
          )}
        </div>

        <div className="flex flex-col gap-2 px-5 pb-[34px] pt-3">
          <AppButton tone="ink" pressed={pressing}>
            <span className="text-[17px] font-bold">
              <span className="font-black">G</span> Pay
            </span>
          </AppButton>
          <span className="flex items-center justify-between rounded-[12px] bg-white px-4 py-[11px]" style={{ boxShadow: "0 1px 4px rgba(0,0,0,0.05)" }}>
            <span className="flex items-center gap-2">
              <span className="rounded-[4px] border px-[6px] py-[2px] text-[10px] font-bold" style={{ borderColor: APP.border, color: APP.meta }}>
                CARD
              </span>
              <span className="text-[14px] font-medium" style={{ color: APP.blue }}>
                Pay with card
              </span>
            </span>
            <ChevronRight className="h-[16px] w-[16px]" style={{ color: APP.dim }} />
          </span>
        </div>
      </div>
    </PhoneShell>
  );
}
