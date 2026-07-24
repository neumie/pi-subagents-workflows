import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const repository = new URL("..", import.meta.url);

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		encoding: "utf8",
		...options,
	});
	assert.equal(result.status, 0, result.stderr || result.stdout);
	return result.stdout;
}

test("packed consumer executes delegation V2 through an installed provider artifact", () => {
	const configuredTarball = process.env.PI_SUBAGENTS_TARBALL;
	assert.ok(
		configuredTarball,
		"PI_SUBAGENTS_TARBALL is required; point it at the reviewed pi-subagents .tgz artifact",
	);
	const providerTarball = resolve(configuredTarball);
	const expectedSha = process.env.PI_SUBAGENTS_TARBALL_SHA256;
	if (expectedSha) {
		const actualSha = createHash("sha256")
			.update(readFileSync(providerTarball))
			.digest("hex");
		assert.equal(
			actualSha,
			expectedSha.toLowerCase(),
			"PI_SUBAGENTS_TARBALL_SHA256 does not match PI_SUBAGENTS_TARBALL",
		);
	}

	const temporaryRoot = mkdtempSync(join(tmpdir(), "pi-subagents-workflows-provider-"));
	const fixture = join(temporaryRoot, "fixture");
	try {
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
		run(process.execPath, ["-e", `require("node:fs").mkdirSync(${JSON.stringify(fixture)})`]);
		writeFileSync(
			join(fixture, "package.json"),
			JSON.stringify({ private: true, type: "module" }),
		);
		run(
			npm,
			[
				"install",
				consumerTarball,
				providerTarball,
				"--ignore-scripts",
				"--no-package-lock",
				"--no-audit",
				"--no-fund",
			],
			{ cwd: fixture },
		);

		const runner = join(fixture, "run-adapter.mjs");
		writeFileSync(
			runner,
			String.raw`
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const workflows = await jiti.import("pi-subagents-workflows");
const delegation = await jiti.import("pi-subagents/delegation");
if (typeof workflows.createPiSubagentsLeafAdapter !== "function") throw new Error("missing root adapter factory");
if (delegation.SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION !== 2) throw new Error("installed provider is not V2");
class Bus {
  listeners = new Map();
  on(event, listener) {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, set = new Set());
    set.add(listener);
    return () => set.delete(listener);
  }
  emit(event, payload) {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
    if (event === delegation.SUBAGENT_DELEGATION_REQUEST_EVENT) {
      if (payload.version !== 2 || payload.toolBudget?.hard !== 0) throw new Error("wrong V2 request");
      this.emit(delegation.SUBAGENT_DELEGATION_RESPONSE_EVENT, {
        version: 2,
        requestId: payload.requestId,
        ownerRunId: payload.ownerRunId,
        nodeId: payload.nodeId,
        status: "completed",
        result: { kind: "text", text: "installed-public-artifacts" },
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1, toolCalls: 0, durationMs: 1 }
      });
    }
  }
}
const bus = new Bus();
const adapter = await workflows.createPiSubagentsLeafAdapter({ events: bus, cwd: process.cwd() });
const terminal = await adapter.leafRunner({
  identity: { runId: "artifact-run", nodeId: "artifact-node", stepId: "artifact-step" },
  agent: "reviewer",
  prompt: "literal",
  output: { mode: "text" },
  limits: { timeoutMs: 1000, maxTurns: 1, maxToolCalls: 0 },
  signal: new AbortController().signal,
  progress: async () => undefined
});
if (terminal.status !== "completed" || terminal.result.text !== "installed-public-artifacts") {
  throw new Error("real adapter did not complete over the fake bus");
}
adapter.dispose();
`,
		);
		run(process.execPath, [runner], { cwd: fixture });
	} finally {
		rmSync(temporaryRoot, { recursive: true, force: true });
	}
});
