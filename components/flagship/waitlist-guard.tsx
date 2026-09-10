"use client";

import { forwardRef, useCallback, useRef } from "react";

/**
 * Invisible bot protection shared by every waitlist form (the store-button
 * modal, the borough/app inline forms, the navbar modal). Two signals, no
 * signup friction and no third-party captcha:
 *
 *  1. Honeypot — a field a human never sees (off-screen, not tabbable,
 *     autocomplete off) but a naive "fill every input" bot completes.
 *  2. Timing — how long the form was on screen. An auto-submitting bot fires
 *     in milliseconds; a person takes seconds to read and type.
 *
 * /api/waitlist silently drops (HTTP 200, no email) any submission that trips
 * either, so a bot never learns why it failed. Kept in sync with the field
 * name the route reads.
 */
export const HONEYPOT_FIELD = "company_website";

export function useBotGuard() {
  const honeypotRef = useRef<HTMLInputElement>(null);
  const openedAt = useRef(Date.now());

  /** Start the timer when the form becomes visible. Modals mount once and stay
   *  mounted, so their clock must start on open — not on mount. */
  const markOpened = useCallback(() => {
    openedAt.current = Date.now();
  }, []);

  /** Spread into the POST body alongside { email, name, … }. */
  const guardFields = useCallback(
    () => ({
      [HONEYPOT_FIELD]: honeypotRef.current?.value ?? "",
      elapsedMs: Date.now() - openedAt.current,
    }),
    [],
  );

  return { honeypotRef, markOpened, guardFields };
}

/** The hidden decoy input. Render inside the form and wire its ref from
 *  useBotGuard(). aria-hidden + tabIndex=-1 + off-screen keeps it away from
 *  humans and assistive tech; autoComplete="off" keeps browser autofill from
 *  tripping it for a real user. */
export const Honeypot = forwardRef<HTMLInputElement>(function Honeypot(_props, ref) {
  return (
    <div
      aria-hidden="true"
      style={{ position: "absolute", left: "-9999px", top: "-9999px", width: 1, height: 1, overflow: "hidden" }}
    >
      <input
        ref={ref}
        type="text"
        name={HONEYPOT_FIELD}
        tabIndex={-1}
        autoComplete="off"
        defaultValue=""
      />
    </div>
  );
});
