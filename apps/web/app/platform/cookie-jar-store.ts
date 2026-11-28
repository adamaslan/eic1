import { create } from "zustand";

// Cookie Jar choices: three independent controls (device memory, audience, measurement)
// plus four presets that move them together. Presets never touch the session policy (I-10),
// never publish (I-2) and never turn measurement on - there is no measurement code at all.

export const CHOICES_KEY = "eic.cookiejar.v1";

export type DeviceMemory = "temporary" | "preferences";
export type Audience = "just-me" | "friends" | "published-per-item";
export type PresetId = "pocket-universe" | "remember-my-room" | "friends-clubhouse" | "showtime";

export interface Choices {
  v: 1;
  deviceMemory: DeviceMemory;
  audience: Audience;
  /** Always "off": the plan has no diagnostics purpose. Kept as a field so a future one is explicit. */
  measurement: "off";
  preset: PresetId | "custom";
  /** Optional purpose switches by registry id. Absent means the registry default (off). */
  purposes: Record<string, boolean>;
}

export const PRESETS: Record<PresetId, { label: string; blurb: string; deviceMemory: DeviceMemory; audience: Audience }> = {
  "pocket-universe": { label: "Pocket universe", blurb: "Everything stays on this device. Nothing is remembered once the tab closes.", deviceMemory: "temporary", audience: "just-me" },
  "remember-my-room": { label: "Remember my room", blurb: "Your look, desk and cassette spot come back next visit. Still just you.", deviceMemory: "preferences", audience: "just-me" },
  "friends-clubhouse": { label: "Friends' clubhouse", blurb: "Pick friends to share postcards with, one item at a time.", deviceMemory: "preferences", audience: "friends" },
  showtime: { label: "Showtime, per item", blurb: "Publish a single postcard on purpose. Nothing is published by default.", deviceMemory: "preferences", audience: "published-per-item" },
};

/** Existing users keep today's behaviour: the look is remembered, nothing is shared (I-7). */
export const DEFAULT_CHOICES: Choices = {
  v: 1,
  deviceMemory: "preferences",
  audience: "just-me",
  measurement: "off",
  preset: "remember-my-room",
  purposes: {},
};

const MEMORY = ["temporary", "preferences"] as const;
const AUDIENCES = ["just-me", "friends", "published-per-item"] as const;

export function sanitizeChoices(input: unknown): Choices {
  if (!input || typeof input !== "object") return { ...DEFAULT_CHOICES, purposes: {} };
  const raw = input as Record<string, unknown>;
  const purposes: Record<string, boolean> = {};
  if (raw.purposes && typeof raw.purposes === "object") {
    for (const [id, value] of Object.entries(raw.purposes as Record<string, unknown>)) {
      if (typeof value === "boolean" && /^[a-z0-9-]{1,40}$/.test(id)) purposes[id] = value;
    }
  }
  const preset = typeof raw.preset === "string" && raw.preset in PRESETS ? (raw.preset as PresetId) : "custom";
  return {
    v: 1,
    deviceMemory: (MEMORY as readonly unknown[]).includes(raw.deviceMemory) ? (raw.deviceMemory as DeviceMemory) : DEFAULT_CHOICES.deviceMemory,
    audience: (AUDIENCES as readonly unknown[]).includes(raw.audience) ? (raw.audience as Audience) : DEFAULT_CHOICES.audience,
    measurement: "off",
    preset,
    purposes,
  };
}

/** Pure: a preset moves the controls but keeps the person's per-purpose switches. */
export function applyPreset(current: Choices, preset: PresetId): Choices {
  const { deviceMemory, audience } = PRESETS[preset];
  return { ...current, deviceMemory, audience, measurement: "off", preset };
}

/** Pure: is an optional purpose allowed to write or send right now (I-3)? */
export function purposeEnabled(choices: Choices, id: string, defaultOn = false): boolean {
  return choices.purposes[id] ?? defaultOn;
}

export type PersistLevel = "device" | "tab" | "memory";

let memoryChoices: Choices | null = null;

function readStored(): Choices {
  try {
    const raw = window.localStorage.getItem(CHOICES_KEY);
    if (raw) return sanitizeChoices(JSON.parse(raw));
  } catch {
    // Corrupt JSON or blocked storage: fall through to what this visit already holds.
  }
  return memoryChoices ?? { ...DEFAULT_CHOICES, purposes: {} };
}

/** Writes choices; reports where they actually landed so the UI never claims a false save (I-8). */
function writeStored(choices: Choices): PersistLevel {
  memoryChoices = choices;
  try {
    window.localStorage.setItem(CHOICES_KEY, JSON.stringify(choices));
    return "device";
  } catch {
    return "memory";
  }
}

interface CookieJarStore {
  choices: Choices;
  loaded: boolean;
  persisted: PersistLevel;
  load: () => void;
  choosePreset: (preset: PresetId) => void;
  setDeviceMemory: (value: DeviceMemory) => void;
  setAudience: (value: Audience) => void;
  setPurpose: (id: string, on: boolean) => void;
  resetChoices: () => void;
}

export const useCookieJarStore = create<CookieJarStore>((set, get) => {
  const commit = (choices: Choices) => set({ choices, persisted: writeStored(choices) });
  const patch = (next: Partial<Choices>) => commit(sanitizeChoices({ ...get().choices, preset: "custom", ...next }));
  return {
    choices: { ...DEFAULT_CHOICES, purposes: {} },
    loaded: false,
    persisted: "device",
    load: () => {
      if (typeof window === "undefined") return;
      // Blocked storage is reported up front so the page never implies choices will be remembered (I-8).
      let usable = true;
      try { window.localStorage.getItem(CHOICES_KEY); } catch { usable = false; }
      set({ choices: readStored(), loaded: true, persisted: usable ? "device" : "memory" });
      // Another tab changed a switch: apply it here and never re-enable from a stale copy (I-3).
      window.addEventListener("storage", (event) => {
        if (event.key === CHOICES_KEY) set({ choices: readStored() });
      });
    },
    choosePreset: (preset) => commit(applyPreset(get().choices, preset)),
    setDeviceMemory: (deviceMemory) => patch({ deviceMemory }),
    setAudience: (audience) => patch({ audience }),
    setPurpose: (id, on) => patch({ purposes: { ...get().choices.purposes, [id]: on } }),
    resetChoices: () => commit({ ...DEFAULT_CHOICES, purposes: {} }),
  };
});
