import { useEffect, useState } from "react";
import { AccessibilityInfo } from "react-native";

let cachedReduceMotion = false;
let subscribed = false;
const listeners = new Set<(value: boolean) => void>();

function ensureSubscribed() {
  if (subscribed) return;
  subscribed = true;
  AccessibilityInfo.isReduceMotionEnabled()
    .then((value) => {
      cachedReduceMotion = value;
      listeners.forEach((cb) => cb(value));
    })
    .catch(() => {});
  AccessibilityInfo.addEventListener("reduceMotionChanged", (value) => {
    cachedReduceMotion = value;
    listeners.forEach((cb) => cb(value));
  });
}

export function isReduceMotionEnabledSync(): boolean {
  ensureSubscribed();
  return cachedReduceMotion;
}

export function useReducedMotion(): boolean {
  const [value, setValue] = useState(() => {
    ensureSubscribed();
    return cachedReduceMotion;
  });
  useEffect(() => {
    ensureSubscribed();
    const cb = (next: boolean) => setValue(next);
    listeners.add(cb);
    setValue(cachedReduceMotion);
    return () => {
      listeners.delete(cb);
    };
  }, []);
  return value;
}
