"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { Check } from "lucide-react";
import { PillButton } from "@/components/flagship/pill-button";
import { SUPPORT_EMAIL } from "@/lib/site";

export type PrivacyRequestKind = "opt_out_vehicle_history" | "delete_account";

const COPY: Record<
  PrivacyRequestKind,
  { hint: string; button: string; doneTitle: string; doneBody: (email: string) => string }
> = {
  opt_out_vehicle_history: {
    hint: "No sign-in or ID needed.",
    button: "Opt out",
    doneTitle: "Your opt-out is recorded.",
    doneBody: (email) =>
      `The Otopair team applies it to the account that uses ${email}. There's nothing else you need to do.`,
  },
  delete_account: {
    hint: "We verify the request with this address before anything is deleted.",
    button: "Request deletion",
    doneTitle: "Request received.",
    doneBody: (email) =>
      `A person on the team will verify it with the email or phone number on the account for ${email} before anything is deleted, and respond by email.`,
  },
};

// Global Privacy Control (Privacy Policy v6.1 honours it as an opt-out). The
// signal is fixed for the page's life, so there is nothing to subscribe to;
// the server snapshot is false, so the notice only ever appears client-side.
const noSubscription = () => () => {};
const readGpc = () => (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true;

// The contact form's field and label styles (components/flagship/contact-form.tsx).
const FIELD =
  "h-12 w-full rounded-full border bg-white px-5 text-[15px] text-[#1a1a1a] outline-none placeholder:text-[#8f8a82] focus-visible:border-[#4B82A5] focus-visible:ring-2 focus-visible:ring-[#4B82A5]/30";
const LABEL = "text-[13px] tracking-[0.02em] text-[#4c5661]";

/**
 * One email field for a privacy request, built like the contact form:
 * the error under the field and focus moved to it, the button disabled only
 * while sending, a mailto fallback, and a hidden field for bots. When the
 * request lands, focus moves to the confirmation so a screen reader or
 * keyboard user isn't left on a button that no longer exists. Posts to
 * /api/privacy-requests.
 */
export default function PrivacyRequestForm({ kind }: { kind: PrivacyRequestKind }) {
  const copy = COPY[kind];
  const id = kind === "delete_account" ? "delete-account" : "privacy-choices";
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [topError, setTopError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState("");
  const gpc = useSyncExternalStore(noSubscription, readGpc, () => false);
  const startedAt = useRef(0);
  const emailRef = useRef<HTMLInputElement>(null);
  const doneRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    startedAt.current = Date.now();
  }, []);

  useEffect(() => {
    if (state === "done") doneRef.current?.focus();
  }, [state]);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (state === "sending") return;
    const fd = new FormData(e.currentTarget);
    const email = String(fd.get("email") ?? "").trim();
    setState("sending");
    setEmailError(null);
    setTopError(null);
    try {
      const res = await fetch("/api/privacy-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          email,
          company: fd.get("company") ?? "",
          elapsedMs: Date.now() - startedAt.current,
          ...(kind === "opt_out_vehicle_history" && gpc ? { gpc: true } : {}),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { errors?: { email?: string }; error?: string };
      if (res.ok) {
        setSentTo(email);
        setState("done");
        return;
      }
      setState("error");
      if (data.errors?.email) {
        setEmailError(data.errors.email);
        emailRef.current?.focus();
      } else {
        setTopError(data.error ?? `The request didn't go through. Email ${SUPPORT_EMAIL} and we'll handle it.`);
      }
    } catch {
      setState("error");
      setTopError(`The request didn't go through. Email ${SUPPORT_EMAIL} and we'll handle it.`);
    }
  }

  if (state === "done") {
    return (
      <div role="status" aria-live="polite" className="flex flex-col items-start gap-3">
        <span className="flex size-10 items-center justify-center rounded-full bg-[#EBF5FB] text-[#4B82A5]">
          <Check className="size-5" aria-hidden />
        </span>
        <p
          ref={doneRef}
          tabIndex={-1}
          className="text-[20px] leading-tight text-[#1a1a1a] outline-none"
          style={{ fontFamily: "var(--font-Petrona)" }}
        >
          {copy.doneTitle}
        </p>
        <p className="max-w-[56ch] text-[15px] leading-[1.6] text-[#4c5661]">{copy.doneBody(sentTo)}</p>
      </div>
    );
  }

  const describedBy = [`${id}-email-hint`, emailError ? `${id}-email-error` : null].filter(Boolean).join(" ");

  return (
    <form onSubmit={submit} noValidate className="flex max-w-[520px] flex-col gap-4">
      {/* Honeypot — hidden from people, filled by autofill bots. */}
      <div className="absolute -left-[9999px] top-0 h-px w-px overflow-hidden" aria-hidden="true">
        <label htmlFor={`${id}-company`}>Company</label>
        <input id={`${id}-company`} name="company" type="text" tabIndex={-1} autoComplete="off" />
      </div>

      {kind === "opt_out_vehicle_history" && gpc && (
        <p className="rounded-[16px] bg-[#EBF5FB] px-4 py-3 text-[14px] leading-[1.5] text-[#2f3a45]">
          Your browser is sending a Global Privacy Control signal. It&apos;s included with your request.
        </p>
      )}

      <div className="flex flex-col gap-2">
        <label htmlFor={`${id}-email`} className={LABEL}>
          Email on your Otopair account
        </label>
        <input
          ref={emailRef}
          id={`${id}-email`}
          name="email"
          type="email"
          inputMode="email"
          required
          autoComplete="email"
          spellCheck={false}
          placeholder="you@example.com"
          aria-invalid={!!emailError}
          aria-describedby={describedBy}
          className={`${FIELD} ${emailError ? "border-[#b04a3a]" : "border-[#1a1a1a]/12"}`}
        />
        <p id={`${id}-email-hint`} className="text-[13px] text-[#777169]">
          {copy.hint}
        </p>
        {emailError && (
          <p id={`${id}-email-error`} className="text-[13px] text-[#b04a3a]">
            {emailError}
          </p>
        )}
      </div>

      <div className="mt-1 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <PillButton type="submit" disabled={state === "sending"}>
          {state === "sending" ? "Sending…" : copy.button}
        </PillButton>
        <p className="text-[13px] leading-[1.5] text-[#777169]">
          Or email{" "}
          <a
            href={`mailto:${SUPPORT_EMAIL}`}
            className="text-[#4B82A5] underline decoration-[#4B82A5]/40 underline-offset-[3px] hover:decoration-[#4B82A5]"
          >
            {SUPPORT_EMAIL}
          </a>
        </p>
      </div>

      <p aria-live="polite" className={`text-[13px] text-[#b04a3a] ${topError ? "" : "sr-only"}`}>
        {topError ?? ""}
      </p>
    </form>
  );
}
