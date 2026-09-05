"use client";

import type { ReactNode } from "react";
import { Sequence, Seq, SeqRule, serif } from "./landing/reveal";

export type LadderStep = { title: string; body: ReactNode };

/**
 * The landing's numbered ladder as a reusable block: blue serif numerals,
 * serif step titles, body copy in the card ink, one hairline between rows,
 * and the rows cascading in from one scroll trigger. Two shapes:
 *
 * - `column` (default): the rows stack, for step-by-step paths (how it
 *   works, the pricing mechanism).
 * - `row`: the steps sit side by side from `lg` with a hairline over each,
 *   for short paths where the sequence is the point (going live, the
 *   coverage ladder). Stacks on phones, two-up on tablets.
 *
 * Client component because `serif` lives in the client module reveal.tsx;
 * server pages pass plain data.
 */
export function Ladder({
  steps,
  direction = "column",
  start = 1,
  className = "",
}: {
  steps: LadderStep[];
  direction?: "column" | "row";
  /** First numeral (a ladder that continues another). */
  start?: number;
  className?: string;
}) {
  if (direction === "row") {
    return (
      <Sequence className={className} delay={0.05}>
        <ol className="grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-[repeat(var(--n),minmax(0,1fr))] lg:gap-6" style={{ ["--n" as string]: steps.length }}>
          {steps.map((s, i) => (
            <Seq key={s.title} at={i * 0.08}>
              <li className="border-t border-[#1a1a1a]/12 pt-5">
                <span className="text-[15px] text-[#4B82A5]" style={serif}>
                  {String(start + i).padStart(2, "0")}.
                </span>
                <h3 className="mt-3 text-[22px] leading-none text-[#1a1a1a]" style={serif}>
                  {s.title}
                </h3>
                <div className="mt-3 text-[15px] leading-[1.6] text-[#6b655d]">{s.body}</div>
              </li>
            </Seq>
          ))}
        </ol>
      </Sequence>
    );
  }
  return (
    <Sequence className={className} delay={0.05}>
      <ol>
        {steps.map((s, i) => (
          <li key={s.title}>
            {i > 0 && <SeqRule at={i * 0.08} className="my-6 h-px w-full bg-[#1a1a1a]/12" />}
            <Seq at={i * 0.08 + 0.02}>
              <div className="flex gap-5">
                <span className="w-8 shrink-0 pt-[3px] text-[17px] text-[#4B82A5]" style={serif}>
                  {String(start + i).padStart(2, "0")}.
                </span>
                <div className="min-w-0">
                  <h3 className="text-[22px] leading-tight text-[#1a1a1a]" style={serif}>
                    {s.title}
                  </h3>
                  <div className="mt-2 text-[15px] leading-relaxed text-[#6b655d]">{s.body}</div>
                </div>
              </div>
            </Seq>
          </li>
        ))}
      </ol>
    </Sequence>
  );
}
