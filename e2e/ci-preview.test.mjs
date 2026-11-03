import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertCurrentCheckout,
  assertPrHeadCheckout,
  runBoundedCommand,
  waitForPreview,
} from "./ci-preview.mjs";

const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";
test("checkout guard accepts the PR head and rejects a different merge-ref commit", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "eic1-head-guard-"));
  try {
    execFileSync("git", ["init", "-q", "-b", "base"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "CI guard test"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "ci-guard@example.invalid"], { cwd: repo });
    await writeFile(path.join(repo, "file.txt"), "base\n");
    execFileSync("git", ["add", "file.txt"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: repo });
    execFileSync("git", ["switch", "-q", "-c", "pr-head"], { cwd: repo });
    await writeFile(path.join(repo, "file.txt"), "PR head\n");
    execFileSync("git", ["commit", "-qam", "PR head"], { cwd: repo });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    assert.equal(assertCurrentCheckout(head, { cwd: repo }), head);

    execFileSync("git", ["switch", "-q", "base"], { cwd: repo });
    await writeFile(path.join(repo, "base-only.txt"), "base changed independently\n");
    execFileSync("git", ["add", "base-only.txt"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "base advances"], { cwd: repo });
    execFileSync("git", ["merge", "--no-ff", "-qm", "synthetic PR merge ref", "pr-head"], { cwd: repo });
    const mergeRef = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    assert.notEqual(mergeRef, head);
    assert.throws(() => assertCurrentCheckout(head, { cwd: repo }), /must test the PR head/);
    assert.throws(() => assertPrHeadCheckout(head, mergeRef), /Restore the head\.sha checkout pin/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("served head stamp passes even when provider status is unavailable", async () => {
  const result = await waitForPreview({
    expectedSha: HEAD_SHA,
    previewUrl: "https://preview.example.invalid",
    repository: "adamaslan/eic1",
    runCommand: async (_command, args) => args[0] === "api"
      ? { exitCode: 1, stdout: "", stderr: "status unavailable", timedOut: false }
      : { exitCode: 0, stdout: `${HEAD_SHA.slice(0, 7)}\n`, stderr: "", timedOut: false },
    log: () => {},
    writeOutput: async () => {},
    now: () => 0,
  });
  assert.equal(result.servedStamp, HEAD_SHA.slice(0, 7));
  assert.equal(result.providerStatus, "");
  assert.equal(result.attempts, 1);
});

test("green provider status and a stale served stamp never satisfy the gate", async () => {
  let now = 0;
  let attempts = 0;
  await assert.rejects(() => waitForPreview({
    expectedSha: HEAD_SHA,
    previewUrl: "https://preview.example.invalid",
    repository: "adamaslan/eic1",
    overallTimeoutMs: 3,
    attemptTimeoutMs: 2,
    pollIntervalMs: 1,
    runCommand: async (_command, args) => {
      if (args[0] === "api") return { exitCode: 0, stdout: "success\n", stderr: "", timedOut: false };
      attempts += 1;
      return { exitCode: 1, stdout: "7654321\n", stderr: "", timedOut: false };
    },
    sleep: async (ms) => { now += ms; },
    now: () => now,
    log: () => {},
    writeOutput: async () => {},
  }), /did not verifiably serve/);
  assert.ok(attempts >= 1);
});

test("every command receives the smaller per-call and remaining attempt budgets", async () => {
  let now = 0;
  const budgets = [];
  await assert.rejects(() => waitForPreview({
    expectedSha: HEAD_SHA,
    previewUrl: "https://preview.example.invalid",
    repository: "adamaslan/eic1",
    overallTimeoutMs: 200,
    attemptTimeoutMs: 100,
    pollIntervalMs: 10,
    ghTimeoutMs: 40,
    probeTimeoutMs: 80,
    runCommand: async (_command, _args, { timeoutMs }) => {
      budgets.push(timeoutMs);
      now += timeoutMs;
      return { exitCode: 124, stdout: "", stderr: "simulated timeout", timedOut: true };
    },
    sleep: async (ms) => { now += ms; },
    now: () => now,
    log: () => {},
    writeOutput: async () => {},
  }), /did not verifiably serve/);
  assert.ok(budgets.length > 2, "polling must continue until the overall deadline");
  assert.ok(budgets.every((budget) => budget > 0 && budget <= 80));
});

test("a hung probe process is terminated at its per-command timeout", async () => {
  const started = Date.now();
  const result = await runBoundedCommand(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
    timeoutMs: 100,
    killGraceMs: 100,
  });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 2000, "hung command exceeded its bounded stop time");
});
