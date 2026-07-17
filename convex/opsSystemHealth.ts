// =============================================================================
// Ops portal · System Health — /ops/system-health (Ops spec p.11). Read-only.
// client_logs error/warn windows → hourly error-rate buckets + grouped-by-
// signature list (stack expand). Bugs strip from the bugs table.
// =============================================================================
import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireDirector } from "./directorGate";

const DAY = 24 * 60 * 60 * 1000;

/** Group key: first line of the message, truncated — the "signature". */
function signature(message: string): string {
  return message.split("\n")[0].slice(0, 120);
}

// --- Authored return types (see dataOverview.ts header) -----------------------

export type LogGroup = {
  signature: string;
  level: string;
  count: number;
  latest_at: number;
  latest_stack: string | null;
  user_ids: number;
};
export type HealthResult = {
  hourly: { hour: string; errors: number; warns: number }[];
  groups: LogGroup[];
  window_days: number;
  truncated: boolean;
};

export const errorOverview = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<HealthResult> => {
    await requireDirector(ctx, token);
    const windowDays = 7;
    const since = Date.now() - windowDays * DAY;
    let truncated = false;
    const all: { level: string; message: string; stack: string | null; at: number; user: string | null }[] = [];
    for (const level of ["error", "warn"]) {
      const rows = await ctx.db
        .query("client_logs")
        .withIndex("by_level", (q) => q.eq("level", level))
        .order("desc")
        .take(500);
      if (rows.length === 500) truncated = true;
      for (const r of rows) {
        if (r.timestamp < since) continue;
        all.push({
          level,
          message: r.message,
          stack: r.stack ?? null,
          at: r.timestamp,
          user: r.user_id ?? null,
        });
      }
    }

    const hourly = new Map<string, { errors: number; warns: number }>();
    const groups = new Map<string, LogGroup & { users: Set<string> }>();
    for (const l of all) {
      const hour = new Date(l.at).toISOString().slice(0, 13);
      const h = hourly.get(hour) ?? { errors: 0, warns: 0 };
      if (l.level === "error") h.errors++;
      else h.warns++;
      hourly.set(hour, h);

      const sig = `${l.level}:${signature(l.message)}`;
      const g =
        groups.get(sig) ??
        ({
          signature: signature(l.message),
          level: l.level,
          count: 0,
          latest_at: 0,
          latest_stack: null,
          user_ids: 0,
          users: new Set<string>(),
        } as LogGroup & { users: Set<string> });
      g.count++;
      if (l.at > g.latest_at) {
        g.latest_at = l.at;
        g.latest_stack = l.stack;
      }
      if (l.user) g.users.add(l.user);
      groups.set(sig, g);
    }

    return {
      hourly: [...hourly.entries()]
        .map(([hour, h]) => ({ hour, ...h }))
        .sort((a, b) => a.hour.localeCompare(b.hour)),
      groups: [...groups.values()]
        .map(({ users, ...g }) => ({ ...g, user_ids: users.size }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 50),
      window_days: windowDays,
      truncated,
    };
  },
});

export type BugRow = {
  id: string;
  title: string;
  source: string;
  status: string;
  device: string | null;
  at: number;
};

export const bugsList = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<BugRow[]> => {
    await requireDirector(ctx, token);
    const rows = await ctx.db.query("bugs").withIndex("by_created_at").order("desc").take(100);
    return rows
      .filter((b) => b.archived !== true)
      .map((b) => ({
        id: String(b._id),
        title: b.title,
        source: b.source,
        status: b.status,
        device: b.device ?? null,
        at: b.created_at,
      }));
  },
});
