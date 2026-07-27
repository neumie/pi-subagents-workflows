import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(
	new URL("../../.github/workflows/release.yml", import.meta.url),
	"utf8",
).replace(/\r\n?/g, "\n");

function occurrences(value: string): number {
	return workflow.split(value).length - 1;
}

test("release jobs use one immutable default-branch commit", () => {
	assert.equal(
		occurrences("ref: ${{ github.event.release.tag_name }}"),
		0,
		"release jobs must not independently resolve a mutable tag",
	);
	assert.equal(
		occurrences("ref: ${{ github.sha }}"),
		3,
		"source verification, provider gates, and publish must use the event SHA",
	);
	assert.match(workflow, /release-source:\n[\s\S]*?fetch-depth: 0/);
	assert.match(workflow, /release-source:\n[\s\S]*?fetch-tags: true/);
	assert.match(
		workflow,
		/git rev-parse "refs\/tags\/\$\{RELEASE_TAG\}\^\{commit\}"/,
	);
	assert.match(workflow, /git rev-parse HEAD/);
	assert.match(workflow, /git merge-base --is-ancestor/);
	assert.match(workflow, /github\.event\.repository\.default_branch/);
	assert.match(workflow, /provider-artifact:\n[\s\S]*?needs: release-source/);
	assert.match(
		workflow,
		/publish:\n[\s\S]*?needs: \[release-source, provider-artifact\]/,
	);
});

test("only the protected publish job receives the bootstrap credential", () => {
	assert.match(workflow, /publish:\n[\s\S]*?environment: npm-publish/);
	assert.match(workflow, /publish:\n[\s\S]*?id-token: write/);
	assert.equal(occurrences("secrets.NPM_TOKEN"), 1);
	assert.match(
		workflow,
		/npm publish --ignore-scripts --provenance --access public\n\s+env:\n\s+NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/,
	);
});
