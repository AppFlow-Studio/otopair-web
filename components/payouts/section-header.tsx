import type { ReactNode } from "react";

export function SectionHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-3 flex items-end justify-between gap-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span
            className="h-4 w-1 rounded-full bg-primary"
            aria-hidden="true"
          />
          <h2 className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            {title}
          </h2>
        </div>
        {description ? (
          <p className="mt-1 pl-3 text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
