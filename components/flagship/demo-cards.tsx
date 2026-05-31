"use client";

import {
  BadgeCheck,
  Bell,
  CalendarClock,
  Check,
  ChevronRight,
  ClipboardList,
  CreditCard,
  FileText,
  Gift,
  MapPin,
  ShieldCheck,
  Sparkles,
  Star,
  X,
} from "lucide-react";
import { motion } from "motion/react";
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
  TIRE_TIERS,
  TRUST_DEMO,
  type DemoFeature,
} from "./oto-flow";

const CARD =
  "w-full rounded-[20px] border border-[#1a1a1a]/10 bg-white/65 p-6 backdrop-blur-2xl shadow-[0_20px_50px_rgba(0,0,0,0.08)]";

const usd = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function CardHead({
  icon: Icon,
  title,
  subtitle,
}: {
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  title: string;
  subtitle?: string;
}) {
  return (
    <>
      <div className="flex items-center gap-2">
        <Icon className="h-[18px] w-[18px] text-[#1a1a1a]" strokeWidth={1.6} />
        <h3 className="text-[19px] text-[#1a1a1a]" style={{ fontFamily: "var(--font-Lora)" }}>
          {title}
        </h3>
      </div>
      {subtitle && <p className="mt-1 text-[12px] text-[#1a1a1a]/45">{subtitle}</p>}
    </>
  );
}

function CheckList({ items }: { items: string[] }) {
  return (
    <ul className="mt-4 space-y-2">
      {items.map((it) => (
        <li key={it} className="flex items-start gap-2 text-[13px] leading-snug text-[#1a1a1a]">
          <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#2f7bff]" /> {it}
        </li>
      ))}
    </ul>
  );
}

function Pills({ items }: { items: string[] }) {
  return (
    <div className="mt-3 flex flex-wrap gap-1.5">
      {items.map((it) => (
        <span
          key={it}
          className="rounded-lg bg-[#1a1a1a]/[0.05] px-2.5 py-1 text-[12px] text-[#1a1a1a]"
        >
          {it}
        </span>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Service Catalog                                                     */
/* ------------------------------------------------------------------ */
export function ServiceCatalogCard() {
  return (
    <div className={CARD}>
      <h3 className="text-[19px] text-[#1a1a1a]" style={{ fontFamily: "var(--font-Lora)" }}>
        Service Catalog
      </h3>
      <p className="mt-1 text-[12px] text-[#1a1a1a]/45">
        Everything bookable at launch · 7 categories
      </p>

      <div className="mt-4 max-h-[300px] space-y-3 overflow-y-auto pr-1 [scrollbar-width:thin]">
        {SERVICE_CATALOG.map((cat) => (
          <div key={cat.category}>
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
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Pricing — line items + 7% fee                                       */
/* ------------------------------------------------------------------ */
export function PricingCard() {
  return (
    <div className={CARD}>
      <h3 className="text-[19px] text-[#1a1a1a]" style={{ fontFamily: "var(--font-Lora)" }}>
        Transparent pricing
      </h3>
      <p className="mt-1 text-[12px] text-[#1a1a1a]/45">
        {PRICING_DEMO.service} · every charge shown as a line
      </p>

      <div className="mt-4 space-y-1">
        {PRICING_DEMO.lines.map((line) => (
          <div
            key={line.label}
            className={`flex items-center justify-between rounded-xl px-4 py-2.5 ${
              line.emphasize ? "bg-[#2f7bff]/10 ring-1 ring-[#2f7bff]/25" : "bg-[#1a1a1a]/[0.04]"
            }`}
          >
            <span className="flex items-center gap-2 text-[13.5px] text-[#1a1a1a]">
              {line.label}
              {line.note && (
                <span
                  className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                    line.emphasize
                      ? "bg-[#2f7bff] text-white"
                      : "bg-[#1a1a1a]/10 text-[#1a1a1a]/60"
                  }`}
                >
                  {line.note}
                </span>
              )}
            </span>
            <span className="text-[13.5px] font-medium text-[#1a1a1a]">{usd(line.amount)}</span>
          </div>
        ))}
      </div>

      <div className="mt-3 flex items-center justify-between border-t border-[#1a1a1a]/10 pt-3">
        <span className="text-[14px] font-medium text-[#1a1a1a]">Total</span>
        <span className="text-[18px] font-semibold text-[#1a1a1a]">{usd(PRICING_DEMO.total)}</span>
      </div>

      <p className="mt-3 text-[11px] leading-relaxed text-[#1a1a1a]/45">
        The 7% fee sits on top — your mechanic keeps their full quote. Example only; real
        prices are built for your exact car.
      </p>
    </div>
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
    <div className={CARD}>
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-[18px] w-[18px] text-[#1a1a1a]" strokeWidth={1.6} />
        <h3 className="text-[19px] text-[#1a1a1a]" style={{ fontFamily: "var(--font-Lora)" }}>
          Vehicle Health
        </h3>
      </div>

      <div className="mt-4 flex items-center gap-5">
        <div className="relative h-[110px] w-[110px] shrink-0">
          <svg className="h-full w-full -rotate-90" viewBox="0 0 100 100">
            <circle cx="50" cy="50" r={r} fill="none" stroke="#1a1a1a" strokeOpacity="0.08" strokeWidth="8" />
            <circle
              cx="50"
              cy="50"
              r={r}
              fill="none"
              stroke="#2f7bff"
              strokeWidth="8"
              strokeLinecap="round"
              strokeDasharray={circ}
              strokeDashoffset={offset}
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-[28px] font-semibold leading-none text-[#1a1a1a]">{score}</span>
            <span className="text-[11px] text-[#1a1a1a]/45">/ 100</span>
          </div>
        </div>
        <div>
          <p className="text-[15px] font-medium text-[#1a1a1a]">{status}</p>
          <p className="mt-1 max-w-[180px] text-[12px] leading-relaxed text-[#1a1a1a]/55">
            A calm snapshot of how well your car is keeping up — never a grade.
          </p>
        </div>
      </div>

      <div className="mt-4 space-y-2">
        {recommendations.map((rec) => (
          <div
            key={rec.title}
            className="flex items-center justify-between rounded-xl bg-[#1a1a1a]/[0.04] px-4 py-2.5"
          >
            <div>
              <p className="text-[13.5px] text-[#1a1a1a]">{rec.title}</p>
              <p className="text-[11.5px] text-[#1a1a1a]/45">{rec.detail}</p>
            </div>
            <span className="flex items-center gap-1 text-[12px] font-medium text-[#2f7bff]">
              +{rec.gain}%
              <ChevronRight className="h-3.5 w-3.5" />
            </span>
          </div>
        ))}
      </div>

      <p className="mt-3 flex items-center gap-1.5 text-[11px] text-[#1a1a1a]/45">
        <Check className="h-3 w-3" /> Completing a service restores the points it was due.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Tires — tier quote flow                                             */
/* ------------------------------------------------------------------ */
export function TiresCard() {
  return (
    <div className={CARD}>
      <h3 className="text-[19px] text-[#1a1a1a]" style={{ fontFamily: "var(--font-Lora)" }}>
        New tires
      </h3>
      <p className="mt-1 text-[12px] text-[#1a1a1a]/45">
        Pick a tier — nearby shops send live quotes
      </p>

      <div className="mt-4 space-y-2">
        {TIRE_TIERS.map((t, i) => (
          <div
            key={t.tier}
            className={`rounded-xl px-4 py-3 ${
              i === 0 ? "bg-[#1a1a1a]/[0.06] ring-1 ring-[#1a1a1a]/15" : "bg-[#1a1a1a]/[0.04]"
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="text-[14px] font-medium text-[#1a1a1a]">{t.tier}</span>
              {i === 0 && (
                <span className="rounded-full bg-[#1a1a1a] px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-white">
                  Most picked
                </span>
              )}
            </div>
            <p className="mt-0.5 text-[12px] leading-snug text-[#1a1a1a]/55">{t.blurb}</p>
          </div>
        ))}
      </div>

      <div className="mt-4 flex items-center gap-2 rounded-xl bg-[#2f7bff]/10 px-4 py-3">
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
        <span className="text-[12.5px] text-[#1a1a1a]">
          Requesting quotes from shops in your area…
        </span>
      </div>

      <p className="mt-3 text-[11px] leading-relaxed text-[#1a1a1a]/45">
        Quotes arrive within 10 minutes, each next to a baseline price. You pick by price and
        date — no commitment.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Ratings — mechanic profile                                          */
/* ------------------------------------------------------------------ */
function Stars({ value }: { value: number }) {
  return (
    <span className="inline-flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((n) => (
        <Star
          key={n}
          className={`h-3.5 w-3.5 ${
            n <= Math.round(value) ? "fill-[#1a1a1a] text-[#1a1a1a]" : "text-[#1a1a1a]/20"
          }`}
        />
      ))}
    </span>
  );
}

export function RatingsCard() {
  const r = RATINGS_DEMO;
  const initials = r.mechanic
    .split(" ")
    .map((w) => w[0])
    .join("");
  return (
    <div className={CARD}>
      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-full bg-[#1a1a1a] text-[15px] font-medium text-white">
          {initials}
        </div>
        <div>
          <p className="text-[16px] font-medium text-[#1a1a1a]">{r.mechanic}</p>
          <p className="text-[12px] text-[#1a1a1a]/45">{r.shop}</p>
        </div>
        <span className="ml-auto flex items-center gap-1 rounded-full bg-[#1a1a1a]/[0.06] px-2 py-1 text-[10px] font-medium text-[#1a1a1a]">
          <BadgeCheck className="h-3.5 w-3.5" /> Vetted
        </span>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <span className="text-[28px] font-semibold leading-none text-[#1a1a1a]">{r.overall}</span>
        <div>
          <Stars value={r.overall} />
          <p className="mt-0.5 text-[11.5px] text-[#1a1a1a]/45">{r.jobs} jobs completed</p>
        </div>
      </div>

      <div className="mt-4 space-y-2">
        {r.breakdown.map((b) => (
          <div key={b.label} className="flex items-center gap-3">
            <span className="w-[120px] text-[12.5px] text-[#1a1a1a]/70">{b.label}</span>
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[#1a1a1a]/10">
              <div
                className="h-full rounded-full bg-[#1a1a1a]"
                style={{ width: `${(b.value / 5) * 100}%` }}
              />
            </div>
            <span className="w-8 text-right text-[12.5px] font-medium text-[#1a1a1a]">
              {b.value.toFixed(1)}
            </span>
          </div>
        ))}
      </div>

      <p className="mt-4 text-[11px] text-[#1a1a1a]/45">
        Two-way ratings — mechanics rate drivers too. Every shop is vetted in person before going
        live.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Rewards — Ownership Credit                                          */
/* ------------------------------------------------------------------ */
export function RewardsCard() {
  const r = REWARDS_DEMO;
  return (
    <div className={CARD}>
      <div className="flex items-center gap-2">
        <Gift className="h-[18px] w-[18px] text-[#1a1a1a]" strokeWidth={1.6} />
        <h3 className="text-[19px] text-[#1a1a1a]" style={{ fontFamily: "var(--font-Lora)" }}>
          Ownership Credit
        </h3>
      </div>
      <p className="mt-1 text-[12px] italic text-[#1a1a1a]/55">“{r.motto}”</p>

      <div className="mt-4 flex items-end justify-between rounded-xl bg-[#1a1a1a] px-4 py-4 text-white">
        <div>
          <p className="text-[11px] uppercase tracking-wide text-white/55">Available credit</p>
          <p className="text-[28px] font-semibold leading-none">{usd(r.balance)}</p>
        </div>
        <span className="rounded-full bg-white/15 px-2.5 py-1 text-[11px] font-medium">
          {r.tier} · {r.rate}
        </span>
      </div>

      <p className="mt-4 mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#1a1a1a]/45">
        Earn more
      </p>
      <div className="space-y-2">
        {r.bonuses.map((b) => (
          <div
            key={b.action}
            className="flex items-center justify-between rounded-xl bg-[#1a1a1a]/[0.04] px-4 py-2.5"
          >
            <span className="text-[13px] text-[#1a1a1a]">{b.action}</span>
            <span className="text-[13px] font-medium text-[#2f7bff]">+{usd(b.amount)}</span>
          </div>
        ))}
      </div>

      <p className="mt-3 text-[11px] text-[#1a1a1a]/45">
        Real dollars toward your next service — not points. Credits expire after 6 months of
        inactivity; we’ll remind you first.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Overview                                                            */
/* ------------------------------------------------------------------ */
export function OverviewCard() {
  return (
    <div className={CARD}>
      <CardHead icon={Sparkles} title="What Otopair is" subtitle={OVERVIEW_DEMO.tagline} />
      <CheckList items={OVERVIEW_DEMO.facts} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Coverage                                                            */
/* ------------------------------------------------------------------ */
export function CoverageCard() {
  return (
    <div className={CARD}>
      <CardHead icon={MapPin} title="Where it works" />
      <div className="mt-4 rounded-xl bg-[#1a1a1a] px-4 py-4 text-white">
        <p className="text-[11px] uppercase tracking-wide text-white/55">Launching</p>
        <p className="text-[22px] font-medium leading-tight">{COVERAGE_DEMO.launch}</p>
        <p className="text-[12px] text-white/55">{COVERAGE_DEMO.date}</p>
      </div>
      <p className="mt-4 text-[12px] font-semibold uppercase tracking-[0.12em] text-[#1a1a1a]/45">
        Expanding across NYC after launch
      </p>
      <Pills items={COVERAGE_DEMO.expansion} />
      <p className="mt-3 text-[11px] text-[#1a1a1a]/45">{COVERAGE_DEMO.note}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Payments                                                            */
/* ------------------------------------------------------------------ */
export function PaymentsCard() {
  return (
    <div className={CARD}>
      <CardHead icon={CreditCard} title="Payments" subtitle="Pay your way — securely" />
      <Pills items={PAYMENTS_DEMO.methods} />
      <CheckList items={PAYMENTS_DEMO.points} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Service history upload                                              */
/* ------------------------------------------------------------------ */
export function ServiceHistoryCard() {
  return (
    <div className={CARD}>
      <CardHead
        icon={FileText}
        title="Service history"
        subtitle={SERVICE_HISTORY_DEMO.accepts}
      />
      <CheckList items={SERVICE_HISTORY_DEMO.benefits} />
      <div className="mt-4 flex items-center gap-2 rounded-xl bg-[#2f7bff]/10 px-4 py-2.5 text-[12.5px] font-medium text-[#1a1a1a]">
        <Gift className="h-4 w-4 text-[#2f7bff]" /> {SERVICE_HISTORY_DEMO.reward}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Quarterly check-in                                                  */
/* ------------------------------------------------------------------ */
export function CheckinCard() {
  return (
    <div className={CARD}>
      <CardHead
        icon={CalendarClock}
        title="Quarterly check-in"
        subtitle={CHECKIN_DEMO.cadence}
      />
      <div className="mt-4 rounded-xl border border-dashed border-[#1a1a1a]/15 bg-[#1a1a1a]/[0.03] px-4 py-3">
        <p className="text-[13px] text-[#1a1a1a]">“It’s been a few months — quick check-in to keep your car on track.”</p>
      </div>
      <p className="mt-4 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#1a1a1a]/45">
        A few quick questions
      </p>
      <Pills items={CHECKIN_DEMO.questions} />
      <p className="mt-3 text-[11px] text-[#1a1a1a]/45">{CHECKIN_DEMO.note}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Bookings tab                                                        */
/* ------------------------------------------------------------------ */
export function BookingsCard() {
  return (
    <div className={CARD}>
      <CardHead icon={ClipboardList} title="Bookings" subtitle="Everything happening now" />
      <div className="mt-4 space-y-2">
        {BOOKINGS_DEMO.tabs.map((tab) => (
          <div key={tab.name} className="rounded-xl bg-[#1a1a1a]/[0.04] px-4 py-3">
            <p className="text-[14px] font-medium text-[#1a1a1a]">{tab.name}</p>
            <p className="mt-0.5 text-[12px] leading-snug text-[#1a1a1a]/55">{tab.desc}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Notifications                                                       */
/* ------------------------------------------------------------------ */
export function NotificationsCard() {
  return (
    <div className={CARD}>
      <CardHead icon={Bell} title="Notifications" subtitle="Only what actually matters" />
      <p className="mt-4 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#1a1a1a]/45">
        We send
      </p>
      <ul className="mt-2 space-y-1.5">
        {NOTIFICATIONS_DEMO.sends.map((it) => (
          <li key={it} className="flex items-center gap-2 text-[13px] text-[#1a1a1a]">
            <Check className="h-3.5 w-3.5 text-[#2f7bff]" /> {it}
          </li>
        ))}
      </ul>
      <p className="mt-4 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#1a1a1a]/45">
        We never send
      </p>
      <ul className="mt-2 space-y-1.5">
        {NOTIFICATIONS_DEMO.never.map((it) => (
          <li key={it} className="flex items-center gap-2 text-[13px] text-[#1a1a1a]/55">
            <X className="h-3.5 w-3.5 text-[#1a1a1a]/30" /> {it}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* What we'll never do (trust)                                         */
/* ------------------------------------------------------------------ */
export function TrustCard() {
  return (
    <div className={CARD}>
      <CardHead
        icon={ShieldCheck}
        title="What we’ll never do"
        subtitle="Trust is the product"
      />
      <ul className="mt-4 space-y-2">
        {TRUST_DEMO.never.map((it) => (
          <li
            key={it}
            className="flex items-center gap-2.5 rounded-xl bg-[#1a1a1a]/[0.04] px-4 py-2.5 text-[13px] text-[#1a1a1a]"
          >
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#1a1a1a]/10">
              <X className="h-3 w-3 text-[#1a1a1a]/55" />
            </span>
            {it}
          </li>
        ))}
      </ul>
    </div>
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
};

export function DemoCard({ feature }: { feature: DemoFeature }) {
  const Card = REGISTRY[feature];
  return Card ? <Card /> : null;
}
