// =============================================================================
// Oto AI — Tool Schemas (Phase 1, v2)
// =============================================================================
//
// These schemas live in the CACHED ZONE of the Anthropic system prompt
// (State Contract §2.3). They are byte-stable across every user and every turn.
// Any edit invalidates the cache for all users on their next request, so
// iterate against the eval harness, not in production.
//
// Three categories:
//   • data       — Read-only Convex queries. Dispatcher calls ctx.runQuery.
//   • render     — UI directives. Dispatcher packages args into a ChatMessage
//                  envelope field (mirrors services/ai/types.ts:ChatMessage).
//   • navigation — A single case: payment handoff to /home/mechanic/{id}/payment.
//                  All other Phase 1 affordances render inline in the chat.
//
// Conventions:
//   • snake_case tool names (the AI reads these)
//   • snake_case service slugs (e.g. "oil_change") — matches the production
//     services.slug column (seeded by convex/seeds/seedServices.ts).
//     NEVER PROPOSE NEW SLUGS. See OTOPAIR_SERVICE_SLUGS at the bottom of this
//     file for the canonical 23. See docs/oto-ai/slug-drift-remediation.md for
//     the kebab-case dead-taxonomy audit.
//   • Tool inputs scoped to what the AI knows from <user> / <vehicle> /
//     <conversation_history>. NO user_id / auth_token — dispatcher injects.
//   • Descriptions tell the AI WHEN to call, not just WHAT.
//
// Companions:
//   • docs/oto-ai/tool-inventory.md     — rationale, rejected, gaps, open Qs
//   • docs/oto-ai/handoff-addendum.md   — locked Section 4.5
//   • convex/oto/dispatcher.ts          — executor
// =============================================================================

export interface OtoToolSchema {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// -----------------------------------------------------------------------------
// DATA TOOLS — execute Convex queries via the dispatcher.
// Dispatcher injects userId from ctx.auth on every call.
// -----------------------------------------------------------------------------

const DATA_TOOLS: OtoToolSchema[] = [
  {
    name: "get_my_vehicles",
    description:
      "List every vehicle the user owns. Each entry includes year, make, model, trim, mileage, and an `is_primary` flag — the primary vehicle is the user's active car. Call this when the user references a vehicle that isn't the one in the <vehicle> context block, when the user has no vehicle context yet, or when the user asks 'what cars do I have?'. Do not call this if the question is already answerable from the <vehicle> block.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },

  {
    name: "get_bookings",
    description:
      "Get the user's bookings filtered by status. Use `status_filter: 'active'` for upcoming/in-progress (statuses: pending, confirmed, in_progress). Use `'completed'` before recommending a new service so you don't duplicate recent work. Use `'all'` only when explicitly asked. Returns most recent first; default limit 5.",
    input_schema: {
      type: "object",
      properties: {
        status_filter: {
          type: "string",
          enum: ["active", "completed", "all"],
          description: "Which bookings to return.",
        },
        limit: { type: "integer", minimum: 1, maximum: 20, description: "Default 5." },
      },
      required: ["status_filter"],
    },
  },

  {
    name: "get_due_services",
    description:
      "Get computed maintenance urgency for a vehicle — which services are overdue, due soon, or fine. This is the answer to 'what does my car need?' or 'anything coming up?'. Each row carries `urgency: 'overdue' | 'due_soon' | 'ok'` plus due-mileage and due-date when known, and uses canonical service slugs (snake_case, e.g. 'oil_change') that you can pass back into get_service_details or render_service_picker.",
    input_schema: {
      type: "object",
      properties: {
        vehicle_id: {
          type: "string",
          description: "VIN. Get from the <vehicle> block or get_my_vehicles.",
        },
      },
      required: ["vehicle_id"],
    },
  },

  {
    name: "list_service_categories",
    description:
      "List the seven Otopair service categories: Diagnostics, Compliance, Routine Maintenance, Tires, Brakes, Battery, Fluids. Use when the user asks 'what kinds of services do you do?' before drilling into specifics. For a per-vehicle filtered list of services, use list_services_for_vehicle instead.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },

  {
    name: "list_services_for_vehicle",
    description:
      "List the services Otopair offers FOR THIS SPECIFIC VEHICLE, after applying compatibility filters (engine type, drivetrain, steering type, model year, tire fitment, state). Use this — not a generic catalog dump — whenever you're suggesting services or showing a service picker. The filter eliminates impossible recommendations (e.g. timing-belt service on a chain-driven engine, oil-change on an EV, emissions-test on an EV, state-inspection in a state that doesn't require one). Returns each service with its canonical snake_case slug, name, description (quote this text when explaining services), default labor hours, and a parts cost band when known. Pass `category` to scope to one of: Diagnostics, Compliance, Routine Maintenance, Tires, Brakes, Battery, Fluids.",
    input_schema: {
      type: "object",
      properties: {
        vehicle_id: { type: "string", description: "VIN of the vehicle." },
        category: {
          type: "string",
          enum: [
            "Diagnostics",
            "Compliance",
            "Routine Maintenance",
            "Tires",
            "Brakes",
            "Battery",
            "Fluids",
          ],
          description: "Optional category filter.",
        },
      },
      required: ["vehicle_id"],
    },
  },

  {
    name: "get_service_details",
    description:
      "Get the full record for one service by its snake_case slug (e.g. 'oil_change', 'brake_pad_replacement', 'check_engine_light'). Use when the user asks 'what does X include?', 'how long does X take?', or you need the educational description to quote in your prose. Slugs MUST match the production catalog — do not invent new ones.",
    input_schema: {
      type: "object",
      properties: {
        service_slug: {
          type: "string",
          description: "Snake_case slug from the production services catalog.",
        },
      },
      required: ["service_slug"],
    },
  },

  {
    name: "get_shop",
    description:
      "Get a shop's name, neighborhood, address, rating, and review count. Call when a shop ID surfaces from a booking, recommendation, or get_my_mechanics and the user wants details.",
    input_schema: {
      type: "object",
      properties: {
        shop_id: { type: "string", description: "Convex shop ID." },
      },
      required: ["shop_id"],
    },
  },

  {
    name: "get_shop_services",
    description:
      "List which services a shop offers (by slug). Use before recommending booking at a shop, or to answer 'does this shop do X?'.",
    input_schema: {
      type: "object",
      properties: {
        shop_id: { type: "string", description: "Convex shop ID." },
      },
      required: ["shop_id"],
    },
  },

  {
    name: "get_shop_hours",
    description:
      "Get a shop's 7-day operating hours. Use when the user asks 'is this shop open Saturday?' or before recommending a slot.",
    input_schema: {
      type: "object",
      properties: {
        shop_id: { type: "string", description: "Convex shop ID." },
      },
      required: ["shop_id"],
    },
  },

  {
    name: "get_mechanic",
    description:
      "Get a mechanic's profile: name, photo, rating, review count, shop. Use when a mechanic ID surfaces and the user wants details.",
    input_schema: {
      type: "object",
      properties: {
        mechanic_id: { type: "string", description: "Convex mechanic ID." },
      },
      required: ["mechanic_id"],
    },
  },

  {
    name: "get_my_mechanics",
    description:
      "The user's preferred mechanics — favorites and recently booked. Use when the user says 'my usual guy' or 'who have I booked with before?'.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },

  {
    name: "get_reviews",
    description:
      "Reviews of a shop or mechanic. Use when the user asks 'is this shop good?' or for social proof before recommending. Returns rating, comment, date, and reviewer initials only — no PII. Default limit 5.",
    input_schema: {
      type: "object",
      properties: {
        target_type: { type: "string", enum: ["shop", "mechanic"] },
        target_id: { type: "string", description: "Convex shop ID or mechanic ID." },
        limit: { type: "integer", minimum: 1, maximum: 20, description: "Default 5." },
      },
      required: ["target_type", "target_id"],
    },
  },

  {
    name: "find_available_slots",
    description:
      "Find the next bookable appointment slots at a specific shop. Use AFTER the user has indicated booking intent and the shop is known — never for discovery. Pair the result with render_time_selector to show the user. Does NOT book anything.",
    input_schema: {
      type: "object",
      properties: {
        shop_id: { type: "string", description: "Convex shop ID." },
        mechanic_id: { type: "string", description: "Optional — restrict to one mechanic." },
        limit: { type: "integer", minimum: 1, maximum: 10, description: "Default 5." },
      },
      required: ["shop_id"],
    },
  },

  {
    name: "get_rewards_summary",
    description:
      "Snapshot of the user's rewards: credit balance, miles safely driven, services completed, shops visited, and current vehicle tier. Single call returns everything — don't chain multiple rewards lookups.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
];

// -----------------------------------------------------------------------------
// RENDER TOOLS — no DB call. Dispatcher packages args into a ChatMessage field
// matching `services/ai/types.ts:ChatMessage`. Multiple render tool_use blocks
// can be emitted per turn (e.g. shop carousel + quick replies); the dispatcher
// merges them when assembling the assistant message envelope.
//
// Field-parity contract:
//   render_shop_carousel        → message.shops
//   render_service_picker       → message.showServicePicker (+ optional services)
//   render_time_selector        → message.timeSlots         (envelope extension — Gap 6)
//   render_booking_confirmation → message.bookingSummary    (envelope extension — Gap 7)
//   render_quick_replies        → message.quickReplies
//   render_reasoning            → message.reasoning
//   render_sources              → message.sources
// -----------------------------------------------------------------------------

const RENDER_TOOLS: OtoToolSchema[] = [
  {
    name: "render_shop_carousel",
    description:
      "Show a horizontal carousel of mechanic/shop cards inside the chat. Use after the user has indicated they want to book or chosen a service, and after you've fetched shops via get_shop or get_my_mechanics. Limit to 5 shops max — more makes the carousel unwieldy. Ranked order matters: put the best fit first.",
    input_schema: {
      type: "object",
      properties: {
        shops: {
          type: "array",
          maxItems: 5,
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              shopName: { type: "string" },
              address: { type: "string" },
              rating: { type: "number" },
              isVerified: { type: "boolean" },
              photoUrl: { type: ["string", "null"] },
              distanceMi: { type: "number" },
              services: { type: "array", items: { type: "string" } },
              yearsExperience: { type: "integer" },
              isAvailable: { type: "boolean" },
              responseTime: { type: "string", enum: ["Quick", "Normal", "Slow"] },
              availability: { type: "integer" },
              nextAvailability: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    dayOfWeek: { type: "string" },
                    day: { type: "string" },
                    time: { type: "string" },
                  },
                  required: ["dayOfWeek", "day", "time"],
                },
              },
              price: { type: "string" },
            },
            required: ["id", "name", "shopName", "rating", "distanceMi"],
          },
        },
      },
      required: ["shops"],
    },
  },

  {
    name: "render_service_picker",
    description:
      "Open the inline service picker with category tabs. Use when the user has expressed general booking intent but hasn't named a specific service. Prefer passing the `services` list filtered via list_services_for_vehicle — the user sees only what's possible for their car. If `services` is omitted the picker shows the default catalog (less precise; only use when no vehicle is in context).",
    input_schema: {
      type: "object",
      properties: {
        services: {
          type: "array",
          description: "Optional filtered list. Omit for default-catalog mode.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Service slug (kebab-case)." },
              name: { type: "string" },
              description: { type: "string" },
              category: {
                type: "string",
                enum: ["maintenance", "tires", "brakes", "diagnostics"],
                // The client's AIServicePicker only has 4 tabs (see
                // components/ai-chat/AIServicePicker.tsx:66-71), but production
                // has 7 service categories. Map at dispatch time:
                //   Routine Maintenance, Fluids, Battery → "maintenance"
                //   Tires                                → "tires"
                //   Brakes                               → "brakes"
                //   Diagnostics, Compliance              → "diagnostics"
                description: "Picker's 4-tab key. Map from list_services_for_vehicle's category field per the comment in tools.ts.",
              },
              price: { type: "string", description: "Display string, e.g. '$80-$120'." },
              duration: { type: "string", description: "Display string, e.g. '30-45 min'." },
            },
            required: ["id", "name", "category"],
          },
        },
      },
    },
  },

  {
    name: "render_time_selector",
    description:
      "Show available time slots for the user to pick from, after find_available_slots has been called. Each slot should be one entry. Display in chronological order.",
    input_schema: {
      type: "object",
      properties: {
        shop_id: { type: "string", description: "Shop the slots belong to." },
        slots: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Slot ID from find_available_slots." },
              day: { type: "string", description: "Day-of-month string, e.g. '14'." },
              dayOfWeek: { type: "string", description: "Day name, e.g. 'Mon'." },
              time: { type: "string", description: "Start time, e.g. '10:30 AM'." },
              displayText: { type: "string", description: "User-facing label, e.g. 'Mon May 14, 10:30 AM'." },
            },
            required: ["id", "day", "time", "displayText"],
          },
        },
      },
      required: ["shop_id", "slots"],
    },
  },

  {
    name: "render_booking_confirmation",
    description:
      "Show the final booking-summary card BEFORE handing off to payment. Use exactly once per booking flow, after the user has confirmed shop + time + service. Follow with navigate_to_payment only after the user explicitly accepts. The card includes service name, price, platform fee, total, shop, and time slot.",
    input_schema: {
      type: "object",
      properties: {
        summary: {
          type: "object",
          properties: {
            serviceName: { type: "string" },
            servicePrice: { type: "string", description: "Display string, e.g. '$95'." },
            platformFee: { type: "string", description: "Display string, e.g. '$7'." },
            total: { type: "string", description: "Display string, e.g. '$102'." },
            shop: {
              type: "object",
              description: "Same shape as one entry in render_shop_carousel.shops.",
              properties: {
                id: { type: "string" },
                name: { type: "string" },
                shopName: { type: "string" },
                address: { type: "string" },
              },
              required: ["id", "name"],
            },
            timeSlot: {
              type: "object",
              properties: {
                day: { type: "string" },
                dayOfWeek: { type: "string" },
                time: { type: "string" },
                displayText: { type: "string" },
              },
              required: ["time", "displayText"],
            },
          },
          required: ["serviceName", "servicePrice", "total", "shop", "timeSlot"],
        },
      },
      required: ["summary"],
    },
  },

  {
    name: "render_quick_replies",
    description:
      "Show 2–4 tap-to-send reply buttons under your message. This tool emits quick-reply buttons that ARE your final response to the user — calling this tool ENDS YOUR TURN. Optionally include a brief introductory text message in the same turn; the buttons supplement your text, but calling this tool means you're done responding for this turn. Do NOT call other tools after this one. Use when offering a small set of obvious next options ('Closest', 'Best rated'; 'Yes', 'No'; 'Reschedule', 'Cancel', 'Got it'). Keep replies short (≤ 18 chars). Don't use this for free-form clarifying questions.",
    input_schema: {
      type: "object",
      properties: {
        replies: {
          type: "array",
          minItems: 2,
          maxItems: 4,
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              text: { type: "string", maxLength: 24 },
              value: { type: "string", description: "Optional payload sent when tapped (defaults to text)." },
              variant: { type: "string", enum: ["default", "primary", "outline"] },
            },
            required: ["id", "text"],
          },
        },
      },
      required: ["replies"],
    },
  },

  {
    name: "render_reasoning",
    description:
      "Attach a structured reasoning trace to your message — surfaces in the AIReasoning component above the prose. Use when explaining a non-trivial decision (diagnosing a symptom, choosing one service over another, scoring shops). Keep to 2–4 steps. Don't use for trivial replies.",
    input_schema: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          minItems: 1,
          maxItems: 5,
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              detail: { type: "string" },
            },
            required: ["title"],
          },
        },
      },
      required: ["steps"],
    },
  },

  {
    name: "render_sources",
    description:
      "Attach source citations to your message — surfaces in the AISources component. Use when grounding a claim in retrieved data (KB chunk, NHTSA recall, manufacturer service interval). Don't fabricate sources; only cite real ones from tool results or retrieved context.",
    input_schema: {
      type: "object",
      properties: {
        sources: {
          type: "array",
          maxItems: 5,
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              details: { type: "string" },
              url: { type: "string", description: "Optional source URL." },
            },
            required: ["title"],
          },
        },
      },
      required: ["sources"],
    },
  },
];

// -----------------------------------------------------------------------------
// NAVIGATION TOOLS — the only Phase 1 navigation case is payment.
// Everything else renders inline.
// -----------------------------------------------------------------------------

const NAVIGATION_TOOLS: OtoToolSchema[] = [
  {
    name: "navigate_to_payment",
    description:
      "Hand off to the payment screen at /home/mechanic/{mechanic_id}/payment to finalize a booking. Call this ONLY after: (1) the user has selected a mechanic, time slot, and service; (2) render_booking_confirmation has shown the summary; and (3) the user has explicitly confirmed they want to proceed. Never call speculatively. State in your prose that you're handing them to the payment screen.",
    input_schema: {
      type: "object",
      properties: {
        mechanic_id: { type: "string", description: "Convex mechanic ID — drives the route path." },
        service_slug: {
          type: "string",
          description: "Snake_case service slug. The payment screen reads this from the booking store.",
        },
        slot_id: { type: "string", description: "Selected time-slot ID from find_available_slots." },
        vehicle_id: { type: "string", description: "VIN of the vehicle to service." },
      },
      required: ["mechanic_id", "service_slug", "slot_id", "vehicle_id"],
    },
  },
];

// -----------------------------------------------------------------------------
// Exports — order is part of the cached prefix. Do not reshuffle without
// bumping the prompt version.
// -----------------------------------------------------------------------------

export const OTO_TOOLS: OtoToolSchema[] = [
  ...DATA_TOOLS,
  ...RENDER_TOOLS,
  ...NAVIGATION_TOOLS,
];

export const OTO_TOOL_NAMES = OTO_TOOLS.map((t) => t.name);

export type OtoToolCategory = "data" | "render" | "navigation";

export const OTO_TOOL_CATEGORY: Record<string, OtoToolCategory> = {
  // data
  get_my_vehicles: "data",
  get_bookings: "data",
  get_due_services: "data",
  list_service_categories: "data",
  list_services_for_vehicle: "data",
  get_service_details: "data",
  get_shop: "data",
  get_shop_services: "data",
  get_shop_hours: "data",
  get_mechanic: "data",
  get_my_mechanics: "data",
  get_reviews: "data",
  find_available_slots: "data",
  get_rewards_summary: "data",
  // render
  render_shop_carousel: "render",
  render_service_picker: "render",
  render_time_selector: "render",
  render_booking_confirmation: "render",
  render_quick_replies: "render",
  render_reasoning: "render",
  render_sources: "render",
  // navigation
  navigate_to_payment: "navigation",
};

// Canonical service slugs — production source of truth is the Convex
// `services` table, populated by `convex/seeds/seedServices.ts`. Verified
// against a production CSV dump on 2026-05-11.
//
// FORMAT IS snake_case. Several other files in this repo still reference an
// older kebab-case taxonomy that no longer matches production —
// see `docs/oto-ai/slug-drift-remediation.md` for the full audit. Do not use
// kebab-case slugs anywhere in Oto AI tool surface.
//
// NEVER add to this list without first adding the service to `convex/services`
// (via the canonical seed) and confirming it surfaces in `services.list`.
export const OTOPAIR_SERVICE_SLUGS = [
  // Diagnostics
  "diagnostic_scan",
  "pre_purchase_inspection",
  "check_engine_light",
  // Compliance
  "state_inspection",
  "emissions_test",
  // Routine Maintenance
  "oil_change",
  "filter_replacement",        // bundled: engine air filter + cabin air filter
  "spark_plugs",
  "timing_belt",
  "coolant_flush",
  "transmission_service",
  // Tires
  "tire_rotation",
  "tire_balance",
  "wheel_alignment",
  "tire_replacement",
  // Brakes
  "brake_pad_replacement",
  "rotor_replacement",
  "brake_fluid_flush",
  // Battery
  "battery_test",
  "battery_replacement",
  // Fluids
  "power_steering_flush",
  "differential_service",
  "fuel_system_cleaning",
] as const;

export type OtopairServiceSlug = (typeof OTOPAIR_SERVICE_SLUGS)[number];

// --- Historical reference: stale kebab-case slugs from
//     convex/seed_services_catalog.ts. Do NOT use. Kept for cross-checking
//     against legacy call sites during the cleanup pass.
// const STALE_KEBAB_SLUGS_DO_NOT_USE = [
//   "oil-change", "engine-air-filter", "cabin-air-filter",
//   "wiper-blade-replacement", "spark-plug-replacement",
//   "serpentine-belt-replacement", "battery-replacement", "battery-test",
//   "coolant-flush", "transmission-fluid-service", "brake-pad-replacement",
//   "brake-rotor-replacement", "brake-fluid-flush", "tire-rotation",
//   "wheel-balancing", "wheel-alignment", "tire-replacement",
//   "tire-installation", "tpms-sensor-calibration", "ny-state-inspection",
//   "general-diagnostic", "check-engine-light", "brake-system-inspection",
// ];

// Canonical service categories — production has 7. Names come from the live
// `service_categories` table seeded by `convex/seeds/seedServices.ts`.
export const OTOPAIR_SERVICE_CATEGORIES = [
  "Diagnostics",
  "Compliance",
  "Routine Maintenance",
  "Tires",
  "Brakes",
  "Battery",
  "Fluids",
] as const;

export type OtopairServiceCategory = (typeof OTOPAIR_SERVICE_CATEGORIES)[number];
