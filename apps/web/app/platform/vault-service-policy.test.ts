import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ marker: "A", save: vi.fn(), unlock: vi.fn(), clear: vi.fn(), discard: vi.fn() }));
vi.mock("./session-persist", () => ({currentLockMarker:()=>state.marker,saveSession:state.save,clearSession:state.clear,discardSavedSession:state.discard,loadSession:vi.fn()}));
vi.mock("@veil/vault", () => ({createVaultKeyed:state.unlock,unlockVaultKeyed:state.unlock,exportBackup:vi.fn(),importBackup:vi.fn(),newRecordId:vi.fn(),resumeVault:vi.fn()}));
import { vaultUnlock } from "./vault-service";
beforeEach(() => { state.marker="A";state.save.mockReset();state.unlock.mockReset();state.clear.mockReset();state.discard.mockReset().mockResolvedValue(true); });
it("Manual Lock during passphrase derivation wins over the late unlock", async () => {
  let finish!: (result: unknown) => void;
  state.unlock.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const lock=vi.fn();const pending=vaultUnlock("synthetic fixture");
  state.marker="B";finish({vault:{lock},key:{}});
  await expect(pending).rejects.toThrow("locked in another tab");expect(lock).toHaveBeenCalledOnce();expect(state.save).not.toHaveBeenCalled();
});
it("Manual Lock during save is not laundered into a fresh marker", async () => {
  const lock=vi.fn();state.unlock.mockResolvedValue({vault:{lock},key:{}});
  state.save.mockImplementation(async()=>{state.marker="B";return Date.now()+28_800_000;});
  await expect(vaultUnlock("synthetic fixture")).rejects.toThrow("locked in another tab");expect(lock).toHaveBeenCalledOnce();
});
it("storage refusal keeps only a bounded in-memory session", async () => {
  state.unlock.mockResolvedValue({vault:{lock:vi.fn()},key:{}});state.save.mockRejectedValue(new Error("quota"));
  const result=await vaultUnlock("synthetic fixture",{privateDevice:true,idleMinutes:60});
  expect(state.discard).toHaveBeenCalledWith(result.timing);expect(state.clear).not.toHaveBeenCalled();
  expect(result.expiresAt-result.timing.startedAt).toBe(30*24*60*60_000);expect(result.lockMarker).toBe("A");
});

it("a successful save does not delete or rewrite its persistence/activity", async () => {
  const key={};state.unlock.mockResolvedValue({vault:{lock:vi.fn()},key});state.save.mockImplementation(async(_key,now)=>now+28_800_000);
  const result=await vaultUnlock("synthetic fixture");
  expect(result.expiresAt-result.timing.startedAt).toBe(28_800_000);
  expect(state.discard).not.toHaveBeenCalled();expect(state.clear).not.toHaveBeenCalled();
});
