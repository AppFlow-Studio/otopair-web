"use client";

import { useEffect, useState } from "react";

function formatElapsed(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

export default function ElapsedTimer({
  startedAtMs,
  paused = false,
  className,
}: {
  startedAtMs: number | null | undefined;
  paused?: boolean;
  className?: string;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (paused || startedAtMs == null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [paused, startedAtMs]);

  if (startedAtMs == null) {
    return <span className={className}>--:--:--</span>;
  }

  return <span className={className}>{formatElapsed(now - startedAtMs)}</span>;
}
