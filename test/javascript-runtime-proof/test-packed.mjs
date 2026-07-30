import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = fileURLToPath(new URL(".", import.meta.url));
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, "test:packed must run through npm so npm_execpath is available");

function readTimeout(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  assert.match(raw, /^[1-9][0-9]*$/, `${name} must be a positive integer`);
  const value = Number(raw);
  assert.ok(Number.isSafeInteger(value), `${name} must be a safe integer`);
  return value;
}

const installCommandTimeoutMs = readTimeout("PI_WORKFLOW_PACKED_INSTALL_TIMEOUT_MS", 180_000);
const runtimeTestTimeoutMs = readTimeout("PI_WORKFLOW_PACKED_TEST_TIMEOUT_MS", 60_000);
const packageJson = JSON.parse(await readFile(join(sourceRoot, "package.json"), "utf8"));
const workspace = await mkdtemp(join(tmpdir(), "pi-workflow-js-packed-"));
const packDirectory = join(workspace, "pack");
const installDirectory = join(workspace, "install");

function run(command, args, options = {}) {
  const capture = options.capture === true;
  const timeoutMs = options.timeoutMs;
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, "subprocess timeout must be positive");
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: capture ? "utf8" : undefined,
    env: options.env ?? process.env,
    maxBuffer: 16 * 1024 * 1024,
    stdio: capture ? "pipe" : "inherit",
    timeout: timeoutMs,
  });
  if (result.error?.code === "ETIMEDOUT") {
    throw new Error(`${options.label ?? command} timed out after ${timeoutMs}ms`, {
      cause: result.error,
    });
  }
  assert.ifError(result.error);
  assert.equal(result.signal, null, `${options.label ?? command} terminated by ${result.signal}`);
  assert.equal(
    result.status,
    0,
    capture ? result.stderr || result.stdout : `${options.label ?? command} exited with ${result.status}`,
  );
  return result;
}

function runNpm(args, options = {}) {
  return run(process.execPath, [npmCli, ...args], {
    ...options,
    label: options.label ?? `npm ${args[0]}`,
    timeoutMs: options.timeoutMs ?? installCommandTimeoutMs,
    env: {
      ...process.env,
      npm_config_before: "",
      npm_config_min_release_age: "0",
      ...options.env,
    },
  });
}

async function listFiles(root, directory = root, files = []) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await listFiles(root, path, files);
    } else {
      assert.equal(entry.isFile(), true, `unexpected packed-package entry: ${path}`);
      files.push(relative(root, path).split(sep).join("/"));
    }
  }
  return files;
}

try {
  await mkdir(packDirectory);
  await mkdir(installDirectory);
  await writeFile(
    join(installDirectory, "package.json"),
    `${JSON.stringify({ name: "packed-proof-host", private: true }, null, 2)}\n`,
  );

  const packed = runNpm(
    ["pack", "--json", "--ignore-scripts", "--pack-destination", packDirectory],
    { cwd: sourceRoot, capture: true },
  );
  const packReport = JSON.parse(packed.stdout);
  assert.equal(packReport.length, 1);
  const artifact = packReport[0];
  assert.equal(artifact.name, packageJson.name);
  assert.equal(artifact.version, packageJson.version);

  const tarball = join(packDirectory, artifact.filename);
  runNpm(
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
    { cwd: installDirectory },
  );
  runNpm(["ls", "--all"], { cwd: installDirectory });

  const installedRoot = join(installDirectory, "node_modules", packageJson.name);
  const expectedFiles = artifact.files.map(({ path }) => path).sort();
  assert.deepEqual(await listFiles(installedRoot), expectedFiles);

  await cp(join(sourceRoot, "test"), join(installedRoot, "test"), { recursive: true });
  for (const testFile of ["cap-wasm-memory.test.mjs", "runtime-proof.test.mjs"]) {
    run(process.execPath, ["--test", `./test/${testFile}`], {
      cwd: installedRoot,
      label: `node --test ${testFile}`,
      timeoutMs: runtimeTestTimeoutMs,
    });
  }

  process.stdout.write(
    `${JSON.stringify({ package: `${artifact.name}@${artifact.version}`, files: expectedFiles.length })}\n`,
  );
} finally {
  await rm(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
