"use client";

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";

const DELETION_REASONS = [
  "I'm closing my shop",
  "I'm switching to another service",
  "Missing features I need",
  "The cost is too high",
  "I'm taking a temporary break",
  "The user interface is unpleasant",
  "Support has not been optimal",
  "I'm having service-related issues",
  "My customers are dissatisfied  with the Otopair integration",
  "My reason isn't listed above",
];

type Step = "default" | "reasons" | "feedback" | "improvement" | "submitted";

function AnimatedStep({
  active,
  children,
}: {
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className="grid transition-all duration-300 ease-in-out"
      style={{ gridTemplateRows: active ? "1fr" : "0fr" }}
    >
      <div className="overflow-hidden">
        <div
          className={`transition-opacity duration-200 ${
            active ? "opacity-100 delay-150" : "opacity-0"
          }`}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

export function UserSupportPage() {
  const [step, setStep] = useState<Step>("default");
  const [selectedReason, setSelectedReason] = useState("");
  const [feedback, setFeedback] = useState("");
  const [improvement, setImprovement] = useState("");
  const submitDeletionRequest = useMutation(api.users.submitDeletionRequest);

  const handleSubmit = async () => {
    await submitDeletionRequest({ reason: selectedReason, feedback, improvement });
    setStep("submitted");
  };

  const isValidText = (text: string) =>
    text.trim().replace(/\s/g, "").length >= 10;

  return (
    <div>
      <h1 className="text-[1.0625rem] font-semibold text-foreground mb-1">
        Support
      </h1>
      <p className="text-sm text-muted-foreground mb-5">
        Need help with your account? Submit a deletion request below and our
        team will follow up with you.
      </p>

      <div className="border-t border-border">
        {/* Step 1: default */}
        <AnimatedStep active={step === "default"}>
          <div className="flex items-start justify-between gap-4 py-4">
            <div>
              <p className="text-[0.8125rem] font-medium text-foreground">
                Request account deletion
              </p>
              <p className="text-[0.8125rem] text-muted-foreground mt-0.5">
                Your data will be permanently removed.
              </p>
            </div>
            <button
              onClick={() => setStep("reasons")}
              className="shrink-0 text-[0.8125rem] font-medium text-destructive hover:text-destructive/80 transition-colors"
            >
              Request deletion
            </button>
          </div>
        </AnimatedStep>

        {/* Step 2: reasons */}
        <AnimatedStep active={step === "reasons"}>
          <div className="pt-4 pb-2">
            <p className="text-[0.875rem] font-semibold text-foreground mb-3">
              What is your main reason for requesting deletion?
            </p>
            <div className="space-y-2.5 mb-5">
              {DELETION_REASONS.map((reason) => (
                <label
                  key={reason}
                  className="flex items-center gap-3 cursor-pointer"
                >
                  <input
                    type="radio"
                    name="deletion-reason"
                    value={reason}
                    checked={selectedReason === reason}
                    onChange={() => setSelectedReason(reason)}
                    className="w-4 h-4 accent-primary"
                  />
                  <span className="text-[0.8125rem] text-foreground">
                    {reason}
                  </span>
                </label>
              ))}
            </div>
            <div className="flex items-center justify-end gap-3">
              <button
                onClick={() => {
                  setStep("default");
                  setSelectedReason("");
                }}
                className="px-4 py-2 rounded-md border border-input text-[0.8125rem] font-medium text-foreground hover:bg-muted transition-colors"
              >
                Go back
              </button>
              <button
                onClick={() => setStep("feedback")}
                disabled={!selectedReason}
                className="px-4 py-2 rounded-md bg-primary text-[0.8125rem] font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Continue
              </button>
            </div>
          </div>
        </AnimatedStep>

        {/* Step 3: feedback */}
        <AnimatedStep active={step === "feedback"}>
          <div className="pt-4 pb-2">
            <p className="text-[0.875rem] font-semibold text-foreground mb-2">
              Please share with us your reasoning.
            </p>
            <textarea
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              maxLength={500}
              rows={3}
              placeholder="Share any details..."
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-[0.8125rem] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-inset focus:ring-ring resize-none"
            />
            <p className="text-right text-[0.75rem] text-muted-foreground mt-1 mb-5">
              {feedback.length}/500
            </p>
            <div className="flex items-center justify-end gap-3">
              <button
                onClick={() => setStep("reasons")}
                className="px-4 py-2 rounded-md border border-input text-[0.8125rem] font-medium text-foreground hover:bg-muted transition-colors"
              >
                Go back
              </button>
              <button
                onClick={() => setStep("improvement")}
                disabled={!isValidText(feedback)}
                className="px-4 py-2 rounded-md bg-primary text-[0.8125rem] font-medium text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Continue
              </button>
            </div>
          </div>
        </AnimatedStep>

        {/* Step 4: improvement */}
        <AnimatedStep active={step === "improvement"}>
          <div className="pt-4 pb-2">
            <p className="text-[0.875rem] font-semibold text-foreground mb-2">
              What could we have done better to make a better experience for you?
            </p>
            <textarea
              value={improvement}
              onChange={(e) => setImprovement(e.target.value)}
              maxLength={500}
              rows={3}
              placeholder="Share any details..."
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-[0.8125rem] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-inset focus:ring-ring resize-none"
            />
            <p className="text-right text-[0.75rem] text-muted-foreground mt-1 mb-5">
              {improvement.length}/500
            </p>
            <div className="flex items-center justify-end gap-3">
              <button
                onClick={() => setStep("feedback")}
                className="px-4 py-2 rounded-md border border-input text-[0.8125rem] font-medium text-foreground hover:bg-muted transition-colors"
              >
                Go back
              </button>
              <button
                onClick={handleSubmit}
                disabled={!isValidText(improvement)}
                className="px-4 py-2 rounded-md bg-destructive text-[0.8125rem] font-medium text-destructive-foreground hover:bg-destructive/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Request deletion
              </button>
            </div>
          </div>
        </AnimatedStep>

        {/* Step 5: submitted */}
        <AnimatedStep active={step === "submitted"}>
          <div className="py-6 text-center">
            <p className="text-[0.9375rem] font-semibold text-foreground">
              Request submitted
            </p>
            <p className="text-sm text-muted-foreground mt-1">
              Our team will be in touch within 24 hours.
            </p>
          </div>
        </AnimatedStep>
      </div>
    </div>
  );
}
