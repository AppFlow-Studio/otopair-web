import type { ComponentProps, ReactNode } from "react";

/**
 * Double-bezel container: a thin tinted tray with a hairline ring, and the
 * content plate seated inside it on a concentric radius (28 outer, 6 of
 * padding, 22 inner). It is how the secondary pages frame anything that
 * should read as an object rather than a region: hero images, the contact
 * form, directory cards, summary panels.
 *
 * Server-safe (no hooks) so the pages that stay server components can use
 * it directly. `tone` picks the tray for its ground: `ink` on white,
 * `glass` on the sky wash, `paper` when the plate itself is the soft panel.
 * `lift` adds the hover physics the pill buttons use (tinted shadow, half a
 * pixel of rise, expo easing) for cards that are links or contain one.
 */
type Tone = "ink" | "glass" | "paper";

const TRAY: Record<Tone, string> = {
  ink: "bg-[#1a1a1a]/[0.035] ring-[#1a1a1a]/[0.06]",
  glass: "bg-white/35 ring-white/60",
  paper: "bg-[#1a1a1a]/[0.035] ring-[#1a1a1a]/[0.06]",
};

const PLATE: Record<Tone, string> = {
  ink: "bg-white",
  glass: "bg-white",
  paper: "bg-[#f7f6f3]",
};

export function Bezel({
  tone = "ink",
  size = "md",
  lift = false,
  clip = true,
  className = "",
  innerClassName = "",
  children,
  ...rest
}: {
  tone?: Tone;
  /** `sm` tightens the radii (22/18) for small tiles and inline chips. */
  size?: "sm" | "md";
  lift?: boolean;
  /** Clip the plate to its radius (images). Off for plates whose children
   *  draw focus rings past their own box. */
  clip?: boolean;
  className?: string;
  innerClassName?: string;
  children: ReactNode;
} & Omit<ComponentProps<"div">, "className" | "children">) {
  const tray = size === "sm" ? "rounded-[22px] p-1" : "rounded-[28px] p-1.5";
  const plate = size === "sm" ? "rounded-[18px]" : "rounded-[22px]";
  return (
    <div
      className={`${tray} ${TRAY[tone]} ring-1 ${
        lift
          ? "transition-[transform,box-shadow] duration-500 ease-expo hover:-translate-y-0.5 hover:shadow-lift"
          : ""
      } ${className}`}
      {...rest}
    >
      <div
        className={`${plate} ${PLATE[tone]} h-full shadow-[0_1px_2px_rgba(26,26,26,0.05),inset_0_1px_0_rgba(255,255,255,0.8)] ${
          clip ? "overflow-hidden" : ""
        } ${innerClassName}`}
      >
        {children}
      </div>
    </div>
  );
}
