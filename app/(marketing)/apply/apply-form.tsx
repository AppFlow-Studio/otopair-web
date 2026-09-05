"use client";

import { useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { CheckCircle2, ChevronLeft, Loader2 } from "lucide-react";
import { PillButton, PillLink } from "@/components/flagship/pill-button";
import { serif } from "@/components/flagship/landing/reveal";
import { useAddressAutocomplete } from "./use-address-autocomplete";

const STEPS = [
  { key: "shop", title: "Your shop", helper: "The basics about your business." },
  { key: "contact", title: "How we reach you", helper: "Where we'll send your invite." },
  { key: "location", title: "Where you're located", helper: "Your shop's street address." },
] as const;

const inputClass =
  "h-12 w-full rounded-full border border-[#1a1a1a]/12 bg-white px-5 text-[15px] text-[#1a1a1a] outline-none placeholder:text-[#8f8a82] focus-visible:border-[#4B82A5] focus-visible:ring-2 focus-visible:ring-[#4B82A5]/30";
const labelClass = "mb-1.5 block text-[13px] tracking-[0.02em] text-[#4c5661]";

export default function ApplyForm() {
  const [step, setStep] = useState(0);
  const [shopLegalName, setShopLegalName] = useState("");
  const [ownerFullName, setOwnerFullName] = useState("");
  const [businessEmail, setBusinessEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [streetAddress, setStreetAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const address = useAddressAutocomplete((value) => setStreetAddress(value));

  function validateStep(s: number) {
    if (s === 0) {
      if (shopLegalName.trim().length < 2) throw new Error("Please enter your shop's legal name.");
      if (ownerFullName.trim().length < 2) throw new Error("Please enter the owner's full name.");
    } else if (s === 1) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(businessEmail.trim())) {
        throw new Error("Please enter a valid business email address.");
      }
      if (phone.replace(/\D/g, "").length < 10) {
        throw new Error("Please enter a valid phone number.");
      }
    } else if (s === 2) {
      if (streetAddress.trim().length < 5) throw new Error("Please enter your shop's street address.");
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
      const res = await fetch("/api/applications/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shopLegalName,
          ownerFullName,
          businessEmail,
          phone,
          streetAddress,
          source: "apply-direct",
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
        <div className="w-full rounded-[28px] bg-[#f7f6f3] p-6 tab:rounded-[40px] sm:p-8" style={{ boxShadow: "inset 0 0 0 1px rgba(26,26,26,0.06)" }}>
          {submitted ? (
            <div className="flex flex-col items-center py-6 text-center">
              <CheckCircle2 className="size-12 text-[#4B82A5]" strokeWidth={1.5} />
              <h1 className="mt-5 text-[28px] text-[#1a1a1a]" style={serif}>
                Application received
              </h1>
              <p className="mt-3 max-w-[38ch] text-[15px] leading-relaxed text-[#777169]">
                We&apos;ve emailed a receipt to <span className="text-[#1a1a1a]">{businessEmail}</span>.
                If approved, you&apos;ll get a private invite to set up your shop.
              </p>
              <PillLink href="/for-shops" className="mt-7">
                See the dashboard tour
              </PillLink>
            </div>
          ) : (
            <>
              {/* Progress stepper */}
              <div className="mb-8 flex items-center" aria-label={`Step ${step + 1} of ${STEPS.length}`}>
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
                    initial={{ opacity: 0, x: 12 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -12 }}
                    transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
                    className="space-y-5"
                  >
                    {step === 0 && (
                      <>
                        <div>
                          <label htmlFor="shopLegalName" className={labelClass}>
                            Shop legal name
                          </label>
                          <input
                            id="shopLegalName"
                            type="text"
                            autoComplete="organization"
                            className={inputClass}
                            placeholder="e.g. Bay Ridge Motors LLC"
                            value={shopLegalName}
                            onChange={(e) => setShopLegalName(e.target.value)}
                          />
                        </div>
                        <div>
                          <label htmlFor="ownerFullName" className={labelClass}>
                            Owner full name
                          </label>
                          <input
                            id="ownerFullName"
                            type="text"
                            autoComplete="name"
                            className={inputClass}
                            placeholder="e.g. Jordan Rivera"
                            value={ownerFullName}
                            onChange={(e) => setOwnerFullName(e.target.value)}
                          />
                        </div>
                      </>
                    )}

                    {step === 1 && (
                      <>
                        <div>
                          <label htmlFor="businessEmail" className={labelClass}>
                            Business email
                          </label>
                          <input
                            id="businessEmail"
                            type="email"
                            autoComplete="email"
                            className={inputClass}
                            placeholder="you@yourshop.com"
                            value={businessEmail}
                            onChange={(e) => setBusinessEmail(e.target.value)}
                          />
                        </div>
                        <div>
                          <label htmlFor="phone" className={labelClass}>
                            Phone number
                          </label>
                          <input
                            id="phone"
                            type="tel"
                            autoComplete="tel"
                            inputMode="tel"
                            className={inputClass}
                            placeholder="(718) 555-0123"
                            value={phone}
                            onChange={(e) => setPhone(e.target.value)}
                          />
                        </div>
                      </>
                    )}

                    {step === 2 && (
                      <div className="relative">
                        <label htmlFor="streetAddress" className={labelClass}>
                          Street address
                        </label>
                        <input
                          id="streetAddress"
                          type="text"
                          autoComplete="off"
                          role="combobox"
                          aria-expanded={address.suggestions.length > 0}
                          aria-autocomplete="list"
                          className={inputClass}
                          placeholder="Start typing your shop's address…"
                          value={streetAddress}
                          onChange={(e) => {
                            const value = e.target.value;
                            setStreetAddress(value);
                            address.search(value);
                          }}
                          onKeyDown={address.handleKeyDown}
                          onBlur={() => window.setTimeout(() => address.clear(), 150)}
                        />
                        {(address.loading || address.suggestions.length > 0) && (
                          <div className="absolute left-0 right-0 top-full z-20 mt-2 overflow-hidden rounded-[18px] border border-[#1a1a1a]/12 bg-white shadow-[0_12px_40px_rgba(0,0,0,0.14)]">
                            {address.loading && address.suggestions.length === 0 ? (
                              <div className="flex items-center gap-2 px-4 py-3 text-[14px] text-[#777169]">
                                <Loader2 className="size-4 animate-spin" />
                                Looking up addresses…
                              </div>
                            ) : (
                              address.suggestions.map((entry, index) => (
                                <button
                                  key={entry.id}
                                  type="button"
                                  onMouseDown={(e) => e.preventDefault()}
                                  onClick={() => void address.choose(entry)}
                                  onMouseEnter={() => address.setHighlight(index)}
                                  className={`block w-full border-b border-[#1a1a1a]/8 px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-[#f5f5f3] ${
                                    address.highlight === index ? "bg-[#f5f5f3]" : ""
                                  }`}
                                >
                                  <div className="text-[14px] font-medium text-[#1a1a1a]">
                                    {entry.primaryText}
                                  </div>
                                  {entry.secondaryText && (
                                    <div className="mt-0.5 text-[12px] text-[#777169]">
                                      {entry.secondaryText}
                                    </div>
                                  )}
                                </button>
                              ))
                            )}
                          </div>
                        )}
                        <p className="mt-1.5 text-[13px] text-[#777169]">
                          Start typing and pick your address from the list.
                        </p>
                      </div>
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
                      "Submit application"
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
          Already have an account?{" "}
          <Link href="/dashboard" className="text-[#4B82A5] underline decoration-[#4B82A5]/40 underline-offset-[3px] hover:decoration-[#4B82A5]">
            Sign in
          </Link>
        </p>
      )}
    </div>
  );
}
