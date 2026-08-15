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
    name: "get_bookings",
    description:
      "Get the user's bookings filtered by status. Use `status_filter: 'active'` for upcoming/in-progress (statuses: pending, confirmed, in_progress). Use `'completed'` before recommending a new service so you don't duplicate recent work. Use `'all'` only when explicitly asked. Returns most recent first; default limit 5. " +
      "VEHICLE SCOPING: when the user's question is scoped to a specific car (\"do I have any bookings for this car\", \"on my MKX\", \"my X\"), you MUST pass `vehicle_vin` from the <vehicle> block so the result only includes that vehicle's bookings. Omit `vehicle_vin` only when the user explicitly asks about ALL their cars (\"across all my vehicles\", \"every car\"). Failing to pass the VIN on a car-scoped question is a bug — Haiku will conflate bookings from other vehicles into the response.",
    input_schema: {
      type: "object",
      properties: {
        status_filter: {
          type: "string",
          enum: ["active", "completed", "all"],
          description: "Which bookings to return.",
        },
        limit: { type: "integer", minimum: 1, maximum: 20, description: "Default 5." },
        vehicle_vin: {
          type: "string",
          description:
            "VIN of the active vehicle (read from <vehicle> block). Filters results to that car only. Required for any car-scoped question. Omit only for cross-vehicle queries.",
        },
      },
      required: ["status_filter"],
    },
  },

  {
    name: "get_pending_bookings",
    description:
      "Get the user's PENDING bookings only — bookings that have been created but NOT yet confirmed by the shop (status === 'pending'). Use when the user asks specifically about pending / unconfirmed bookings: \"what's pending?\", \"do I have any pending bookings?\", \"what bookings haven't been confirmed yet?\", \"anything still waiting?\". This is a STRICT SUBSET of get_bookings(status_filter: 'active') — that broader call includes pending + confirmed + in_progress. If the user wants ALL upcoming/active work (including confirmed appointments), call get_bookings(status_filter: 'active') instead. Returns most recent first; default limit 5; max 20. Same OtoBookingSummary shape as get_bookings. " +
      "VEHICLE SCOPING: same rule as get_bookings — pass `vehicle_vin` from the <vehicle> block whenever the question is scoped to a specific car. Omit only for cross-vehicle queries.",
    input_schema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 20, description: "Default 5." },
        vehicle_vin: {
          type: "string",
          description:
            "VIN of the active vehicle (read from <vehicle> block). Filters results to that car only. Required for any car-scoped question. Omit only for cross-vehicle queries.",
        },
      },
    },
  },

  {
    name: "get_due_services",
    description:
      "Get computed maintenance urgency for a vehicle — which services are overdue, due soon, or fine. This is the answer to 'what does my car need?' or 'anything coming up?'. Each row carries `urgency: 'overdue' | 'due_soon' | 'ok'` plus due-mileage and due-date when known, and uses canonical service slugs (snake_case, e.g. 'oil_change') that you can pass back into get_service_details or render_book_service.",
    input_schema: {
      type: "object",
      properties: {
        vehicle_id: {
          type: "string",
          description: "The active vehicle's identifier from the <vehicle> block (its VIN or Convex id — either works).",
        },
      },
      required: ["vehicle_id"],
    },
  },

  {
    name: "list_services_for_vehicle",
    description:
      "List the services Otopair offers FOR THIS SPECIFIC VEHICLE, after applying compatibility filters (engine type, drivetrain, steering type, model year, tire fitment, state). Use this — not a generic catalog dump — whenever you're suggesting services or showing a service picker. The filter eliminates impossible recommendations (e.g. timing-belt service on a chain-driven engine, oil-change on an EV, emissions-test on an EV, state-inspection in a state that doesn't require one). Returns each service with its canonical snake_case slug, name, description (quote this text when explaining services), default labor hours, and a parts cost band when known. Pass `category` to scope to one of: Routine, Tires & Brakes, Scheduled Service, Inspections.",
    input_schema: {
      type: "object",
      properties: {
        vehicle_id: { type: "string", description: "VIN of the vehicle." },
        category: {
          type: "string",
          enum: ["Routine", "Tires & Brakes", "Scheduled Service", "Inspections"],
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
    name: "get_rewards_summary",
    description:
      "Snapshot of the user's rewards: credit balance, miles safely driven, services completed, shops visited, and current vehicle tier. Single call returns everything — don't chain multiple rewards lookups. Call this for \"what's my balance?\", \"how many credits do I have?\", \"what tier am I?\", \"how many miles have I driven safely?\", \"how many services have I completed?\". OPEN/SHOW REQUESTS FIRE THIS TOOL: \"open my rewards\", \"take me to the loyalty screen\", \"show me my loyalty stuff\" — Loyalty is an in-chat domain with no redirect destination, so the way you \"open\" it is to call this tool NOW and present the balance in the same turn. Never explain that there's no loyalty screen and then ask whether to pull the balance — fire, don't offer. And never follow the summary with render_link_button: loyalty has no destination, and profile/settings are NOT proxies for it — the in-chat answer plus a prose pointer to the Loyalty screen IS the complete fulfillment. For deep-dive transaction history use get_loyalty_points_history; for what the user can redeem use get_available_redemptions; for program rules use get_loyalty_program_info.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },

  {
    name: "get_loyalty_points_history",
    description:
      "Recent ownership-credit transactions for the user (both earn and redeem). Call this when the user asks where their credits came from, what they earned recently, what they redeemed, or to itemize last month's activity (\"how many credits have I earned this month?\", \"where did my last credit come from?\", \"show me my points history\"). For the current balance snapshot, use get_rewards_summary instead — don't chain.",
    input_schema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "Maximum number of transactions to return. Default 5.",
        },
      },
    },
  },

  {
    name: "get_available_redemptions",
    description:
      "What redemption options the user can browse with their current rewards posture (gift cards, booking credit, deals). INFORMATIONAL SURFACING ONLY — Haiku surfaces options to the user; the actual claim happens on the Loyalty screen in the app, NEVER in chat. Do NOT promise to claim, do NOT call this in response to \"redeem [X]\" expecting it to execute the redemption. When the user wants to actually claim, briefly describe what's available and point them to the Loyalty screen in their account — IN PROSE ONLY. Never fire render_link_button for the claim path: there is no loyalty destination, and profile/settings are NOT proxies for it. Optional `category` narrows the list (e.g., \"gift_card\", \"service_credit\") if the user asks for a specific kind.",
    input_schema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          description: "Optional filter for redemption category (e.g., \"gift_card\", \"service_credit\"). Pass through verbatim; matched case-insensitively against reward_deals categories.",
        },
      },
    },
  },

  {
    name: "get_loyalty_program_info",
    description:
      "Program rules for the OtoPair loyalty program: tier breakpoints (Driver / Preferred / Elite), credit earning rates per tier, credit-expiry rules, and how the program works overall. Call this when the user asks \"how does the loyalty program work?\", \"what are the tier breakpoints?\", \"how do I earn credits?\", \"do my credits expire?\". Returns plain-language rules — Haiku summarizes them in conversational tone. For the user's CURRENT tier / balance, use get_rewards_summary instead.",
    input_schema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["overview", "tiers", "earning_rules", "expiry_rules"],
          description: "Optional scope filter. \"overview\" returns everything; \"tiers\" only breakpoints; \"earning_rules\" only rate-per-tier; \"expiry_rules\" only credit-expiry policy. Default \"overview\".",
        },
      },
    },
  },

  {
    name: "get_vehicle_health",
    description:
      "Returns the user's vehicle health snapshot: a 0–100 health score, whether the score is estimated, and a per-maintenance-type breakdown (oil, brakes, tires, inspection, battery) with status, description, and service-history details. Call this tool when the user asks about their car's overall condition (\"how is my car doing?\", \"what's my score?\") or when narrowing a symptom has pointed toward a routine maintenance category and you need to check whether that maintenance is overdue or due-soon. MANDATORY before concluding a maintenance-flavored symptom conversation: once narrowing has pointed at a maintenance category (brakes, tires, oil, battery), you may NOT fire render_book_service, wrap up, or answer the final narrowed turn without having called this in the SAME conversation — the trust gate (symptom vs self_reported record → render_record_confirmation) cannot be evaluated without it, and skipping the read skips the gate blind. Do NOT call this tool for educational questions, refusals, or general catalog inquiries — only when vehicle-specific maintenance state is relevant to the response.\n\nEach item includes `record_provenance`, which tells you how much to trust its status: `verified` = backed by third-party evidence (a completed OtoPair booking, an uploaded service record, or mechanic-onboarded data), treat as truth; `self_reported` = user-provided via onboarding or check-in without a backing document, soft data that may be stale or wrong (data form hallucination is common — users misremember service dates and click through onboarding quickly); `inferred` = no record exists, status came from a fallback (warning light, vehicle age, default). When a user-described symptom contradicts a `self_reported` item's status, the record itself is suspect — surface it to the user before treating the status as authoritative. When the contradiction is against a `verified` item, the symptom is the surprise — narrow it.\n\nCOVERAGE IS NARROW AND THE RESPONSE SAYS SO. Every response carries `monitored_systems` (the complete set OtoPair tracks, each with a `covers` note stating its exact boundary) and `not_monitored` (the statement of everything outside it). Read those two fields BEFORE the items. The absence of a system from `items` means it has never been measured — it does NOT mean it is healthy. Never call an unlisted system fine, healthy, or \"covered,\" and never let a good score or a clean item list stand in for data you do not have. Note especially that the `battery` item is the 12V starter battery ONLY — it is NOT a hybrid or EV high-voltage traction battery, and traction packs, transmission, suspension and A/C are never tracked here. For anything outside `monitored_systems`, say plainly that you have no data on it and offer an inspection.",
    input_schema: {
      type: "object",
      properties: {
        vehicle_id: {
          type: "string",
          description: "The active vehicle's identifier from the <vehicle> block (its VIN or Convex id — either works).",
        },
      },
      required: ["vehicle_id"],
    },
  },

  {
    name: "lookup_vehicle_spec",
    description:
      "Look up factual specs for ANY vehicle (engine, drivetrain, transmission, chassis code, trim) by free-text query — used for comparison questions or general curiosity about cars the user does NOT own. Pass a natural-language query like *\"2020 BMW M5\"*, *\"Tesla Model 3 Performance\"*, *\"Honda Civic Si\"*. Returns either a single matched config with the full facts, or a candidates list to disambiguate (Haiku then asks the user which they meant, OR picks the most recent year by default). If the result is empty (no match in our catalog), fall back IN THE SAME TURN: call web_search for a published spec, or answer from general knowledge hedged as general info — never fabricate. A MISS IS NOT A TERMINAL: never end your turn announcing what you'll do next (\"let me search for the current spec\", \"let me pull that from general knowledge\") — an announcement without the answer is a failed turn; the user asked a question and gets an answer or a clean \"I don't know\", nothing in between. For the user's OWN car, use get_vehicle_facts instead.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Free-text car name. Examples: \"2020 BMW M5\", \"Tesla Model 3\", \"Honda Civic Si Coupe\".",
        },
      },
      required: ["query"],
    },
  },

  {
    name: "retrieve_vehicle_facts",
    description:
      "Search Oto's growing knowledge base of vehicle facts. Pass a `topic` slug (e.g. \"oil_capacity\", \"timing_belt_or_chain\", \"recommended_tire_pressure\") AND optionally a `question_text` (the user's actual phrasing — enables semantic similarity search). Optional scope: `vehicle_config_id`, `chassis_code`, or `engine_code` — restricts results to facts relevant to that scoping (e.g., chassis-axis facts propagate to all configs sharing the chassis). Returns matched facts with provenance + confidence. Call this BEFORE answering any factual question about a car — saves training-knowledge fabrication AND grows the KB over time. If results are empty, answer from training knowledge (or web_search for verifiable specs) AND call record_vehicle_fact so the next user with the same question gets the cached answer.",
    input_schema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Short topic slug; pick something stable so future writes match (e.g. 'oil_capacity_qts')." },
        question_text: { type: "string", description: "The user's actual question, for semantic similarity ranking. Optional." },
        vehicle_config_id: { type: "string", description: "Convex vehicle_configs._id to scope to one specific config." },
        chassis_code: { type: "string", description: "Chassis code to scope to all configs sharing this chassis." },
        engine_code: { type: "string", description: "Engine code to scope to all configs sharing this engine." },
        limit: { type: "integer", minimum: 1, maximum: 10, description: "Default 5." },
      },
      required: ["topic"],
    },
  },

  {
    name: "record_vehicle_fact",
    description:
      "Persist a factual statement to Oto's knowledge base so future turns and other users don't have to re-derive it. Call this AFTER answering a factual question — whether from your training knowledge, from web_search results, or from a tool response that confirmed a detail. Scope the fact along ONE axis (\"vehicle\" / \"trim\" / \"chassis\" / \"engine\" / \"model_year\") — pick the axis the fact actually applies to. Engine facts (oil viscosity, displacement, timing) go on \"engine\" with engine_code so they propagate to all cars sharing that engine. Chassis facts (suspension geometry, body dimensions) go on \"chassis\". Trim-specific facts (tire fitment, brake hardware) go on \"trim\" or \"vehicle\". Set `source` honestly: \"manufacturer\" for OEM-documented values, \"web_search\" for sourced web results (cite the URL), \"oto_inferred\" for reasoned-from-training conclusions, \"user_confirmed\" when the user supplied the answer. `confidence` 0.0–1.0 — calibrate honestly; over-confident facts pollute the KB.",
    input_schema: {
      type: "object",
      properties: {
        topic: { type: "string" },
        topic_axis: {
          type: "string",
          enum: ["vehicle", "trim", "chassis", "engine", "model_year"],
        },
        vehicle_config_id: { type: "string" },
        chassis_code: { type: "string" },
        engine_code: { type: "string" },
        make: { type: "string" },
        model: { type: "string" },
        trim_name: { type: "string" },
        year_min: { type: "integer" },
        year_max: { type: "integer" },
        fact_text: { type: "string", description: "The fact itself, written naturally." },
        question_text: { type: "string", description: "The question this fact answers — used to embed for semantic retrieval." },
        answer_format: { type: "string", description: "Optional: 'numeric_qts', 'numeric_psi', 'enum', 'prose', etc." },
        source: {
          type: "string",
          enum: ["manufacturer", "oto_inferred", "web_search", "user_confirmed", "propagated"],
        },
        cited_url: { type: "string", description: "Required when source='web_search'." },
        confidence: { type: "number", minimum: 0, maximum: 1 },
      },
      required: ["topic", "topic_axis", "fact_text", "question_text", "source", "confidence"],
    },
  },

  // NOTE: web_search is a server-managed Anthropic tool (see chat.ts
  // SERVER_MANAGED_TOOLS). Its schema is set by Anthropic, not by us — we
  // don't define it here, but the system_prompt documents when Haiku should
  // invoke it. After a web_search invocation, Haiku MUST call
  // record_vehicle_fact with source="web_search" and the cited URL so the
  // KB grows.

  {
    name: "get_vehicle_facts",
    description:
      "Get factual specifications for the user's vehicle — engine (displacement, cylinders, configuration, aspiration, oil viscosity, oil capacity, coolant type, coolant capacity), transmission (type, speeds, fluid), drivetrain, tire fitment and pressures, brake and power-steering fluid types. Call this when the user asks specifics about THEIR car (\"what engine does my car have?\", \"what oil does it take?\", \"what tire pressure should I use?\", \"does it have a timing belt or chain?\"). Do NOT call for general questions about cars they don't own — use your training knowledge for that with a 'general info, your actual config may differ' caveat.",
    input_schema: {
      type: "object",
      properties: {
        vehicle_id: {
          type: "string",
          description: "Convex `vehicles._id` from the <vehicle> block (NOT a VIN).",
        },
      },
      required: ["vehicle_id"],
    },
  },

  {
    name: "get_projected_health_score",
    description:
      "Returns what the user's health score would become if a specific maintenance item flipped to on-time. Used for conversion moments — \"fixing this would lift your score from 71 to 84.\" Call this AFTER get_vehicle_health has identified a non-on_time item the user is being encouraged to address. Pass the item_id from that item.",
    input_schema: {
      type: "object",
      properties: {
        vehicle_id: {
          type: "string",
          description: "VIN. Same value passed to get_vehicle_health.",
        },
        item_id: {
          type: "string",
          description: "MaintenanceItem id from get_vehicle_health (e.g. \"user-brakes\", \"unknown-oil\").",
        },
      },
      required: ["vehicle_id", "item_id"],
    },
  },
];

// -----------------------------------------------------------------------------
// MODEL ROUTING TOOLS — Phase 2 Sonnet cascade.
//
// Haiku self-assesses when a turn needs deeper reasoning than it can reliably
// deliver, and calls request_sonnet_handoff to escalate. Sonnet handles the
// hard turn, then calls request_haiku_handback to return to default Haiku
// routing for the next turn.
//
// Per-turn model state lives on ai_conversations.current_model. chat.ts
// reads it at the start of each turn and selects the model accordingly.
//
// Calibration target (TestFlight data): complexity self-assessment fires on
// ~15-25% of diagnostic turns. Below = missing hard cases; above = over-
// routing to Sonnet. Threshold is tuned in the prompt rule, not in code.
// -----------------------------------------------------------------------------

const MODEL_ROUTING_TOOLS: OtoToolSchema[] = [
  {
    name: "request_sonnet_handoff",
    description:
      "Escalate this conversation to Claude Sonnet for the NEXT user turn. Call this when you (Haiku) recognize that the current or upcoming turn exceeds what you can reliably deliver — common triggers: (a) the user has asked a deep diagnostic question with 3+ candidate causes that need careful narrowing, (b) the conversation has accumulated 4+ turns of failed narrowing and you're about to render the polite-exit form (sonnet may close it cleanly), (c) the user asked a multi-part technical/comparison question that needs cross-tool reasoning (vehicle facts + KB + comparison), (d) legal-adjacent or safety-sensitive turn where wording precision matters. Do NOT escalate for: simple specs lookups, single-fact answers, routine booking-flow stages. Escalation costs ~5x more per turn; over-routing hurts cost-per-booking.",
    input_schema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Short tag explaining why you're escalating. Used for telemetry calibration. Examples: 'deep_diagnostic_narrowing', 'cross_tool_reasoning', 'legal_adjacent', 'polite_exit_complex'.",
        },
      },
      required: ["reason"],
    },
  },
  {
    name: "request_haiku_handback",
    description:
      "Sonnet calls this when its escalated turn(s) are complete and the next turn can return to Haiku at the default rate. Use after Sonnet has finished the hard turn — typically immediately after Sonnet's user-facing response. Haiku will pick up the next turn at default cost.",
    input_schema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Short tag explaining why handing back. Examples: 'narrowing_complete', 'recommendation_made', 'refusal_landed'.",
        },
      },
      required: ["reason"],
    },
  },
];

// -----------------------------------------------------------------------------
// STATE TOOLS — Oto-maintained conversation state writebacks.
//
// State tools are side-effect calls that persist to ai_conversations. The
// dispatcher fires them in parallel with the main response (data/render),
// returns a trivial ack tool_result for API contract conformance, and does
// NOT use them to control loop continuation. Call them WHENEVER you produce a
// user-facing response; the next turn replays the saved state as a
// <conversation_state> envelope block so you don't have to re-derive context
// from raw message history every turn.
// -----------------------------------------------------------------------------

const STATE_TOOLS: OtoToolSchema[] = [
  {
    name: "record_semantic_fact",
    description:
      "Record something the user has stated about themselves that's worth remembering ACROSS future conversations. Use sparingly — only when the user expresses a durable preference, a profile attribute (mileage, driving habits, location, communication style), dismisses an option you might otherwise re-offer later, or anchors a service-history event. Do NOT use for one-off conversational facts about a specific vehicle or service — those go in update_conversation_state. Examples of CORRECT use: user says 'I prefer text summaries over images when you tell me about my car' → fact_type=communication_style, source=user_stated; user says 'I drive about 30k miles per year' → fact_type=service_preference (driving habit influences service cadence), source=user_stated; user declines a brake-check recommendation and says 'I'll do it myself' → fact_type=service_preference, source=user_stated. Examples of INCORRECT use: user says 'my car has a check-engine warning right now' (one-off symptom — belongs in update_conversation_state); user names their car (chat-only fluff). Write the fact in THIRD PERSON referring to the user (e.g., 'User prefers text over images.'). Call this in ADDITION to update_conversation_state — these serve different scopes. REINFORCEMENT: when the user REPEATS, re-asserts, or adds emphasis to a fact you already recorded — even one recorded earlier in THIS conversation ('like I said, only BMW specialists touch this car'; 'that pull I mentioned — happens every cold morning without fail') — call this tool AGAIN with the same payload. Analyzing the repetition in prose without re-calling the tool is WRONG: the re-call IS how the emphasis gets stored. Repetition is signal: the backend deduplicates and bumps the fact's reinforcement weight; it will never double-store. Never skip the call because the fact is 'already on file'. Retraction has its own tool (retract_semantic_fact).",
    input_schema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description:
            "The fact, written in third person referring to the user. Concise, single sentence. Example: 'User prefers synthetic oil.' or 'User drives ~30k miles per year.'",
        },
        fact_type: {
          type: "string",
          enum: [
            "mechanic_preference",
            "service_preference",
            "communication_style",
            "vehicle_quirk",
            "history_anchor",
          ],
          description:
            "Category. mechanic_preference = repeated-booking-with-specific-mechanic anchors. service_preference = stated taste/choice about services or maintenance cadence (also covers dismissals — 'declines synthetic blend'). communication_style = how the user wants Oto to communicate ('terse answers', 'text over images'). vehicle_quirk = a durable, vehicle-specific behavior the user has observed ('pulls left when cold'). history_anchor = a prior service event worth remembering ('last brake service ~March 2026').",
        },
        source: {
          type: "string",
          enum: ["user_stated", "inferred_behavior"],
          description:
            "Provenance. user_stated = the user said it explicitly in this conversation. inferred_behavior = derived from a pattern across this conversation (e.g., user has dismissed brake-check 3 times). Do NOT use 'mechanic_confirmed' — that's reserved for verified service records, not chat.",
        },
        confidence: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description:
            "Initial confidence. Anchor 0.4-0.6 for first observation; raise toward 0.7-0.8 only when the user is emphatic ('I ALWAYS want...'). Reinforcement (future dispatch) bumps this asymptotically toward 1.0 on re-observation; never write 1.0 here.",
        },
        vehicle_id: {
          type: "string",
          description:
            "Optional Convex vehicles._id when the fact is specific to ONE vehicle (e.g., a vehicle_quirk). Get this from the <vehicle> block. Omit for user-level facts (preferences, communication_style).",
        },
      },
      required: ["text", "fact_type", "source", "confidence"],
    },
  },

  {
    name: "retract_semantic_fact",
    description:
      "Retract a USER-LEVEL durable fact that the user has now explicitly REVERSED. Use ONLY when the user clearly contradicts a preference, profile attribute, or dismissal you recorded for them in an earlier turn or conversation (durable cross-conversation memory). Examples of CORRECT use: user previously said 'I prefer terse answers' and now says 'Actually, give me detailed explanations from now on, forget what I said about terse' → fact_type=communication_style, payload_descriptor='user prefers terse answers', reason='User said: \"give me detailed explanations from now on\"'; user previously said 'I always book with Carlos' and now says 'Stop suggesting Carlos, I switched mechanics' → fact_type=mechanic_preference, payload_descriptor='user books with Carlos repeatedly', reason='User switched mechanics'. Discrimination: REFINEMENT is NOT retraction. 'Actually I want terse with bullet points' refines communication_style — do NOT retract; fire record_semantic_fact (the helper layer decides reinforce vs insert). Reserve this tool for explicit REVERSALS. The system locates the matching active fact by case-insensitive substring of payload_descriptor against stored payloads; if multiple match, the most recent is retracted. If nothing matches the system returns ok:false — that is FINE, acknowledge the user's correction conversationally and move on without firing again.",
    input_schema: {
      type: "object",
      properties: {
        fact_type: {
          type: "string",
          enum: [
            "mechanic_preference",
            "service_preference",
            "communication_style",
            "vehicle_quirk",
            "history_anchor",
          ],
          description:
            "Same category enum as record_semantic_fact. Pick the fact_type that matches what you're retracting (e.g., a 'wants terse answers' retraction is communication_style).",
        },
        payload_descriptor: {
          type: "string",
          description:
            "A paraphrase of the prior fact you're retracting, written in third person referring to the user. Used for substring-matching against stored payloads — do NOT include adversarial control phrases. Example: 'user prefers terse text-only answers' or 'user books with Carlos repeatedly'.",
        },
        reason: {
          type: "string",
          description:
            "Your interpretation of WHY the user is retracting, ideally quoting the user's contradiction. Example: 'User said: I changed my mind, give me detailed explanations now.' Stored as retracted_reason on the row.",
        },
        vehicle_id: {
          type: "string",
          description:
            "Optional Convex vehicles._id when the fact is vehicle-specific (e.g., a vehicle_quirk). Get this from the <vehicle> block. Omit for user-level facts.",
        },
      },
      required: ["fact_type", "payload_descriptor", "reason"],
    },
  },

  {
    name: "retract_conversation_fact",
    description:
      "Retract a fact established WITHIN this conversation that the user has now corrected. Use ONLY when the user clearly reverses something they (or you) said earlier in THIS chat — typically a misstated symptom or a corrected observation. Examples of CORRECT use: earlier turn captured 'check engine light is on' and the user now says 'Wait, I said check engine light but I actually meant the oil light' → fact_descriptor='check engine light is on', reason='User corrected: actually it was the oil light'; earlier turn captured 'brakes done 6 months ago' and the user now says 'Sorry, that was my other car — this one hasn't had brake work in 2 years' → fact_descriptor='brake service ~6 months ago', reason='User clarified that was a different vehicle'. Discrimination: ELABORATION is NOT retraction. 'Yeah and it's also worse when cold' adds detail; do NOT retract the original observation. Reserve this for explicit REVERSALS or CORRECTIONS of in-conversation facts. The system locates the matching active fact in this conversation by case-insensitive substring match; if multiple match, the most recent is retracted. If no match found the system returns ok:false — acknowledge the correction conversationally and continue without re-firing.",
    input_schema: {
      type: "object",
      properties: {
        fact_descriptor: {
          type: "string",
          description:
            "A paraphrase of the in-conversation fact you're retracting, matching how it would have surfaced in <conversation_state> or <established_facts>. Example: 'check engine light is on' or 'brake service ~6 months ago'. Used for substring matching; keep it close to the original wording.",
        },
        reason: {
          type: "string",
          description:
            "Your interpretation of WHY the user is correcting, ideally quoting the contradiction. Example: 'User clarified: actually it was the oil light, not check engine.' Stored as retracted_reason on the row.",
        },
      },
      required: ["fact_descriptor", "reason"],
    },
  },

  {
    name: "update_conversation_state",
    description:
      "Persist your current read of the conversation so the next turn picks it up. Call this on EVERY user-facing response turn alongside your text or render directive. Send the FULL CURRENT STATE each time — not deltas. If a field hasn't changed, repeat its prior value. The next turn's envelope replays these fields as <conversation_state>; if you stop writing, the next turn sees stale or empty state.",
    input_schema: {
      type: "object",
      properties: {
        mood: {
          type: "string",
          enum: ["calm", "curious", "worried", "frustrated", "hyped", "confused", "neutral"],
          description:
            "Your best read of the user's emotional state from their last message AND the conversation arc. Not their vocabulary (don't mirror) — their underlying state. 'calm' is the default for routine chat. 'curious' for educational questions. 'worried' for safety concerns about their car. 'frustrated' for impatience, complaints, push-back, or cap-hit anger. 'hyped' for excited/upbeat energy. 'confused' when they're lost and need a slower explanation. 'neutral' if you genuinely can't tell.",
        },
        arc: {
          type: "string",
          maxLength: 400,
          description:
            "One or two sentences capturing where the conversation is right now — what was asked, what's been established, what's pending. Used by future turns to avoid retracing. Example: 'User reported brake squeal, narrowed to first-stop pattern. Asked Oto about health and learned brakes are on_time with no flagged service history. Currently considering whether to book a Diagnostic Scan.' Field name is `arc` (matches the envelope label).",
        },
        established_facts: {
          type: "array",
          items: { type: "string" },
          description:
            "Short factual statements the conversation has surfaced — symptoms reported, conditions, mileages, prior service mentions, user preferences. Each entry is one self-contained string. SEND THE FULL CURRENT LIST every time (this REPLACES the prior value — no deltas). Cap around 10 entries; drop oldest if you exceed. Examples: 'mileage ~38000', 'brake squeal at first braking only', 'no recent brake work mentioned', 'user prefers shop nearest to home zip'.",
        },
        last_intent: {
          type: "string",
          description:
            "Short tag for what the user is doing in this latest message. Examples: 'health_check', 'symptom_narrowing_brakes', 'service_history_lookup', 'vehicle_facts_query', 'override_attempt', 'general_car_knowledge', 'support_intake', 'safety'. Free-form — pick what's most descriptive. Field name is `last_intent` (matches the envelope label).",
        },
      },
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
//   render_book_service          → message.bookService       (Sprint 4 Day 1 Pass B — single terminal booking render, consolidates the prior 6-stage flow)
//   render_record_confirmation   → message.showRecordConfirmation { vehicle_id, maintenance_type }
//   render_link_button           → message.linkButton        (Sprint 3 §14.1 — 9-destination app-nav redirect)
//   render_booking_card          → message.bookingCard       (Sprint 3 §14.3 — single-booking detail card)
//   render_bookings_list         → message.bookingsList      (Sprint 3 §14.3 — multi-booking list)
//   render_quick_replies         → message.quickReplies
//   render_reasoning             → message.reasoning
//   render_sources               → message.sources
// -----------------------------------------------------------------------------

const RENDER_TOOLS: OtoToolSchema[] = [
  {
    name: "render_book_service",
    description:
      "Single terminal render that opens the consolidated booking component pre-filled with everything Oto has narrowed down. Fire this ONCE per booking conversation cycle when ANY of these is true: " +
      "(a) symptom narrowing has converged on a Diagnostic Scan (multi-cause ambiguity, on_time verified records, unknown/needs_attention records, or 6-turn polite exit) — pass `service_slugs: [\"diagnostic_scan\"]` + `diagnostic_system` + `customer_notes`. " +
      "(b) vehicle-health flags an item due_soon/overdue AND the symptom matches that wear (direct service) — pass `service_slugs: [<direct_service_slug>]` (e.g. `[\"brake_pad_replacement\"]`), omit `diagnostic_system`, optionally include a brief `customer_notes` anchor. " +
      "(c) user explicitly asks to book a specific service (\"I want an oil change\") — pass `service_slugs: [<requested_service_slug>]`, omit `diagnostic_system` and `customer_notes`. " +
      "(d) user bundles multiple services (\"oil change AND tire rotation\") — pass `service_slugs: [\"oil_change\", \"tire_rotation\"]`, omit `diagnostic_system`. " +
      "(e) user confirms (\"yeah\" / \"yes\" / \"go ahead\" / \"sounds good\" / \"let's do it\") AFTER Oto offered to book — fire IMMEDIATELY; DO NOT re-ask, re-explain, or chain another \"Want me to…?\" sentence. " +
      "(f) the record-confirmation result arrives — a synthetic user message reading \"Confirmed — [type] record is correct as-is.\" or \"Updated — last [type] service was actually …\" after a render_record_confirmation turn. Confirmed → fire THIS TURN with `service_slugs: [\"diagnostic_scan\"]` + `diagnostic_system` + `customer_notes` (record was right, symptom is the surprise). Updated → re-check get_vehicle_health; overdue/due_soon → direct slug, still on_time → diagnostic-scan prefill. Answering the confirmation turn in prose without the booking render is the defect — and never name a canonical repair service (no \"Brake Pad Replacement\") on the way. " +
      "TRUST-GATE PRECEDENCE: do NOT fire this on the turn a narrowed symptom contradicts a get_vehicle_health item that is on_time with record_provenance \"self_reported\" and the record has NOT yet been confirmed this conversation — that turn belongs to render_record_confirmation (the record itself may be wrong); this tool fires on the FOLLOWING turn, after the user confirms or updates the record. " +
      "Polite-exit pattern (6 unconverged narrowing turns): pass `service_slugs: [\"diagnostic_scan\"]`, `diagnostic_system: \"not_sure\"`, `customer_notes` = summary of everything the user mentioned. " +
      "TERMINAL render — no further data lookups and no second card after it; update_conversation_state still fires in the same turn (render_quick_replies MAY accompany it in the same turn). SINGLE FIRE per booking conversation cycle — do NOT fire it again on subsequent turns; the mobile component handles every sub-stage internally (service options → notes → mechanic selection → time-slot → confirmation → pay-screen redirect) without going back through Oto. " +
      "Do NOT pass a `price` field on any service. Do NOT invent slugs — must match OTOPAIR_SERVICE_SLUGS exactly. Do NOT fabricate `customer_notes` content; quote only what the user actually said.",
    input_schema: {
      type: "object",
      properties: {
        service_slugs: {
          type: "array",
          minItems: 1,
          items: { type: "string" },
          description:
            "Required. At least one canonical snake_case service slug from OTOPAIR_SERVICE_SLUGS. Supports multi-service bundling: e.g. [\"diagnostic_scan\"] OR [\"oil_change\", \"tire_rotation\"]. NEVER invent new slugs; match the production catalog exactly.",
        },
        diagnostic_system: {
          type: "string",
          enum: ["brakes", "tires_wheels", "engine", "battery_electrical", "not_sure"],
          description:
            "Set ONLY when one of service_slugs is `diagnostic_scan`. The subsystem closest to the symptom Oto narrowed. Use `not_sure` for the 6-turn polite-exit pattern.",
        },
        customer_notes: {
          type: "string",
          description:
            "2-3 sentence service-advisor summary in calm, factual voice. Set when one of service_slugs is `diagnostic_scan`, OR when narrowing context anchors a direct-service booking (e.g. \"Customer mentioned squeal during stop-and-go\"). Only what the user actually said — no invented duration, mileage, or conditions.",
        },
        recommended_priority: {
          type: "string",
          enum: ["closest", "best_rated", "best_price"],
          description:
            "Optional default mechanic-sort order. Set ONLY if the user stated a clear preference (e.g. \"I want the cheapest\" → `best_price`); otherwise omit and the mobile component defaults to `best_rated`.",
        },
        recommended_mechanic_id: {
          type: "string",
          description:
            "Optional pre-selected mechanic ID. Set ONLY when a concrete mechanic id has already surfaced in this conversation (e.g. from a prior booking the user referenced). Do NOT invent one — omit it and the mobile component lets the user pick.",
        },
      },
      required: ["service_slugs"],
    },
  },

  {
    name: "render_record_confirmation",
    description:
      "Surface a self_reported maintenance record to the user and ask them to confirm it's still correct, OR update it with new details. Call this when a user-described symptom contradicts an item from get_vehicle_health whose `record_provenance` is `self_reported` — the record itself may be wrong (data form hallucination is common during onboarding). CONTRADICTION TEST: would the recorded service, if it really happened, have ELIMINATED this symptom? Fresh pads shouldn't squeal like wear indicators (fire this); a month-old battery shouldn't crank slow (fire this); but an oil change doesn't fix oil consumption and a rotation doesn't cure a speed-band vibration — those coexist with a true record, so do NOT fire this for them; they go to the diagnostic-scan branch of render_book_service. The component shows the user what we have on file (last service date and mileage) with two buttons: [Yes, that's right] and [No, update it]. On confirm: the record gets stamped confirmedHealthyAt: now (locks status to on_time for 90 days). On update: an inline date+mileage form appears, the user submits new values, and the record is rewritten. Either way the user's decision is pushed back into conversation_state, so on your NEXT turn you can react to it (e.g., if they updated the record showing it was actually overdue, route to the relevant service or diagnostic). Trigger-only: do not call for `verified` items — those are backed by completed bookings or uploaded receipts, you can trust them. Do not call for `inferred` items — there's no record to confirm. DO NOT call this when the user REPORTS a service they DID (\"I did a brake service\", \"log the brakes as complete\", \"just changed the oil\", \"mark it as done\") — that is a completed-service LOG that must go to render_vehicle_update with a service_claim of kind:\"completed\" (which records the new completion AND clears the flag/light). This tool only stamps confirmedHealthyAt on the EXISTING record; it does NOT log a new completion, so using it for a \"I did the service\" report leaves the flag/light uncleared. An existing self_reported record for the same maintenance type does NOT turn a completed-service report into a record-confirmation. PRECEDENCE: on the turn the trust gate holds (narrowed contradicting symptom + on_time + self_reported, not yet confirmed this conversation), THIS card outranks render_book_service — answering in prose, rendering quick replies alone, or jumping to the booking is the defect this tool exists to prevent. ANTI-RATIONALIZATION: a RECENT service date plus the very wear symptom that service should have eliminated is the contradiction at its STRONGEST, not a consistent timeline — pads serviced ~2 months ago do not reach wear indicators in 2 months, so never narrate 'the timeline fits' and offer the replacement booking; if you catch yourself explaining why the record and the symptom are consistent, re-run the contradiction test and fire this card. Firing it does NOT violate the three-state termination rule: the record-confirmation turn is a sanctioned step, and the booking lands on the following turn once the user confirms or updates. Terminal render tool — no further data lookups and no second card after it; update_conversation_state still fires in the same turn; render_quick_replies may accompany it in the same turn.",
    input_schema: {
      type: "object",
      properties: {
        vehicle_id: {
          type: "string",
          description: "Convex `vehicles._id` from the <vehicle> block. Same value you'd pass to get_vehicle_facts.",
        },
        maintenance_type: {
          type: "string",
          enum: ["oil", "brakes", "tires", "battery", "inspection"],
          description: "Which maintenance item the record applies to. Must match the `type` of an item from get_vehicle_health that has record_provenance: \"self_reported\".",
        },
      },
      required: ["vehicle_id", "maintenance_type"],
    },
  },

  {
    name: "render_vehicle_update",
    description:
      "Surface a one-tap confirm card that lets the user approve pending vehicle-truth updates (odometer reading, service claims, and/or warning lights Oto captured during the conversation). Call this when you have gathered one or more of: a user-stated mileage, service-due claims, or active fault lights — and you want the user to confirm before writing them to the vehicle record. On confirm the mobile component calls vehicleTruth.applyVehicleTruth with the supplied inputs. Terminal render — no further data lookups and no second card after it; update_conversation_state still fires in the same turn, but you SHOULD pair it with render_quick_replies in the same turn when the user has an obvious next tap (e.g. 'That's everything' / 'What's due next?'), plus a brief framing sentence confirming what you heard.",
    input_schema: {
      type: "object",
      properties: {
        mileage: {
          type: "number",
          description:
            "Optional. User-stated odometer reading in miles. Set only when the user explicitly mentioned their current mileage.",
        },
        service_claims: {
          type: "array",
          items: {
            type: "object",
            properties: {
              service_slug: {
                type: "string",
                description: "Canonical snake_case service slug from OTOPAIR_SERVICE_SLUGS.",
              },
              kind: {
                type: "string",
                enum: ["due", "light_on", "completed"],
                description:
                  "\"due\" = the user says this service is past-due; \"light_on\" = a dashboard light flagged it; \"completed\" = the user says they ALREADY HAD this service done (e.g. \"I did my brakes\", \"just changed the oil\", \"replaced the battery last week\"). \"completed\" clears the flag and records the service done — NEVER use \"due\" for a service the user reports as finished.",
              },
              service_mileage: {
                type: "number",
                description:
                  "Optional, kind:\"completed\" only. The odometer at which THIS service was performed when the user states a PAST mileage (e.g. \"oil change at 89,000\" while currently at 90,000). This is the service's OWN mileage — do NOT put it in the top-level current-odometer `mileage` field. Omit if the user gave no service mileage.",
              },
              service_age_days: {
                type: "number",
                description:
                  "Optional, kind:\"completed\" only. How many days ago the service was done, for relative phrasing — \"a week ago\" → 7, \"2 weeks ago\" → 14, \"last month\" → 30, \"yesterday\" → 1. The server resolves it to (now − days). Use this for relative time; omit if the user gave no time.",
              },
              service_date: {
                type: "number",
                description:
                  "Optional, kind:\"completed\" only. Absolute Unix ms timestamp the service was performed — use ONLY when the user names a concrete date. Prefer service_age_days for relative phrases. Wins over service_age_days if both are set.",
              },
              stated_confidence: {
                type: "string",
                enum: ["certain", "hedged"],
                description:
                  "Optional. How sure the user sounded about THIS claim. \"hedged\" = the user signals uncertainty: \"I think\", \"pretty sure\", \"maybe\", \"probably\", \"if I remember right\", or an unsure date/mileage (\"like 6 months ago?\", \"around 90k I guess\"). \"certain\" = a plain assertion with no uncertainty markers (\"I did my brakes last week\", \"changed the oil at 89,000\"). Omit when certain — absent defaults to \"certain\" server-side. e.g. \"I think I changed the oil, like 6 months ago?\" → {oil_change, completed, service_age_days: 180, stated_confidence: \"hedged\"}; \"pretty sure the brakes were done recently\" → {brake_pad_replacement, completed, stated_confidence: \"hedged\"}.",
              },
            },
            required: ["service_slug", "kind"],
          },
          description:
            "Optional. Array of service claims the user stated. Each entry has a service_slug + a kind: \"due\"/\"light_on\" FLAG a service that needs attention; \"completed\" RECORDS a service the user says they already had done (clears the flag, improves health). For a \"completed\" service done in the PAST, attach service_mileage (\"at 89,000\") and/or service_age_days (\"a week ago\" → 7) so the maintenance schedule re-anchors to WHEN it was actually done, not to today. e.g. overdue oil change → {oil_change, due}; \"I did my brakes 2 weeks ago\" → {brake_pad_replacement, completed, service_age_days: 14}; \"changed the oil at 89k, I'm at 90k now\" → mileage:90000 + {oil_change, completed, service_mileage: 89000}.",
        },
        fault_lights: {
          type: "array",
          items: {
            type: "string",
            enum: [
              "check_engine",
              "oil_pressure",
              "battery_charging",
              "temperature",
              "abs",
              "tpms",
              "airbag_srs",
              "transmission",
            ],
          },
          description:
            "Optional. Array of dashboard warning-light ids the user reported. Use ONLY these canonical ids: check_engine, oil_pressure, battery_charging, temperature, abs (brakes/ABS), tpms (tire pressure), airbag_srs, transmission. E.g. [\"check_engine\", \"tpms\"].",
        },
      },
      required: [],
    },
  },

  {
    name: "render_link_button",
    description:
      "Render a tap-to-redirect button that opens a specific in-app screen. Use when the user asks to go to (or perform an action that lives on) one of the 9 supported destinations — DO NOT recompose screen content in chat. TERMINAL render — no further data lookups and no second card after it; update_conversation_state still fires in the same turn; render_quick_replies may accompany it in the same turn. Pair with a short framing sentence in your prose (e.g. 'Settings is in your account area — tap to open.'). Destinations and when to fire each: " +
      "(1) `terms_of_service` — user asks to see the TOS / terms (\"show me the terms\", \"where's the TOS?\"). " +
      "(2) `privacy_policy` — user asks about privacy policy / data privacy (\"what's your privacy policy?\", \"data privacy\"). " +
      "(3) `settings` — user wants to change preferences, notifications, app settings (\"take me to settings\", \"open settings\", \"update notification settings\"). Fire EVEN WHEN a booking flow is in-flight: the CURRENT turn's ask wins, and the rendered booking component survives the redirect — never hold the navigation request hostage to an unconfirmed booking (\"want to lock that in first?\" is a conversion-pressure move, not helpfulness). " +
      "(4) `profile` — user wants to view or edit their profile info (\"open my profile\", \"change my name / email / phone\", \"update my profile\"). " +
      "(5) `transaction_history` — user asks about PAYMENTS / billing history (\"show my transaction history\", \"past payments\", \"my billing history\", \"what have I been charged?\"). This is the payments-ledger view — DISTINCT from service history (past completed bookings with shops + dates), which is served by `get_bookings(status_filter: \"completed\")` in chat. " +
      "(6) `customer_support` — user asks how to reach support or wants a human (\"contact customer support\", \"talk to a human\", \"I need help with my account\"). " +
      "(7) `feedback` — user wants to leave general feedback / feature suggestions (\"I have a suggestion\", \"feature request\", \"I want to leave feedback\"). " +
      "(8) `bug_report` — user reports a GENERAL APP bug: crash, broken screen, broken booking flow, UI breakage (\"the app crashed\", \"I found a bug\", \"the bookings tab is broken\"). " +
      "(9) `vehicle_onboarding` — EXPLICIT-ONLY: fire ONLY when the user explicitly states they want to add / register / onboard a vehicle to their garage (\"add a new vehicle\", \"register my Subaru\", \"I want to onboard my Civic\", \"how do I add another car?\", \"add my truck to the app\"). CRITICAL: implicit-ownership phrasings — where the user mentions a vehicle Oto has no record of but does NOT explicitly ask to add it (\"my new Subaru needs an oil change\", \"the RAV4 I just bought is making a noise\", \"can you book service for my new truck?\") — do NOT trigger this redirect. In those cases ask a clarifying question instead (e.g. \"I don't see that vehicle in your garage yet — do you want to add it, or were you asking about a different car?\") and only fire `render_link_button(destination: \"vehicle_onboarding\")` after the user confirms they want to add it. " +
      "IMPORTANT: `bug_report` is for GENERAL APP bugs ONLY. If the user complains about YOUR response (\"Oto, you got that wrong\", \"your answer was weird\", \"that's not right\"), DO NOT fire `render_link_button(destination: \"bug_report\")` — AI-conversation feedback is handled by a per-message UI button (next to copy / TTS) that the mobile chat UI owns; point the user to that icon instead. Same applies to `feedback`: it is for general feature suggestions, not for response-specific complaints about Oto. " +
      "Use the optional `label` field to override the default button text when context demands a more specific framing (e.g. user asked about notification settings → `label: \"Open notification settings\"`).",
    input_schema: {
      type: "object",
      properties: {
        destination: {
          type: "string",
          enum: [
            "terms_of_service",
            "privacy_policy",
            "settings",
            "profile",
            "transaction_history",
            "customer_support",
            "feedback",
            "bug_report",
            "vehicle_onboarding",
          ],
          description:
            "Which in-app screen to redirect to. Must be one of the 9 enum values. The enum IS the contract — there is no 10th destination today (e.g. no `loyalty`, no `payment_methods`). If the user wants a destination not in this enum, do NOT call this tool; explain conversationally instead. Special-case: `vehicle_onboarding` is EXPLICIT-ONLY — see the tool description's destination-(9) guidance for the implicit-ownership clarifying-ask rule.",
        },
        label: {
          type: "string",
          description:
            "Optional button-text override. Default is the destination's generic label (e.g. `settings` → \"Open Settings\"); override when the user asked about a specific area within that screen (e.g. \"notification settings\" → \"Open notification settings\").",
        },
      },
      required: ["destination"],
    },
  },

  {
    name: "render_booking_card",
    description:
      "Render a single-booking detail card inline in chat for ONE specific booking the user is asking about. Use when the user asks about a particular upcoming or recent appointment — \"what's my next appointment?\", \"when's my booking with Carlos?\", \"show me that booking\". WORKFLOW: first call get_bookings(status_filter: 'active', limit: 1) (or limit: N + pick the relevant id) — THEN call render_booking_card with the booking_id from that result. Trigger-only: you pass ONLY the booking_id; the FRONTEND queries Convex for the shop name, mechanic, scheduled date/time, service names, status, and renders the card itself. You do NOT compose booking details, do NOT pass dates, do NOT pass shop names — the component handles all of that. Pair with a short framing sentence in your prose (e.g. \"Here's your upcoming oil change.\"). FIRE, DON'T OFFER: when your answer IS a single booking, render this card WITH the answer in the same turn — never answer in prose and then ask \"want me to pull up the booking card?\" (offering a render you can simply perform is the agency failure this tool exists to close, and \"pull up\" phrasing is banned besides). TERMINAL render — no further data lookups and no second card after it; update_conversation_state still fires in the same turn; render_quick_replies may accompany it in the same turn. For MULTIPLE bookings use render_bookings_list instead.",
    input_schema: {
      type: "object",
      properties: {
        booking_id: {
          type: "string",
          description: "Convex bookings._id from a prior get_bookings or get_pending_bookings call. The mobile component reads this id and queries Convex itself for the renderable booking record.",
        },
      },
      required: ["booking_id"],
    },
  },

  {
    name: "render_bookings_list",
    description:
      "Render a list of booking cards inline in chat when the user asks about MULTIPLE bookings. Use when the user asks \"show me all my upcoming bookings\", \"what's coming up?\", \"list my bookings\", \"what do I have scheduled?\" AND multiple active bookings exist. WORKFLOW: first call get_bookings(status_filter: 'active') (or get_pending_bookings for pending-only) to get the ids — THEN call render_bookings_list with the booking_ids array. Trigger-only: you pass ONLY the booking_ids array; the FRONTEND queries Convex for each booking's shop / mechanic / date / services / status and renders the list itself. You do NOT compose booking details. Pair with a short framing sentence in your prose (e.g. \"Here are your three upcoming bookings.\"). TERMINAL render — no further data lookups and no second card after it; update_conversation_state still fires in the same turn; render_quick_replies may accompany it in the same turn. For ONE booking use render_booking_card instead.",
    input_schema: {
      type: "object",
      properties: {
        booking_ids: {
          type: "array",
          minItems: 1,
          maxItems: 10,
          items: { type: "string" },
          description: "Array of Convex bookings._id values from a prior get_bookings or get_pending_bookings call. The mobile component reads these ids and queries Convex itself for each renderable booking record. Min 1, max 10.",
        },
      },
      required: ["booking_ids"],
    },
  },

  {
    name: "render_quick_replies",
    description:
      "Show 2–4 tap-to-send reply buttons under your message. CHIPS ARE THE DEFAULT for ANY clarifying question with an enumerable answer set: if the answers are a small set of words, the question MUST ship as chips — 'does it crank or is it silent?' → [Cranks, Silent]; 'gas, exhaust, or more like mildew?' → [Gas, Exhaust, Mildew, Not sure]. The ONLY chipless questions are genuinely open-ended ones ('describe the noise'). Chips matter MOST when the input is messy — a fragmented multi-symptom message means the user is struggling to type, so ask exactly ONE question that turn, with chips, never two open questions in prose. Confidence is NOT a precondition: do not reserve chips for turns where you already know the next action. Also use for obvious next options ('Closest', 'Best rated'; 'Yes', 'No'; 'Reschedule', 'Cancel', 'Got it'). The buttons are part of your final response — make no further data lookups after this (update_conversation_state still fires in the same turn). This tool MAY be emitted in the SAME assistant turn as exactly one card render (render_vehicle_update, render_book_service, render_record_confirmation, render_booking_card, render_bookings_list, render_link_button): emit text + the card + this tool together in one block, and the chip row renders above the card. PAIR it with a card whenever the user still has an obvious next thing to tap. Optionally include a brief introductory text message in the same turn; the buttons supplement your text. Keep replies short (≤ 18 chars). Do NOT pair chips with a card during a stop_now safety override — there the instruction stands alone.",
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
// NAVIGATION TOOLS — none. Sprint 4 Day 1 Pass B removed the sole entry
// (`navigate_to_payment`) when the booking flow consolidated into
// `render_book_service`; the mobile component handles the pay-screen redirect
// internally on final user confirm. Keeping the empty array preserves the
// cached-prefix shape and the OTO_TOOL_CATEGORY "navigation" enum value for
// any future re-introduction without an additional schema bump.
// -----------------------------------------------------------------------------

const NAVIGATION_TOOLS: OtoToolSchema[] = [];

// -----------------------------------------------------------------------------
// Exports — order is part of the cached prefix. Do not reshuffle without
// bumping the prompt version.
// -----------------------------------------------------------------------------

export const OTO_TOOLS: OtoToolSchema[] = [
  ...DATA_TOOLS,
  ...STATE_TOOLS,
  ...MODEL_ROUTING_TOOLS,
  ...RENDER_TOOLS,
  ...NAVIGATION_TOOLS,
];

export const OTO_TOOL_NAMES = OTO_TOOLS.map((t) => t.name);

export type OtoToolCategory = "data" | "state" | "model_routing" | "render" | "navigation";

export const OTO_TOOL_CATEGORY: Record<string, OtoToolCategory> = {
  // data
  get_bookings: "data",
  // Booking Status — Sprint 3 Day 5 §14.3 (pending-only subset of get_bookings)
  get_pending_bookings: "data",
  get_due_services: "data",
  list_services_for_vehicle: "data",
  get_service_details: "data",
  get_rewards_summary: "data",
  // Loyalty Tier 2 expansion (Sprint 3 Day 3 §11 + §14.2) — informational
  // surfacing only; no claim-flow tool (per §14.2 Constraint 2, Day 1 Pass F).
  get_loyalty_points_history: "data",
  get_available_redemptions: "data",
  get_loyalty_program_info: "data",
  get_vehicle_health: "data",
  get_projected_health_score: "data",
  get_vehicle_facts: "data",
  lookup_vehicle_spec: "data",
  retrieve_vehicle_facts: "data",
  // web_search is a server-managed Anthropic tool — defined in chat.ts
  // SERVER_MANAGED_TOOLS, NOT in this category map.
  // state (Oto writes back; ack is trivial; doesn't gate loop continuation)
  update_conversation_state: "state",
  // record_semantic_fact — Wave 3 §2.2 user_semantic_facts insert. Side-effect
  // mutation routed through memoryEditing.recordUserSemanticFact. Same loop
  // shape as update_conversation_state: parallel dispatch, trivial ack, no
  // continuation gate.
  record_semantic_fact: "state",
  // retract_semantic_fact — Sprint 2 Day 7 — Wave 3 retract pair wire-in.
  // Side-effect mutation routed through memoryEditing.retractUserSemanticFact
  // after an internalQuery lookup for the active row. Same loop shape as the
  // other state tools: parallel dispatch, trivial ack, no continuation gate.
  retract_semantic_fact: "state",
  // retract_conversation_fact — Sprint 2 Day 7 — Wave 3 retract pair wire-in.
  // Side-effect mutation routed through memoryEditing.retractConversationFact
  // after an internalQuery lookup. Same loop shape as retract_semantic_fact.
  retract_conversation_fact: "state",
  // record_vehicle_fact is also a state-write side effect — Haiku emits it
  // alongside the user-facing text on the same iteration; the dispatcher
  // fires it in parallel and the loop terminates without forcing another
  // round-trip. Treating it as "data" caused the loop to swallow the text
  // accompanying the call.
  record_vehicle_fact: "state",
  // model_routing — side-effect writes to ai_conversations.current_model.
  // Same dispatch shape as state tools; ack is trivial and doesn't gate the
  // loop. Routing takes effect on the NEXT turn.
  request_sonnet_handoff: "model_routing",
  request_haiku_handback: "model_routing",
  // render
  // Booking flow — Sprint 4 Day 1 Pass B consolidation. Single terminal
  // render replacing the prior 6-stage chain (render_service_picker →
  // render_diagnostic_form → render_shop_carousel → render_time_selector →
  // render_booking_confirmation → navigate_to_payment). The mobile component
  // handles every sub-stage internally including pay-screen redirect.
  render_book_service: "render",
  render_record_confirmation: "render",
  render_vehicle_update: "render",
  render_link_button: "render",
  // Booking Status — Sprint 3 Day 5 §14.3 (single + list booking surfaces)
  render_booking_card: "render",
  render_bookings_list: "render",
  render_quick_replies: "render",
  render_reasoning: "render",
  render_sources: "render",
  // navigation — empty as of Sprint 4 Day 1 Pass B; see NAVIGATION_TOOLS note.
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

// Canonical service categories — the four locked Jul 13 (7→4 consolidation;
// names match the mobile app's tabs). Live names come from the
// `service_categories` table (seeded by `convex/seeds/seedServices.ts`,
// migrated by `convex/migrations/categoryConsolidation.ts`).
export const OTOPAIR_SERVICE_CATEGORIES = [
  "Routine",
  "Tires & Brakes",
  "Scheduled Service",
  "Inspections",
] as const;

export type OtopairServiceCategory = (typeof OTOPAIR_SERVICE_CATEGORIES)[number];
