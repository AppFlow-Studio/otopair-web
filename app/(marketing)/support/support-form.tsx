"use client";

import { useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { CheckCircle2, ChevronLeft, Loader2 } from "lucide-react";
import { PillButton, PillLink } from "@/components/flagship/pill-button";
import { serif } from "@/components/flagship/landing/reveal";

const STEPS = [
  { key: "you", title: "About you", helper: "How we reach you about this request." },
  { key: "issue", title: "Your issue", helper: "Tell us what happened so we can help." },
] as const;

const CATEGORIES = [
  { value: "charge_dispute", label: "Dispute a charge" },
  { value: "service_quality", label: "Service quality" },
  { value: "other", label: "Something else" },
] as const;

const inputClass =
  "h-12 w-full rounded-full border border-[#1a1a1a]/12 bg-white px-5 text-[15px] text-[#1a1a1a] outline-none placeholder:text-[#8f8a82] focus-visible:border-[#4B82A5] focus-visible:ring-2 focus-visible:ring-[#4B82A5]/30";
const areaClass =
  "w-full rounded-[20px] border border-[#1a1a1a]/12 bg-white px-5 py-3.5 text-[15px] text-[#1a1a1a] outline-none placeholder:text-[#8f8a82] focus-visible:border-[#4B82A5] focus-visible:ring-2 focus-visible:ring-[#4B82A5]/30";
const labelClass = "mb-1.5 block text-[13px] tracking-[0.02em] text-[#4c5661]";

export default function SupportForm() {
  const [step, setStep] = useState(0);
  const [customerName, setCustomerName] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [category, setCategory] = useState<string>("charge_dispute");
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [orderReference, setOrderReference] = useState("");
  const [shopNameText, setShopNameText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  function validateStep(s: number) {
    if (s === 0) {
      if (customerName.trim().length < 2) throw new Error("Please enter your name.");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail.trim())) {
        throw new Error("Please enter a valid email address.");
      }
      const digits = customerPhone.replace(/\D/g, "");
      if (customerPhone.trim() && digits.length < 10) {
        throw new Error("Please enter a valid phone number, or leave it blank.");
      }
    } else if (s === 1) {
      if (!category) throw new Error("Please choose a category.");
      if (subject.trim().length < 2) throw new Error("Please enter a short subject.");
      if (description.trim().length < 10) {
        throw new Error("Please describe your issue (at least 10 characters).");
      }
    }
  }

  function goBack() {
    setError(null);
    setStep((s) => Math.max(0, s - 1));
  }

  async function handleContinue(e: React.FormEvent) {
    e.preventDefault();
    try {
      validateStep(step);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Please check your entries.");
      return;
    }
    setError(null);
    if (step < STEPS.length - 1) {
      setStep((s) => s + 1);
      return;
    }
    await submit();
  }

  async function submit() {
    setLoading(true);
    try {
      const res = await fetch("/api/support/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerName,
          customerEmail,
          customerPhone,
          category,
          subject,
          description,
          orderReference,
          shopNameText,
          source: "support-web",
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setSubmitted(true);
      } else {
        setError(data?.error || "Something went wrong. Please try again.");
      }
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  const isLast = step === STEPS.length - 1;

  return (
    <div className="w-full">
      <div className="w-full">
        <div
          className="w-full rounded-[28px] bg-[#f7f6f3] p-6 tab:rounded-[40px] sm:p-8"
          style={{ boxShadow: "inset 0 0 0 1px rgba(26,26,26,0.06)" }}
        >
          {submitted ? (
            <div className="flex flex-col items-center py-6 text-center">
              <CheckCircle2 className="size-12 text-[#4B82A5]" strokeWidth={1.5} />
              <h1 className="mt-5 text-[28px] text-[#1a1a1a]" style={serif}>
                Request received
              </h1>
              <p className="mt-3 max-w-[40ch] text-[15px] leading-relaxed text-[#777169]">
                We&apos;ve emailed a copy to{" "}
                <span className="text-[#1a1a1a]">{customerEmail}</span>. Our team
                will review it and get back to you.
              </p>
              <PillLink href="/" className="mt-7">
                Back to home
              </PillLink>
            </div>
          ) : (
            <>
              {/* Progress stepper */}
              <div
                className="mb-8 flex items-center"
                aria-label={`Step ${step + 1} of ${STEPS.length}`}
              >
                {STEPS.map((s, i) => {
                  const state = i < step ? "done" : i === step ? "active" : "upcoming";
                  return (
                    <div key={s.key} className="flex flex-1 items-center last:flex-none">
                      <span
                        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold transition-colors ${
                          state === "active"
                            ? "bg-[#1a1a1a] text-white"
                            : state === "done"
                              ? "bg-[#4B82A5] text-white"
                              : "bg-white text-[#777169] ring-1 ring-[#1a1a1a]/10"
                        }`}
                      >
                        {state === "done" ? "✓" : i + 1}
                      </span>
                      {i < STEPS.length - 1 && (
                        <span
                          className={`mx-2 h-px flex-1 transition-colors ${
                            i < step ? "bg-[#4B82A5]" : "bg-[#1a1a1a]/10"
                          }`}
                        />
                      )}
                    </div>
                  );
                })}
              </div>

              <h2 className="text-[26px] text-[#1a1a1a]" style={serif}>
                {STEPS[step].title}
              </h2>
              <p className="mt-1 text-[14px] text-[#777169]">{STEPS[step].helper}</p>

              <form onSubmit={handleContinue} className="mt-7">
                <AnimatePresence mode="wait">
                  <motion.div
                    key={step}
                    data-reveal
                    initial={{ opacity: 0, x: 12 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -12 }}
                    transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
                    className="space-y-5"
                  >
                    {step === 0 && (
                      <>
                        <div>
                          <label htmlFor="customerName" className={labelClass}>
                            Your name
                          </label>
                          <input
                            id="customerName"
                            type="text"
                            autoComplete="name"
                            className={inputClass}
                            placeholder="e.g. Jordan Rivera"
                            value={customerName}
                            onChange={(e) => setCustomerName(e.target.value)}
                          />
                        </div>
                        <div>
                          <label htmlFor="customerEmail" className={labelClass}>
                            Email
                          </label>
                          <input
                            id="customerEmail"
                            type="email"
                            autoComplete="email"
                            className={inputClass}
                            placeholder="you@example.com"
                            value={customerEmail}
                            onChange={(e) => setCustomerEmail(e.target.value)}
                          />
                        </div>
                        <div>
                          <label htmlFor="customerPhone" className={labelClass}>
                            Phone <span className="text-[#8f8a82]">(optional)</span>
                          </label>
                          <input
                            id="customerPhone"
                            type="tel"
                            autoComplete="tel"
                            inputMode="tel"
                            className={inputClass}
                            placeholder="(718) 555-0123"
                            value={customerPhone}
                            onChange={(e) => setCustomerPhone(e.target.value)}
                          />
                        </div>
                      </>
                    )}

                    {step === 1 && (
                      <>
                        <div>
                          <label htmlFor="category" className={labelClass}>
                            What&apos;s this about?
                          </label>
                          <select
                            id="category"
                            className={inputClass}
                            value={category}
                            onChange={(e) => setCategory(e.target.value)}
                          >
                            {CATEGORIES.map((c) => (
                              <option key={c.value} value={c.value}>
                                {c.label}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label htmlFor="subject" className={labelClass}>
                            Subject
                          </label>
                          <input
                            id="subject"
                            type="text"
                            className={inputClass}
                            placeholder="e.g. Charged more than my quote"
                            value={subject}
                            onChange={(e) => setSubject(e.target.value)}
                          />
                        </div>
                        <div>
                          <label htmlFor="description" className={labelClass}>
                            What happened?
                          </label>
                          <textarea
                            id="description"
                            rows={5}
                            className={areaClass}
                            placeholder="Tell us the details — what you were charged, what you expected, and anything else that helps."
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                          />
                        </div>
                        <div>
                          <label htmlFor="orderReference" className={labelClass}>
                            Order / invoice number{" "}
                            <span className="text-[#8f8a82]">(if you have it)</span>
                          </label>
                          <input
                            id="orderReference"
                            type="text"
                            className={inputClass}
                            placeholder="e.g. INV-2026-000123"
                            value={orderReference}
                            onChange={(e) => setOrderReference(e.target.value)}
                          />
                        </div>
                        <div>
                          <label htmlFor="shopNameText" className={labelClass}>
                            Shop name <span className="text-[#8f8a82]">(if you know it)</span>
                          </label>
                          <input
                            id="shopNameText"
                            type="text"
                            className={inputClass}
                            placeholder="e.g. Bay Ridge Motors"
                            value={shopNameText}
                            onChange={(e) => setShopNameText(e.target.value)}
                          />
                        </div>
                      </>
                    )}
                  </motion.div>
                </AnimatePresence>

                {error && (
                  <p role="alert" className="mt-4 text-[14px] text-[#b04a3a]">
                    {error}
                  </p>
                )}

                <div className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-3">
                  <PillButton type="submit" disabled={loading}>
                    {loading ? (
                      <span className="inline-flex items-center gap-2">
                        <Loader2 className="size-4 animate-spin" />
                        {isLast ? "Submitting…" : "Working…"}
                      </span>
                    ) : isLast ? (
                      "Submit request"
                    ) : (
                      "Continue"
                    )}
                  </PillButton>
                  {step > 0 && (
                    <button
                      type="button"
                      onClick={goBack}
                      disabled={loading}
                      className="inline-flex items-center gap-1 text-[14px] text-[#4c5661] underline decoration-[#1a1a1a]/25 underline-offset-[4px] transition-colors hover:text-[#1a1a1a] hover:decoration-[#1a1a1a] disabled:opacity-60"
                    >
                      <ChevronLeft className="size-4" />
                      Back
                    </button>
                  )}
                </div>
              </form>
            </>
          )}
        </div>
      </div>

      {!submitted && (
        <p className="mt-4 text-[13px] text-[#4c5661]">
          Have an account?{" "}
          <Link
            href="/dashboard"
            className="text-[#4B82A5] underline decoration-[#4B82A5]/40 underline-offset-[3px] hover:decoration-[#4B82A5]"
          >
            Sign in
          </Link>
        </p>
      )}
    </div>
  );
}
