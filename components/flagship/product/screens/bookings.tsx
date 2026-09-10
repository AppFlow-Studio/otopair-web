"use client";

import { motion } from "motion/react";
import { Calendar, ChevronRight, Clock, Star, Wrench } from "lucide-react";
import { APP, PhoneShell } from "../device";
import { AppButton, AppCard, Avatar, Badge, Divider, KV, ScreenHeader, Segmented, TabHeader } from "../ui";

/**
 * Bookings tab (otopair-1 app/(main-tabs)/bookings + components/bookings).
 * BookingCard: white, radius 16, padding 16; id line in caps; services +
 * status badge; car + mechanic rows; the date/time box (radius 10, hairline);
 * actions "View Details" / "Reschedule". BookingProgressBar sits at the top
 * of the card: four 4px segments on a 4px gap, filled #5299FE, the next
 * segment sweeping left to right; title + subtitle above, the current
 * stage under. ApprovalBanner: white, radius 18, 14/18 padding, a 4px
 * accent rail, a 40px icon chip at 12% accent, title 14 semibold, body 13.
 */
export const STAGES = ["Booked", "Confirmed", "In service", "Ready"] as const;

export function ProgressBar({ current, title, subtitle, sweep = true }: { current: number; title?: string; subtitle?: string; sweep?: boolean }) {
  const next = current >= 0 && current < STAGES.length - 1 ? current + 1 : -1;
  return (
    <div className="flex flex-col gap-[6px] pb-2 pt-1">
      {title && (
        <p className="text-center text-[16px] font-bold" style={{ color: "#1F2937" }}>
          {title}
        </p>
      )}
      {subtitle && (
        <p className="-mt-1 text-center text-[12px]" style={{ color: APP.meta }}>
          {subtitle}
        </p>
      )}
      <div className="flex gap-[4px]">
        {STAGES.map((_, i) => (
          <span key={i} className="relative h-[4px] flex-1 overflow-hidden rounded-[2px]" style={{ backgroundColor: i <= current ? APP.blue : "#E5E7EB" }}>
            {i === next && sweep && (
              <motion.span
                className="absolute inset-y-0 left-0"
                style={{ backgroundColor: APP.blue, opacity: 0.55 }}
                animate={{ width: ["0%", "100%"], opacity: [0.55, 0.55, 0] }}
                transition={{ duration: 2.4, ease: "easeInOut", repeat: Infinity, times: [0, 0.92, 1] }}
              />
            )}
          </span>
        ))}
      </div>
      {current >= 0 && (
        <p className="mt-1 text-center text-[14px] font-semibold" style={{ color: "#1F2937" }}>
          {STAGES[current]}
        </p>
      )}
    </div>
  );
}

export function ApprovalBanner({ kind = "pre" }: { kind?: "pre" | "mid" | "post" }) {
  const title = { pre: "Your car requires more than we expected", mid: "Update from your mechanic", post: "Final breakdown, please confirm" }[kind];
  const body = { pre: "Tap to review your mechanic's updated estimate.", mid: "Tap to review the additional scope your mechanic found.", post: "Tap to review the final total before charge." }[kind];
  return (
    <div className="relative flex items-center overflow-hidden rounded-[18px] bg-white py-[14px] pl-[18px] pr-[14px]" style={{ boxShadow: "0 2px 4px rgba(0,0,0,0.05), 0 10px 28px rgba(0,0,0,0.07)" }}>
      <span className="absolute inset-y-0 left-0 w-[4px]" style={{ backgroundColor: APP.amber }} />
      <span className="mr-3 flex h-[40px] w-[40px] shrink-0 items-center justify-center rounded-full" style={{ backgroundColor: `${APP.amber}1F` }}>
        <Wrench className="h-[20px] w-[20px]" style={{ color: APP.amber }} />
      </span>
      <span className="min-w-0 flex-1 pr-2">
        <span className="block text-[14px] font-semibold leading-[18px]" style={{ color: APP.ink }}>
          {title}
        </span>
        <span className="mt-[2px] block text-[13px] leading-[17px]" style={{ color: APP.meta }}>
          {body}
        </span>
      </span>
      <ChevronRight className="h-[20px] w-[20px] shrink-0" style={{ color: APP.meta }} />
    </div>
  );
}

const STATUS = {
  confirmed: { label: "Confirmed", bg: "#DCFCE7", fg: "#15803D" },
  pending: { label: "Awaiting shop", bg: "#FEF3C7", fg: "#B45309" },
  in_progress: { label: "In service", bg: "#DBEAFE", fg: "#1D4ED8" },
  completed: { label: "Completed", bg: "#F1F5F9", fg: "#475569" },
} as const;

export function BookingCard({
  stage,
  status = "confirmed",
  title,
  subtitle,
  approval,
  actions = true,
}: {
  stage: number;
  status?: keyof typeof STATUS;
  title?: string;
  subtitle?: string;
  approval?: boolean;
  actions?: boolean;
}) {
  const st = STATUS[status];
  return (
    <AppCard>
      <ProgressBar current={stage} title={title} subtitle={subtitle} sweep={stage < 3} />
      {approval && (
        <div className="mb-3 mt-2">
          <ApprovalBanner />
        </div>
      )}
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.06em]" style={{ color: APP.dim }}>
        Booking #4F2A9C
      </p>
      <div className="mb-4 flex items-center justify-between">
        <span className="text-[16px] font-bold" style={{ color: APP.ink }}>
          Front brake pads
        </span>
        <Badge bg={st.bg} fg={st.fg}>
          {st.label}
        </Badge>
      </div>
      <div className="mb-4 flex items-center gap-4">
        <span className="flex min-w-0 flex-1 items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/images/landing/app/covered-car.png" alt="" className="h-[32px] w-[50px] object-contain" />
          <span className="min-w-0">
            <span className="block truncate text-[13px] font-semibold" style={{ color: APP.ink }}>
              2019 Honda Civic EX
            </span>
            <span className="block text-[12px]" style={{ color: APP.meta }}>
              KXT 4821
            </span>
          </span>
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <Avatar initials="MT" />
          <span className="min-w-0">
            <span className="block truncate text-[13px] font-semibold" style={{ color: APP.ink }}>
              Marcus T.
            </span>
            <span className="block truncate text-[12px]" style={{ color: APP.meta }}>
              Eltingville Auto Care
            </span>
          </span>
        </span>
      </div>
      <div className="mb-4 flex items-center justify-between rounded-[10px] border bg-white px-4 py-3" style={{ borderColor: APP.border }}>
        <span className="flex items-center gap-2 text-[13px] font-medium" style={{ color: APP.ink }}>
          <Calendar className="h-[15px] w-[15px]" style={{ color: APP.blue }} />
          Tue, Sep 9
        </span>
        <span className="flex items-center gap-2 text-[13px] font-medium" style={{ color: APP.ink }}>
          <Clock className="h-[15px] w-[15px]" style={{ color: APP.blue }} />
          9:40 AM
        </span>
      </div>
      {actions && (
        <div className="flex gap-[10px]">
          <AppButton className="flex-1">View Details</AppButton>
          <AppButton tone="ghost" className="flex-1">
            Reschedule
          </AppButton>
        </div>
      )}
    </AppCard>
  );
}

/** The tab root with one live booking. */
export function BookingsScreen({ stage = 1, approval = false, title, subtitle }: { stage?: number; approval?: boolean; title?: string; subtitle?: string }) {
  return (
    <PhoneShell tab={1} bookingsBadge={approval}>
      <TabHeader title="My Bookings" />
      <Segmented items={["Upcoming", "History"]} on={0} />
      <div className="px-5 pt-4">
        <BookingCard stage={stage} approval={approval} title={title} subtitle={subtitle} status={stage >= 2 ? "in_progress" : stage >= 1 ? "confirmed" : "pending"} />
      </div>
    </PhoneShell>
  );
}

/* ------------------------------------------------------------------ */
/* Approve estimate — app/booking/approve-estimate/[id].tsx            */
/* ------------------------------------------------------------------ */

/**
 * Header copy is the app's ("Your car needs a little more than expected",
 * "Your mechanic took a closer look and found additional work. Here's
 * what changed."), then the original estimate and updated total, the
 * added line, Approve / Decline, and the 24-hour note.
 */
export function ApproveEstimateScreen({ decided }: { decided?: "approved" | "declined" }) {
  return (
    <PhoneShell>
      <div className="flex h-full flex-col">
        <ScreenHeader title="Estimate update" />
        <div className="flex min-h-0 flex-1 flex-col gap-3 px-5 pt-4">
          <div className="px-1">
            <p className="text-[22px] font-bold leading-[27px] tracking-[-0.01em]" style={{ color: APP.ink }}>
              Your car needs a little more than expected
            </p>
            <p className="mt-2 text-[14px] leading-[21px]" style={{ color: APP.meta }}>
              Your mechanic took a closer look and found additional work. Here&apos;s what changed. Review and approve to keep things moving.
            </p>
          </div>
          <AppCard>
            <div className="flex items-center gap-3">
              <Avatar initials="MT" rating="4.9" />
              <span className="min-w-0 flex-1">
                <span className="block text-[15px] font-bold" style={{ color: APP.ink }}>
                  Marcus T.
                </span>
                <span className="block text-[13px]" style={{ color: APP.meta }}>
                  Eltingville Auto Care · on the lift now
                </span>
              </span>
            </div>
            <Divider className="my-3" />
            <div className="flex items-baseline justify-between">
              <span className="text-[13px]" style={{ color: "#8E8E93" }}>
                Original estimate
              </span>
              <span className="text-[14px] font-semibold tabular-nums" style={{ color: "#8E8E93" }}>
                $312.00
              </span>
            </div>
            <div className="mt-2 flex items-baseline justify-between">
              <span className="text-[14px] font-semibold" style={{ color: APP.ink }}>
                Updated total
              </span>
              <span className="text-[24px] font-extrabold tabular-nums tracking-[-0.01em]" style={{ color: APP.ink }}>
                $452.00
              </span>
            </div>
            <Divider className="my-3" />
            <p className="text-[11px] font-bold uppercase tracking-[0.06em]" style={{ color: APP.amber }}>
              What changed
            </p>
            <div className="mt-2 flex flex-col gap-[7px]">
              <KV k="Rear brake pads, worn to 2 mm" v="+$118.00" />
              <KV k="Labor (40 min)" v="+$22.00" />
              <KV k="Tax + service fee" v="+$0.00" sub />
            </div>
            <p className="mt-3 text-[12.5px] leading-[17px]" style={{ color: APP.meta }}>
              Nothing above the $312 you approved is charged unless you say yes here. Decline and the shop completes the front pads only.
            </p>
          </AppCard>
        </div>
        <div className="flex flex-col gap-2 px-5 pb-[34px] pt-3">
          <span className="flex items-center justify-center gap-1.5 text-[12px] font-medium" style={{ color: APP.meta }}>
            <Clock className="h-[12px] w-[12px]" />
            24 hours to answer
          </span>
          <AppButton pressed={decided === "approved"} tone={decided === "declined" ? "ghost" : "blue"}>
            {decided === "approved" ? "Approved" : "Approve $452.00"}
          </AppButton>
          <AppButton tone="ghost" pressed={decided === "declined"}>
            {decided === "declined" ? "Declined" : "Decline"}
          </AppButton>
        </div>
      </div>
    </PhoneShell>
  );
}

/* ------------------------------------------------------------------ */
/* Completed booking — PaymentBreakdown lifecycle rows + parts         */
/* ------------------------------------------------------------------ */

export function ReceiptScreen({ approvedExtra = false }: { approvedExtra?: boolean }) {
  const final = approvedExtra ? "$452.00" : "$312.00";
  return (
    <PhoneShell>
      <div className="flex h-full flex-col">
        <ScreenHeader title="Booking details" />
        <div className="flex min-h-0 flex-1 flex-col gap-3 px-5 pt-4">
          <AppCard>
            <ProgressBar current={3} title="Ready for pickup" subtitle="Marked complete at 12:56 PM" sweep={false} />
          </AppCard>
          <p className="px-1 pt-1 text-[13px] font-bold uppercase tracking-[0.06em]" style={{ color: APP.dim }}>
            Payment
          </p>
          <AppCard pad={0}>
            <div className="flex items-center justify-between px-4 py-[13px]">
              <span className="text-[14px]" style={{ color: "#8E8E93" }}>
                Hold placed at booking
              </span>
              <span className="text-[14px] font-semibold tabular-nums" style={{ color: "#8E8E93" }}>
                $20.00
              </span>
            </div>
            <Divider />
            <div className="flex items-center justify-between px-4 py-[13px]">
              <span className="text-[14px]" style={{ color: APP.text }}>
                Estimate confirmed
              </span>
              <span className="text-[14px] font-semibold tabular-nums" style={{ color: APP.text }}>
                {final}
              </span>
            </div>
            <Divider />
            <div className="flex items-center justify-between px-4 py-[13px]">
              <span className="text-[14px]" style={{ color: APP.text }}>
                Final charged
              </span>
              <span className="text-[16px] font-bold tabular-nums" style={{ color: APP.text }}>
                {final}
              </span>
            </div>
          </AppCard>
          <AppCard>
            <p className="text-[11px] font-bold uppercase tracking-[0.06em]" style={{ color: "#8E8E93" }}>
              Parts used
            </p>
            <div className="mt-2 flex items-center justify-between">
              <span>
                <span className="block text-[14px] font-semibold" style={{ color: APP.text }}>
                  Front brake pads
                </span>
                <span className="block text-[12px]" style={{ color: "#8E8E93" }}>
                  Akebono · ACT1521
                </span>
                <span className="mt-[2px] flex items-center gap-1.5 text-[12px]" style={{ color: APP.meta }}>
                  Qty 1 · $104.00 ea
                  <span className="rounded-full px-[6px] py-[1px] text-[10px] font-semibold" style={{ backgroundColor: APP.greenLight, color: "#047857" }}>
                    At or below catalog median
                  </span>
                </span>
              </span>
              <span className="text-[14px] font-semibold tabular-nums" style={{ color: APP.text }}>
                $104.00
              </span>
            </div>
          </AppCard>
          <span className="flex items-center justify-center gap-2 rounded-[12px] border py-[11px] text-[13px] font-semibold" style={{ borderColor: "#FDE68A", backgroundColor: "#FFFBEB", color: "#92400e" }}>
            Something wrong with this charge?
          </span>
        </div>
        <div className="px-5 pb-[34px] pt-3">
          <AppButton>
            <Star className="h-[16px] w-[16px]" />
            Leave a review
          </AppButton>
        </div>
      </div>
    </PhoneShell>
  );
}
