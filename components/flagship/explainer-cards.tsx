"use client";

/* ------------------------------------------------------------------ */
/* The two cards Oto gained on 2026-09-07.                             */
/*                                                                     */
/* Everything Oto could previously put on screen explained OTOPAIR —   */
/* fourteen cards about pricing, rewards, coverage, trust. Nothing      */
/* explained a CAR. These two answer the questions visitors actually    */
/* arrive with: "what is this service and do I really need it" and      */
/* "my car is doing something, should I worry".                         */
/*                                                                     */
/* Both are built on OtoCard, so they inherit the shell, the header,    */
/* the panel fit and the fade at the cut for free — which is the point  */
/* of having a contract: a new card is now data plus a layout, not a    */
/* new set of decisions about padding.                                  */
/* ------------------------------------------------------------------ */

import { AlertTriangle, Gauge, ShieldAlert, Wrench } from "lucide-react";
import { Step } from "./shared";
import { OtoCard } from "./oto-card";
import {
  URGENCY_COPY,
  type ServiceExplainer,
  type SymptomExplainer,
} from "./oto-knowledge";

/** The "this is a safety item" line. Matches the agent prompt's own guardrail
 *  word for word in intent: for load-bearing systems the answer is always
 *  "get it inspected", never a reassurance. */
function SafetyNote({ delay, children }: { delay: number; children: React.ReactNode }) {
  return (
    <Step delay={delay} className="mt-4 flex items-start gap-2.5 rounded-xl bg-[#1a1a1a]/[0.05] px-4 py-3">
      <ShieldAlert className="mt-[1px] h-4 w-4 shrink-0 text-[#1a1a1a]" strokeWidth={1.8} />
      <p className="text-[12.5px] leading-snug text-[#1a1a1a]">{children}</p>
    </Step>
  );
}

/* ------------------------------------------------------------------ */
/* Service — what it is, what happens at the shop, why, when           */
/* ------------------------------------------------------------------ */
export function ServiceCard({ service }: { service: ServiceExplainer }) {
  return (
    <OtoCard icon={Wrench} title={service.service} subtitle={service.category}>
      <Step delay={0.14}>
        <p className="mt-4 text-[13.5px] leading-relaxed text-[#1a1a1a]">{service.what}</p>
      </Step>

      <Step delay={0.2}>
        <p className="mt-5 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#1a1a1a]/45">
          What happens at the shop
        </p>
      </Step>
      <ol className="mt-2 space-y-1.5">
        {service.shop.map((line, i) => (
          <Step
            key={line}
            delay={0.26 + i * 0.07}
            className="flex items-start gap-3 rounded-xl bg-[#1a1a1a]/[0.04] px-4 py-2.5"
          >
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#1a1a1a] text-[11px] font-semibold text-white">
              {i + 1}
            </span>
            <span className="text-[13px] leading-snug text-[#1a1a1a]">{line}</span>
          </Step>
        ))}
      </ol>

      <Step delay={0.26 + service.shop.length * 0.07}>
        <p className="mt-5 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#1a1a1a]/45">
          Why it matters
        </p>
        <p className="mt-1.5 text-[13px] leading-relaxed text-[#1a1a1a]">{service.why}</p>
      </Step>

      <Step delay={0.32 + service.shop.length * 0.07}>
        <p className="mt-4 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#1a1a1a]/45">
          When it&rsquo;s due
        </p>
        <p className="mt-1.5 text-[13px] leading-relaxed text-[#1a1a1a]">{service.due}</p>
      </Step>

      {service.safety && (
        <SafetyNote delay={0.4 + service.shop.length * 0.07}>
          This one is load-bearing. If anything feels off, have it inspected before you drive on it.
        </SafetyNote>
      )}

      {/* The interval deferral doubles as the reason to hand over a VIN — the
          card is honest that it cannot be specific without knowing the car. */}
      <Step delay={0.46 + service.shop.length * 0.07}>
        <p className="mt-4 text-[11px] leading-relaxed text-[#1a1a1a]/45">
          Intervals differ by car. Give Oto your VIN and it reads the schedule your car was actually built to.
        </p>
      </Step>
    </OtoCard>
  );
}

/* ------------------------------------------------------------------ */
/* Symptom — possibilities, urgency, what a mechanic checks            */
/* ------------------------------------------------------------------ */
export function SymptomCard({ symptom }: { symptom: SymptomExplainer }) {
  const u = URGENCY_COPY[symptom.urgency];
  const tone =
    symptom.urgency === "now"
      ? "bg-[#1a1a1a] text-white"
      : symptom.urgency === "soon"
        ? "bg-[#1a1a1a]/[0.08] text-[#1a1a1a]"
        : "bg-[#1a1a1a]/[0.05] text-[#1a1a1a]/70";

  return (
    <OtoCard
      icon={Gauge}
      title={symptom.symptom}
      subtitle="What it could be — not a diagnosis"
      aside={
        <Step delay={0.1}>
          <span className={`rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide ${tone}`}>
            {u.label}
          </span>
        </Step>
      }
    >
      <Step delay={0.16}>
        <p className="mt-4 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#1a1a1a]/45">
          Could be
        </p>
      </Step>
      <ul className="mt-2 space-y-1.5">
        {symptom.couldBe.map((c, i) => (
          <Step key={c} delay={0.22 + i * 0.07} className="flex items-start gap-2.5">
            <AlertTriangle className="mt-[3px] h-3.5 w-3.5 shrink-0 text-[#2f7bff]" strokeWidth={1.8} />
            <span className="text-[13px] leading-snug text-[#1a1a1a]">{c}</span>
          </Step>
        ))}
      </ul>

      <Step delay={0.24 + symptom.couldBe.length * 0.07}>
        <p className="mt-5 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#1a1a1a]/45">
          What a mechanic checks
        </p>
      </Step>
      <ul className="mt-2 space-y-1.5">
        {symptom.checks.map((c, i) => (
          <Step
            key={c}
            delay={0.3 + symptom.couldBe.length * 0.07 + i * 0.06}
            className="rounded-xl bg-[#1a1a1a]/[0.04] px-4 py-2.5 text-[13px] leading-snug text-[#1a1a1a]"
          >
            {c}
          </Step>
        ))}
      </ul>

      <SafetyNote delay={0.4 + (symptom.couldBe.length + symptom.checks.length) * 0.06}>
        {u.line}
        {symptom.safety ? " Anything load-bearing needs a real inspection to be sure." : ""}
      </SafetyNote>

      <Step delay={0.48 + (symptom.couldBe.length + symptom.checks.length) * 0.06}>
        <p className="mt-4 text-[11px] leading-relaxed text-[#1a1a1a]/45">
          Oto narrows down possibilities from what you describe. Only a mechanic putting hands on the car can confirm it.
        </p>
      </Step>
    </OtoCard>
  );
}
