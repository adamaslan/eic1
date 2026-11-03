import { spawn, execFileSync } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const DEFAULT_OVERALL_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 30 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 10 * 1000;
const DEFAULT_GH_TIMEOUT_MS = 10 * 1000;
const DEFAULT_PROBE_TIMEOUT_MS = 20 * 1000;
const KILL_GRACE_MS = 1000;
const MAX_COMMAND_OUTPUT_CHARS = 50000;

export function assertPrHeadCheckout(expectedSha, actualSha) {
  if (!/^[0-9a-f]{40}$/i.test(expectedSha ?? "")) {
    throw new Error(`Expected PR head SHA must be a full 40-character SHA; received ${expectedSha || "<empty>"}.`);
  }
  if (actualSha !== expectedSha) {
    throw new Error(
      `transition-smoke must test the PR head the deploy preview serves (${expectedSha}), but checked out ${actualSha || "<unknown>"}. Restore the head.sha checkout pin.`,
    );
  }
}

export function assertCurrentCheckout(expectedSha, { cwd = process.cwd() } = {}) {
  const actualSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  assertPrHeadCheckout(expectedSha, actualSha);
  return actualSha;
}

function signalProcessTree(child, signal) {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function appendBounded(current, chunk) {
  const combined = current + chunk;
  return combined.length > MAX_COMMAND_OUTPUT_CHARS
    ? combined.slice(-MAX_COMMAND_OUTPUT_CHARS)
    : combined;
}

export function runBoundedCommand(command, args, {
  cwd = process.cwd(),
  env = process.env,
  timeoutMs,
  killGraceMs = KILL_GRACE_MS,
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.resolve({ exitCode: 124, stdout: "", stderr: "No command time remains.", timedOut: true });
  }
  const effectiveKillGraceMs = Math.min(killGraceMs, Math.floor(timeoutMs / 3));

  return new Promise((resolveResult) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let killTimer;
    const child = spawn(command, args, {
      cwd,
      env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      resolveResult({ stdout, stderr, timedOut, ...result });
    };
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      signalProcessTree(child, "SIGTERM");
      killTimer = setTimeout(() => signalProcessTree(child, "SIGKILL"), effectiveKillGraceMs);
    }, Math.max(1, timeoutMs - effectiveKillGraceMs));

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout = appendBounded(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = appendBounded(stderr, chunk); });
    child.on("error", (error) => finish({ exitCode: 127, error: error.message }));
    child.on("close", (code, signal) => finish({ exitCode: code ?? 128, signal }));
  });
}

function boundedText(value, max = 300) {
  return String(value ?? "").replace(/[\r\n]+/g, " ").slice(0, max);
}

export async function waitForPreview({
  expectedSha,
  previewUrl,
  repository,
  runCommand = runBoundedCommand,
  sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
  now = () => performance.now(),
  log = console.log,
  writeOutput = async () => {},
  overallTimeoutMs = DEFAULT_OVERALL_TIMEOUT_MS,
  attemptTimeoutMs = DEFAULT_ATTEMPT_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  ghTimeoutMs = DEFAULT_GH_TIMEOUT_MS,
  probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  cwd = process.cwd(),
  env = process.env,
} = {}) {
  if (!/^[0-9a-f]{40}$/i.test(expectedSha ?? "")) throw new Error("HEAD_SHA must be a full 40-character commit SHA.");
  if (!previewUrl || !repository) throw new Error("PREVIEW_URL and GITHUB_REPOSITORY are required.");

  const wantedStamp = expectedSha.slice(0, 7);
  const deadline = now() + overallTimeoutMs;
  let lastProbeError = "";
  let attempt = 0;

  while (now() < deadline) {
    attempt += 1;
    const attemptDeadline = Math.min(deadline, now() + attemptTimeoutMs);
    const remaining = () => Math.min(attemptDeadline, deadline) - now();
    const statusBudget = Math.min(ghTimeoutMs, remaining());
    let providerStatus = "";

    if (statusBudget > 0) {
      const statusResult = await runCommand("gh", [
        "api",
        `repos/${repository}/commits/${expectedSha}/status`,
        "--jq",
        '[.statuses[] | select(.context == "netlify/everybodyiscool/deploy-preview") | .state] | first // ""',
      ], { cwd, env, timeoutMs: statusBudget, killGraceMs: KILL_GRACE_MS });
      if (statusResult.exitCode === 0 && !statusResult.timedOut) providerStatus = statusResult.stdout.trim();
      else if (statusResult.stderr) lastProbeError = boundedText(statusResult.stderr);
    }

    const probeBudget = Math.min(probeTimeoutMs, remaining());
    let servedStamp = "";
    if (probeBudget > 0) {
      const probeResult = await runCommand(process.execPath, ["e2e/preview-stamp.mjs", wantedStamp], {
        cwd,
        env: { ...env, PREVIEW_URL: previewUrl, PREVIEW_STAMP_TIMEOUT_MS: String(probeBudget) },
        timeoutMs: probeBudget,
        killGraceMs: KILL_GRACE_MS,
      });
      servedStamp = probeResult.stdout.trim();
      if (probeResult.stderr) lastProbeError = boundedText(probeResult.stderr);
      if (!probeResult.timedOut && probeResult.exitCode === 0 && servedStamp === wantedStamp) {
        await writeOutput(`url=${previewUrl}\n`);
        log(`Served footer stamp ${servedStamp} == head ${wantedStamp} (provider status: '${providerStatus || "unknown"}')`);
        return { servedStamp, providerStatus, attempts: attempt };
      }
    }

    log(`[${attempt}] served_stamp='${boundedText(servedStamp, 40)}' status='${providerStatus || "unknown"}' - waiting for ${wantedStamp}`);
    const sleepMs = Math.min(pollIntervalMs, remaining());
    if (sleepMs <= 0) break;
    await sleep(sleepMs);
  }

  const message = `Deploy preview did not verifiably serve the build of ${expectedSha} within ${overallTimeoutMs}ms. Last probe/status stderr (bounded): ${lastProbeError || "<none>"}`;
  log(`::error::${message}`);
  throw new Error(message);
}

async function runWaitCli() {
  const { HEAD_SHA, PREVIEW_URL, GITHUB_REPOSITORY, GITHUB_OUTPUT } = process.env;
  await waitForPreview({
    expectedSha: HEAD_SHA,
    previewUrl: PREVIEW_URL,
    repository: GITHUB_REPOSITORY,
    writeOutput: GITHUB_OUTPUT
      ? (text) => appendFile(GITHUB_OUTPUT, text, "utf8")
      : async () => {},
  });
}

async function main() {
  const mode = process.argv[2];
  if (mode === "assert-head") {
    const sha = process.env.HEAD_SHA;
    const actual = assertCurrentCheckout(sha);
    console.log(`PR head checkout verified: ${actual}`);
    return;
  }
  if (mode === "wait") {
    await runWaitCli();
    return;
  }
  throw new Error("Usage: node e2e/ci-preview.mjs <assert-head|wait>");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
