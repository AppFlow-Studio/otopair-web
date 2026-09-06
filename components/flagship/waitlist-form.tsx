"use client";

import { useState, type FormEvent } from "react";
import { Check } from "lucide-react";
import { PillButton } from "./pill-button";

/**
 * Borough waitlist — the capture form on /brooklyn, /queens, /bronx and
 * /manhattan (site audit 2026-08-31, Tier 2: "publish the borough pages
 * before launch… a waitlist form starts that clock and captures early
 * intent"). Posts to the existing /api/waitlist route, which emails the
 * signup to the team tagged with the borough. Styled as the landing's white
 * pill + ink button so it reads as the same product.
 */
export default function WaitlistForm({
  borough,
  list = "borough",
  className,
}: {
  /** The borough this list belongs to (borough lists only). */
  borough?: string;
  /** `app`: the launch list on /download, the destination of every Get Oto
   *  control while the store listings are still placeholders
   *  (design pass 2026-09-05). */
  list?: "borough" | "app";
  className?: string;
}) {
  const [email, setEmail] = useState("");
  const app = list === "app";
  const id = app ? "waitlist-app" : `waitlist-${borough}`;
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (state === "sending") return;
    setState("sending");
    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, borough, list }),
      });
      setState(res.ok ? "done" : "error");
    } catch {
      setState("error");
    }
  }

  if (state === "done") {
    return (
      <p
        role="status"
        className={`inline-flex items-center gap-2 rounded-full border border-[#1a1a1a]/10 bg-white px-5 py-3 text-[15px] text-[#1a1a1a] ${className ?? ""}`}
      >
        <Check className="size-4 text-[#4B82A5]" aria-hidden />
        {app
          ? "You're on the launch list. One email the day the app is live, nothing else."
          : `You're on the ${borough} list. The team will be in touch when the first shops open.`}
      </p>
    );
  }

  return (
    <form onSubmit={submit} className={`flex w-full max-w-[460px] flex-col gap-2 sm:flex-row ${className ?? ""}`}>
      <label className="sr-only" htmlFor={id}>
        Email address
      </label>
      <input
        id={id}
        type="email"
        required
        autoComplete="email"
        placeholder="you@example.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="h-12 flex-1 rounded-full border border-[#1a1a1a]/12 bg-white px-5 text-[15px] text-[#1a1a1a] outline-none placeholder:text-[#777169] focus-visible:border-[#4B82A5] focus-visible:ring-2 focus-visible:ring-[#4B82A5]/30"
      />
      <PillButton type="submit" disabled={state === "sending"} className="shrink-0">
        {state === "sending" ? "Joining…" : app ? "Get notified at launch" : `Join the ${borough} waitlist`}
      </PillButton>
      {state === "error" && (
        <p role="alert" className="text-[13px] text-[#b04a3a] sm:basis-full">
          That didn&rsquo;t go through. Try again, or email support@otopair.com.
        </p>
      )}
    </form>
  );
}
