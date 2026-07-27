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
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const repository = fileURLToPath(new URL("..", import.meta.url));

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

function manifestExtension(fixture, packageName) {
	const packageRoot = realpathSync(join(fixture, "node_modules", packageName));
	const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
	assert.ok(
		Array.isArray(manifest.pi?.extensions) && manifest.pi.extensions.length === 1,
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
			run(
				npm,
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
		writeFileSync(
			join(fixture, "package.json"),
			JSON.stringify({
				private: true,
				type: "module",
				dependencies: {
					"@earendil-works/pi-ai": "0.81.0",
					"@earendil-works/pi-coding-agent": "0.81.0",
					"pi-subagents": pathToFileURL(providerTarball).href,
					"pi-subagents-workflows": pathToFileURL(consumerTarball).href,
				},
			}),
		);
		run(
			npm,
			[
				"install",
				"--ignore-scripts",
				"--no-package-lock",
				"--no-audit",
				"--no-fund",
			],
			{ cwd: fixture },
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
