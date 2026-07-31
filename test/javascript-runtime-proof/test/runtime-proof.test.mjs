import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	access,
	cp,
	mkdtemp,
	mkdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const parentPath = fileURLToPath(
	new URL("../proof-parent.mjs", import.meta.url),
);
const childPath = fileURLToPath(new URL("../proof-child.mjs", import.meta.url));
const proofRoot = dirname(parentPath);
const expectedEnvironmentKeys =
	process.platform === "win32"
		? ["systemroot"]
		: process.platform === "darwin"
			? ["__cf_user_text_encoding"]
			: [];

function runProof(...args) {
	const result = spawnSync(process.execPath, [parentPath, ...args], {
		cwd: root,
		encoding: "utf8",
		env: {
			PATH: process.env.PATH,
			SystemRoot: process.env.SystemRoot,
			WINDIR: process.env.WINDIR,
		},
		timeout: 30_000,
	});
	assert.equal(result.status, 0, result.stderr || result.stdout);
	assert.equal(result.signal, null);
	return JSON.parse(result.stdout);
}

test("pins package, engine, WASM, and import identity", () => {
	const report = runProof("identity");
	assert.deepEqual(report.package, {
		name: "quickjs-wasi",
		version: "3.2.0",
		license: "MIT",
		runtimeDependencies: 0,
		lifecycleScripts: [],
		lockIntegrity:
			"sha512-+7ArUWrc1qCtFLjpNVGI47eGih4TKWg3RSB+FfPFtnfZrKlgvCGUUWbClDalFL7lzNAYH82jrPPHsh3LBkuk7g==",
	});
	assert.deepEqual(report.engine, { name: "quickjs-ng", version: "0.15.1" });
	assert.deepEqual(report.dependencyFiles, {
		verified: 24,
		manifestBytes: 3314,
		manifestSha256:
			"96f2003a8840057195df2700c53e9e3362522fcc6fb6341400d5ca85f4dc0ec8",
	});
	assert.deepEqual(report.posture, {
		wrapperCommit: "eddbe6d0f16a999f973e015d8f497ee4e9fbf5d0",
		engineCommit: "fd0a0210b7be00957751871e7e01b8291268fc29",
		publishedAt: "2026-07-23T09:51:52.792Z",
		maintainers: ["adamdong", "tootallnate"],
		provenanceUrl:
			"https://registry.npmjs.org/-/npm/v1/attestations/quickjs-wasi@3.2.0",
		reviewedFixedAdvisories: [
			"CVE-2026-0821",
			"CVE-2026-0822",
			"CVE-2026-1144",
			"CVE-2026-1145",
			"CVE-2026-37630",
			"CVE-2026-3979",
		],
		licenseNoticeFilesPresent: false,
		phase16Decision: {
			asOf: "2026-07-31",
			disposition: "rejected",
			accepted: false,
			reasonCodes: [
				"post-release-memory-safety-fixes-missing",
				"unresolved-upstream-memory-safety-report",
				"license-notice-files-missing",
				"final-launch-posture-not-proven",
			],
		},
	});
	assert.deepEqual(report.wasm, {
		sourceBytes: 612319,
		sourceSha256:
			"078199ef140ec06f18cf7382cca6a39cae638b2d49dca6bdfd139023abb71db4",
		cappedBytes: 612321,
		cappedSha256:
			"1716aece9c92901ecc3afd4edf2e21e21c3bc341632e4353ef18c90f180c44f5",
		maximumLinearMemory: 64 * 1024 * 1024,
	});
	assert.deepEqual(
		report.hostEnvironmentKeys.map((key) => key.toLowerCase()),
		expectedEnvironmentKeys,
	);
	assert.deepEqual(report.imports, [
		{ module: "env", name: "host_call", kind: "function" },
		{ module: "env", name: "host_get_timezone_offset", kind: "function" },
		{ module: "env", name: "host_interrupt", kind: "function" },
		{ module: "env", name: "host_module_load", kind: "function" },
		{ module: "env", name: "host_module_normalize", kind: "function" },
		{ module: "env", name: "host_promise_rejection", kind: "function" },
		{
			module: "wasi_snapshot_preview1",
			name: "clock_time_get",
			kind: "function",
		},
		{ module: "wasi_snapshot_preview1", name: "fd_close", kind: "function" },
		{
			module: "wasi_snapshot_preview1",
			name: "fd_fdstat_get",
			kind: "function",
		},
		{ module: "wasi_snapshot_preview1", name: "fd_seek", kind: "function" },
		{ module: "wasi_snapshot_preview1", name: "fd_write", kind: "function" },
		{ module: "wasi_snapshot_preview1", name: "random_get", kind: "function" },
	]);
});

test("scrubs ambient variables before importing the runtime dependency", async () => {
	const childSource = await readFile(childPath, "utf8");
	assert.doesNotMatch(childSource, /^import\s+.*["']quickjs-wasi["'];?$/mu);
	const resetIndex = childSource.indexOf("resetHostEnvironment();");
	const importIndex = childSource.indexOf('await import("quickjs-wasi")');
	assert.ok(resetIndex >= 0, "child entry does not reset its environment");
	assert.ok(
		importIndex > resetIndex,
		"runtime dependency loads before environment reset",
	);

	const result = spawnSync(process.execPath, [childPath, "identity"], {
		cwd: root,
		encoding: "utf8",
		env: {
			PATH: process.env.PATH,
			SystemRoot: process.env.SystemRoot,
			PI_WORKFLOW_AMBIENT_SHOULD_BE_REMOVED: "present",
		},
		maxBuffer: 64 * 1024,
		timeout: 30_000,
	});
	assert.equal(result.status, 0, result.stderr || result.stdout);
	assert.equal(result.signal, null);
	const report = JSON.parse(result.stdout);
	assert.deepEqual(
		report.hostEnvironmentKeys.map((key) => key.toLowerCase()),
		expectedEnvironmentKeys,
	);
});

test("rejects dependency tampering before runtime child code executes", async () => {
	const fixture = await mkdtemp(join(tmpdir(), "pi-workflow-js-tamper-"));
	const marker = join(fixture, "child-started");
	try {
		for (const filename of [
			"cap-wasm-memory.mjs",
			"package.json",
			"proof-child.mjs",
			"proof-parent.mjs",
			"runtime-dependency-files.json",
			"runtime-identity.json",
		]) {
			await cp(join(proofRoot, filename), join(fixture, filename));
		}
		const dependencyPackageJson = fileURLToPath(
			new URL(import.meta.resolve("quickjs-wasi/package.json")),
		);
		const dependencyRoot = dirname(dependencyPackageJson);
		const fixtureDependencyRoot = join(
			fixture,
			"node_modules",
			basename(dependencyRoot),
		);
		await mkdir(dirname(fixtureDependencyRoot), { recursive: true });
		await cp(dependencyRoot, fixtureDependencyRoot, { recursive: true });
		const childPath = join(fixture, "proof-child.mjs");
		const childSource = await readFile(childPath, "utf8");
		await writeFile(
			childPath,
			`import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "spawned");\n${childSource}`,
		);
		await writeFile(join(fixtureDependencyRoot, "README.md"), "tampered\n", {
			flag: "a",
		});

		const result = spawnSync(
			process.execPath,
			[join(fixture, "proof-parent.mjs"), "identity"],
			{
				encoding: "utf8",
				timeout: 5_000,
				maxBuffer: 64 * 1024,
			},
		);
		assert.notEqual(result.status, 0);
		assert.match(
			result.stderr,
			/installed quickjs-wasi files do not match the pinned manifest/,
		);
		await assert.rejects(access(marker));
	} finally {
		await rm(fixture, { recursive: true, force: true });
	}
});

test("exposes only the required restricted guest intrinsic surface", () => {
	const report = runProof("globals");
	assert.equal(report.case, "globals");
	assert.deepEqual(report.required, {
		JSON: "object",
		Math: "object",
		Promise: "function",
	});
	assert.deepEqual(
		Object.keys(report.forbidden).sort(),
		[
			"ArrayBuffer",
			"Atomics",
			"BigInt",
			"Buffer",
			"Bun",
			"Date",
			"Deno",
			"FinalizationRegistry",
			"Function",
			"Map",
			"Math.random",
			"Proxy",
			"Reflect",
			"RegExp",
			"Set",
			"SharedArrayBuffer",
			"WeakMap",
			"WeakRef",
			"WeakSet",
			"WebAssembly",
			"WebSocket",
			"XMLHttpRequest",
			"console",
			"crypto",
			"eval",
			"fetch",
			"module",
			"performance",
			"print",
			"process",
			"require",
		].sort(),
	);
	for (const [name, type] of Object.entries(report.forbidden)) {
		assert.equal(type, "undefined", `${name} remained available as ${type}`);
	}
	assert.deepEqual(report.dynamicConstructors, {
		functionConstructor: "undefined",
		asyncFunctionConstructor: "undefined",
		generatorFunctionConstructor: "undefined",
		asyncGeneratorFunctionConstructor: "undefined",
	});
});

test("reports the exact engine and independently settles concurrent host promises", () => {
	const report = runProof("concurrency");
	assert.deepEqual(report.runtime, {
		package: "quickjs-wasi",
		packageVersion: "3.2.0",
		engine: "quickjs-ng",
		engineVersion: "0.15.1",
	});
	assert.deepEqual(report.result, ["slow", "fast"]);
	assert.deepEqual(report.settlementOrder, ["fast", "slow"]);
	assert.equal(report.maximumActive, 2);
	assert.equal(report.processVisible, false);
	assert.equal(report.requireVisible, false);
});

test("interrupts infinite guest CPU without killing the parent", () => {
	const report = runProof("cpu");
	assert.equal(report.case, "cpu");
	assert.equal(report.outcome, "interrupted");
	assert.equal(report.childExitCode, 0);
	assert.equal(report.childSignal, null);
	assert.ok(report.interruptChecks > 100);
	assert.ok(report.elapsedMs < 2_000, `interrupt took ${report.elapsedMs}ms`);
});

test("contains persistent-object OOM and disposes the child VM cleanly", () => {
	const report = runProof("oom");
	assert.equal(report.case, "oom");
	assert.equal(report.outcome, "out_of_memory");
	assert.equal(report.postOomValue, 2);
	assert.equal(report.childExitCode, 0);
	assert.equal(report.childSignal, null);
	assert.ok(
		report.wasmMemoryBytes < 8 * 1024 * 1024,
		`WASM grew to ${report.wasmMemoryBytes}`,
	);
});

test("rejects malformed bridge values without invoking guest traps", () => {
	const report = runProof("bridge");
	assert.equal(report.case, "bridge");
	assert.equal(report.validResult, "ok");
	assert.deepEqual(report.errors, [
		"frame_must_be_string",
		"frame_must_be_string",
		"frame_is_not_json",
		"frame_too_large",
		"frame_contains_dangerous_key",
	]);
	assert.equal(report.proxyTrapCount, 0);
	assert.equal(report.childExitCode, 0);
	assert.equal(report.childSignal, null);
});

test("contains a WASM runtime abort inside the disposable child", () => {
	const report = runProof("abort");
	assert.equal(report.case, "abort");
	assert.equal(report.outcome, "runtime_abort");
	assert.equal(report.parentAlive, true);
	assert.equal(report.aliveAfterExit, false);
	assert.ok(report.childExitCode !== 0 || report.childSignal !== null);
	assert.ok(report.stderrBytes <= 64 * 1024);
	assert.ok(
		report.elapsedMs < 5_000,
		`runtime abort took ${report.elapsedMs}ms`,
	);
});

test("contains deep recursion inside the disposable child", () => {
	const report = runProof("stack");
	assert.equal(report.case, "stack");
	assert.equal(report.outcome, "stack_overflow");
	assert.equal(report.childExitCode, 0);
	assert.equal(report.childSignal, null);
	assert.ok(report.elapsedMs < 2_000, `stack trap took ${report.elapsedMs}ms`);
});

test("bounds cancellation-child output before termination", () => {
	const report = runProof("cancel-output");
	assert.equal(report.case, "cancel-output");
	assert.equal(report.outcome, "output_limit");
	assert.equal(report.outputTruncated, true);
	assert.ok(report.stdoutBytes <= 64 * 1024);
	assert.ok(report.stderrBytes <= 64 * 1024);
	assert.equal(report.aliveAfterExit, false);
	assert.ok(
		report.cleanupMs < 1_500,
		`output-limit cleanup took ${report.cleanupMs}ms`,
	);
});

test("reaps a child that never reaches cancellation readiness", () => {
	const report = runProof("cancel-timeout");
	assert.equal(report.case, "cancel-timeout");
	assert.equal(report.outcome, "startup_timeout");
	assert.equal(report.ready, false);
	assert.equal(report.aliveAfterExit, false);
	assert.ok(report.terminationAttempts >= 1);
	assert.ok(
		report.cleanupMs < 1_500,
		`startup-timeout cleanup took ${report.cleanupMs}ms`,
	);
});

test("preserves a child exit before cancellation readiness", () => {
	const report = runProof("cancel-exit");
	assert.equal(report.case, "cancel-exit");
	assert.equal(report.outcome, "exited_before_ready");
	assert.equal(report.ready, false);
	assert.equal(report.exitCode, 0);
	assert.equal(report.exitSignal, null);
	assert.equal(report.aliveAfterExit, false);
	assert.ok(
		report.cleanupMs < 1_500,
		`early-exit cleanup took ${report.cleanupMs}ms`,
	);
});

test("terminates an unresolved capability child without leaving an orphan", () => {
	const report = runProof("cancel");
	assert.equal(report.case, "cancel");
	assert.equal(report.outcome, "terminated");
	assert.equal(report.ready, true);
	assert.equal(report.aliveAfterExit, false);
	assert.ok(report.terminationAttempts >= 1);
	assert.ok(
		report.cleanupMs < 1_500,
		`cancellation cleanup took ${report.cleanupMs}ms`,
	);
});

test("repeated OOM children leave parent memory bounded", () => {
	const report = runProof("stress");
	assert.equal(report.case, "stress");
	assert.equal(report.iterations, 16);
	assert.equal(report.completed, 16);
	assert.equal(report.maxWasmMemoryBytes, 4 * 1024 * 1024);
	assert.ok(
		report.parentRssGrowthBytes < 16 * 1024 * 1024,
		`parent RSS grew by ${report.parentRssGrowthBytes}`,
	);
	assert.ok(
		report.elapsedMs < 20_000,
		`stress proof took ${report.elapsedMs}ms`,
	);
});
