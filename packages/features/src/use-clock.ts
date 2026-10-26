import { useEffect, useState } from "react";

const TICK_MS = 10_000;

/** Current time, refreshed every 10 seconds. Enough for "14m"-style labels and the taskbar clock. */
export function useClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), TICK_MS);
    return () => clearInterval(id);
  }, []);
  return now;
}
