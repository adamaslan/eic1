import { describe, expect, it, vi } from "vitest";
import { RelayStoreUnavailableError, createSupabaseRelayStore } from "./supabase-relay-store";

describe("server-only Supabase relay store boundary", () => {
  it("does nothing on construction, calls only named RPC with parameters", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { data: "ciphertext", generation: "9007199254740993" }, error: null });
    const store = createSupabaseRelayStore({ rpc }); expect(rpc).not.toHaveBeenCalled();
    expect(await store.get("feeds/a/objects/1/chat.json")).toEqual({ data: "ciphertext", generation: "9007199254740993" });
    expect(rpc).toHaveBeenCalledWith("eic_relay_get", { p_key: "feeds/a/objects/1/chat.json" });
  });
  it("preserves CAS failure and arbitrary-precision generations without numeric conversion", async () => {
    const rpc = vi.fn().mockResolvedValueOnce({ data: null, error: null }).mockResolvedValueOnce({ data: "9007199254740994", error: null });
    const store = createSupabaseRelayStore({ rpc });
    expect(await store.compareAndSet("state", "x", { createOnly: true })).toBeNull();
    expect(await store.compareAndSet("state", "y", { generation: "9007199254740993" })).toBe("9007199254740994");
    expect(rpc.mock.calls[1][1]).toEqual({ p_key: "state", p_data: "y", p_expected: "9007199254740993" });
  });
  it("bounds path, bytes, batch and invalid CAS before any call", async () => {
    const rpc = vi.fn(); const store = createSupabaseRelayStore({ rpc });
    await expect(store.get("")).rejects.toThrow("path");
    await expect(store.putObject("x", "é".repeat(550001))).rejects.toThrow("large");
    await expect(store.list("x", { limit: 1001 })).rejects.toThrow("limit");
    await expect(store.compareAndSet("x", "y", { generation: "bad' OR 1=1" })).rejects.toThrow("generation");
    expect(rpc).not.toHaveBeenCalled();
  });
  it("never leaks backend errors or accepts malformed response shape", async () => {
    const rpc = vi.fn().mockResolvedValueOnce({ data: null, error: { message: "postgres://secret" } }).mockResolvedValue({ data: { data: "x", generation: 12 }, error: null });
    const store = createSupabaseRelayStore({ rpc });
    await expect(store.get("a")).rejects.toThrow(/^The encrypted relay store is unavailable\.$/);
    await expect(store.get("a")).rejects.toThrow("Invalid relay store response");
  });
  it("rejects broadened pages, oversized pages and unrelated cursors", async () => {
    const rpc = vi.fn().mockResolvedValueOnce({ data: { keys: ["other/key"] }, error: null }).mockResolvedValueOnce({ data: { keys: ["a/1", "a/2"] }, error: null }).mockResolvedValueOnce({ data: { keys: ["a/1"], nextCursor: "a/3" }, error: null });
    const store = createSupabaseRelayStore({ rpc });
    await expect(store.list("a/")).rejects.toThrow("Invalid relay store response");
    await expect(store.list("a/", { limit: 1 })).rejects.toThrow("Invalid relay store response");
    await expect(store.list("a/")).rejects.toThrow("Invalid relay store response");
  });
});


it("counts path limits in UTF-8 bytes before calling RPC", async () => {
  const rpc = vi.fn(); const store = createSupabaseRelayStore({ rpc });
  await expect(store.get("é".repeat(513))).rejects.toThrow("path");
  expect(rpc).not.toHaveBeenCalled();
});
it("sanitizes rejected RPC transports as store-unavailable errors", async () => {
  const store = createSupabaseRelayStore({ rpc: vi.fn().mockRejectedValue(new Error("postgres://private")) });
  await expect(store.get("a")).rejects.toThrow(/^The encrypted relay store is unavailable\.$/);
});

it("classifies malformed successful RPC payloads as backend faults", async () => {
  const store = createSupabaseRelayStore({ rpc: vi.fn().mockResolvedValue({ data: { wrong: "shape" }, error: null }) });
  await expect(store.get("a")).rejects.toBeInstanceOf(RelayStoreUnavailableError);
  await expect(store.compareAndSet("a", "x", { createOnly: true })).rejects.toBeInstanceOf(RelayStoreUnavailableError);
  await expect(store.list("a/")).rejects.toBeInstanceOf(RelayStoreUnavailableError);
});
