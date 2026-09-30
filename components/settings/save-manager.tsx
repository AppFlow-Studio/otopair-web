"use client";

/**
 * Settings save registry + universal save bar.
 *
 * Instead of a Save button in every section, each editable section reports its
 * dirty state and a `save`/`reset` pair up to one shared registry. A single
 * sticky bar at the bottom appears whenever anything is dirty and saves (or
 * discards) everything at once, then confirms with a toast.
 *
 * Sections register with `useRegisterSaveable(...)`. Registration re-reports on
 * every render so the captured `save`/`reset` closures are never stale; the bar
 * only re-renders when a section's dirty flag actually flips.
 *
 * Leaving with unsaved changes asks first (bug #404): an unticked service sits
 * only in this page's state until Save, so an owner who unticked Brake Fluid
 * Flush and navigated away kept taking bookings for it — the save landed
 * minutes after a customer booked. Closing/reloading the tab gets the
 * browser's own prompt; clicking a link to another page gets a confirm.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { Check, Loader2 } from "lucide-react";
import { errorMessage } from "@/lib/feedback";
import { BTN_PRIMARY, BTN_SECONDARY } from "./primitives";

type Saveable = {
  label: string;
  dirty: boolean;
  save: () => Promise<void>;
  reset: () => void;
};

type SaveHandlers = Pick<Saveable, "save" | "reset">;

export function createLatestSaveHandlers(latest: {
  current: SaveHandlers;
}): SaveHandlers {
  return {
    save: () => latest.current.save(),
    reset: () => latest.current.reset(),
  };
}

type Manager = {
  report: (id: string, entry: Saveable) => void;
  remove: (id: string) => void;
  entries: { current: Map<string, Saveable> };
  version: number;
};

const Ctx = createContext<Manager | null>(null);

/** Confirm copy when leaving with unsaved sections. */
export function unsavedChangesPrompt(labels: readonly string[]): string {
  const names = labels.filter(Boolean);
  const where =
    names.length === 0
      ? ""
      : names.length === 1
        ? ` in ${names[0]}`
        : ` in ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `You have unsaved changes${where}. Leave without saving?`;
}

/**
 * True when a click on `link` would take the owner off this page inside the
 * app: a plain left click on a same-origin link to a different path/query.
 * New-tab/download/modified clicks keep this page open, and cross-origin
 * links already get the browser's beforeunload prompt.
 */
export function linkClickLeavesPage(
  click: {
    button: number;
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
    defaultPrevented: boolean;
  },
  link: { href: string; target: string; download: boolean },
  current: { href: string },
): boolean {
  if (click.defaultPrevented || click.button !== 0) return false;
  if (click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return false;
  if (link.download) return false;
  if (link.target && link.target !== "_self") return false;
  let to: URL;
  let from: URL;
  try {
    from = new URL(current.href);
    to = new URL(link.href, from);
  } catch {
    return false;
  }
  if (to.origin !== from.origin) return false;
  return to.pathname !== from.pathname || to.search !== from.search;
}

export function SettingsSaveProvider({ children }: { children: ReactNode }) {
  const entries = useRef<Map<string, Saveable>>(new Map());
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  // Guard navigation while anything is dirty. Reads the registry at event
  // time, so it's attached once and never sees stale dirty flags.
  useEffect(() => {
    const dirtyLabels = () =>
      Array.from(entries.current.values())
        .filter((entry) => entry.dirty)
        .map((entry) => entry.label);

    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (dirtyLabels().length === 0) return;
      event.preventDefault();
      // Older Chromium only shows the prompt when returnValue is set.
      event.returnValue = "";
    };

    // Capture phase on document runs before React's root listener, so
    // stopping the event here also stops next/link's client-side navigation.
    const onClick = (event: MouseEvent) => {
      const labels = dirtyLabels();
      if (labels.length === 0) return;
      const target = event.target;
      const anchor =
        target instanceof Element ? target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!anchor) return;
      const leaves = linkClickLeavesPage(
        event,
        {
          href: anchor.href,
          target: anchor.target,
          download: anchor.hasAttribute("download"),
        },
        window.location,
      );
      if (!leaves) return;
      if (window.confirm(unsavedChangesPrompt(labels))) return;
      event.preventDefault();
      event.stopPropagation();
    };

    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, []);

  const report = useCallback(
    (id: string, entry: Saveable) => {
      const prev = entries.current.get(id);
      entries.current.set(id, entry);
      if (!prev || prev.dirty !== entry.dirty || prev.label !== entry.label) {
        bump();
      }
    },
    [bump],
  );

  const remove = useCallback(
    (id: string) => {
      if (entries.current.delete(id)) bump();
    },
    [bump],
  );

  return (
    <Ctx.Provider value={{ report, remove, entries, version }}>
      {children}
      <SettingsSaveBar />
    </Ctx.Provider>
  );
}

export function useRegisterSaveable(
  id: string,
  label: string,
  dirty: boolean,
  save: () => Promise<void>,
  reset: () => void,
) {
  const m = useContext(Ctx);
  const latestHandlers = useRef<SaveHandlers>({ save, reset });
  latestHandlers.current = { save, reset };
  // Re-report every render so save/reset closures stay current.
  useEffect(() => {
    m?.report(id, {
      label,
      dirty,
      ...createLatestSaveHandlers(latestHandlers),
    });
  });
  // Drop the registration when the section unmounts for good.
  useEffect(() => {
    return () => m?.remove(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
}

function SettingsSaveBar() {
  const m = useContext(Ctx);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ tone: "ok" | "err"; text: string } | null>(
    null,
  );

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(t);
  }, [toast]);

  if (!m) return null;

  const dirty = Array.from(m.entries.current.values()).filter((e) => e.dirty);
  const count = dirty.length;

  async function saveAll() {
    setSaving(true);
    const failures: string[] = [];
    for (const entry of dirty) {
      try {
        await entry.save();
      } catch (err) {
        failures.push(errorMessage(err, `Couldn't save ${entry.label}.`));
      }
    }
    setSaving(false);
    setToast(
      failures.length > 0
        ? { tone: "err", text: failures[0] }
        : { tone: "ok", text: "Settings saved." },
    );
  }

  function discardAll() {
    for (const entry of dirty) entry.reset();
  }

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-[80] flex flex-col items-center gap-3 px-4">
      {toast ? (
        <div
          className={`pointer-events-auto flex items-center gap-2 rounded-full border px-4 py-2 text-sm shadow-lg ${
            toast.tone === "ok"
              ? "border-success/20 bg-success/10 text-success"
              : "border-destructive/20 bg-destructive/10 text-destructive"
          }`}
        >
          {toast.tone === "ok" ? <Check className="h-4 w-4" /> : null}
          {toast.text}
        </div>
      ) : null}
      {count > 0 ? (
        <div className="pointer-events-auto flex items-center gap-3 rounded-full border border-border bg-card px-3 py-2 pl-5 shadow-[0_10px_40px_rgba(15,23,42,0.16)]">
          <span className="text-sm text-foreground">
            <span className="font-medium">Unsaved changes</span>
            <span className="text-muted-foreground">
              {" "}
              in {count} section{count === 1 ? "" : "s"}
            </span>
          </span>
          <button
            type="button"
            onClick={discardAll}
            disabled={saving}
            className={`${BTN_SECONDARY} rounded-full px-3 py-1.5`}
          >
            Discard
          </button>
          <button
            type="button"
            onClick={() => void saveAll()}
            disabled={saving}
            className={`${BTN_PRIMARY} rounded-full px-4 py-1.5`}
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Check className="h-4 w-4" />
            )}
            Save changes
          </button>
        </div>
      ) : null}
    </div>
  );
}
