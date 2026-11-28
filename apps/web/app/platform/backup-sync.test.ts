import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CHOICES } from "./cookie-jar-store";
import { downloadBackup, generateRecoveryCode, isRecoveryCode, syncAllowed, syncAvailable, uploadBackup } from "./backup-sync";

const code = generateRecoveryCode();
const res = (status: number, body = "") => new Response(body, { status });

describe("backup sync client", () => {
  it("is unavailable and disallowed by default (I-3, I-7)", () => {
    expect(syncAvailable({})).toBe(false);
    expect(syncAllowed(DEFAULT_CHOICES, true)).toBe(false);
    expect(syncAllowed({ ...DEFAULT_CHOICES, purposes: { "backup-sync": true } }, false)).toBe(false);
    expect(syncAllowed({ ...DEFAULT_CHOICES, purposes: { "backup-sync": true } }, true)).toBe(true);
  });
  it("makes valid, unique 43-char codes", () => {
    expect(isRecoveryCode(code)).toBe(true);
    expect(code).toHaveLength(43);
    expect(generateRecoveryCode()).not.toBe(code);
    expect(isRecoveryCode("short")).toBe(false);
  });
  it("sends the code only as a header, never in the URL or body", async () => {
    const fetcher = vi.fn(async () => res(200, JSON.stringify({ expiresAt: "2026-12-27T00:00:00Z" })));
    const out = await uploadBackup(code, '{"format":"veil95-vault"}', fetcher);
    expect(out).toEqual({ ok: true, detail: "2026-12-27T00:00:00Z" });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/backup");
    expect(url).not.toContain(code);
    expect(String(init.body)).not.toContain(code);
    expect((init.headers as Record<string, string>)["x-backup-secret"]).toBe(code);
  });
  it("does not call the network for an invalid code", async () => {
    const fetcher = vi.fn();
    expect(await uploadBackup("nope", "{}", fetcher)).toMatchObject({ ok: false });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([[404, /not switched on/], [429, /Too many/], [413, /too big/], [500, /could not finish/]])("maps status %s to a plain message", async (status, pattern) => {
    const out = await uploadBackup(code, "{}", async () => res(status as number));
    expect(out).toMatchObject({ ok: false });
    expect((out as { message: string }).message).toMatch(pattern as RegExp);
  });
  it("reports network failure without claiming success (I-8)", async () => {
    expect(await uploadBackup(code, "{}", async () => { throw new Error("offline"); })).toMatchObject({ ok: false });
    expect(await downloadBackup(code, async () => { throw new Error("offline"); })).toMatchObject({ ok: false });
  });
  it("returns the ciphertext text on download", async () => {
    expect(await downloadBackup(code, async () => res(200, "CIPHERTEXT"))).toEqual({ ok: true, text: "CIPHERTEXT" });
  });
});
