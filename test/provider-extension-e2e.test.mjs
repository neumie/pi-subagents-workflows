import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repository = fileURLToPath(new URL("..", import.meta.url));
const supportedPiVersions = new Set(["0.81.0", "0.82.1"]);

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		encoding: "utf8",
		timeout: 120_000,
		...options,
	});
	assert.equal(
		result.status,
		0,
		result.error?.stack || result.stderr || result.stdout,
	);
	return result.stdout;
}

function runNpm(args, options = {}) {
	const npmCli = process.env.npm_execpath;
	return npmCli === undefined
		? run(process.platform === "win32" ? "npm.cmd" : "npm", args, options)
		: run(process.execPath, [npmCli, ...args], options);
}

function manifestExtension(fixture, packageName) {
	const packageRoot = realpathSync(join(fixture, "node_modules", packageName));
	const manifest = JSON.parse(
		readFileSync(join(packageRoot, "package.json"), "utf8"),
	);
	assert.ok(
		Array.isArray(manifest.pi?.extensions) &&
			manifest.pi.extensions.length === 1,
		`${packageName} must publish exactly one Pi extension for this E2E`,
	);
	const declared = manifest.pi.extensions[0];
	assert.equal(typeof declared, "string");
	const extension = resolve(packageRoot, declared);
	const locator = relative(packageRoot, extension);
	assert.equal(
		locator.startsWith("..") || isAbsolute(locator),
		false,
		`${packageName} extension escapes its installed package`,
	);
	return extension;
}

test("packed extension executes through the real published provider in a real Pi session", () => {
	const piCodingAgentVersion = process.env.PI_CODING_AGENT_VERSION;
	assert.ok(
		piCodingAgentVersion,
		"PI_CODING_AGENT_VERSION is required; use a supported exact Pi version",
	);
	assert.ok(
		supportedPiVersions.has(piCodingAgentVersion),
		`unsupported PI_CODING_AGENT_VERSION: ${piCodingAgentVersion}`,
	);
	const configuredTarball = process.env.PI_SUBAGENTS_TARBALL;
	assert.ok(
		configuredTarball,
		"PI_SUBAGENTS_TARBALL is required; point it at a reviewed pi-subagents tarball",
	);
	const providerTarball = resolve(configuredTarball);
	const expectedSha = process.env.PI_SUBAGENTS_TARBALL_SHA256;
	if (expectedSha) {
		const actualSha = createHash("sha256")
			.update(readFileSync(providerTarball))
			.digest("hex");
		assert.equal(actualSha, expectedSha.toLowerCase());
	}

	const temporaryRoot = mkdtempSync(
		join(realpathSync(tmpdir()), "workflow-provider-e2e-"),
	);
	const fixture = join(temporaryRoot, "fixture");
	try {
		mkdirSync(fixture);
		const packedReport = JSON.parse(
			runNpm(
				[
					"pack",
					"--json",
					"--ignore-scripts",
					"--pack-destination",
					temporaryRoot,
				],
				{ cwd: repository },
			),
		);
		const consumerTarball = join(
			temporaryRoot,
			packedReport[0]?.filename ?? "missing-consumer.tgz",
		);
		const localConsumerTarball = join(fixture, basename(consumerTarball));
		const localProviderTarball = join(fixture, basename(providerTarball));
		copyFileSync(consumerTarball, localConsumerTarball);
		copyFileSync(providerTarball, localProviderTarball);
		writeFileSync(
			join(fixture, "package.json"),
			JSON.stringify({
				private: true,
				type: "module",
				dependencies: {
					"@earendil-works/pi-ai": piCodingAgentVersion,
					"@earendil-works/pi-coding-agent": piCodingAgentVersion,
					"pi-subagents": `file:./${basename(localProviderTarball)}`,
					"pi-subagents-workflows": `file:./${basename(localConsumerTarball)}`,
				},
			}),
		);
		runNpm(
			[
				"install",
				"--ignore-scripts",
				"--no-package-lock",
				"--prefer-offline",
				"--no-audit",
				"--no-fund",
			],
			{ cwd: fixture, timeout: 600_000 },
		);

		const runner = join(fixture, "workflow-provider-runner.mjs");
		const child = join(fixture, "workflow-provider-child.mjs");
		copyFileSync(
			join(repository, "test", "support", "workflow-provider-runner.mjs"),
			runner,
		);
		copyFileSync(
			join(repository, "test", "support", "workflow-provider-child.mjs"),
			child,
		);
		const workRoot = join(temporaryRoot, "run");
		mkdirSync(workRoot);
		const stdout = run(process.execPath, [runner], {
			cwd: fixture,
			env: {
				...process.env,
				PI_WORKFLOWS_E2E_ROOT: workRoot,
				PI_WORKFLOWS_E2E_CONSUMER_EXTENSION: manifestExtension(
					fixture,
					"pi-subagents-workflows",
				),
				PI_WORKFLOWS_E2E_PROVIDER_EXTENSION: manifestExtension(
					fixture,
					"pi-subagents",
				),
				PI_WORKFLOWS_E2E_CHILD_SOURCE: child,
			},
		});
		const reportLine = stdout
			.trim()
			.split(/\r?\n/u)
			.findLast((line) => line.startsWith('{"status":"ok"'));
		assert.ok(reportLine, stdout);
		const report = JSON.parse(reportLine);
		assert.equal(report.status, "ok");
		assert.equal(report.marker, "PACKED_REAL_PROVIDER_WORKFLOW_OK");
		assert.ok(report.modelCalls >= 2);
	} finally {
		rmSync(temporaryRoot, { recursive: true, force: true });
	}
});
