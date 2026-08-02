"use client";

import { useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { CheckCircle2, ChevronLeft, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PopIn, serif } from "@/components/flagship/landing/reveal";

const STEPS = [
  { key: "shop", title: "Your shop", helper: "The basics about your business." },
  { key: "contact", title: "How we reach you", helper: "Where we'll send your invite." },
  { key: "location", title: "Where you're located", helper: "Your shop's street address." },
] as const;

const inputClass =
  "w-full rounded-xl border border-[#1a1a1a]/12 bg-white px-4 py-3 text-[16px] text-[#1a1a1a] placeholder-[#777169] transition focus:border-[#5299fe]/50 focus:outline-none focus:ring-2 focus:ring-[#5299fe]/40";
const labelClass = "mb-1.5 block text-[14px] font-medium text-[#1a1a1a]";

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
    <div className="mx-auto flex min-h-screen w-full max-w-[560px] flex-col items-center justify-center px-5 py-28">
      <PopIn className="w-full">
        <div className="w-full rounded-3xl border border-[#1a1a1a]/8 bg-white p-8 shadow-[0_20px_60px_rgba(0,0,0,0.08)] sm:p-10">
          {submitted ? (
            <div className="flex flex-col items-center py-6 text-center">
              <CheckCircle2 className="size-12 text-[#457942]" strokeWidth={1.5} />
              <h1 className="mt-5 text-[28px] text-[#1a1a1a]" style={serif}>
                Application received
              </h1>
              <p className="mt-3 max-w-[38ch] text-[15px] leading-relaxed text-[#777169]">
                We&apos;ve emailed a receipt to <span className="text-[#1a1a1a]">{businessEmail}</span>.
                If approved, you&apos;ll get a private invite to set up your shop.
              </p>
              <Button asChild size="lg" className="mt-7 bg-[#5299fe] text-white hover:bg-[#5299fe]/90">
                <Link href="/">Back to home</Link>
              </Button>
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
                            ? "bg-[#5299fe] text-white"
                            : state === "done"
                              ? "bg-[#1a1a1a] text-white"
                              : "bg-[#1a1a1a]/10 text-[#777169]"
                        }`}
                      >
                        {state === "done" ? "✓" : i + 1}
                      </span>
                      {i < STEPS.length - 1 && (
                        <span
                          className={`mx-2 h-px flex-1 transition-colors ${
                            i < step ? "bg-[#1a1a1a]" : "bg-[#1a1a1a]/10"
                          }`}
                        />
                      )}
                    </div>
                  );
                })}
              </div>

              <h1 className="text-[26px] text-[#1a1a1a]" style={serif}>
                {STEPS[step].title}
              </h1>
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
                      <div>
                        <label htmlFor="streetAddress" className={labelClass}>
                          Street address
                        </label>
                        <input
                          id="streetAddress"
                          type="text"
                          autoComplete="street-address"
                          className={inputClass}
                          placeholder="123 Main St, Staten Island, NY 10301"
                          value={streetAddress}
                          onChange={(e) => setStreetAddress(e.target.value)}
                        />
                      </div>
                    )}
                  </motion.div>
                </AnimatePresence>

                {error && <p className="mt-4 text-[14px] text-red-600">{error}</p>}

                <div className="mt-8 flex gap-3">
                  {step > 0 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="lg"
                      onClick={goBack}
                      disabled={loading}
                      className="text-[#1a1a1a]"
                    >
                      <ChevronLeft className="size-4" />
                      Back
                    </Button>
                  )}
                  <Button
                    type="submit"
                    size="lg"
                    disabled={loading}
                    className="flex-1 bg-[#5299fe] text-white hover:bg-[#5299fe]/90"
                  >
                    {loading && <Loader2 className="size-4 animate-spin" />}
                    {isLast ? "Submit application" : "Continue"}
                  </Button>
                </div>
              </form>
            </>
          )}
        </div>
      </PopIn>

      {!submitted && (
        <p className="mt-6 text-center text-[13px] text-[#777169]">
          Already have an account?{" "}
          <Link href="/dashboard" className="text-[#5299fe] underline-offset-4 hover:underline">
            Sign in
          </Link>
        </p>
      )}
    </div>
  );
}
