import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];
const supportedModes = [
  "identity",
  "globals",
  "concurrency",
  "bridge",
  "cpu",
  "oom",
  "abort",
  "stack",
  "cancel",
  "cancel-timeout",
  "cancel-output",
  "cancel-exit",
  "stress",
];
assert.ok(supportedModes.includes(mode), "unsupported proof mode");

const root = fileURLToPath(new URL(".", import.meta.url));
const childPath = fileURLToPath(new URL("./proof-child.mjs", import.meta.url));
const childEnvironment = {};
if (process.platform === "win32") {
  assert.ok(process.env.SystemRoot, "trusted SystemRoot is required on Windows");
  childEnvironment.SystemRoot = process.env.SystemRoot;
} else if (process.platform === "darwin") {
  childEnvironment.__CF_USER_TEXT_ENCODING = "0x0:0:0";
}
Object.freeze(childEnvironment);
const maximumCapturedBytes = 64 * 1024;

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function verifyRuntimeDependency() {
  const identity = JSON.parse(await readFile(new URL("./runtime-identity.json", import.meta.url), "utf8"));
  const manifestBytes = await readFile(new URL("./runtime-dependency-files.json", import.meta.url));
  const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
  assert.equal(manifestBytes.byteLength, identity.dependencyFileManifest.bytes);
  assert.equal(manifestSha256, identity.dependencyFileManifest.sha256);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  assert.equal(manifest.version, 1);
  assert.deepEqual(manifest.package, {
    name: identity.package.name,
    version: identity.package.version,
  });
  assert.equal(manifest.files.length, identity.dependencyFileManifest.fileCount);

  const packageJsonPath = fileURLToPath(import.meta.resolve("quickjs-wasi/package.json"));
  const packageRoot = dirname(packageJsonPath);
  const actualFiles = [];
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const absolutePath = resolve(directory, entry.name);
      const metadata = await lstat(absolutePath);
      assert.equal(metadata.isSymbolicLink(), false, `dependency symlink rejected: ${absolutePath}`);
      if (metadata.isDirectory()) {
        await walk(absolutePath);
      } else {
        assert.equal(metadata.isFile(), true, `non-file dependency entry rejected: ${absolutePath}`);
        const bytes = await readFile(absolutePath);
        actualFiles.push({
          path: relative(packageRoot, absolutePath).split(sep).join("/"),
          bytes: metadata.size,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      }
    }
  }
  await walk(packageRoot);
  actualFiles.sort((left, right) => compareText(left.path, right.path));
  assert.deepEqual(actualFiles, manifest.files, "installed quickjs-wasi files do not match the pinned manifest");
  return {
    verified: actualFiles.length,
    manifestBytes: manifestBytes.byteLength,
    manifestSha256,
  };
}

const dependencyFiles = await verifyRuntimeDependency();

function runChildSync(childMode) {
  const child = spawnSync(process.execPath, [childPath, childMode], {
    cwd: root,
    encoding: "utf8",
    env: childEnvironment,
    timeout: 20_000,
    maxBuffer: maximumCapturedBytes,
  });
  if (child.error) throw child.error;
  assert.equal(child.signal, null, `proof child terminated by ${child.signal}`);
  assert.equal(child.status, 0, child.stderr || child.stdout);
  return {
    ...JSON.parse(child.stdout),
    dependencyFiles,
    childExitCode: child.status,
    childSignal: child.signal,
  };
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function proveRuntimeAbort() {
  const started = performance.now();
  const child = spawnSync(process.execPath, [childPath, "abort"], {
    cwd: root,
    encoding: "utf8",
    env: childEnvironment,
    timeout: 5_000,
    maxBuffer: maximumCapturedBytes,
  });
  if (child.error) throw child.error;
  const failed = child.status !== 0 || child.signal !== null;
  return {
    case: "abort",
    outcome: failed ? "runtime_abort" : "completed",
    parentAlive: true,
    childExitCode: child.status,
    childSignal: child.signal,
    stderrBytes: Buffer.byteLength(child.stderr ?? "", "utf8"),
    aliveAfterExit: processIsAlive(child.pid),
    elapsedMs: performance.now() - started,
  };
}

function proveStress() {
  const iterations = 16;
  const started = performance.now();
  const initialRss = process.memoryUsage().rss;
  let peakRss = initialRss;
  let completed = 0;
  let maxWasmMemoryBytes = 0;
  for (let index = 0; index < iterations; index += 1) {
    const report = runChildSync("oom");
    assert.equal(report.outcome, "out_of_memory");
    completed += 1;
    maxWasmMemoryBytes = Math.max(maxWasmMemoryBytes, report.wasmMemoryBytes);
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }
  return {
    case: "stress",
    iterations,
    completed,
    maxWasmMemoryBytes,
    parentRssGrowthBytes: peakRss - initialRss,
    elapsedMs: performance.now() - started,
  };
}

function appendBounded(capture, chunk) {
  const bytes = Buffer.from(chunk);
  capture.totalBytes += bytes.byteLength;
  const remaining = maximumCapturedBytes - capture.capturedBytes;
  if (remaining > 0) {
    const accepted = bytes.subarray(0, remaining);
    capture.text += accepted.toString("utf8");
    capture.capturedBytes += accepted.byteLength;
  }
  capture.exceeded ||= capture.totalBytes > maximumCapturedBytes;
}

async function terminateAndReap(child, exit) {
  const killResults = [];
  let terminal;
  if (child.exitCode !== null || child.signalCode !== null) {
    terminal = await exit;
    return { terminal, terminationAttempts: 0, killResults };
  }

  killResults.push(child.kill("SIGTERM"));
  terminal = await Promise.race([
    exit.then((value) => ({ exited: true, value })),
    delay(100, { exited: false }, { ref: false }),
  ]);
  if (!terminal.exited) {
    killResults.push(child.kill("SIGKILL"));
    terminal = await Promise.race([
      exit.then((value) => ({ exited: true, value })),
      delay(1_000, { exited: false }, { ref: false }),
    ]);
  }
  if (!terminal.exited) {
    throw new Error(`failed to reap child ${child.pid} after force-kill`);
  }
  if (killResults.every((sent) => sent === false) && processIsAlive(child.pid)) {
    throw new Error(`all termination attempts failed for live child ${child.pid}`);
  }
  return {
    terminal: terminal.value,
    terminationAttempts: killResults.length,
    killResults,
  };
}

async function proveCancellation({ childMode, caseName, readyTimeoutMs }) {
  const started = performance.now();
  const child = spawn(process.execPath, [childPath, childMode], {
    cwd: root,
    env: childEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = { text: "", totalBytes: 0, capturedBytes: 0, exceeded: false };
  const stderr = { text: "", totalBytes: 0, capturedBytes: 0, exceeded: false };
  let settleState;
  const state = new Promise((resolve) => { settleState = resolve; });
  child.stdout.on("data", (chunk) => {
    appendBounded(stdout, chunk);
    if (stdout.exceeded) settleState("output_limit");
    else if (stdout.text.includes("READY\n")) settleState("ready");
  });
  child.stderr.on("data", (chunk) => {
    appendBounded(stderr, chunk);
    if (stderr.exceeded) settleState("output_limit");
  });
  const exit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  const startupState = await Promise.race([
    state,
    exit.then(() => "exited_before_ready"),
    delay(readyTimeoutMs, "startup_timeout", { ref: false }),
  ]);
  const cleanupStarted = performance.now();
  const cleanup = await terminateAndReap(child, exit);
  const cleanupMs = performance.now() - cleanupStarted;
  const ready = startupState === "ready";
  const outcome = startupState === "output_limit"
    ? "output_limit"
    : startupState === "exited_before_ready"
      ? "exited_before_ready"
      : ready
        ? "terminated"
        : "startup_timeout";
  return {
    case: caseName,
    outcome,
    ready,
    terminationAttempts: cleanup.terminationAttempts,
    killResults: cleanup.killResults,
    exitCode: cleanup.terminal.code,
    exitSignal: cleanup.terminal.signal,
    aliveAfterExit: processIsAlive(child.pid),
    stdoutBytes: stdout.capturedBytes,
    stderrBytes: stderr.capturedBytes,
    outputTruncated: stdout.exceeded || stderr.exceeded,
    cleanupMs,
    elapsedMs: performance.now() - started,
  };
}

const report = mode === "cancel"
  ? await proveCancellation({ childMode: "cancel", caseName: "cancel", readyTimeoutMs: 5_000 })
  : mode === "cancel-timeout"
    ? await proveCancellation({ childMode: "cancel-silent", caseName: "cancel-timeout", readyTimeoutMs: 100 })
    : mode === "cancel-output"
      ? await proveCancellation({ childMode: "cancel-flood", caseName: "cancel-output", readyTimeoutMs: 5_000 })
      : mode === "cancel-exit"
        ? await proveCancellation({ childMode: "cancel-exit", caseName: "cancel-exit", readyTimeoutMs: 5_000 })
        : mode === "stress"
          ? proveStress()
          : mode === "abort"
            ? proveRuntimeAbort()
            : runChildSync(mode);
process.stdout.write(`${JSON.stringify(report)}\n`);
