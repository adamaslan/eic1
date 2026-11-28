import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PROTECTED_KEYS, PURPOSES, refMatches, rowsFor, webStorageRefs, type StorageKind } from "./purpose-registry";

const APP = fileURLToPath(new URL("..", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

// Finds every key that reaches a storage API: *_KEY constants, getItem/setItem/removeItem
// literals, named databases and BroadcastChannels. CSS classes and event names are not storage.
function keysInSource(): Array<{ key: string; kind: StorageKind; file: string }> {
  const found: Array<{ key: string; kind: StorageKind; file: string }> = [];
  for (const file of sourceFiles(APP)) {
    const text = readFileSync(file, "utf8");
    const usesSession = /sessionStorage/.test(text);
    const kind: StorageKind = usesSession && !/localStorage/.test(text) ? "sessionStorage" : "localStorage";
    // IndexedDB record keys (META_KEY, KEY) live inside a named database, not in web storage.
    if (!/openDB|indexedDB/.test(text)) for (const match of text.matchAll(/\b[A-Z_]*(?:KEY|STORAGE)[A-Z_]*\s*=\s*["'`]([^"'`]+)["'`]/g)) found.push({ key: match[1], kind, file });
    for (const match of text.matchAll(/(?:get|set|remove)Item\(\s*["']([^"']+)["']/g)) found.push({ key: match[1], kind, file });
    for (const match of text.matchAll(/(?:const DB_NAME\s*=|openDB(?:<[^>]*>)?\()\s*["']([a-z-]+)["']/g)) found.push({ key: match[1], kind: "indexedDB", file });
    for (const match of text.matchAll(/new BroadcastChannel\(\s*["']([^"']+)["']/g)) found.push({ key: match[1], kind: "broadcastChannel", file });
    for (const match of text.matchAll(/`(eic\.pendingLink\.v2\.)\$\{/g)) found.push({ key: `${match[1]}*`, kind: "sessionStorage", file });
  }
  return found;
}

function covered(key: string, kind: StorageKind): boolean {
  return PURPOSES.some((purpose) => purpose.storage.some((ref) => refMatches(ref, kind, key) || (kind === "localStorage" || kind === "sessionStorage") && (refMatches(ref, "localStorage", key) || refMatches(ref, "sessionStorage", key)) || refMatches(ref, "memory", key)));
}

describe("purpose registry", () => {
  it("covers every storage key and database found in source (T-10, I-9)", () => {
    const unknown = keysInSource().filter(({ key, kind }) => !covered(key, kind));
    expect(unknown.map((entry) => `${entry.key} in ${entry.file.replace(APP, "")}`)).toEqual([]);
  });

  it("gives every registry key to exactly one row", () => {
    const seen = new Map<string, string>();
    for (const purpose of PURPOSES) {
      for (const ref of purpose.storage) {
        const id = `${ref.kind}:${ref.key}`;
        expect(seen.has(id), `${id} is in both ${seen.get(id)} and ${purpose.id}`).toBe(false);
        seen.set(id, purpose.id);
      }
    }
  });

  it("never lets Clear preferences touch security rows (I-1)", () => {
    const touched = webStorageRefs(rowsFor("clear-preferences")).map((ref) => ref.key);
    for (const key of PROTECTED_KEYS) {
      expect(touched.some((ref) => refMatches({ kind: "localStorage", key: ref }, "localStorage", key))).toBe(false);
    }
    expect(rowsFor("clear-preferences").some((row) => row.id === "vault" || row.id === "remembered-access")).toBe(false);
  });

  it("starts every optional purpose off unless it is existing behaviour (I-7)", () => {
    for (const purpose of PURPOSES.filter((row) => row.group === "connected" || row.group === "diagnostics")) {
      expect(purpose.defaultOn, purpose.id).toBe(false);
    }
  });

  it("lists every third-party origin with a reason (I-9)", () => {
    const turnstile = PURPOSES.find((row) => row.id === "turnstile");
    expect(turnstile?.leavesDevice).toMatchObject({ to: "challenges.cloudflare.com" });
    for (const purpose of PURPOSES) {
      if (purpose.leavesDevice) expect(purpose.leavesDevice.what.length).toBeGreaterThan(0);
    }
  });

  it("has unique ids and no diagnostics purpose (no analytics, ever)", () => {
    const ids = PURPOSES.map((purpose) => purpose.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(PURPOSES.some((purpose) => purpose.group === "diagnostics")).toBe(false);
  });
});
