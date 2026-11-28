import { purposeEnabled, type Choices, type PersistLevel } from "./cookie-jar-store";

// One place that decides where an optional preference may be written, so every feature
// obeys the same rules: off means no write (I-3), tab-only means sessionStorage, blocked
// storage falls back to memory and says so (I-8). Secrets never come through here (I-4).

const memory = new Map<string, string>();

export interface PrefStores {
  local: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  session: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
}

function browserStores(): PrefStores {
  try {
    return { local: window.localStorage, session: window.sessionStorage };
  } catch {
    return { local: null, session: null };
  }
}

export interface WriteResult {
  /** Where the value really landed. "none" when the purpose is off. */
  level: PersistLevel | "none";
}

export function writePref(choices: Choices, purposeId: string, key: string, value: unknown, stores: PrefStores = browserStores()): WriteResult {
  if (!purposeEnabled(choices, purposeId)) return { level: "none" };
  const text = JSON.stringify(value);
  const target = choices.deviceMemory === "temporary" ? stores.session : stores.local;
  try {
    if (target) {
      target.setItem(key, text);
      return { level: choices.deviceMemory === "temporary" ? "tab" : "device" };
    }
  } catch {
    // Quota or denied: keep it for this visit only and report that honestly.
  }
  memory.set(key, text);
  return { level: "memory" };
}

export function readPref<T>(choices: Choices, purposeId: string, key: string, parse: (raw: unknown) => T | null, stores: PrefStores = browserStores()): T | null {
  if (!purposeEnabled(choices, purposeId)) return null;
  const target = choices.deviceMemory === "temporary" ? stores.session : stores.local;
  let text: string | null = null;
  try {
    text = target?.getItem(key) ?? null;
  } catch {
    text = null;
  }
  text ??= memory.get(key) ?? null;
  if (text === null) return null;
  try {
    return parse(JSON.parse(text));
  } catch {
    // Corrupt value: drop this key only, never throw into unlock or render.
    try { target?.removeItem(key); } catch { /* nothing to do */ }
    memory.delete(key);
    return null;
  }
}

export function removePref(key: string, stores: PrefStores = browserStores()): void {
  memory.delete(key);
  for (const store of [stores.local, stores.session]) {
    try { store?.removeItem(key); } catch { /* nothing to do */ }
  }
}

/** Test hook. */
export function resetMemoryPrefs(): void {
  memory.clear();
}
