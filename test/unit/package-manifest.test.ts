import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";

import { PACKAGE_VERSION } from "../../src/version.ts";

const repositoryUrl = "https://github.com/neumie/pi-subagents-workflows";
const manifestPath = new URL("../../package.json", import.meta.url);

interface PackageManifest {
	name?: string;
	version?: string;
	description?: string;
	license?: string;
	type?: string;
	engines?: Record<string, string>;
	keywords?: string[];
	repository?: { type?: string; url?: string };
	homepage?: string;
	bugs?: { url?: string };
	files?: string[];
	exports?: Record<string, string>;
	scripts?: Record<string, string>;
	pi?: { extensions?: string[] };
	dependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	peerDependenciesMeta?: Record<string, { optional?: boolean }>;
	devDependencies?: Record<string, string>;
	bundledDependencies?: string[];
	bin?: unknown;
}

function loadManifest(): PackageManifest {
	return JSON.parse(readFileSync(manifestPath, "utf8")) as PackageManifest;
}

function spawnNpm(
	args: readonly string[],
	options: { readonly cwd: string | URL; readonly encoding: "utf8" },
) {
	const npmCli = process.env.npm_execpath;
	return npmCli === undefined
		? spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", args, options)
		: spawnSync(process.execPath, [npmCli, ...args], options);
}

test("package manifest establishes the pi-subagents-workflows identity", () => {
	const manifest = loadManifest();

	assert.equal(manifest.name, "pi-subagents-workflows");
	assert.equal(manifest.version, "0.1.0");
	assert.equal(manifest.version, PACKAGE_VERSION);
	assert.equal(
		manifest.description,
		"Strict JSON workflow orchestration for pi-subagents and the Pi coding agent",
	);
	assert.equal(manifest.license, "MIT");
	assert.equal(manifest.type, "module");
	assert.deepEqual(manifest.engines, { node: ">=24" });
	assert.deepEqual(manifest.keywords, [
		"pi-package",
		"pi",
		"pi-coding-agent",
		"pi-subagents",
		"workflows",
		"ai",
		"agents",
	]);
	assert.deepEqual(manifest.repository, {
		type: "git",
		url: `git+${repositoryUrl}.git`,
	});
	assert.equal(manifest.homepage, repositoryUrl);
	assert.deepEqual(manifest.bugs, { url: `${repositoryUrl}/issues` });
	assert.doesNotMatch(
		JSON.stringify(manifest),
		/(?:^|[^-])pi-workflows(?:[^-]|$)/,
	);
});

test("package exposes only stable barrels and one scaffold Pi extension", () => {
	const manifest = loadManifest();

	assert.deepEqual(manifest.exports, {
		".": "./src/index.ts",
		"./ir": "./src/ir/index.ts",
		"./engine": "./src/engine/index.ts",
	});
	assert.deepEqual(manifest.pi, {
		extensions: ["./src/extension/index.ts"],
	});
	assert.deepEqual(manifest.files, [
		"src",
		"README.md",
		"PLAN.md",
		"CHANGELOG.md",
		"LICENSE",
	]);

	for (const path of [
		...Object.values(manifest.exports ?? {}),
		...(manifest.pi?.extensions ?? []),
		...(manifest.files ?? []),
	]) {
		assert.ok(
			existsSync(
				new URL(`../../${path.replace(/^\.\//, "")}`, import.meta.url),
			),
			`declared package path does not exist: ${path}`,
		);
	}
});

test("supported host and provider ranges stay explicit", () => {
	const manifest = loadManifest();
	const hostPackage = "@earendil-works/pi-coding-agent";

	assert.deepEqual(manifest.dependencies, {
		jiti: "2.7.0",
		"pi-subagents": ">=0.36.0 <0.38.0",
		typebox: "1.1.38",
	});
	assert.deepEqual(manifest.optionalDependencies, undefined);
	assert.deepEqual(manifest.peerDependencies, {
		[hostPackage]: ">=0.81.0 <0.83.0",
	});
	assert.deepEqual(manifest.peerDependenciesMeta, {
		[hostPackage]: { optional: true },
	});
	assert.deepEqual(manifest.devDependencies, {
		[hostPackage]: "0.82.1",
		"@types/node": "24.13.3",
		typescript: "5.9.3",
	});
	assert.equal(manifest.bin, undefined);
	assert.deepEqual(manifest.bundledDependencies, undefined);

	const dependencySections = [
		manifest.dependencies,
		manifest.optionalDependencies,
		manifest.peerDependencies,
		manifest.devDependencies,
	];
	for (const dependencies of dependencySections) {
		for (const [name, specifier] of Object.entries(dependencies ?? {})) {
			assert.doesNotMatch(
				specifier,
				/^(?:file|link|git|git\+|github:)|(?:^|[\\/])\.\.?(?:[\\/]|$)|^[~/]/i,
				`prohibited dependency specifier for ${name}: ${specifier}`,
			);
		}
	}

	assert.deepEqual(manifest.scripts, {
		"test:unit": "node --experimental-strip-types --test test/unit/*.test.ts",
		"test:provider-artifact": "node --test test/provider-artifact.test.mjs",
		"test:provider-extension-e2e":
			"node --test test/provider-extension-e2e.test.mjs",
		typecheck: "tsc --noEmit",
		test: "npm run test:unit && npm run typecheck",
		"pack:check": "npm pack --dry-run --ignore-scripts",
	});
	assert.equal("install" in manifest.scripts, false);
	assert.equal("preinstall" in manifest.scripts, false);
	assert.equal("postinstall" in manifest.scripts, false);
});

test("dry-run tarball contains only declared source and documentation", () => {
	const result = spawnNpm(["pack", "--dry-run", "--json", "--ignore-scripts"], {
		cwd: new URL("../..", import.meta.url),
		encoding: "utf8",
	});

	assert.equal(result.status, 0, result.stderr || result.stdout);
	const reports = JSON.parse(result.stdout) as Array<{
		files: Array<{ path: string }>;
	}>;
	assert.equal(reports.length, 1);

	const packedFiles = reports[0]?.files.map(({ path }) => path).sort();
	assert.ok(packedFiles);
	assert.deepEqual(packedFiles, [
		"CHANGELOG.md",
		"LICENSE",
		"PLAN.md",
		"README.md",
		"package.json",
		"src/adapters/pi-subagents-core.ts",
		"src/adapters/pi-subagents-errors.ts",
		"src/adapters/pi-subagents.ts",
		"src/engine/execute-workflow.ts",
		"src/engine/index.ts",
		"src/engine/types.ts",
		"src/extension/audit-codec.ts",
		"src/extension/foreground-run.ts",
		"src/extension/index.ts",
		"src/extension/pi-usage.ts",
		"src/extension/render.ts",
		"src/extension/run-store.ts",
		"src/extension/safe-filesystem.ts",
		"src/extension/strict-json.ts",
		"src/extension/workflow-command.ts",
		"src/extension/workflow-source.ts",
		"src/index.ts",
		"src/ir/index.ts",
		"src/ir/json.ts",
		"src/ir/parser.ts",
		"src/ir/types.ts",
		"src/version.ts",
	]);
	assert.equal(
		packedFiles.some((path) => /workflow.*\.js$/i.test(path)),
		false,
	);
});

test("packed package imports every public entry through Jiti from a clean install", () => {
	const temporaryDirectory = mkdtempSync(
		join(tmpdir(), "pi-subagents-workflows-pack-"),
	);
	try {
		const packed = spawnNpm(
			[
				"pack",
				"--json",
				"--ignore-scripts",
				"--pack-destination",
				temporaryDirectory,
			],
			{ cwd: new URL("../..", import.meta.url), encoding: "utf8" },
		);
		assert.equal(packed.status, 0, packed.stderr || packed.stdout);
		const reports = JSON.parse(packed.stdout) as Array<{ filename: string }>;
		const tarball = join(
			temporaryDirectory,
			reports[0]?.filename ?? "missing.tgz",
		);
		const providerPacked = spawnNpm(
			[
				"pack",
				"--json",
				"--ignore-scripts",
				"--pack-destination",
				temporaryDirectory,
			],
			{
				cwd: new URL("../../node_modules/pi-subagents/", import.meta.url),
				encoding: "utf8",
			},
		);
		assert.equal(
			providerPacked.status,
			0,
			providerPacked.stderr || providerPacked.stdout,
		);
		const providerReports = JSON.parse(providerPacked.stdout) as Array<{
			filename: string;
		}>;
		const providerTarball = join(
			temporaryDirectory,
			providerReports[0]?.filename ?? "missing-provider.tgz",
		);

		writeFileSync(
			join(temporaryDirectory, "package.json"),
			JSON.stringify({
				private: true,
				type: "module",
				dependencies: {
					jiti: "2.7.0",
					"pi-subagents": `file:./${basename(providerTarball)}`,
					"pi-subagents-workflows": `file:./${basename(tarball)}`,
				},
			}),
		);
		const installed = spawnNpm(
			["install", "--ignore-scripts", "--no-audit", "--no-fund"],
			{ cwd: temporaryDirectory, encoding: "utf8" },
		);
		assert.equal(installed.status, 0, installed.stderr || installed.stdout);

		const runner = join(temporaryDirectory, "import-packed.mjs");
		writeFileSync(
			runner,
			`
      import { createJiti } from "jiti";
      const jiti = createJiti(import.meta.url);
      const root = await jiti.import("pi-subagents-workflows");
      const ir = await jiti.import("pi-subagents-workflows/ir");
      const engine = await jiti.import("pi-subagents-workflows/engine");
      if (typeof root.parseWorkflowDefinition !== "function") throw new Error("missing root parser");
      if (typeof root.executeWorkflow !== "function") throw new Error("missing root engine");
      if (typeof ir.parseWorkflowDefinition !== "function") throw new Error("missing IR parser");
      if (typeof engine.executeWorkflow !== "function") throw new Error("missing engine export");
      const parsed = root.parseWorkflowDefinition({
        version: 1,
        id: "packed",
        args: {},
        limits: { concurrency: 1, maxCalls: 1, maxItems: 1 },
        steps: [{
          type: "agent",
          id: "only",
          agent: "reviewer",
          prompt: { template: "Literal", values: {} },
          output: { mode: "text" },
          limits: { timeoutMs: 1000, maxTurns: 1, maxToolCalls: 0 }
        }],
        result: { ref: "step", stepId: "only" }
      });
      if (parsed.id !== "packed") throw new Error("packed parser returned the wrong definition");
      const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, toolCalls: 0, durationMs: 1 };
      const outcome = await engine.executeWorkflow(parsed, {}, async () => ({
        status: "completed",
        result: { mode: "text", text: "packed" },
        usage
      }), {});
      if (outcome.status !== "succeeded") throw new Error("packed engine did not execute");
    `,
		);
		const imported = spawnSync(process.execPath, [runner], {
			cwd: temporaryDirectory,
			encoding: "utf8",
		});
		assert.equal(imported.status, 0, imported.stderr || imported.stdout);
	} finally {
		rmSync(temporaryDirectory, { recursive: true, force: true });
	}
});
