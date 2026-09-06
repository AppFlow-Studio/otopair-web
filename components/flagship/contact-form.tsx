"use client";

import { useRef, useState, type FormEvent } from "react";
import { Check } from "lucide-react";
import { PillButton } from "./pill-button";
import { SUPPORT_EMAIL } from "@/lib/site";

type Lane = "driver" | "shop" | "data" | "press";
const LANES: { value: Lane; label: string }[] = [
  { value: "driver", label: "A driver" },
  { value: "shop", label: "A repair shop" },
  { value: "data", label: "Here for car data or the API" },
  { value: "press", label: "Press or a partner" },
];

const FIELD =
  "h-12 w-full rounded-full border bg-white px-5 text-[15px] text-[#1a1a1a] outline-none placeholder:text-[#8f8a82] focus-visible:border-[#4B82A5] focus-visible:ring-2 focus-visible:ring-[#4B82A5]/30";
const LABEL = "text-[13px] tracking-[0.02em] text-[#4c5661]";

/**
 * The contact form: four fields, inline errors under the field that has
 * them, focus moved to the first error on submit, the submit button
 * disabled only while the request is in flight, and a plain mailto
 * fallback under it in case the form itself is the problem. Posts to
 * /api/contact, which forwards to the support inbox.
 */
export default function ContactForm({ className }: { className?: string }) {
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [topError, setTopError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (state === "sending") return;
    const fd = new FormData(e.currentTarget);
    const payload = Object.fromEntries(fd.entries());
    setState("sending");
    setTopError(null);
    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => ({}))) as { errors?: Record<string, string>; error?: string };
      if (res.ok) {
        setState("done");
        return;
      }
      setErrors(data.errors ?? {});
      setTopError(data.errors ? null : (data.error ?? "The message did not send."));
      setState("error");
      const first = Object.keys(data.errors ?? {})[0];
      if (first) formRef.current?.querySelector<HTMLElement>(`[name="${first}"]`)?.focus();
    } catch {
      setTopError("The message did not send.");
      setState("error");
    }
  }

  if (state === "done") {
    return (
      <div role="status" aria-live="polite" className={`flex flex-col items-start gap-3 ${className ?? ""}`}>
        <span className="flex size-10 items-center justify-center rounded-full bg-[#EBF5FB] text-[#4B82A5]">
          <Check className="size-5" aria-hidden />
        </span>
        <p className="text-[20px] leading-tight text-[#1a1a1a]" style={{ fontFamily: "var(--font-Petrona)" }}>
          Sent. A person will reply.
        </p>
        <p className="text-[15px] leading-[1.6] text-[#4c5661]">
          It went to the Otopair team with your address as the reply-to, so the answer lands in your
          inbox.
        </p>
      </div>
    );
  }

  return (
    <form ref={formRef} onSubmit={submit} noValidate className={`flex flex-col gap-4 ${className ?? ""}`}>
      {/* Honeypot — hidden from people, filled by autofill bots. */}
      <div className="absolute -left-[9999px] top-0 h-px w-px overflow-hidden" aria-hidden="true">
        <label htmlFor="contact-company">Company</label>
        <input id="contact-company" name="company" type="text" tabIndex={-1} autoComplete="off" />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <label htmlFor="contact-name" className={LABEL}>
            Your name
          </label>
          <input
            id="contact-name"
            name="name"
            type="text"
            required
            autoComplete="name"
            placeholder="Maria Rossi"
            aria-invalid={!!errors.name}
            aria-describedby={errors.name ? "contact-name-error" : undefined}
            className={`${FIELD} ${errors.name ? "border-[#b04a3a]" : "border-[#1a1a1a]/12"}`}
          />
          {errors.name && (
            <p id="contact-name-error" className="text-[13px] text-[#b04a3a]">
              {errors.name}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <label htmlFor="contact-email" className={LABEL}>
            Email
          </label>
          <input
            id="contact-email"
            name="email"
            type="email"
            inputMode="email"
            required
            autoComplete="email"
            spellCheck={false}
            placeholder="you@example.com"
            aria-invalid={!!errors.email}
            aria-describedby={errors.email ? "contact-email-error" : undefined}
            className={`${FIELD} ${errors.email ? "border-[#b04a3a]" : "border-[#1a1a1a]/12"}`}
          />
          {errors.email && (
            <p id="contact-email-error" className="text-[13px] text-[#b04a3a]">
              {errors.email}
            </p>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="contact-lane" className={LABEL}>
          You are
        </label>
        <select
          id="contact-lane"
          name="lane"
          defaultValue="driver"
          autoComplete="off"
          className={`${FIELD} appearance-none border-[#1a1a1a]/12 bg-[url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2214%22 height=%2214%22 viewBox=%220 0 24 24%22 fill=%22none%22 stroke=%22%234c5661%22 stroke-width=%222%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22><path d=%22m6 9 6 6 6-6%22/></svg>')] bg-[length:14px] bg-[position:right_18px_center] bg-no-repeat pr-11 text-[#1a1a1a]`}
          style={{ backgroundColor: "#ffffff", color: "#1a1a1a" }}
        >
          {LANES.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="contact-message" className={LABEL}>
          What is going on
        </label>
        <textarea
          id="contact-message"
          name="message"
          required
          rows={5}
          autoComplete="off"
          placeholder="The booking, the car, or the question. Dates and shop names help…"
          aria-invalid={!!errors.message}
          aria-describedby={errors.message ? "contact-message-error" : undefined}
          className={`w-full rounded-[20px] border bg-white px-5 py-4 text-[15px] leading-[1.55] text-[#1a1a1a] outline-none placeholder:text-[#8f8a82] focus-visible:border-[#4B82A5] focus-visible:ring-2 focus-visible:ring-[#4B82A5]/30 ${
            errors.message ? "border-[#b04a3a]" : "border-[#1a1a1a]/12"
          }`}
        />
        {errors.message && (
          <p id="contact-message-error" className="text-[13px] text-[#b04a3a]">
            {errors.message}
          </p>
        )}
      </div>

      <div className="mt-1 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <PillButton type="submit" disabled={state === "sending"}>
          {state === "sending" ? "Sending…" : "Send message"}
        </PillButton>
        <p className="text-[13px] leading-[1.5] text-[#777169]">
          Or email{" "}
          <a href={`mailto:${SUPPORT_EMAIL}`} className="text-[#4B82A5] underline decoration-[#4B82A5]/40 underline-offset-[3px] hover:decoration-[#4B82A5]">
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
