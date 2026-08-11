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
import { BTN_PRIMARY, BTN_SECONDARY } from "./primitives";

type Saveable = {
  label: string;
  dirty: boolean;
  save: () => Promise<void>;
  reset: () => void;
};

type Manager = {
  report: (id: string, entry: Saveable) => void;
  remove: (id: string) => void;
  entries: { current: Map<string, Saveable> };
  version: number;
};

const Ctx = createContext<Manager | null>(null);

export function SettingsSaveProvider({ children }: { children: ReactNode }) {
  const entries = useRef<Map<string, Saveable>>(new Map());
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

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
  // Re-report every render so save/reset closures stay current.
  useEffect(() => {
    m?.report(id, { label, dirty, save, reset });
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
        failures.push(err instanceof Error ? err.message : `Couldn't save ${entry.label}.`);
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
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-[80] flex justify-center px-4">
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
      ) : toast ? (
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
    </div>
  );
}
