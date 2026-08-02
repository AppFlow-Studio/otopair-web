// Shared return-shape types for the director Shops surfaces. These mirror the
// convex/shops*.ts query returns (ported verbatim from the /shops portal, whose
// pages pinned the same shapes locally). Auth is identical between the portal
// and director panel, so the director calls api.shops*.* directly with its own
// session token — these types just keep the TSX honest.

/* ---------- Directory (api.shopsDirectory.directoryList) ---------- */
export type DirectoryRow = {
  id: string
  name: string
  city: string
  zip: string
  address: string | null
  phone: string | null
  email: string | null
  hasCoords: boolean
  laborRate: number | null
  rating: number | null
  reviewCount: number
  mechanics: number
  isActive: boolean
  isVerified: boolean
  health: 'green' | 'amber'
  failingChecks: string[]
}

/* ---------- Network (api.shopsNetwork.*) ---------- */
export type WeekKpis = {
  week_start: number
  bookings_week: number
  gmv_week: number
  bookings_prev_week: number
  gmv_prev_week: number
}

export type LeagueRow = {
  id: string
  name: string
  city: string | null
  is_active: boolean
  rating: number | null
  review_count: number
  bookings_7d: number
  gmv_7d: number
  completion_rate_7d: number | null
}

export type AttentionShop = {
  id: string
  name: string
  checks: { kind: string; detail: string }[]
}

/* ---------- Shop detail (api.shopsDirectory.*) ---------- */
export type TierRates = {
  T1?: number; T2a?: number; T2b?: number; T2c?: number; T3a?: number; T3b?: number; T4?: number
}

export type Profile = {
  id: string
  name: string
  slug: string | null
  address: string | null
  city: string | null
  state: string | null
  zip: string | null
  phone: string | null
  email: string | null
  website: string | null
  timezone: string | null
  lat: number | null
  lng: number | null
  description: string | null
  logo: string | null
  laborRate: number | null
  laborRatesByTier: TierRates | null
  declinedTiers: string[]
  laborRatesUpdatedAt: number | null
  rating: number | null
  reviewCount: number
  isActive: boolean
  isVerified: boolean
  onboardingComplete: boolean
  stripeAccountId: string | null
  stripeChargesEnabled: boolean
  stripePayoutsEnabled: boolean
  stripeOnboardingCompletedAt: number | null
  stripeRequirementsDue: string[]
  scheduling: {
    bufferMinutes: number | null
    noShowThresholdMinutes: number | null
    maxBookingsPerMechanicRollingHour: number | null
    appointmentReminderLeadMinutes: number | null
    overrunDefaultExtensionPercent: number | null
    overrunExtensionFloorMinutes: number | null
    overrunEscalationMinutes: number | null
    overrunAutoApplyMinutes: number | null
    entityLabelMode: string | null
  }
  mechanicCount: number
  createdAt: number
  health: 'green' | 'amber'
  failingChecks: string[]
  owner: { id: string; name: string } | null
} | null

export type HourRow = {
  id: string
  dayOfWeek: number
  dayName: string
  openTime: string | null
  closeTime: string | null
  isClosed: boolean
}

export type ServicesResult = {
  laborRate: number | null
  services: Array<{
    id: string
    serviceId: string
    name: string
    category: string
    isOffered: boolean
    defaultLaborHours: number | null
    description: string | null
    partsKind: string | null
    laborDeterminant: string | null
    minModelYear: number | null
    repairpalSlug: string | null
    isLaborOnly: boolean
    requiresParts: boolean
    hasOptions: boolean
  }>
} | null

export type RosterMechanic = {
  id: string
  name: string
  title: string | null
  email: string | null
  photo: string | null
  rating: number | null
  reviewCount: number
  isActive: boolean
}

export type CalendarResult = {
  mechanics: Array<{ id: string; name: string; isActive: boolean }>
  slots: Array<{
    id: string
    mechanicId: string
    date: string
    start: string
    end: string
    state: 'available' | 'booked' | 'blocked'
    note: string | null
    title: string | null
  }>
}

export type ShopBookingRow = {
  id: string
  user: string
  user_id: string
  vehicle: string | null
  services: string[]
  status: string
  date: string | null
  time: string | null
  total: number | null
  laborCost: number | null
  partsCost: number | null
  estLaborMinutes: number | null
  actualDurationMinutes: number | null
  invoiceNumber: string | null
  customerNotes: string | null
  recommendationState: string | null
  rescheduled: boolean
  createdAt: number
}

export type EnrichedReview = {
  id: string
  rating: number
  comment: string | null
  reviewer: string | null
  reviewer_id: string
  mechanic: string | null
  mechanic_id: string | null
  booking_id: string
  vehicle: { ymm: string | null; imageUrl: string | null }
  service_names: string[]
  hidden: boolean
  hidden_reason: string | null
  hidden_by: string | null
  at: number
}

export type ShopInsights = {
  reviews: EnrichedReview[]
  rateHistory: { actor: string; detail: string | null; at: number }[]
  fixedPrices: { service: string; tier: string; price: number }[]
  portfolio: { id: string; url: string; caption: string | null }[]
  laborQa: { sampled: number; flagged: number; avgVariancePct: number | null }
  disputes: {
    id: string
    booking_id: string | null
    reason: string | null
    status: string
    amount: number
    openedAt: number
    closedAt: number | null
  }[]
  stats: {
    total: number
    completed: number
    cancelled: number
    noShow: number
    cancelRate: number | null
    noShowRate: number | null
    disputeCount: number
  }
}

/* ---------- Mechanics directory + detail (api.shopsMechanics.*) ---------- */
export type MechanicDirRow = {
  id: string
  name: string
  title: string | null
  email: string | null
  photo: string | null
  shop: string | null
  shop_id: string
  active: boolean
  rating: number | null
  review_count: number | null
  jobs: number
  jobs_capped: boolean
  contributions: number
  next_slot: string | null
}

export type MechanicDetail = {
  id: string
  name: string
  title: string | null
  email: string | null
  photo: string | null
  shop: string | null
  shop_id: string
  active: boolean
  rating: number | null
  review_count: number | null
  aggregates: {
    total_jobs: number
    avg_labor_minutes: number | null
    labor_variance_pct: number | null
    total_parts_cost: number | null
    labor_revenue: number | null
    avg_difficulty: number | null
    distinct_services: number
    distinct_customers: number
    avg_review: number | null
    contribution_accuracy: number | null
  }
  recent_jobs: Array<{
    id: string
    at: number
    booking_id: string
    services: string[]
    vehicle: string | null
    notes: string | null
    est_minutes: number | null
    minutes: number | null
    parts_cost: number | null
    parts_count: number | null
    difficulty: number | null
    mileage_in: number | null
    mileage_out: number | null
    status: string | null
  }>
  reviews: Array<{
    id: string
    rating: number
    reviewer: string | null
    hidden: boolean
    hidden_reason: string | null
    at: number
    vehicle: { ymm: string | null; imageUrl: string | null }
    service_names: string[]
    booking_id: string
    comment: string | null
  }>
  week_slots: Array<{ date: string; available: number; booked: number }>
  contributions: Array<{
    id: string
    status: string | null
    service: string | null
    labor_hours: number | null
    parts_correct: boolean | null
    fields: number
    decisions: number
    accuracy: number | null
    reviewer: string | null
    at: number
  }>
} | null

/* ---------- Network reviews (api.shopsReviews.byShop) ---------- */
export type ShopReviewRow = EnrichedReview
export type ShopReviewGroup = {
  shop_id: string
  shop: string
  avg_rating: number | null
  count: number
  low_this_week: number
  trend_30d: { week: string; count: number; avg: number | null }[]
  reviews: ShopReviewRow[]
}
