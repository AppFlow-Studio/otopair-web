"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
} from "react";
import Image from "next/image";
import { AnimatePresence, motion } from "motion/react";
import { Check, X } from "lucide-react";
import { PillButton } from "./pill-button";
import { serifDisplay } from "./landing/reveal";
import { useReducedMotionSafe } from "./shared";
import type { Platform } from "./download-app";
import { isValidEmail } from "@/lib/email";
import { Honeypot, useBotGuard } from "./waitlist-guard";

/**
 * The pre-launch waitlist. Every store control (the footer/hero PlatformPill,
 * the download-page badges) opens this one modal while the App Store / Google
 * Play listings are still the "#" placeholder — the launch flag in
 * download-app.tsx. On launch the controls become real links and this is never
 * opened. Mounted once, site-wide, by the marketing layout.
 *
 * Posts to the existing /api/waitlist route with list:"app", which emails a
 * branded confirmation to the signup and a notification to developer@otopair.com.
 */
type OpenOpts = { platform?: Platform };

/** Fallback for store surfaces rendered outside the provider — e.g. the global
 *  app/not-found page renders PageShell's footer under the root layout, not the
 *  marketing one. Rather than crash (or no-op), send the visitor to /download,
 *  which carries the same app-launch waitlist form. */
const WaitlistCtx = createContext<{
  open: (opts?: OpenOpts) => void;
  close: () => void;
}>({
  open: () => {
    if (typeof window !== "undefined") window.location.assign("/download");
  },
  close: () => {},
});

/** Open the waitlist modal from any store control. */
export function useWaitlist() {
  return useContext(WaitlistCtx);
}

export function WaitlistProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);

  const open = useCallback((_opts?: OpenOpts) => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);

  return (
    <WaitlistCtx.Provider value={{ open, close }}>
      {children}
      <WaitlistModal open={isOpen} onClose={close} />
    </WaitlistCtx.Provider>
  );
}

function WaitlistModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const reduce = useReducedMotionSafe();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");
  const emailRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const { honeypotRef, markOpened, guardFields } = useBotGuard();
  const emailOk = isValidEmail(email);

  // Esc closes; focus the email field when the sheet opens; start the bot-guard
  // timer from the moment it opens (the modal itself stays mounted).
  useEffect(() => {
    if (!open) return;
    markOpened();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const t = setTimeout(() => emailRef.current?.focus(), 60);
    return () => {
      document.removeEventListener("keydown", onKey);
      clearTimeout(t);
    };
  }, [open, onClose, markOpened]);

  // A fresh sheet every time: reset once the exit animation has run.
  useEffect(() => {
    if (open) return;
    const t = setTimeout(() => {
      setEmail("");
      setName("");
      setState("idle");
    }, 250);
    return () => clearTimeout(t);
  }, [open]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (state === "sending" || !emailOk) return;
    setState("sending");
    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, name: name || undefined, list: "app", ...guardFields() }),
      });
      setState(res.ok ? "done" : "error");
    } catch {
      setState("error");
    }
  }

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-[200] bg-[#0b1f2e]/40 backdrop-blur-sm"
            onClick={onClose}
          />
          <motion.div
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: 16 }}
            animate={reduce ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: 16 }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            className="pointer-events-none fixed inset-0 z-[201] flex items-center justify-center p-4"
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
              className="pointer-events-auto relative w-full max-w-[420px] overflow-hidden rounded-[28px] bg-white shadow-[0_30px_80px_-24px_rgba(43,84,120,0.5)]"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Sky wash header — the home page's hero gradient. */}
              <div className="bg-[linear-gradient(180deg,#98C9E8_0%,#FFFFFF_100%)] px-8 pb-6 pt-9 text-center">
                <button
                  onClick={onClose}
                  className="absolute right-5 top-5 flex size-9 items-center justify-center rounded-full text-[#4B82A5] transition-colors hover:bg-black/[0.05]"
                  aria-label="Close"
                >
                  <X className="size-5" strokeWidth={1.75} />
                </button>
                <Image
                  src="/logo.png"
                  alt="Otopair"
                  width={56}
                  height={56}
                  className="mx-auto mb-4 h-14 w-14 object-contain"
                />
                <h2
                  id={titleId}
                  className="text-[26px] leading-[1.1] text-[#4B82A5]"
                  style={serifDisplay}
                >
                  {state === "done" ? "You're on the list." : "Be first to get Otopair"}
                </h2>
              </div>

              <div className="px-8 pb-8 pt-1">
                {state === "done" ? (
                  <div className="flex flex-col items-center py-4 text-center">
                    <span className="mb-4 flex size-12 items-center justify-center rounded-full bg-[#EBF5FB]">
                      <Check className="size-6 text-[#4B82A5]" strokeWidth={2} aria-hidden />
                    </span>
                    <p className="text-[15px] leading-[1.6] text-[#4c5661]">
                      One email the day the app is live in your area — nothing else.
                      Check your inbox for a note confirming you&rsquo;re in.
                    </p>
                    <button
                      onClick={onClose}
                      className="mt-6 text-[14px] text-[#4B82A5] underline decoration-[#4B82A5]/30 underline-offset-4 transition-colors hover:decoration-[#4B82A5]"
                    >
                      Done
                    </button>
                  </div>
                ) : (
                  <>
                    <p className="mb-6 text-center text-[14px] leading-[1.6] text-[#777169]">
                      We&rsquo;re opening one NYC borough at a time. Leave your email and
                      we&rsquo;ll tell you the day Otopair goes live near you.
                    </p>
                    <form onSubmit={submit} className="flex flex-col gap-3">
                      <input
                        type="text"
                        autoComplete="name"
                        placeholder="Name (optional)"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        className="h-12 w-full rounded-full border border-[#1a1a1a]/12 bg-white px-5 text-[15px] text-[#1a1a1a] outline-none placeholder:text-[#777169] focus-visible:border-[#4B82A5] focus-visible:ring-2 focus-visible:ring-[#4B82A5]/30"
                      />
                      <input
                        ref={emailRef}
                        type="email"
                        required
                        autoComplete="email"
                        placeholder="you@example.com"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        aria-invalid={email.length > 0 && !emailOk}
                        className="h-12 w-full rounded-full border border-[#1a1a1a]/12 bg-white px-5 text-[15px] text-[#1a1a1a] outline-none placeholder:text-[#777169] focus-visible:border-[#4B82A5] focus-visible:ring-2 focus-visible:ring-[#4B82A5]/30"
                      />
                      {/* Invisible bot trap — never seen or tabbed to by a human. */}
                      <Honeypot ref={honeypotRef} />
                      {email.length > 2 && !emailOk && (
                        <p className="-mt-1 pl-1 text-[12px] text-[#b04a3a]">
                          Enter a valid email address.
                        </p>
                      )}
                      <PillButton
                        type="submit"
                        disabled={state === "sending" || !emailOk}
                        className="mt-1 w-full justify-center"
                      >
                        {state === "sending" ? "Joining…" : "Get notified at launch"}
                      </PillButton>
                      {state === "error" && (
                        <p role="alert" className="text-center text-[13px] text-[#b04a3a]">
                          That didn&rsquo;t go through. Try again, or email
                          support@otopair.com.
                        </p>
                      )}
                    </form>
                    <p className="mt-4 text-center text-[12px] text-[#9aa3ab]">
                      One launch email. No spam, unsubscribe anytime.
                    </p>
                  </>
                )}
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
