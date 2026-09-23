"use client";

// Shop-side StubHub-style slot hold for a picked schedule slot (tire / rotor
// quote dialogs). The moment a slot is chosen we reserve that mechanic+window
// via `slotHolds.holdSlot` (15-min TTL, director-tunable) so a customer can't
// book it from the app while the shop is still filling out the form.
//
// Lifecycle:
//   - selection set/changed → hold (idempotent per session; moving slots moves
//     the hold server-side)
//   - selection cleared / dialog unmounts → release
//   - holdSlot rejects (someone got there first) → onLost("taken")
//   - countdown hits zero → onLost("expired")
// The caller deselects the slot in onLost and shows a friendly notice. The
// schedule grid is reactive, so the booking that beat us is already on screen.

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { errorMessage } from "@/lib/feedback";

export type SlotHoldStatus =
  | "idle"
  | "holding"
  | "held"
  | "taken"
  | "expired"
  | "disabled";

export type SlotHoldLostReason = "taken" | "expired";

export interface SlotHoldSelection {
  date: string;
  time: string;
  mechanicId: string;
}

export type RequoteOf =
  | { quote_type: "tire"; response_id: Id<"tire_quote_responses"> }
  | { quote_type: "rotor"; response_id: Id<"rotor_quote_responses"> };

function newSessionId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `shop-quote-${crypto.randomUUID()}`;
  }
  return `shop-quote-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function useSlotHold({
  shopId,
  date,
  time,
  mechanicId,
  durationMinutes,
  requoteOf,
  onLost,
}: {
  shopId: Id<"shops"> | null | undefined;
  date: string;
  time: string;
  mechanicId: string;
  durationMinutes: number;
  requoteOf?: RequoteOf;
  onLost: (
    reason: SlotHoldLostReason,
    selection: SlotHoldSelection,
    serverMessage?: string,
  ) => void;
}) {
  const holdSlot = useMutation(api.slotHolds.holdSlot);
  const releaseSlotHold = useMutation(api.slotHolds.releaseSlotHold);

  const sessionIdRef = useRef<string>("");
  if (!sessionIdRef.current) sessionIdRef.current = newSessionId();
  const sessionId = sessionIdRef.current;

  const [hold, setHold] = useState<{
    holdId: Id<"slot_holds">;
    expiresAt: number;
    selection: SlotHoldSelection;
  } | null>(null);
  const [status, setStatus] = useState<SlotHoldStatus>("idle");
  const [nowMs, setNowMs] = useState(() => Date.now());

  const holdRef = useRef(hold);
  holdRef.current = hold;
  const onLostRef = useRef(onLost);
  onLostRef.current = onLost;
  const generationRef = useRef(0);
  const unmountedRef = useRef(false);

  const requoteKey = requoteOf ? `${requoteOf.quote_type}:${requoteOf.response_id}` : "";
  const requoteOfRef = useRef(requoteOf);
  requoteOfRef.current = requoteOf;

  const hasSelection = Boolean(shopId && date && time && mechanicId);
  const hasSelectionRef = useRef(hasSelection);
  hasSelectionRef.current = hasSelection;

  // Acquire / move / release as the selection changes.
  useEffect(() => {
    const generation = ++generationRef.current;

    if (!hasSelection) {
      const h = holdRef.current;
      if (h) {
        releaseSlotHold({ holdId: h.holdId, session_id: sessionId }).catch(() => {});
      }
      setHold(null);
      // Keep "taken"/"expired" visible until the next selection; otherwise idle.
      setStatus((s) => (s === "taken" || s === "expired" ? s : "idle"));
      return;
    }

    const selection = { date, time, mechanicId };
    setStatus("holding");
    (async () => {
      try {
        const res = await holdSlot({
          shop_id: shopId as Id<"shops">,
          mechanic_id: mechanicId as Id<"mechanics">,
          date,
          start_time: time,
          duration_minutes: durationMinutes > 0 ? durationMinutes : 30,
          session_id: sessionId,
          requote_of: requoteOfRef.current,
        });
        if (generation !== generationRef.current) {
          // A newer selection superseded this call. A newer holdSlot on the
          // same session replaces this row server-side; only clean up when
          // nothing newer will (selection cleared or dialog closed).
          if (res?.holdId && (unmountedRef.current || !hasSelectionRef.current)) {
            releaseSlotHold({ holdId: res.holdId, session_id: sessionId }).catch(() => {});
          }
          return;
        }
        if (res?.disabled) {
          setHold(null);
          setStatus("disabled");
          return;
        }
        if (res?.holdId && res.expiresAt != null) {
          setHold({ holdId: res.holdId, expiresAt: res.expiresAt, selection });
          setNowMs(Date.now());
          setStatus("held");
        }
      } catch (e) {
        if (generation !== generationRef.current) return;
        // The failed move left our previous hold intact server-side — free it.
        const prev = holdRef.current;
        if (prev) {
          releaseSlotHold({ holdId: prev.holdId, session_id: sessionId }).catch(() => {});
        }
        setHold(null);
        setStatus("taken");
        onLostRef.current("taken", selection, errorMessage(e, ""));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasSelection, shopId, date, time, mechanicId, durationMinutes, requoteKey, sessionId]);

  // 1s countdown while held; auto-release on expiry.
  useEffect(() => {
    if (!hold) return;
    const id = setInterval(() => {
      const now = Date.now();
      setNowMs(now);
      if (now >= hold.expiresAt) {
        clearInterval(id);
        generationRef.current++;
        setHold(null);
        setStatus("expired");
        onLostRef.current("expired", hold.selection);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [hold]);

  // Release on unmount (close / cancel). After a successful submit the server
  // already consumed the hold, so this is a harmless no-op.
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      generationRef.current++;
      const h = holdRef.current;
      if (h) {
        releaseSlotHold({ holdId: h.holdId, session_id: sessionId }).catch(() => {});
      }
    };
  }, [releaseSlotHold, sessionId]);

  const remainingMs = hold ? Math.max(0, hold.expiresAt - nowMs) : 0;
  const countdownLabel = useMemo(() => {
    if (!hold) return null;
    const mins = Math.floor(remainingMs / 60000);
    const secs = Math.floor((remainingMs % 60000) / 1000);
    return `${mins}:${String(secs).padStart(2, "0")}`;
  }, [hold, remainingMs]);

  return {
    sessionId,
    status,
    holdId: hold?.holdId ?? null,
    remainingMs,
    countdownLabel,
  };
}
