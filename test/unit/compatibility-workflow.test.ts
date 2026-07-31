import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function source(path: string): string {
	return readFileSync(
		new URL(`../../${path}`, import.meta.url),
		"utf8",
	).replace(/\r\n?/g, "\n");
}

const ci = source(".github/workflows/ci.yml");
const release = source(".github/workflows/release.yml");
const providerE2e = source("test/provider-extension-e2e.test.mjs");

const hostMatrix = 'pi-version: ["0.81.0", "0.82.1", "0.83.0"]';
const operatingSystemMatrix = "os: [ubuntu-latest, windows-latest]";

function assertProviderMatrix(workflow: string): void {
	assert.match(workflow, /provider:\n\s+- version: "0\.36\.0"/u);
	assert.match(workflow, /provider:\n[\s\S]*?- version: "0\.37\.0"/u);
	assert.match(
		workflow,
		/PI_SUBAGENTS_VERSION: \$\{\{ matrix\.provider\.version \}\}/u,
	);
	assert.match(
		workflow,
		/PI_SUBAGENTS_TARBALL_SHA256: \$\{\{ matrix\.provider\.sha256 \}\}/u,
	);
}

test("CI runs feature branches through pull requests and pushes only main", () => {
	assert.match(
		ci,
		/on:\n {2}push:\n {4}branches: \[main\]\n {2}pull_request:\n\npermissions:/u,
	);
});

test("CI covers every supported Pi host and provider on Ubuntu and Windows", () => {
	assert.ok(ci.includes(operatingSystemMatrix));
	assert.ok(ci.includes(hostMatrix));
	assertProviderMatrix(ci);
	assert.match(ci, /PI_CODING_AGENT_VERSION: \$\{\{ matrix\.pi-version \}\}/u);
});

test("release provider gates preserve the complete compatibility matrix", () => {
	assert.ok(release.includes(operatingSystemMatrix));
	assert.ok(release.includes(hostMatrix));
	assertProviderMatrix(release);
	assert.match(
		release,
		/PI_CODING_AGENT_VERSION: \$\{\{ matrix\.pi-version \}\}/u,
	);
});

test("packed real-session fixtures require an explicit supported Pi host", () => {
	assert.match(providerE2e, /process\.env\.PI_CODING_AGENT_VERSION/u);
	assert.match(
		providerE2e,
		/new Set\(\["0\.81\.0", "0\.82\.1", "0\.83\.0"\]\)/u,
	);
	assert.match(providerE2e, /"@earendil-works\/pi-ai": piCodingAgentVersion/u);
	assert.match(
		providerE2e,
		/"@earendil-works\/pi-coding-agent": piCodingAgentVersion/u,
	);
});
