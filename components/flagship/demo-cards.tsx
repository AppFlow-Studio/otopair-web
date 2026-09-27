"use client";

import Link from "next/link";
import {
  ArrowUpRight,
  BadgeCheck,
  Bell,
  CalendarClock,
  Check,
  ChevronRight,
  CircleDot,
  ClipboardList,
  CreditCard,
  FileText,
  Gift,
  MapPin,
  Receipt,
  ShieldCheck,
  Sparkles,
  Star,
  Wrench,
  X,
} from "lucide-react";
import { motion } from "motion/react";
import { CARD, CardHead, OtoCard } from "./oto-card";
import {
  BOOKINGS_DEMO,
  CHECKIN_DEMO,
  COVERAGE_DEMO,
  HEALTH_DEMO,
  NOTIFICATIONS_DEMO,
  OVERVIEW_DEMO,
  PAYMENTS_DEMO,
  PRICING_DEMO,
  RATINGS_DEMO,
  REWARDS_DEMO,
  SERVICE_CATALOG,
  SERVICE_HISTORY_DEMO,
  TIRE_QUOTE_STEPS,
  TRUST_DEMO,
  type DemoFeature,
} from "./oto-flow";
import { CountUp, Step } from "./shared";


// Re-exported so existing importers keep resolving to the single definition.
export { CARD };

const usd = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const EASE = [0.22, 1, 0.36, 1] as const;

/** Checklist whose rows slide in one-by-one. */
function CheckList({ items, base = 0.18 }: { items: string[]; base?: number }) {
  return (
    <ul className="mt-4 space-y-2">
      {items.map((it, i) => (
        <motion.li
          key={it}
          initial={{ opacity: 0, x: -8 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: base + i * 0.06, duration: 0.45, ease: EASE }}
          className="flex items-start gap-2 text-[13px] leading-snug text-[#1a1a1a]"
        >
          <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#2f7bff]" /> {it}
        </motion.li>
      ))}
    </ul>
  );
}

/** Pills that pop in with a tiny stagger. */
function Pills({ items, base = 0.18 }: { items: string[]; base?: number }) {
  return (
    <div className="mt-3 flex flex-wrap gap-1.5">
      {items.map((it, i) => (
        <motion.span
          key={it}
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: base + i * 0.04, duration: 0.35, ease: EASE }}
          className="rounded-lg bg-[#1a1a1a]/[0.05] px-2.5 py-1 text-[12px] text-[#1a1a1a]"
        >
          {it}
        </motion.span>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Service Catalog                                                     */
/* ------------------------------------------------------------------ */
export function ServiceCatalogCard() {
  return (
    <OtoCard
      icon={Wrench}
      title="Service Catalog"
      subtitle={`Everything bookable at launch · ${SERVICE_CATALOG.length} categories`}
    >
      <div className="mt-4 space-y-3">
        {SERVICE_CATALOG.map((cat, i) => (
          <Step key={cat.category} delay={0.15 + i * 0.07}>
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#1a1a1a]/45">
              {cat.category}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {cat.services.map((s) => (
                <span
                  key={s}
                  className="rounded-lg bg-[#1a1a1a]/[0.05] px-2.5 py-1 text-[12px] text-[#1a1a1a]"
                >
                  {s}
                </span>
              ))}
            </div>
          </Step>
        ))}
      </div>
    </OtoCard>
  );
}

/* ------------------------------------------------------------------ */
/* Pricing — line items, total locked before you confirm                */
/* ------------------------------------------------------------------ */
export function PricingCard() {
  const lineBase = 0.16;
  const totalDelay = lineBase + PRICING_DEMO.lines.length * 0.08 + 0.05;
  return (
    <OtoCard
      icon={Receipt}
      title="Transparent pricing"
      subtitle={`Sample · ${PRICING_DEMO.service} · the full total before you book`}
      footer={
        <div className="mt-4 border-t border-[#1a1a1a]/10 pt-3">
          <Link
            href="/pricing"
            className="flex w-full items-center justify-between rounded-xl bg-[#1a1a1a] px-4 py-2.5 text-[13px] font-medium text-white shadow-sm transition-all hover:bg-[#5299fe] hover:shadow"
          >
            <span>Read full pricing details & guarantee</span>
            <ArrowUpRight className="h-4 w-4" />
          </Link>
        </div>
      }
    >
      <div className="mt-4 space-y-1">
        {PRICING_DEMO.lines.map((line, i) => (
          <Step
            key={line.label}
            delay={lineBase + i * 0.08}
            className={`flex items-center justify-between rounded-xl px-4 py-2.5 ${
              line.emphasize ? "bg-[#2f7bff]/10 ring-1 ring-[#2f7bff]/25" : "bg-[#1a1a1a]/[0.04]"
            }`}
          >
            <span className="flex items-center gap-2 text-[13.5px] text-[#1a1a1a]">
              {line.label}
              {line.note && (
                <span
                  className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                    line.emphasize ? "bg-[#2f7bff] text-white" : "bg-[#1a1a1a]/10 text-[#1a1a1a]/60"
                  }`}
                >
                  {line.note}
                </span>
              )}
            </span>
            <span className="text-[13.5px] font-medium text-[#1a1a1a]">{usd(line.amount)}</span>
          </Step>
        ))}
      </div>

      <Step delay={totalDelay} className="mt-3 flex items-center justify-between border-t border-[#1a1a1a]/10 pt-3">
        <span className="text-[14px] font-medium text-[#1a1a1a]">Total</span>
        <CountUp
          to={PRICING_DEMO.total}
          decimals={2}
          prefix="$"
          duration={1}
          className="text-[18px] font-semibold text-[#1a1a1a]"
        />
      </Step>

      <Step delay={totalDelay + 0.1}>
        <p className="mt-3 text-[11px] leading-relaxed text-[#1a1a1a]/45">
          A sample — the brake-pad example from our pricing page. Each shop sets its own price, built for
          your exact car, and the total you approve is the most you pay unless you say yes to more in the app.
        </p>
      </Step>
    </OtoCard>
  );
}

/* ------------------------------------------------------------------ */
/* Vehicle Health Score                                                */
/* ------------------------------------------------------------------ */
export function HealthScoreCard() {
  const { score, status, recommendations } = HEALTH_DEMO;
  const r = 42;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - score / 100);

  return (
    <OtoCard
      icon={ShieldCheck}
      title="Vehicle Health"
      subtitle="Sample car · how the score looks in the app"
      footer={
        <div className="mt-4 border-t border-[#1a1a1a]/10 pt-3">
          <Link
            href="/vehicle-health-score"
            className="flex w-full items-center justify-between rounded-xl bg-[#1a1a1a] px-4 py-2.5 text-[13px] font-medium text-white shadow-sm transition-all hover:bg-[#5299fe] hover:shadow"
          >
            <span>Learn how Vehicle Health Score works</span>
            <ArrowUpRight className="h-4 w-4" />
          </Link>
        </div>
      }
    >

      <Step delay={0.15} className="mt-4 flex items-center gap-5">
        <div className="relative h-[110px] w-[110px] shrink-0">
          <svg className="h-full w-full -rotate-90" viewBox="0 0 100 100">
            <circle cx="50" cy="50" r={r} fill="none" stroke="#1a1a1a" strokeOpacity="0.08" strokeWidth="8" />
            <motion.circle
              cx="50"
              cy="50"
              r={r}
              fill="none"
              stroke="#2f7bff"
              strokeWidth="8"
              strokeLinecap="round"
              strokeDasharray={circ}
              initial={{ strokeDashoffset: circ }}
              animate={{ strokeDashoffset: offset }}
              transition={{ duration: 1.3, ease: EASE, delay: 0.35 }}
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <CountUp to={score} duration={1.3} className="text-[28px] font-semibold leading-none text-[#1a1a1a]" />
            <span className="text-[11px] text-[#1a1a1a]/45">/ 100</span>
          </div>
        </div>
        <div>
          <p className="text-[15px] font-medium text-[#1a1a1a]">{status}</p>
          <p className="mt-1 max-w-[180px] text-[12px] leading-relaxed text-[#1a1a1a]/55">
            How well your car&rsquo;s upkeep is keeping up — upkeep, not a diagnosis.
          </p>
        </div>
      </Step>

      <div className="mt-4 space-y-2">
        {recommendations.map((rec, i) => (
          <Step
            key={rec.title}
            delay={0.45 + i * 0.1}
            className="flex items-center justify-between rounded-xl bg-[#1a1a1a]/[0.04] px-4 py-2.5"
          >
            <div>
              <p className="text-[13.5px] text-[#1a1a1a]">{rec.title}</p>
              <p className="text-[11.5px] text-[#1a1a1a]/45">{rec.detail}</p>
            </div>
            <span className="flex items-center gap-1 text-[12px] font-medium text-[#2f7bff]">
              +{rec.gain}
              <ChevronRight className="h-3.5 w-3.5" />
            </span>
          </Step>
        ))}
      </div>

      <Step delay={0.7}>
        <p className="mt-3 flex items-center gap-1.5 text-[11px] text-[#1a1a1a]/45">
          <Check className="h-3 w-3" /> A completed service updates the items it touches. Not a safety rating.
        </p>
      </Step>
    </OtoCard>
  );
}

/* ------------------------------------------------------------------ */
/* Tires — quote request flow                                          */
/* ------------------------------------------------------------------ */
export function TiresCard() {
  return (
    <OtoCard icon={CircleDot} title="New tires" subtitle="Post a request — shops quote the exact tire">

      <div className="mt-4 space-y-2">
        {TIRE_QUOTE_STEPS.map((t, i) => (
          <Step key={t.step} delay={0.15 + i * 0.09} className="rounded-xl bg-[#1a1a1a]/[0.04] px-4 py-3">
            <div className="flex items-center gap-2.5">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#1a1a1a] text-[11px] font-semibold text-white">
                {i + 1}
              </span>
              <span className="text-[14px] font-medium text-[#1a1a1a]">{t.step}</span>
            </div>
            <p className="mt-0.5 pl-[30px] text-[12px] leading-snug text-[#1a1a1a]/55">{t.blurb}</p>
          </Step>
        ))}
      </div>

      <Step delay={0.45} className="mt-4 flex items-center gap-2 rounded-xl bg-[#2f7bff]/10 px-4 py-3">
        <span className="flex gap-1" aria-hidden>
          {[0, 1, 2].map((i) => (
            <motion.span
              key={i}
              className="h-1.5 w-1.5 rounded-full bg-[#2f7bff]"
              animate={{ opacity: [0.3, 1, 0.3] }}
              transition={{ duration: 1, repeat: Infinity, delay: i * 0.2 }}
            />
          ))}
        </span>
        <span className="text-[12.5px] text-[#1a1a1a]">Shops quote the exact tire for your car…</span>
      </Step>

      <Step delay={0.55}>
        <p className="mt-3 text-[11px] leading-relaxed text-[#1a1a1a]/45">
          Each quote names the tire, the price per tire, labor, the total and a time the shop can
          offer. Free to cancel until you accept one.
        </p>
      </Step>
    </OtoCard>
  );
}

/* ------------------------------------------------------------------ */
/* Ratings — mechanic profile                                          */
/* ------------------------------------------------------------------ */
function Stars({ value }: { value: number }) {
  return (
    <span className="inline-flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((n) => (
        <motion.span
          key={n}
          initial={{ opacity: 0, scale: 0.4 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.3 + n * 0.06, duration: 0.3, ease: EASE }}
        >
          <Star
            className={`h-3.5 w-3.5 ${
              n <= Math.round(value) ? "fill-[#1a1a1a] text-[#1a1a1a]" : "text-[#1a1a1a]/20"
            }`}
          />
        </motion.span>
      ))}
    </span>
  );
}

export function RatingsCard() {
  const r = RATINGS_DEMO;
  return (
    <OtoCard
      icon={Star}
      title="Ratings"
      subtitle="Only from drivers who completed a booking"
      footer={
        <div className="mt-4 border-t border-[#1a1a1a]/10 pt-3">
          <Link
            href="/shops"
            className="flex w-full items-center justify-between rounded-xl bg-[#1a1a1a] px-4 py-2.5 text-[13px] font-medium text-white shadow-sm transition-all hover:bg-[#5299fe] hover:shadow"
          >
            <span>Browse all verified Staten Island shops</span>
            <ArrowUpRight className="h-4 w-4" />
          </Link>
        </div>
      }
    >
      <Step delay={0.12} className="mt-4 flex items-center gap-3">
        <div className="min-w-0">
          <p className="truncate text-[16px] font-medium text-[#1a1a1a]">{r.shop}</p>
          <p className="text-[12px] text-[#1a1a1a]/45">Verified shop profile · Staten Island, NY</p>
        </div>
        <span className="ml-auto flex shrink-0 items-center gap-1 rounded-full bg-[#10b981]/10 px-2 py-1 text-[10px] font-medium text-[#059669]">
          <BadgeCheck className="h-3.5 w-3.5" /> Verified
        </span>
      </Step>

      <Step delay={0.15} className="mt-4 flex items-center gap-3">
        <CountUp to={r.overall} decimals={1} className="text-[28px] font-semibold leading-none text-[#1a1a1a]" />
        <div>
          <Stars value={r.overall} />
          <p className="mt-0.5 text-[11.5px] text-[#1a1a1a]/45">{r.reviews} reviews from completed bookings</p>
        </div>
      </Step>

      <CheckList items={r.rules} base={0.28} />

      <Step delay={0.7}>
        <p className="mt-4 text-[11px] text-[#1a1a1a]/45">
          Every shop is reviewed and approved by Otopair&rsquo;s team and passes Otopair&rsquo;s
          checks before going live.
        </p>
      </Step>
    </OtoCard>
  );
}

/* ------------------------------------------------------------------ */
/* Rewards — Ownership Credit                                          */
/* ------------------------------------------------------------------ */
export function RewardsCard() {
  const r = REWARDS_DEMO;
  return (
    <OtoCard icon={Gift} title="Ownership Credit" subtitle={`“${r.motto}”`}>

      <Step delay={0.16} className="mt-4 flex items-end justify-between rounded-xl bg-[#1a1a1a] px-4 py-4 text-white">
        <div>
          <p className="text-[11px] uppercase tracking-wide text-white/55">In the app</p>
          <p className="text-[20px] font-semibold leading-tight">Coming soon</p>
        </div>
        <span className="rounded-full bg-white/15 px-2.5 py-1 text-[11px] font-medium">Not switched on yet</span>
      </Step>

      <Step delay={0.28}>
        <p className="mt-4 mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#1a1a1a]/45">
          What credit is for
        </p>
      </Step>
      <div className="space-y-2">
        {r.earn.map((action, i) => (
          <Step
            key={action}
            delay={0.34 + i * 0.08}
            className="flex items-center justify-between rounded-xl bg-[#1a1a1a]/[0.04] px-4 py-2.5"
          >
            <span className="text-[13px] text-[#1a1a1a]">{action}</span>
            <Check className="h-3.5 w-3.5 text-[#2f7bff]" />
          </Step>
        ))}
      </div>

      <Step delay={0.7}>
        <p className="mt-3 text-[11px] text-[#1a1a1a]/45">
          Real dollars, not points. How credit is earned, what it&apos;s worth and how you use it will be
          shown in the app when rewards are switched on.
        </p>
      </Step>
    </OtoCard>
  );
}

/* ------------------------------------------------------------------ */
/* Overview                                                            */
/* ------------------------------------------------------------------ */
export function OverviewCard() {
  return (
    <OtoCard
      icon={Sparkles}
      title="What Otopair is"
      subtitle={OVERVIEW_DEMO.tagline}
      footer={
        <div className="mt-4 border-t border-[#1a1a1a]/10 pt-3">
          <Link
            href="/about"
            className="flex w-full items-center justify-between rounded-xl bg-[#1a1a1a] px-4 py-2.5 text-[13px] font-medium text-white shadow-sm transition-all hover:bg-[#5299fe] hover:shadow"
          >
            <span>Learn more about Otopair</span>
            <ArrowUpRight className="h-4 w-4" />
          </Link>
        </div>
      }
    >
      <CheckList items={OVERVIEW_DEMO.facts} base={0.16} />
    </OtoCard>
  );
}

/* ------------------------------------------------------------------ */
/* Coverage                                                            */
/* ------------------------------------------------------------------ */
export function CoverageCard() {
  return (
    <OtoCard
      icon={MapPin}
      title="Where it works"
      footer={
        <div className="mt-4 border-t border-[#1a1a1a]/10 pt-3">
          <Link
            href="/coverage"
            className="flex w-full items-center justify-between rounded-xl bg-[#1a1a1a] px-4 py-2.5 text-[13px] font-medium text-white shadow-sm transition-all hover:bg-[#5299fe] hover:shadow"
          >
            <span>View borough expansion schedule</span>
            <ArrowUpRight className="h-4 w-4" />
          </Link>
        </div>
      }
    >
      <Step delay={0.15} className="mt-4 rounded-xl bg-[#1a1a1a] px-4 py-4 text-white">
        <p className="text-[11px] uppercase tracking-wide text-white/55">Live now</p>
        <p className="text-[22px] font-medium leading-tight">{COVERAGE_DEMO.launch}</p>
        <p className="text-[12px] text-white/55">{COVERAGE_DEMO.date}</p>
      </Step>
      <Step delay={0.27}>
        <p className="mt-4 text-[12px] font-semibold uppercase tracking-[0.12em] text-[#1a1a1a]/45">
          Planned next, borough by borough
        </p>
      </Step>
      <Pills items={COVERAGE_DEMO.expansion} base={0.32} />
      <Step delay={0.46}>
        <p className="mt-3 text-[11px] text-[#1a1a1a]/45">{COVERAGE_DEMO.note}</p>
      </Step>
    </OtoCard>
  );
}

/* ------------------------------------------------------------------ */
/* Payments                                                            */
/* ------------------------------------------------------------------ */
export function PaymentsCard() {
  return (
    <OtoCard icon={CreditCard} title="Payments" subtitle="Pay your way — securely">
      <Pills items={PAYMENTS_DEMO.methods} base={0.15} />
      <CheckList items={PAYMENTS_DEMO.points} base={0.3} />
    </OtoCard>
  );
}

/* ------------------------------------------------------------------ */
/* Service history upload                                              */
/* ------------------------------------------------------------------ */
export function ServiceHistoryCard() {
  return (
    <OtoCard icon={FileText} title="Service history" subtitle={SERVICE_HISTORY_DEMO.accepts}>
      <CheckList items={SERVICE_HISTORY_DEMO.benefits} base={0.15} />
      <Step delay={0.34} className="mt-4 flex items-center gap-2 rounded-xl bg-[#2f7bff]/10 px-4 py-2.5 text-[12.5px] font-medium text-[#1a1a1a]">
        <Gift className="h-4 w-4 text-[#2f7bff]" /> {SERVICE_HISTORY_DEMO.reward}
      </Step>
    </OtoCard>
  );
}

/* ------------------------------------------------------------------ */
/* Quarterly check-in                                                  */
/* ------------------------------------------------------------------ */
export function CheckinCard() {
  return (
    <OtoCard icon={CalendarClock} title="Quarterly check-in" subtitle={CHECKIN_DEMO.cadence}>
      <Step delay={0.15} className="mt-4 rounded-xl border border-dashed border-[#1a1a1a]/15 bg-[#1a1a1a]/[0.03] px-4 py-3">
        <p className="text-[13px] text-[#1a1a1a]">“{CHECKIN_DEMO.banner}”</p>
      </Step>
      <Step delay={0.27}>
        <p className="mt-4 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#1a1a1a]/45">
          Quick questions, like
        </p>
      </Step>
      <Pills items={CHECKIN_DEMO.questions} base={0.32} />
      <Step delay={0.48}>
        <p className="mt-3 text-[11px] text-[#1a1a1a]/45">{CHECKIN_DEMO.note}</p>
      </Step>
    </OtoCard>
  );
}

/* ------------------------------------------------------------------ */
/* Bookings tab                                                        */
/* ------------------------------------------------------------------ */
export function BookingsCard() {
  return (
    <OtoCard icon={ClipboardList} title="Bookings" subtitle="Follow every booking as it moves">
      <div className="mt-4 space-y-2">
        {BOOKINGS_DEMO.tabs.map((tab, i) => (
          <Step key={tab.name} delay={0.15 + i * 0.1} className="rounded-xl bg-[#1a1a1a]/[0.04] px-4 py-3">
            <p className="text-[14px] font-medium text-[#1a1a1a]">{tab.name}</p>
            <p className="mt-0.5 text-[12px] leading-snug text-[#1a1a1a]/55">{tab.desc}</p>
          </Step>
        ))}
      </div>
    </OtoCard>
  );
}

/* ------------------------------------------------------------------ */
/* Notifications                                                       */
/* ------------------------------------------------------------------ */
function NotifList({ items, muted, base }: { items: string[]; muted?: boolean; base: number }) {
  return (
    <ul className="mt-2 space-y-1.5">
      {items.map((it, i) => (
        <motion.li
          key={it}
          initial={{ opacity: 0, x: -8 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: base + i * 0.06, duration: 0.4, ease: EASE }}
          className={`flex items-center gap-2 text-[13px] ${muted ? "text-[#1a1a1a]/55" : "text-[#1a1a1a]"}`}
        >
          {muted ? (
            <X className="h-3.5 w-3.5 text-[#1a1a1a]/30" />
          ) : (
            <Check className="h-3.5 w-3.5 text-[#2f7bff]" />
          )}
          {it}
        </motion.li>
      ))}
    </ul>
  );
}

export function NotificationsCard() {
  const neverBase = 0.2 + NOTIFICATIONS_DEMO.sends.length * 0.06 + 0.12;
  return (
    <OtoCard icon={Bell} title="Notifications" subtitle="Only what actually matters">
      <Step delay={0.15}>
        <p className="mt-4 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#1a1a1a]/45">
          We send
        </p>
      </Step>
      <NotifList items={NOTIFICATIONS_DEMO.sends} base={0.2} />
      <Step delay={neverBase}>
        <p className="mt-4 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#1a1a1a]/45">
          We never send
        </p>
      </Step>
      <NotifList items={NOTIFICATIONS_DEMO.never} muted base={neverBase + 0.05} />
    </OtoCard>
  );
}

/* ------------------------------------------------------------------ */
/* What we'll never do (trust)                                         */
/* ------------------------------------------------------------------ */
export function TrustCard() {
  return (
    <OtoCard
      icon={ShieldCheck}
      title="What we’ll never do"
      subtitle="Trust is the product"
      footer={
        <div className="mt-4 border-t border-[#1a1a1a]/10 pt-3">
          <Link
            href="/trust"
            className="flex w-full items-center justify-between rounded-xl bg-[#1a1a1a] px-4 py-2.5 text-[13px] font-medium text-white shadow-sm transition-all hover:bg-[#5299fe] hover:shadow"
          >
            <span>Read our trust & verification standard</span>
            <ArrowUpRight className="h-4 w-4" />
          </Link>
        </div>
      }
    >
      <ul className="mt-4 space-y-2">
        {TRUST_DEMO.never.map((it, i) => (
          <Step
            key={it}
            delay={0.15 + i * 0.08}
            className="flex items-center gap-2.5 rounded-xl bg-[#1a1a1a]/[0.04] px-4 py-2.5 text-[13px] text-[#1a1a1a]"
          >
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#1a1a1a]/10">
              <X className="h-3 w-3 text-[#1a1a1a]/55" />
            </span>
            {it}
          </Step>
        ))}
      </ul>
    </OtoCard>
  );
}

/* ------------------------------------------------------------------ */
/* Warranty standard                                                  */
/* ------------------------------------------------------------------ */
export function WarrantyCard() {
  const points = [
    "Independent warranty on parts & labor from every verified shop",
    "Digital repair record stored with full itemized parts breakdown",
    "Direct messaging with the mechanic who worked on your car",
    "7-day dispute window if an issue isn't resolved directly",
  ];
  return (
    <OtoCard
      icon={ShieldCheck}
      title="Warranty Standard"
      subtitle="Repairs backed by verified shops"
      footer={
        <div className="mt-4 border-t border-[#1a1a1a]/10 pt-3">
          <Link
            href="/warranties"
            className="flex w-full items-center justify-between rounded-xl bg-[#1a1a1a] px-4 py-2.5 text-[13px] font-medium text-white shadow-sm transition-all hover:bg-[#5299fe] hover:shadow"
          >
            <span>Read our Warranty Standard</span>
            <ArrowUpRight className="h-4 w-4" />
          </Link>
        </div>
      }
    >
      <ul className="mt-4 space-y-2">
        {points.map((pt, i) => (
          <Step
            key={pt}
            delay={0.15 + i * 0.08}
            className="flex items-center gap-2.5 rounded-xl bg-[#1a1a1a]/[0.04] px-4 py-2.5 text-[13px] text-[#1a1a1a]"
          >
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600">
              <Check className="h-3 w-3" />
            </span>
            {pt}
          </Step>
        ))}
      </ul>
    </OtoCard>
  );
}

/* ------------------------------------------------------------------ */
/* Privacy policy                                                     */
/* ------------------------------------------------------------------ */
export function PrivacyCard() {
  const points = [
    "Contact, messaging & payment data is strictly protected",
    "Never sold, rented, or shared with third-party advertisers",
    "Payment card details processed securely via Stripe",
    "Service logs tied to VIN solely for vehicle maintenance history",
  ];
  return (
    <OtoCard
      icon={FileText}
      title="Privacy Policy"
      subtitle="Driver data is strictly protected"
      footer={
        <div className="mt-4 border-t border-[#1a1a1a]/10 pt-3">
          <Link
            href="/privacy"
            className="flex w-full items-center justify-between rounded-xl bg-[#1a1a1a] px-4 py-2.5 text-[13px] font-medium text-white shadow-sm transition-all hover:bg-[#5299fe] hover:shadow"
          >
            <span>Read our Privacy Policy</span>
            <ArrowUpRight className="h-4 w-4" />
          </Link>
        </div>
      }
    >
      <ul className="mt-4 space-y-2">
        {points.map((pt, i) => (
          <Step
            key={pt}
            delay={0.15 + i * 0.08}
            className="flex items-center gap-2.5 rounded-xl bg-[#1a1a1a]/[0.04] px-4 py-2.5 text-[13px] text-[#1a1a1a]"
          >
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-500/10 text-[#5299fe]">
              <Check className="h-3 w-3" />
            </span>
            {pt}
          </Step>
        ))}
      </ul>
    </OtoCard>
  );
}

/* ------------------------------------------------------------------ */
/* Terms of service                                                   */
/* ------------------------------------------------------------------ */
export function TermsCard() {
  const points = [
    "Locked upfront pricing: prices cannot rise without approval",
    "100% verified reviews from completed driver bookings only",
    "Strict shop vetting: DMV registered, licensed & insured",
    "Transparent marketplace rules with zero hidden platform fees",
  ];
  return (
    <OtoCard
      icon={Receipt}
      title="Terms of Service"
      subtitle="Transparent marketplace rules"
      footer={
        <div className="mt-4 border-t border-[#1a1a1a]/10 pt-3">
          <Link
            href="/terms"
            className="flex w-full items-center justify-between rounded-xl bg-[#1a1a1a] px-4 py-2.5 text-[13px] font-medium text-white shadow-sm transition-all hover:bg-[#5299fe] hover:shadow"
          >
            <span>Read Terms of Service</span>
            <ArrowUpRight className="h-4 w-4" />
          </Link>
        </div>
      }
    >
      <ul className="mt-4 space-y-2">
        {points.map((pt, i) => (
          <Step
            key={pt}
            delay={0.15 + i * 0.08}
            className="flex items-center gap-2.5 rounded-xl bg-[#1a1a1a]/[0.04] px-4 py-2.5 text-[13px] text-[#1a1a1a]"
          >
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-500/10 text-[#5299fe]">
              <Check className="h-3 w-3" />
            </span>
            {pt}
          </Step>
        ))}
      </ul>
    </OtoCard>
  );
}

/* ------------------------------------------------------------------ */
/* Cancellation policy                                                */
/* ------------------------------------------------------------------ */
export function CancellationCard() {
  const points = [
    "Free cancellation up to 24 hours prior to appointment",
    "$20 authorization hold released immediately upon cancellation",
    "Inside 24 hours, hold is kept as a late-cancellation fee",
    "Effortlessly reschedule anytime directly through the app",
  ];
  return (
    <OtoCard
      icon={CalendarClock}
      title="Cancellation Policy"
      subtitle="Driver-first appointment flexibility"
      footer={
        <div className="mt-4 border-t border-[#1a1a1a]/10 pt-3">
          <Link
            href="/cancellation"
            className="flex w-full items-center justify-between rounded-xl bg-[#1a1a1a] px-4 py-2.5 text-[13px] font-medium text-white shadow-sm transition-all hover:bg-[#5299fe] hover:shadow"
          >
            <span>Read Cancellation Policy</span>
            <ArrowUpRight className="h-4 w-4" />
          </Link>
        </div>
      }
    >
      <ul className="mt-4 space-y-2">
        {points.map((pt, i) => (
          <Step
            key={pt}
            delay={0.15 + i * 0.08}
            className="flex items-center gap-2.5 rounded-xl bg-[#1a1a1a]/[0.04] px-4 py-2.5 text-[13px] text-[#1a1a1a]"
          >
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600">
              <Check className="h-3 w-3" />
            </span>
            {pt}
          </Step>
        ))}
      </ul>
    </OtoCard>
  );
}

/* ------------------------------------------------------------------ */
/* Dispatcher — renders the card for a given feature                   */
/* ------------------------------------------------------------------ */
const REGISTRY: Record<DemoFeature, () => React.JSX.Element> = {
  service_catalog: ServiceCatalogCard,
  pricing: PricingCard,
  health_score: HealthScoreCard,
  tires: TiresCard,
  ratings: RatingsCard,
  rewards: RewardsCard,
  overview: OverviewCard,
  coverage: CoverageCard,
  payments: PaymentsCard,
  service_history: ServiceHistoryCard,
  checkin: CheckinCard,
  bookings: BookingsCard,
  notifications: NotificationsCard,
  trust: TrustCard,
  warranty: WarrantyCard,
  privacy: PrivacyCard,
  terms: TermsCard,
  cancellation: CancellationCard,
};

export function DemoCard({ feature }: { feature: DemoFeature }) {
  const Card = REGISTRY[feature];
  return Card ? <Card /> : null;
}
