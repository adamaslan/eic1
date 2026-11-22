import { beforeEach, expect, it, vi } from "vitest";
import type { VaultKey } from "@veil/core";

// Controlled transaction-shaped IndexedDB adapter. Competing fixture writes
// queue until done; a native-browser probe separately verifies real IDB behavior.
const disk = vi.hoisted(() => ({
  value: undefined as any,
  refusePut: false,
  refuseDelete: false,
  afterRead: null as (() => void) | null,
  beforeOpen: null as (() => void) | null,
  transactions: 0,
  inTransaction: false,
  queued: null as (() => void) | null,
}));
vi.mock("idb", () => ({ openDB: async () => {
  disk.beforeOpen?.();
  const read = async () => { const snapshot = structuredClone(disk.value); const next = disk.afterRead; disk.afterRead = null; next?.(); return snapshot; };
  const put = async (_store: string, value: any) => { if (disk.refusePut) throw new Error("quota refused"); disk.value = structuredClone(value); };
  const del = async () => { if (disk.refuseDelete) throw new Error("delete refused"); disk.value = undefined; };
  return {
    get: read, put, delete: del,
    transaction: () => {
      disk.transactions++; disk.inTransaction = true;
      return { store: { get: read, put: (value: any) => put("session", value), delete: del }, get done() {
        return Promise.resolve().then(() => { disk.inTransaction = false; const queued = disk.queued; disk.queued = null; queued?.(); });
      } };
    },
  };
} }));
const vaults = vi.hoisted(() => ({ unlock: vi.fn(), resume: vi.fn() }));
vi.mock("@veil/vault", () => ({
  createVaultKeyed: vaults.unlock, unlockVaultKeyed: vaults.unlock,
  resumeVault: vaults.resume, exportBackup: vi.fn(), importBackup: vi.fn(), newRecordId: vi.fn(),
}));
import { clearSession, loadSession, saveSession } from "./session-persist";
import { beginSessionActivity, clearSessionActivity, newSessionTiming } from "./session-policy";
import { vaultResume, vaultUnlock } from "./vault-service";
const key = {} as VaultKey;
beforeEach(() => {
  vi.unstubAllGlobals(); clearSessionActivity();
  disk.value = undefined; disk.refusePut = false; disk.refuseDelete = false;
  disk.afterRead = null; disk.beforeOpen = null; disk.transactions = 0; disk.inTransaction = false; disk.queued = null;
  vaults.unlock.mockReset(); vaults.resume.mockReset();
  vaults.unlock.mockResolvedValue({ vault: { lock: vi.fn() }, key });
  vaults.resume.mockResolvedValue({ lock: vi.fn() });
});
it("does not delete a replacement written while rejected-session cleanup waits for the database", async () => {
  const old = { key, expiresAt: 1, lockMarker: null, timing: { id: "old-expired", startedAt: 0, policy: { privateDevice: false, idleMinutes: 60 } } };
  const timing = newSessionTiming({ privateDevice: false, idleMinutes: 60 }, 1000);
  const replacement = { key, expiresAt: 28_801_000, lockMarker: null, timing };
  disk.value = old;
  disk.afterRead = () => {
    const replace = () => { disk.value = replacement; beginSessionActivity(timing); };
    if (disk.inTransaction) disk.queued = replace;
    else replace();
  };
  expect(await loadSession(1000)).toBeNull();
  expect(disk.value).toEqual(replacement);
  expect(disk.transactions).toBeGreaterThan(0);
});
it.each([false, true])("a refused replacement save cannot resume the old longer policy, even if delete refuses=%s", async (refuseDelete) => {
  const now = Date.now();
  await saveSession(key, now, newSessionTiming({ privateDevice: true, idleMinutes: 1440 }, now));
  disk.refusePut = true; disk.refuseDelete = refuseDelete;
  const memory = await vaultUnlock("synthetic local fixture", { privateDevice: false, idleMinutes: 15 });
  expect(memory.expiresAt - memory.timing.startedAt).toBe(28_800_000);
  expect(await vaultResume()).toBeNull();
  expect(vaults.resume).not.toHaveBeenCalled();
  // The revocation must survive another read. Cleanup may not erase its fence.
  expect(await vaultResume()).toBeNull();
});

it("keeps another tab's newer key/activity when an old asynchronous resume finishes late", async () => {
  const now=Date.now();
  await saveSession(key,now,newSessionTiming({privateDevice:false,idleMinutes:60},now));
  let replacement: unknown; const lateVault={lock:vi.fn()};
  vaults.resume.mockImplementation(async()=>{
    await saveSession(key,now+1,newSessionTiming({privateDevice:false,idleMinutes:15},now+1));
    replacement=structuredClone(disk.value); return lateVault;
  });
  expect(await vaultResume()).toBeNull();
  expect(lateVault.lock).toHaveBeenCalledOnce();
  expect(disk.value).toEqual(replacement);
});
it("keeps the replacement-save fence across fresh module state and repeated refused cleanup", async () => {
  const data=new Map<string,string>();
  vi.stubGlobal("window",{});
  vi.stubGlobal("localStorage",{getItem:(name:string)=>data.get(name)??null,setItem:(name:string,value:string)=>data.set(name,value),removeItem:(name:string)=>data.delete(name)});
  const now=Date.now();
  await saveSession(key,now,newSessionTiming({privateDevice:true,idleMinutes:1440},now));
  disk.refusePut=true;disk.refuseDelete=true;
  const memory=await vaultUnlock("synthetic fixture",{privateDevice:false,idleMinutes:15});
  const fence=data.get("eic.vault-activity.v1");
  expect(JSON.parse(fence!).id).toBe(memory.timing.id);
  vi.resetModules();
  const fresh=await import("./vault-service");
  expect(await fresh.vaultResume()).toBeNull();
  expect(await fresh.vaultResume()).toBeNull();
  expect(data.get("eic.vault-activity.v1")).toBe(fence);
  expect(vaults.resume).not.toHaveBeenCalled();
});

it("conditional cleanup deletes its own record but preserves a replacement and its activity", async () => {
  const now=Date.now();const old=newSessionTiming({privateDevice:false,idleMinutes:60},now);
  await saveSession(key,now,old);await clearSession(old);expect(disk.value).toBeUndefined();
  const newer=newSessionTiming({privateDevice:false,idleMinutes:15},now);
  await saveSession(key,now,newer);const replacement=structuredClone(disk.value);
  await clearSession(old);expect(disk.value).toEqual(replacement);
  expect((await loadSession(now))?.timing.id).toBe(newer.id);
});
it("manual cleanup waiting for DB opening preserves a fresh unlock after the lock request", async () => {
  const now=Date.now();await saveSession(key,now,newSessionTiming({privateDevice:false,idleMinutes:60},now));
  const timing=newSessionTiming({privateDevice:false,idleMinutes:15},now);
  const replacement={key,expiresAt:now+28_800_000,lockMarker:null,timing};
  disk.beforeOpen=()=>{disk.beforeOpen=null;beginSessionActivity(timing);disk.value=replacement;};
  await clearSession();expect(disk.value).toEqual(replacement);
  expect((await loadSession(now))?.timing.id).toBe(timing.id);
});

it.each([false, true])("samples resume validation after the read; genuinely future activity rejects=%s", async (future) => {
  const data = new Map<string, string>();
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: (name: string) => data.get(name) ?? null, setItem: (name: string, value: string) => data.set(name, value), removeItem: (name: string) => data.delete(name) });
  const now = 1_000_000;
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  try {
    const timing = newSessionTiming({ privateDevice: false, idleMinutes: 60 }, now);
    await saveSession(key, now, timing);
    disk.afterRead = () => {
      clock.mockReturnValue(now + 20);
      // Another tab updates this session while our IndexedDB read is pending.
      data.set("eic.vault-activity.v1", JSON.stringify({ id: timing.id, at: now + (future ? 30 : 10) }));
    };
    const resumed = await vaultResume();
    if (future) {
      expect(resumed).toBeNull();
      expect(vaults.resume).not.toHaveBeenCalled();
      expect(disk.value).toBeUndefined();
    } else {
      expect(resumed).not.toBeNull();
      expect(resumed?.timing.id).toBe(timing.id);
      expect(vaults.resume).toHaveBeenCalledOnce();
      expect(disk.value?.timing.id).toBe(timing.id);
    }
  } finally { clock.mockRestore(); }
});
