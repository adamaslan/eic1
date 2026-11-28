// Purpose registry: the single source of truth for what this device remembers and why.
// It drives the Cookie Jar panel, the scoped reset actions and the completeness test.
// Rule I-9: every storage key in source has exactly one row here, so nothing ships undisclosed.

export type StorageKind = "localStorage" | "sessionStorage" | "indexedDB" | "cache" | "cookie" | "memory" | "broadcastChannel";
export type PurposeGroup = "necessary" | "look" | "private-device" | "connected" | "diagnostics" | "external";
export type ResetAction = "clear-preferences" | "forget-access" | "erase-vault";

export interface StorageRef {
  kind: StorageKind;
  /** Exact key, database name, or a `*` suffix pattern for per-kind keys. */
  key: string;
}

export interface Purpose {
  id: string;
  /** Bump only when what is stored or sent changes. */
  version: number;
  group: PurposeGroup;
  label: string;
  /** What the person sees in the panel: what it holds and why. */
  description: string;
  storage: StorageRef[];
  leavesDevice: false | { to: string; what: string };
  /** False for every optional purpose (I-7). Necessary rows are always on. */
  defaultOn: boolean;
  /** Human text shown in the panel. */
  expiry: string;
  /** Which reset actions touch this row. Security rows are never in clear-preferences (I-1). */
  clearedBy: ResetAction[];
  /** True when the content is a secret or grants access; shown with a warning. */
  sensitive: boolean;
  /** True for rows that can be switched off without breaking the app. */
  optional: boolean;
}

export const PURPOSES: readonly Purpose[] = [
  {
    id: "vault",
    version: 1,
    group: "necessary",
    label: "Encrypted vault",
    description: "Your posts, journal and connections, encrypted with your passphrase.",
    storage: [{ kind: "indexedDB", key: "veil" }],
    leavesDevice: false,
    defaultOn: true,
    expiry: "Until you erase it. Browser clearing or storage eviction can remove it, so export a backup.",
    clearedBy: ["erase-vault"],
    sensitive: true,
    optional: false,
  },
  {
    id: "remembered-access",
    version: 1,
    group: "private-device",
    label: "Remembered access",
    description: "A key your browser cannot export, so the vault can reopen without the passphrase.",
    storage: [
      { kind: "indexedDB", key: "veil-session" },
      { kind: "localStorage", key: "eic.vault-activity.v1" },
    ],
    leavesDevice: false,
    defaultOn: true,
    expiry: "Fixed at unlock: 8 hours, or 30 days if you chose private-device mode.",
    clearedBy: ["forget-access", "erase-vault"],
    sensitive: true,
    optional: false,
  },
  {
    id: "lock-marker",
    version: 1,
    group: "necessary",
    label: "Cross-tab lock marker",
    description: "A random value so locking one tab locks the others.",
    storage: [{ kind: "localStorage", key: "eic.vault-lock" }],
    leavesDevice: false,
    defaultOn: true,
    expiry: "Rewritten on every lock.",
    clearedBy: [],
    sensitive: true,
    optional: false,
  },
  {
    id: "pending-link",
    version: 1,
    group: "necessary",
    label: "Link waiting for unlock",
    description: "A link you tapped while locked, kept so it opens after you unlock. May contain shared text.",
    storage: [
      { kind: "sessionStorage", key: "eic.pendingLink.v2.*" },
      { kind: "sessionStorage", key: "eic.pendingLinkHash" },
      { kind: "memory", key: "__eicArrivalHash" },
    ],
    leavesDevice: false,
    defaultOn: true,
    expiry: "Removed as soon as it is used, or when this tab closes.",
    clearedBy: ["clear-preferences"],
    sensitive: true,
    optional: false,
  },
  {
    id: "cross-tab-signals",
    version: 1,
    group: "necessary",
    label: "Cross-tab signals",
    description: "In-browser messages between your own open tabs (lock now, chat message applied). Nothing is stored and nothing leaves this browser.",
    storage: [
      { kind: "broadcastChannel", key: "eic-vault-lock" },
      { kind: "broadcastChannel", key: "eic-chat-applied" },
    ],
    leavesDevice: false,
    defaultOn: true,
    expiry: "Gone when the tabs close.",
    clearedBy: [],
    sensitive: false,
    optional: false,
  },
  {
    id: "relay-save-intent",
    version: 1,
    group: "necessary",
    label: "Relay save choice",
    description: "The id of a relay item you chose to save, so the save finishes after unlock.",
    storage: [{ kind: "sessionStorage", key: "eic.relaySaveIntent" }],
    leavesDevice: false,
    defaultOn: true,
    expiry: "Removed once used, or when this tab closes.",
    clearedBy: ["clear-preferences"],
    sensitive: false,
    optional: false,
  },
  {
    id: "remember-look",
    version: 1,
    group: "look",
    label: "Remember my look",
    description: "Theme, wallpaper, text size and sounds for this device.",
    storage: [{ kind: "localStorage", key: "eic.display.v1" }],
    leavesDevice: false,
    defaultOn: true,
    expiry: "Until you reset it. Never written to the vault.",
    clearedBy: ["clear-preferences"],
    sensitive: false,
    optional: true,
  },
  {
    id: "boot-splash",
    version: 1,
    group: "look",
    label: "Boot splash shown",
    description: "Remembers that the start-up splash already played in this tab.",
    storage: [{ kind: "sessionStorage", key: "eic.boot.shown.v1" }],
    leavesDevice: false,
    defaultOn: true,
    expiry: "Until this tab closes.",
    clearedBy: ["clear-preferences"],
    sensitive: false,
    optional: true,
  },
  {
    id: "graph-layout",
    version: 1,
    group: "look",
    label: "Connections map layout",
    description: "Pinned positions and spread. Pins are keyed by map node, so they can reveal the shape of your vault.",
    storage: [
      { kind: "localStorage", key: "eic-graph-pins:v1" },
      { kind: "localStorage", key: "eic-graph-spread:v1" },
    ],
    leavesDevice: false,
    defaultOn: true,
    expiry: "Until you reset it.",
    clearedBy: ["clear-preferences"],
    sensitive: true,
    optional: true,
  },
  {
    id: "cookie-jar-choices",
    version: 1,
    group: "necessary",
    label: "Your Cookie Jar choices",
    description: "Which preset and switches you picked, so they are respected on the next visit.",
    storage: [{ kind: "localStorage", key: "eic.cookiejar.v1" }],
    leavesDevice: false,
    defaultOn: true,
    expiry: "Until you change or reset them.",
    clearedBy: [],
    sensitive: false,
    optional: false,
  },
  {
    id: "desk-memory",
    version: 1,
    group: "look",
    label: "Desk memory",
    description: "Your sticker tray and last-used tool. No names or content.",
    storage: [{ kind: "localStorage", key: "eic.desk.v1" }],
    leavesDevice: false,
    defaultOn: false,
    expiry: "Until you reset it. Tab-only mode keeps it in this tab.",
    clearedBy: ["clear-preferences"],
    sensitive: false,
    optional: true,
  },
  {
    id: "cassette-bookmark",
    version: 1,
    group: "look",
    label: "Cassette bookmark",
    description: "Where you stopped in a track. Stores a hash of the file path and a time, never a title or name.",
    storage: [{ kind: "localStorage", key: "eic.cassette.v1" }],
    leavesDevice: false,
    defaultOn: false,
    expiry: "Until you reset it. Never resumes sound on its own.",
    clearedBy: ["clear-preferences"],
    sensitive: false,
    optional: true,
  },
  {
    id: "received-postcards",
    version: 1,
    group: "connected",
    label: "Postcards you accepted",
    description: "Room postcards friends sent that you chose to keep. Stored only here.",
    storage: [{ kind: "localStorage", key: "eic.postcards.v1" }],
    leavesDevice: false,
    defaultOn: false,
    expiry: "Until you delete them. At most 20 are kept.",
    clearedBy: ["clear-preferences"],
    sensitive: false,
    optional: true,
  },
  {
    id: "backup-sync",
    version: 1,
    group: "connected",
    label: "Encrypted backup sync",
    description: "An already-encrypted vault backup stored with the host so you can recover on another device. Off unless the host enables it and you opt in.",
    storage: [{ kind: "localStorage", key: "eic.backup-sync.v1" }],
    leavesDevice: { to: "the EIC host's blob storage", what: "your encrypted backup, never the passphrase" },
    defaultOn: false,
    expiry: "30 days after the last upload, or until you delete it.",
    clearedBy: ["clear-preferences"],
    sensitive: true,
    optional: true,
  },
  {
    id: "turnstile",
    version: 1,
    group: "external",
    label: "Cloudflare Turnstile",
    description: "The bot check on the relay join screen. Loaded only on that screen. It runs Cloudflare's script, which can set its own storage.",
    storage: [],
    leavesDevice: { to: "challenges.cloudflare.com", what: "a bot check when you join a relay" },
    defaultOn: true,
    expiry: "Controlled by Cloudflare, outside EIC.",
    clearedBy: [],
    sensitive: false,
    optional: false,
  },
] as const;

/** Rows a plain "Clear preferences" may touch. Computed, so it cannot drift from the table. */
export function rowsFor(action: ResetAction): Purpose[] {
  return PURPOSES.filter((purpose) => purpose.clearedBy.includes(action));
}

/** The storage refs of a set of rows, for local/session storage only. */
export function webStorageRefs(rows: readonly Purpose[]): StorageRef[] {
  return rows.flatMap((row) => row.storage).filter((ref) => ref.kind === "localStorage" || ref.kind === "sessionStorage");
}

/** True if a concrete storage key is covered by a registry ref (supports a trailing `*`). */
export function refMatches(ref: StorageRef, kind: StorageKind, key: string): boolean {
  if (ref.kind !== kind) return false;
  return ref.key.endsWith("*") ? key.startsWith(ref.key.slice(0, -1)) : ref.key === key;
}

/** Keys that Clear preferences must never touch, derived from sensitive security rows. */
export const PROTECTED_KEYS: readonly string[] = ["veil", "veil-session", "eic.vault-lock", "eic.vault-activity.v1"];
