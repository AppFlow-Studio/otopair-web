"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useConvex, useMutation } from "convex/react";
import {
  useConversation,
  useConversationClientTool,
} from "@elevenlabs/react";
import { api } from "@/convex/_generated/api";
import { sanitizeInfoCard, type InfoCardPayload } from "./info-card";
import {
  DEFAULT_BOOKING,
  DEFAULT_SHOPS,
  DEFAULT_SLOTS,
  DEMO_USER_OPENER,
  OTO_LINES,
  composeVehicleLabel,
  nextStep,
  DEMO_FEATURES,
  type Booking,
  type ChatMessage,
  type DemoFeature,
  type OtoStep,
  type Shop,
  type Slot,
  type Vehicle,
} from "./oto-flow";

const VIN_RE = /\b[A-HJ-NPR-Z0-9]{17}\b/i;

// Demo-mode (no live agent) keyword → feature, so typed questions still demo.
// Ordered: more specific first. Stems omit a trailing \b so plurals match.
const DEMO_KEYWORDS: [RegExp, DemoFeature][] = [
  [/\b(tire|tyre|wheel)/, "tires"],
  [/\b(rating|review|vetted|rated)/, "ratings"],
  [/\b(reward|credit|loyalty|cashback|cash back|points)/, "rewards"],
  [/\b(notification|notif|alert|spam|push)/, "notifications"],
  [/\b(refund|dispute|apple pay|google pay|how (do|can) i pay|payment|\bcard\b|debit)/, "payments"],
  [/\b(history|records|upload)/, "service_history"],
  [/\b(check.?in|quarterly|90.?day)/, "checkin"],
  [/\b(live tracker|track my|bookings tab|upcoming|my appointment)/, "bookings"],
  [/\b(trust|hidden fee|dark pattern|sell.*data|privacy|pressure|upsell|scam)/, "trust"],
  [/\b(where|area|staten island|borough|which cit|expand)/, "coverage"],
  [/\b(what is otopair|about otopair|overview|tell me about otopair|who are you)/, "overview"],
  [/\b(price|pricing|cost|fee|how much|charge)/, "pricing"],
  [/\b(health|score|condition)/, "health_score"],
  [/\b(services|catalog|offer|do you (offer|handle)|what can you do)/, "service_catalog"],
];

function matchDemoFeature(text: string): DemoFeature | null {
  const t = text.toLowerCase();
  for (const [re, feature] of DEMO_KEYWORDS) {
    if (re.test(t)) return feature;
  }
  return null;
}

// Intent to start the interactive booking WALKTHROUGH (distinct from the
// "bookings" tab demo). Triggers the shops → times → confirm flow.
const BOOKING_RE =
  /\b(walk me through|step by step|how (do|does|can) (i|you|we) book|how (to|do i) book|book (a|my|an|me)|start (a |the )?booking|see (the )?booking flow|how (does )?booking work)/i;

// Intent to re-show the user's OWN decoded car (only meaningful after a VIN).
const MYCAR_RE =
  /\b(my (car|vehicle|specs|ride)|its specs|the specs|show.*(car|vehicle|specs)|see.*(car|vehicle|specs)|about my car)\b/i;

// Short, natural demo-mode acknowledgements (live agent speaks its own words).
const DEMO_LINES: Record<DemoFeature, string> = {
  service_catalog: "Here's everything you can book at launch.",
  pricing: "Here's how pricing works — every charge is its own line, including our 7% fee.",
  health_score: "Here's how the Vehicle Health Score keeps your car protected.",
  tires: "Tires work a little differently — you pick a tier and nearby shops send live quotes.",
  ratings: "Every mechanic is rated by real customers and vetted in person before they go live.",
  rewards: "You earn real dollar credit — Ownership Credit — on every booking. No points, no hoops.",
  overview: "Here's Otopair in a nutshell.",
  coverage: "Here's where Otopair is launching.",
  payments: "Here's how payments work — pay your way, securely.",
  service_history: "You can upload past records — here's why it makes everything more accurate.",
  checkin: "Every 90 days there's a soft check-in to keep things accurate — never a push.",
  bookings: "Here's your Bookings tab — everything happening with your car.",
  notifications: "We only send what matters — here's the breakdown.",
  trust: "Here's what Otopair will never do. Trust is the whole point.",
};

const AGENT_ID = process.env.NEXT_PUBLIC_ELEVENLABS_AGENT_ID;

let msgCounter = 0;
const mkId = () => `m${++msgCounter}`;

/**
 * Drives the flagship hero flow. Connects to an ElevenLabs Conversational AI
 * agent when one is configured (public agent via NEXT_PUBLIC_ELEVENLABS_AGENT_ID,
 * or a private agent via the /api/elevenlabs/signed-url route). The agent
 * advances the on-screen flow by calling the registered client tools
 * (show_scheduling / show_shops / show_times / confirm_booking).
 *
 * When no agent is reachable it falls back to a scripted local demo so the
 * page is fully interactive out of the box.
 */
export function useOtoAgent() {
  const [step, setStep] = useState<OtoStep>("intro");
  const [shops, setShops] = useState<Shop[]>(DEFAULT_SHOPS);
  const [slots, setSlots] = useState<Slot[]>(DEFAULT_SLOTS);
  const [selectedShop, setSelectedShop] = useState<Shop | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<Slot | null>(null);
  const [booking, setBooking] = useState<Booking>(DEFAULT_BOOKING);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [thinking, setThinking] = useState(false);
  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [presignupSaved, setPresignupSaved] = useState(false);
  const [demoFeature, setDemoFeature] = useState<DemoFeature | null>(null);
  // Outlier fallback: a generic, agent-composed info card for knowledge-base
  // topics with no dedicated demo card (validated/clamped before it lands here).
  const [dynamicCard, setDynamicCard] = useState<InfoCardPayload | null>(null);
  // "awake" flips the hero into the live 3-panel layout the moment the user
  // engages (focuses the input / taps a chip / mic), before any message lands —
  // so the chat + schedule panels slide in together ("Oto just woke up").
  const [awake, setAwake] = useState(false);
  const demoTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const createStub = useMutation(api.preSignups.createStub);
  const convex = useConvex();
  const stepRef = useRef<OtoStep>("intro");
  const connectedRef = useRef(false);
  // Reliability plumbing: driveSeqRef bumps on every UI change (tool OR local),
  // so the live-mode safety net only fires when the agent didn't drive the UI.
  const driveSeqRef = useRef(0);
  const cardFallbackRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastVinRef = useRef("");
  useEffect(() => {
    stepRef.current = step;
  }, [step]);
  useEffect(() => {
    driveSeqRef.current += 1;
  }, [demoFeature, step, dynamicCard]);
  // The dynamic card lives in its own visual channel. Clear it the moment any
  // OTHER channel takes over (a demo card, or any funnel step change) so a
  // stale info card can never mask whatever the agent showed next.
  useEffect(() => {
    if (demoFeature !== null) setDynamicCard(null);
  }, [demoFeature]);
  useEffect(() => {
    setDynamicCard(null);
  }, [step]);

  const pushMessage = useCallback((role: ChatMessage["role"], text: string) => {
    setMessages((prev) => [...prev, { id: mkId(), role, text }]);
  }, []);

  /** Wake the hero into its live layout (called on first engagement). */
  const wake = useCallback(() => setAwake(true), []);

  /** Decode a VIN via NHTSA (/api/vin) and surface the vehicle. */
  const decodeVin = useCallback(
    async (rawVin: string): Promise<string> => {
      const vin = rawVin.trim().toUpperCase();
      lastVinRef.current = vin;
      setThinking(true);
      try {
        const res = await fetch(`/api/vin/${encodeURIComponent(vin)}`);
        if (!res.ok) {
          setThinking(false);
          if (!connectedRef.current) {
            pushMessage("oto", "I couldn't read that VIN — mind double-checking it?");
          }
          return "VIN could not be decoded.";
        }
        const v = (await res.json()) as Vehicle;

        // Link a pre-existing vehicle_config if one already exists (richer
        // specs) — read-only, NEVER enriches. Falls back to raw NHTSA on miss.
        try {
          if (v.year && v.make && v.model) {
            const cfg = await convex.query(api.preSignups.lookupConfig, {
              year: v.year,
              make: v.make,
              model: v.model,
              trim: v.trim,
              displacementL: v.displacementL,
              cylinders: v.cylinders,
              fuelType: v.fuelType,
            });
            if (cfg.found) {
              v.configLinked = true;
              if (cfg.trim) v.trim = cfg.trim;
              if (cfg.drivetrain) v.drivetrain = cfg.drivetrain;
              if (cfg.engineLabel) v.engineLabel = cfg.engineLabel;
              if (cfg.specs) v.specs = cfg.specs;
              v.label = composeVehicleLabel(v);
            }
          }
        } catch {
          // ignore — keep raw NHTSA data
        }

        setDemoFeature(null);
        setVehicle(v);
        setThinking(false);
        // In a live session the agent narrates the result itself — don't double up.
        if (!connectedRef.current) {
          pushMessage(
            "oto",
            v.configLinked
              ? `Got it — that's a ${v.label}, and I already have full specs on file for it.`
              : `Got it — that's a ${v.label}.`
          );
        }
        // Surface the decoded vehicle as a card on the component side.
        stepRef.current = "vehicle";
        setStep("vehicle");
        return `Decoded VIN: ${v.label}${v.configLinked ? " (full specs on file)" : ""}.`;
      } catch {
        setThinking(false);
        return "VIN decode failed.";
      }
    },
    [convex, pushMessage]
  );

  /** Persist a pre-signup lead (email + decoded car) so signup is seamless. */
  const savePreSignup = useCallback(
    async (rawEmail: string): Promise<string> => {
      const email = rawEmail.trim();
      if (!email || !email.includes("@")) return "A valid email is required.";
      try {
        await createStub({
          email,
          vin: vehicle?.vin,
          year: vehicle?.year,
          make: vehicle?.make,
          model: vehicle?.model,
          trim: vehicle?.trim,
          displacementL: vehicle?.displacementL,
          cylinders: vehicle?.cylinders,
          fuelType: vehicle?.fuelType,
        });
        setPresignupSaved(true);
        return "Saved — their car will be waiting when they sign up.";
      } catch (err) {
        console.warn("[oto] pre-signup save failed:", err);
        return "Could not save pre-signup.";
      }
    },
    [createStub, vehicle]
  );

  /** Summon an explainer demo card on the component side. */
  const showDemo = useCallback((feature: DemoFeature) => {
    setDemoFeature(feature);
  }, []);

  /** Re-display the decoded vehicle card (the user's specific car). */
  const showVehicle = useCallback(() => {
    setDemoFeature(null);
    stepRef.current = "vehicle";
    setStep("vehicle");
  }, []);

  /** Kick off the interactive booking walkthrough at the shop-picker step. */
  const startBookingFlow = useCallback(() => {
    setDemoFeature(null);
    stepRef.current = "shops";
    setStep("shops");
  }, []);

  /**
   * Live-mode safety net. The agent SHOULD call a client tool for every topic,
   * but model tool-calling isn't 100% reliable — so we also read each turn and,
   * if the agent didn't drive the UI shortly after, surface the matching card
   * ourselves. A VIN in a user turn is decoded immediately (never depends on a
   * tool call). The drive-seq guard guarantees we never override the agent when
   * it DID act, and the step guard keeps us out of the booking funnel.
   */
  const handleLiveTurn = useCallback(
    (text: string, isUser: boolean) => {
      if (isUser) {
        const m = text.match(VIN_RE);
        if (m && lastVinRef.current !== m[0].toUpperCase()) {
          void decodeVin(m[0]);
          return;
        }
      }
      // Decide what the screen should show if the agent doesn't drive it.
      let action: (() => void) | null = null;
      if (isUser && lastVinRef.current && MYCAR_RE.test(text)) {
        action = () => showVehicle();
      } else if (isUser && BOOKING_RE.test(text)) {
        action = () => {
          setDemoFeature(null);
          stepRef.current = "shops";
          setStep("shops");
        };
      } else {
        const feature = matchDemoFeature(text);
        if (feature) action = () => setDemoFeature(feature);
      }
      if (!action) return;
      const apply = action;
      const seq = driveSeqRef.current;
      if (cardFallbackRef.current) clearTimeout(cardFallbackRef.current);
      cardFallbackRef.current = setTimeout(
        () => {
          if (driveSeqRef.current !== seq) return; // agent already drove the UI
          const s = stepRef.current;
          if (s !== "intro" && s !== "vehicle") return; // don't hijack an active booking flow
          apply();
        },
        isUser ? 1000 : 500
      );
    },
    [decodeVin, showVehicle]
  );

  const conversation = useConversation({
    onMessage: ({ message, source }) => {
      const role = source === "user" ? "user" : "oto";
      // Strip ElevenLabs voice-direction tags (e.g. "[warmly]") from the text
      // transcript — they're meant to be spoken, not displayed.
      const clean = (message ?? "")
        .replace(/\[[a-zA-Z][a-zA-Z ]{0,24}\]/g, "")
        .replace(/\s{2,}/g, " ")
        .trim();
      if (!clean) return;
      pushMessage(role, clean);
      // Safety net runs only for live sessions (demo mode routes via runDemo).
      if (connectedRef.current) handleLiveTurn(clean, source === "user");
    },
    onError: (message) => {
      console.warn("[oto] conversation error:", message);
    },
  });

  const connected = conversation.status === "connected";

  // ---- Live session plumbing (voice + text share one session) --------------
  const pendingTextRef = useRef<string[]>([]);
  const connectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voicePendingRef = useRef(false);
  const sessionModeRef = useRef<"voice" | "text" | null>(null);

  useEffect(() => {
    connectedRef.current = connected;
    if (connected) {
      if (connectTimerRef.current) {
        clearTimeout(connectTimerRef.current);
        connectTimerRef.current = null;
      }
      voicePendingRef.current = false;
      if (pendingTextRef.current.length) {
        const queue = pendingTextRef.current;
        pendingTextRef.current = [];
        queue.forEach((t) => conversation.sendUserMessage(t));
      }
    }
  }, [connected, conversation]);

  const agentConfigured = Boolean(AGENT_ID);

  // ---- Client tools the live agent calls to drive the UI -------------------
  useConversationClientTool("show_scheduling", () => {
    setStep("scheduling");
    return "Scheduling preview shown.";
  });

  useConversationClientTool("show_shops", (params: Record<string, unknown>) => {
    const incoming = params?.shops;
    if (Array.isArray(incoming) && incoming.length) {
      setShops(incoming as unknown as Shop[]);
    }
    setStep("shops");
    return "Shop list shown to the user.";
  });

  useConversationClientTool("show_times", (params: Record<string, unknown>) => {
    const incoming = params?.times ?? params?.slots;
    if (Array.isArray(incoming) && incoming.length) {
      setSlots(incoming as unknown as Slot[]);
    }
    if (typeof params?.shop === "string") {
      setSelectedShop((prev) => prev ?? { ...DEFAULT_SHOPS[0], name: params.shop as string });
    }
    setStep("datetime");
    return "Available times shown to the user.";
  });

  useConversationClientTool(
    "confirm_booking",
    (params: Record<string, unknown>) => {
      setBooking((prev) => ({
        service: (params?.service as string) ?? prev.service,
        shop: (params?.shop as string) ?? selectedShop?.name ?? prev.shop,
        mechanic: (params?.mechanic as string) ?? prev.mechanic,
        date: (params?.date as string) ?? prev.date,
        time: (params?.time as string) ?? selectedSlot?.label ?? prev.time,
        total:
          typeof params?.total === "number"
            ? (params.total as number)
            : prev.total,
      }));
      setStep("confirmed");
      return "Booking confirmed in the UI.";
    }
  );

  useConversationClientTool("decode_vin", async (params: Record<string, unknown>) => {
    const vin = String(params?.vin ?? "");
    if (!VIN_RE.test(vin)) return "That doesn't look like a valid 17-character VIN.";
    return decodeVin(vin);
  });

  useConversationClientTool("save_presignup", async (params: Record<string, unknown>) => {
    const email = String(params?.email ?? "");
    return savePreSignup(email);
  });

  useConversationClientTool("show_demo", (params: Record<string, unknown>) => {
    const feature = String(params?.feature ?? "");
    if (!DEMO_FEATURES.includes(feature as DemoFeature)) {
      return `Unknown demo. Options: ${DEMO_FEATURES.join(", ")}.`;
    }
    setDemoFeature(feature as DemoFeature);
    return `Showing the ${feature.replace(/_/g, " ")} demo on screen.`;
  });

  useConversationClientTool("show_vehicle", () => {
    if (!vehicle) {
      return "No car on file yet — ask the user for their VIN so I can decode it first.";
    }
    setDemoFeature(null);
    stepRef.current = "vehicle";
    setStep("vehicle");
    return `Showing the user's ${vehicle.label} details${vehicle.configLinked ? " with full specs" : ""}.`;
  });

  useConversationClientTool("show_booking_flow", () => {
    setDemoFeature(null);
    stepRef.current = "shops";
    setStep("shops");
    return "Started the interactive booking walkthrough — nearby shops are on screen. The user taps a shop → picks a time → confirms; narrate each step. (You can also call show_times then confirm_booking to advance for them.)";
  });

  /** Validate + surface a generic agent-composed info card (the long-tail fallback). */
  const showInfoCard = useCallback((raw: unknown): string => {
    const card = sanitizeInfoCard(raw);
    if (!card) return "Couldn't build that card — it needs at least a title.";
    // Take over the canvas; the channel-exclusion effects keep things tidy.
    setDemoFeature(null);
    setDynamicCard(card);
    return `Showing an info card: ${card.title}.`;
  }, []);

  useConversationClientTool("show_info_card", (params: Record<string, unknown>) =>
    showInfoCard(params)
  );

  // ---- Scripted demo fallback ---------------------------------------------
  const clearDemoTimers = useCallback(() => {
    demoTimers.current.forEach(clearTimeout);
    demoTimers.current = [];
  }, []);

  const after = useCallback((ms: number, fn: () => void) => {
    const t = setTimeout(fn, ms);
    demoTimers.current.push(t);
  }, []);

  /** Advance one step in the montage and emit the matching Oto line (demo). */
  const advance = useCallback(
    (to?: OtoStep) => {
      const current = stepRef.current;
      const target = to ?? nextStep(current);
      if (target === current) return;
      setDemoFeature(null); // funnel takes over the component side
      stepRef.current = target;
      setStep(target);
      // Scripted Oto lines are for the demo fallback only — in a live session
      // the real agent narrates, so never inject canned copy.
      const line = OTO_LINES[target as Exclude<OtoStep, "intro">];
      if (line && !connectedRef.current) {
        setThinking(true);
        after(700, () => {
          setThinking(false);
          pushMessage("oto", line);
        });
      }
    },
    [after, pushMessage]
  );

  // ---- Live connection (shared by voice + text) ----------------------------
  /** Start a live session: public agent id → server token → fail (false). */
  const connect = useCallback(
    async (textOnly: boolean): Promise<boolean> => {
      const connectionType = textOnly ? "websocket" : "webrtc";
      if (AGENT_ID) {
        try {
          await conversation.startSession({ agentId: AGENT_ID, connectionType, textOnly });
          return true;
        } catch {
          // private agent — fall through to the server token route
        }
      }
      try {
        const res = await fetch("/api/elevenlabs/signed-url");
        if (res.ok) {
          const data = (await res.json()) as {
            signedUrl?: string;
            conversationToken?: string;
          };
          if (data.signedUrl) {
            await conversation.startSession({ signedUrl: data.signedUrl, textOnly });
            return true;
          }
          if (data.conversationToken) {
            await conversation.startSession({
              conversationToken: data.conversationToken,
              connectionType: "webrtc",
              textOnly,
            });
            return true;
          }
        }
      } catch {
        // ignore
      }
      return false;
    },
    [conversation]
  );

  // ---- Scripted demo fallback (only when no live agent is reachable) -------
  const runDemo = useCallback(
    (text: string) => {
      const vinMatch = text.match(VIN_RE);
      if (vinMatch) {
        void decodeVin(vinMatch[0]);
        return;
      }
      // If we already know their car, re-show it when they ask about it.
      if (
        vehicle &&
        /\b(my car|my vehicle|car detail|its specs|the specs|show.*car|see.*car|about my car|my (specs|ride))\b/.test(
          text.toLowerCase()
        )
      ) {
        showVehicle();
        return;
      }
      // Booking walkthrough intent → jump straight into the shop picker.
      if (BOOKING_RE.test(text)) {
        startBookingFlow();
        setThinking(true);
        after(600, () => {
          setThinking(false);
          pushMessage("oto", OTO_LINES.shops ?? "Here are nearby shops with fixed prices.");
        });
        return;
      }
      const feature = matchDemoFeature(text);
      if (feature) {
        setDemoFeature(feature);
        setThinking(true);
        after(600, () => {
          setThinking(false);
          pushMessage("oto", DEMO_LINES[feature]);
        });
        return;
      }
      advance();
    },
    [advance, after, decodeVin, pushMessage, showVehicle, startBookingFlow, vehicle]
  );

  // ---- Public actions ------------------------------------------------------
  /** Type to Oto — opens/uses a live session (no mic needed), else demo. */
  const sendText = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text) return;
      setAwake(true);
      pushMessage("user", text);
      // With an agent configured, run the live safety net (instant VIN decode +
      // card fallback) so the visual never depends solely on the agent's tools.
      if (agentConfigured) handleLiveTurn(text, true);

      // Live session already up (voice or text) — send straight to the agent.
      if (connectedRef.current) {
        conversation.sendUserMessage(text);
        return;
      }
      // Mid-connect — queue; the flush effect delivers it on connect.
      if (conversation.status === "connecting") {
        pendingTextRef.current.push(text);
        return;
      }
      // Agent configured — open a text-only session (no microphone) and queue.
      if (agentConfigured) {
        pendingTextRef.current.push(text);
        sessionModeRef.current = "text";
        const ok = await connect(true);
        if (!ok) {
          pendingTextRef.current = pendingTextRef.current.filter((t) => t !== text);
          runDemo(text);
          return;
        }
        if (connectTimerRef.current) clearTimeout(connectTimerRef.current);
        connectTimerRef.current = setTimeout(() => {
          if (!connectedRef.current && pendingTextRef.current.length) {
            const queued = pendingTextRef.current;
            pendingTextRef.current = [];
            queued.forEach((t) => runDemo(t));
          }
        }, 8000);
        return;
      }
      // No agent — local demo.
      runDemo(text);
    },
    [agentConfigured, connect, conversation, handleLiveTurn, pushMessage, runDemo]
  );

  /** Talk to Oto — opens a live voice (WebRTC) session, else demo. */
  const startVoice = useCallback(async () => {
    setAwake(true);
    // Microphone requires a secure context (https or http://localhost). On a
    // plain-IP/LAN URL navigator.mediaDevices is undefined and no prompt fires.
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      pushMessage(
        "oto",
        "Voice needs a secure page to reach your mic. Open this on http://localhost:3000 (or an https link) and tap the mic again — or just type to me right here."
      );
      return;
    }

    // Already in a live VOICE session — nothing to do.
    if (
      sessionModeRef.current === "voice" &&
      (connectedRef.current || conversation.status === "connecting")
    ) {
      return;
    }

    // ALWAYS request the mic on a mic click — this is what shows Chrome's
    // "allow microphone" prompt. (Must run before any early return so a prior
    // text-only session can't suppress it.)
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      pushMessage(
        "oto",
        "I couldn't get microphone access — check the mic permission in your browser's address bar. You can keep chatting by typing, too."
      );
      return;
    }

    // A text-only session is already up — tear it down so we can reconnect
    // with audio (voice).
    if (connectedRef.current && sessionModeRef.current !== "voice") {
      conversation.endSession();
      await new Promise((r) => setTimeout(r, 150));
    }

    if (agentConfigured) {
      sessionModeRef.current = "voice";
      const ok = await connect(false);
      if (ok) {
        voicePendingRef.current = true;
        if (connectTimerRef.current) clearTimeout(connectTimerRef.current);
        connectTimerRef.current = setTimeout(() => {
          if (!connectedRef.current && voicePendingRef.current) {
            voicePendingRef.current = false;
            if (messages.length === 0) {
              pushMessage("user", DEMO_USER_OPENER);
              advance("shops");
            } else {
              advance();
            }
          }
        }, 9000);
        return;
      }
    }

    // No agent reachable — run the scripted demo opener.
    if (messages.length === 0) {
      pushMessage("user", DEMO_USER_OPENER);
      advance("shops");
    } else {
      advance();
    }
  }, [advance, agentConfigured, connect, conversation, messages.length, pushMessage]);

  const stop = useCallback(() => {
    clearDemoTimers();
    if (connected) conversation.endSession();
  }, [clearDemoTimers, connected, conversation]);

  /** Pick a shop (Choose-a-Shop card) and move to time selection. */
  const chooseShop = useCallback(
    (shop: Shop) => {
      setSelectedShop(shop);
      if (connectedRef.current) {
        // Advance the walkthrough locally so it never stalls on a tool call;
        // the live agent narrates the next step from the message we send it.
        setDemoFeature(null);
        stepRef.current = "datetime";
        setStep("datetime");
        conversation.sendUserMessage(`I'll go with ${shop.name}.`);
      } else {
        // Scripted demo (no live agent): canned line via advance().
        pushMessage("user", `Let's go with ${shop.name}.`);
        advance("datetime");
      }
    },
    [advance, conversation, pushMessage]
  );

  /** Pick a time slot (Date & Time card). */
  const chooseSlot = useCallback((slot: Slot) => {
    if (slot.disabled) return;
    setSelectedSlot(slot);
  }, []);

  /** Confirm the appointment and reveal the confirmation card. */
  const confirmAppointment = useCallback(() => {
    const shopName = selectedShop?.name ?? booking.shop;
    const time = selectedSlot?.label ?? booking.time;
    setBooking((prev) => ({ ...prev, shop: shopName, time }));
    if (connectedRef.current) {
      setDemoFeature(null);
      stepRef.current = "confirmed";
      setStep("confirmed");
      conversation.sendUserMessage(`Confirm my ${time} appointment.`);
    } else {
      pushMessage("user", `Confirm my ${time} appointment.`);
      advance("confirmed");
    }
  }, [advance, booking.shop, booking.time, conversation, pushMessage, selectedShop, selectedSlot]);

  const reset = useCallback(() => {
    clearDemoTimers();
    if (connectTimerRef.current) {
      clearTimeout(connectTimerRef.current);
      connectTimerRef.current = null;
    }
    if (cardFallbackRef.current) {
      clearTimeout(cardFallbackRef.current);
      cardFallbackRef.current = null;
    }
    lastVinRef.current = "";
    pendingTextRef.current = [];
    voicePendingRef.current = false;
    sessionModeRef.current = null;
    if (connected) conversation.endSession();
    stepRef.current = "intro";
    setStep("intro");
    setMessages([]);
    setSelectedShop(null);
    setSelectedSlot(null);
    setShops(DEFAULT_SHOPS);
    setSlots(DEFAULT_SLOTS);
    setBooking(DEFAULT_BOOKING);
    setThinking(false);
    setVehicle(null);
    setPresignupSaved(false);
    setDemoFeature(null);
    setDynamicCard(null);
    setAwake(false);
  }, [clearDemoTimers, connected, conversation]);

  return {
    // state
    step,
    shops,
    slots,
    selectedShop,
    selectedSlot,
    booking,
    messages,
    thinking,
    vehicle,
    presignupSaved,
    demoFeature,
    dynamicCard,
    awake,
    connected,
    isSpeaking: conversation.isSpeaking,
    status: conversation.status,
    // actions
    wake,
    sendText,
    startVoice,
    stop,
    advance,
    chooseShop,
    chooseSlot,
    confirmAppointment,
    decodeVin,
    savePreSignup,
    showDemo,
    showVehicle,
    showInfoCard,
    startBookingFlow,
    reset,
    getInputByteFrequencyData: conversation.getInputByteFrequencyData,
    getOutputByteFrequencyData: conversation.getOutputByteFrequencyData,
  };
}

export type OtoAgent = ReturnType<typeof useOtoAgent>;
