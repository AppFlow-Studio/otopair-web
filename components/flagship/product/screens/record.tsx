"use client";

import { Check, ChevronDown } from "lucide-react";
import { APP } from "../device";
import { AppButton } from "../ui";
import { BRAKES, ChatScreen, OtoTurn, UserBubble } from "./chat";

/**
 * AIRecordConfirmation (otopair-1 components/ai-chat): when the driver
 * mentions work done elsewhere, Oto suggests the record and asks before
 * writing anything ("Suggest, don't mutate"). States from the source:
 * the suggestion with "Add a record" / "No, update it"; the follow-up
 * "When was it last serviced?" with the month-and-year picker and "Save
 * update"; then the resolved chip "Confirmed" (or "Left as is").
 */
export function RecordCard({ state = "ask" }: { state?: "ask" | "when" | "done" }) {
  return (
    <div className="rounded-[16px] border bg-white p-4" style={{ borderColor: APP.border, boxShadow: "0 1px 4px rgba(0,0,0,0.04)" }}>
      <p className="text-[11px] font-semibold uppercase tracking-[0.06em]" style={{ color: APP.blue }}>
        Add to your car&apos;s record?
      </p>
      <p className="mt-2 text-[15px] font-semibold leading-[20px]" style={{ color: APP.ink }}>
        Brake pads replaced elsewhere
      </p>
      <p className="mt-1 text-[13px] leading-[18px]" style={{ color: APP.meta }}>
        You said a shop did the front pads last spring. Nothing is written until you confirm.
      </p>
      {state === "ask" && (
        <div className="mt-3 flex gap-2">
          <AppButton small className="flex-1">
            Add a record
          </AppButton>
          <AppButton small tone="ghost" className="flex-1">
            No, update it
          </AppButton>
        </div>
      )}
      {state === "when" && (
        <>
          <p className="mt-3 text-[13px] font-medium" style={{ color: APP.ink }}>
            When was it last serviced?
          </p>
          <span className="mt-2 flex items-center justify-between rounded-[10px] border px-3 py-[10px] text-[14px]" style={{ borderColor: APP.border, color: APP.ink }}>
            March 2025
            <ChevronDown className="h-[16px] w-[16px]" style={{ color: APP.dim }} />
          </span>
          <AppButton small className="mt-3">
            Save update
          </AppButton>
        </>
      )}
      {state === "done" && (
        <span className="mt-3 inline-flex items-center gap-1.5 rounded-full px-3 py-[6px] text-[12.5px] font-semibold" style={{ backgroundColor: APP.greenLight, color: "#047857" }}>
          <Check className="h-[12px] w-[12px]" strokeWidth={3} />
          Confirmed · Mar 2025
        </span>
      )}
    </div>
  );
}

export function RecordScreen({ state = "ask" }: { state?: "ask" | "when" | "done" }) {
  return (
    <ChatScreen input="idle" animate={false}>
      <UserBubble>Also, a shop near my office did the front pads last spring. I do not have the receipt.</UserBubble>
      <OtoTurn thinking={false}>Good to know. That changes what I would look at first. Want me to add it to the Civic&apos;s record?</OtoTurn>
      <RecordCard state={state} />
      {state === "done" && <OtoTurn thinking={false}>{BRAKES.answer.replace("Your last brake service on file is 18 months ago, so", "With pads from March 2025 on file,")}</OtoTurn>}
    </ChatScreen>
  );
}
