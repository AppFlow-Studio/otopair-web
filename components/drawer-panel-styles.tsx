import type { ElementType, ReactNode } from "react";
import { cn } from "@/lib/utils";

export const drawerInputClassName =
  "w-full bg-muted/70 border-0 border-b-2 border-transparent focus:border-primary rounded-lg px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/50 transition-colors outline-none";

export const drawerTextareaClassName = cn(
  drawerInputClassName,
  "min-h-[88px] resize-none",
);

export const drawerSelectTriggerClassName =
  "w-full h-10 rounded-lg border-border bg-card text-sm px-3";

export const drawerInfoCardClassName =
  "rounded-xl bg-muted/40 px-4 py-3";

export const drawerSecondaryButtonClassName =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50 disabled:text-muted-foreground disabled:hover:bg-background";

export const drawerDestructiveButtonClassName =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2 text-sm font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50";

export const drawerPrimaryButtonClassName =
  "inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground transition-all hover:opacity-90 active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed";

export function DrawerSectionHeader({
  icon: Icon,
  label,
  className,
}: {
  icon: ElementType<{ className?: string }>;
  label: string;
  className?: string;
}) {
  return (
    <div className={cn("mb-4 flex items-center gap-2", className)}>
      <Icon className="h-4 w-4 text-primary" />
      <h3 className="text-[11px] font-bold tracking-wider text-muted-foreground">
        {label}
      </h3>
    </div>
  );
}

export function DrawerFieldLabel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <label
      className={cn(
        "mb-1.5 block text-[10px] font-bold tracking-widest text-muted-foreground",
        className,
      )}
    >
      {children}
    </label>
  );
}
