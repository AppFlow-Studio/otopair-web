"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import type { VariantProps } from "class-variance-authority";

import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// A Confirm/Continue/Submit button that reacts before it's clicked: when
// `missing` lists unmet requirements it disables itself and says *why* — as a
// hover tooltip (desktop) and an inline note under the button (touch/a11y). When
// `loading` it shows a spinner and disables. Generalizes the pattern in
// create-booking-drawer.tsx (`missingRequired` → disabled + "Still needed: …").
type ActionButtonProps = React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    /** Unmet requirements. Non-empty → button disabled + explains what's left. */
    missing?: string[];
    /** In-flight action → spinner + disabled. */
    loading?: boolean;
    /** Class for the wrapper that holds the button + inline note. */
    wrapperClassName?: string;
  };

export function ActionButton({
  missing,
  loading = false,
  disabled,
  children,
  className,
  wrapperClassName,
  title,
  ...props
}: ActionButtonProps) {
  const blocked = (missing?.length ?? 0) > 0;
  const reason = blocked ? `Still needed: ${missing!.join(", ")}` : undefined;
  const isDisabled = disabled || loading || blocked;

  return (
    <div className={cn("flex flex-col", wrapperClassName)}>
      <Button
        {...props}
        className={className}
        disabled={isDisabled}
        aria-disabled={isDisabled || undefined}
        title={reason ?? title}
      >
        {loading ? <Loader2 className="animate-spin" /> : null}
        {children}
      </Button>
      {reason ? (
        <p className="mt-1 text-xs text-muted-foreground" role="status">
          {reason}
        </p>
      ) : null}
    </div>
  );
}
