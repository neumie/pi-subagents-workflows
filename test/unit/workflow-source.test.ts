import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import {
	listSavedWorkflowDefinitions,
	MAX_WORKFLOW_SOURCE_BYTES,
	resolveWorkflowDefinition,
} from "../../src/extension/workflow-source.ts";

function definition(id = "sourceTest"): Record<string, unknown> {
	return {
		version: 1,
		id,
		args: {},
		limits: { concurrency: 1, maxCalls: 1, maxItems: 1 },
		steps: [
			{
				type: "agent",
				id: "only",
				agent: "reviewer",
				prompt: { template: "Literal", values: {} },
				output: { mode: "text" },
				limits: { timeoutMs: 1_000, maxTurns: 1, maxToolCalls: 0 },
			},
		],
		result: { ref: "step", stepId: "only" },
	};
}

async function fixture(): Promise<{
	root: string;
	cwd: string;
	agentDir: string;
}> {
	const root = await mkdtemp(
		join(await realpath(tmpdir()), "workflow-source-"),
	);
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	await Promise.all([mkdir(cwd), mkdir(agentDir)]);
	return { root, cwd, agentDir };
}

async function writeDefinition(
	path: string,
	value = definition(),
): Promise<string> {
	await mkdir(dirname(path), { recursive: true });
	const text = JSON.stringify(value, null, 2);
	await writeFile(path, text);
	return text;
}

async function rejects(
	source: unknown,
	options: { cwd: string; agentDir: string; allowPath: boolean },
	pattern: RegExp,
): Promise<void> {
	await assert.rejects(resolveWorkflowDefinition(source, options), pattern);
}

test("inline resolution canonicalizes, hashes, freezes, and isolates input mutation", async (t) => {
	const paths = await fixture();
	t.after(() => rm(paths.root, { recursive: true, force: true }));
	const input = definition();
	const resolved = await resolveWorkflowDefinition(
		{ kind: "inline", definition: input },
		{ ...paths, allowPath: false },
	);

	const expectedText =
		'{"args":{},"id":"sourceTest","limits":{"concurrency":1,"maxCalls":1,"maxItems":1},"result":{"ref":"step","stepId":"only"},"steps":[{"agent":"reviewer","id":"only","limits":{"maxToolCalls":0,"maxTurns":1,"timeoutMs":1000},"output":{"mode":"text"},"prompt":{"template":"Literal","values":{}},"type":"agent"}],"version":1}';
	assert.equal(resolved.sourceKind, "inline");
	assert.equal(resolved.displaySource, "inline workflow definition");
	assert.equal(resolved.canonicalPath, undefined);
	assert.equal(resolved.sourceText, expectedText);
	assert.equal(resolved.sourceByteLength, Buffer.byteLength(expectedText));
	assert.equal(
		resolved.sha256,
		createHash("sha256").update(expectedText).digest("hex"),
	);
	assert.ok(Object.isFrozen(resolved));
	assert.ok(Object.isFrozen(resolved.definition));

	input.id = "mutated";
	(
		(input.steps as Record<string, unknown>[])[0] as Record<string, unknown>
	).id = "changed";
	assert.equal(resolved.definition.id, "sourceTest");
	assert.equal(resolved.sourceText, expectedText);
});

test("inline resolution rejects hostile accessors and proxies without invoking them", async (t) => {
	const paths = await fixture();
	t.after(() => rm(paths.root, { recursive: true, force: true }));
	let getterCalls = 0;
	const hostile = definition();
	Object.defineProperty(hostile, "secret", {
		enumerable: true,
		get() {
			getterCalls += 1;
			return "leak";
		},
	});
	await rejects(
		{ kind: "inline", definition: hostile },
		{ ...paths, allowPath: false },
		/data properties|safely inspected/,
	);
	assert.equal(getterCalls, 0);

	const proxy = new Proxy(definition(), {
		ownKeys() {
			throw new Error("secret");
		},
	});
	await rejects(
		{ kind: "inline", definition: proxy },
		{ ...paths, allowPath: false },
		/proxy values are not allowed|safely inspected/,
	);
});

test("saved definitions resolve only exact user or project roots and reject collisions", async (t) => {
	const paths = await fixture();
	t.after(() => rm(paths.root, { recursive: true, force: true }));
	const user = join(
		paths.agentDir,
		"pi-subagents-workflows",
		"definitions",
		"review.workflow.json",
	);
	const project = join(paths.cwd, ".pi", "workflows", "project.workflow.json");
	const userText = await writeDefinition(user, definition("userFlow"));
	await writeDefinition(project, definition("projectFlow"));

	const userResolved = await resolveWorkflowDefinition(
		{ kind: "saved", name: "review" },
		{ ...paths, allowPath: false },
	);
	assert.equal(userResolved.sourceKind, "saved-user");
	assert.equal(userResolved.displaySource, "saved user workflow: review");
	assert.equal(userResolved.sourceText, userText);
	assert.equal(
		userResolved.canonicalPath,
		await import("node:fs/promises").then(({ realpath }) => realpath(user)),
	);

	const projectResolved = await resolveWorkflowDefinition(
		{ kind: "saved", name: "project" },
		{ ...paths, allowPath: false },
	);
	assert.equal(projectResolved.sourceKind, "saved-project");

	await writeDefinition(
		join(paths.cwd, ".pi", "workflows", "review.workflow.json"),
	);
	await rejects(
		{ kind: "saved", name: "review" },
		{ ...paths, allowPath: false },
		/ambiguous.*saved workflow.*review/i,
	);
});

test("saved resolution rechecks ambiguity after reading the selected file", async (t) => {
	const paths = await fixture();
	t.after(() => rm(paths.root, { recursive: true, force: true }));
	await writeDefinition(
		join(
			paths.agentDir,
			"pi-subagents-workflows",
			"definitions",
			"raced.workflow.json",
		),
	);
	await assert.rejects(
		resolveWorkflowDefinition(
			{ kind: "saved", name: "raced" },
			{
				...paths,
				allowPath: false,
				testHooks: {
					afterRead: async () => {
						await writeDefinition(
							join(paths.cwd, ".pi", "workflows", "raced.workflow.json"),
						);
					},
				},
			},
		),
		/ambiguous/i,
	);
});

test("saved name grammar makes traversal, separators, dot components, uppercase, and overflow impossible", async (t) => {
	const paths = await fixture();
	t.after(() => rm(paths.root, { recursive: true, force: true }));
	for (const name of [
		"",
		".",
		"..",
		"../escape",
		"a/b",
		"a\\b",
		"UPPER",
		"-start",
		`a${"b".repeat(128)}`,
	]) {
		await rejects(
			{ kind: "saved", name },
			{ ...paths, allowPath: false },
			/saved workflow name/i,
		);
	}
	await rejects(
		{ kind: "saved", name: "missing" },
		{ ...paths, allowPath: false },
		/not found/i,
	);
});

test("explicit paths require the path capability and resolve relative to cwd", async (t) => {
	const paths = await fixture();
	t.after(() => rm(paths.root, { recursive: true, force: true }));
	const path = join(paths.cwd, "definitions", "explicit.workflow.json");
	const text = await writeDefinition(path);

	await rejects(
		{ kind: "path", path: "definitions/explicit.workflow.json" },
		{ ...paths, allowPath: false },
		/path sources are not allowed/i,
	);
	const resolved = await resolveWorkflowDefinition(
		{ kind: "path", path: "definitions/explicit.workflow.json" },
		{ ...paths, allowPath: true },
	);
	assert.equal(resolved.sourceKind, "path");
	assert.equal(resolved.sourceText, text);
	assert.equal(resolved.canonicalPath, path);
	assert.match(resolved.displaySource, /explicit\.workflow\.json$/);
});

test("file resolution preserves exact accepted bytes and rejects malformed encoding or content", async (t) => {
	const paths = await fixture();
	t.after(() => rm(paths.root, { recursive: true, force: true }));
	const exactPath = join(paths.cwd, "exact.workflow.json");
	const exact = `${JSON.stringify(definition())}\n`;
	await writeFile(exactPath, exact);
	const resolved = await resolveWorkflowDefinition(
		{ kind: "path", path: exactPath },
		{ ...paths, allowPath: true },
	);
	assert.equal(resolved.sourceText, exact);
	assert.equal(resolved.sourceByteLength, Buffer.byteLength(exact));
	assert.equal(
		resolved.sha256,
		createHash("sha256").update(Buffer.from(exact)).digest("hex"),
	);

	const malformed = join(paths.cwd, "malformed.workflow.json");
	await writeFile(malformed, "{not-json");
	await rejects(
		{ kind: "path", path: malformed },
		{ ...paths, allowPath: true },
		/JSON|object key/i,
	);

	const bom = join(paths.cwd, "bom.workflow.json");
	await writeFile(
		bom,
		Buffer.concat([
			Buffer.from([0xef, 0xbb, 0xbf]),
			Buffer.from(JSON.stringify(definition())),
		]),
	);
	await rejects(
		{ kind: "path", path: bom },
		{ ...paths, allowPath: true },
		/BOM/i,
	);

	const invalid = join(paths.cwd, "invalid.workflow.json");
	await writeFile(invalid, Buffer.from([0xc3, 0x28]));
	await rejects(
		{ kind: "path", path: invalid },
		{ ...paths, allowPath: true },
		/UTF-8/i,
	);
});

test("file resolution rejects oversized, unsafe-path, wrong-extension, and nonregular inputs", async (t) => {
	const paths = await fixture();
	t.after(() => rm(paths.root, { recursive: true, force: true }));
	const oversized = join(paths.cwd, "oversized.workflow.json");
	await writeFile(oversized, Buffer.alloc(MAX_WORKFLOW_SOURCE_BYTES + 1, 0x20));
	await rejects(
		{ kind: "path", path: oversized },
		{ ...paths, allowPath: true },
		/1 MiB/i,
	);
	await rejects(
		{ kind: "path", path: "bad\u0000.workflow.json" },
		{ ...paths, allowPath: true },
		/path text/i,
	);
	await rejects(
		{ kind: "path", path: "bad\u202e.workflow.json" },
		{ ...paths, allowPath: true },
		/path text/i,
	);
	await rejects(
		{ kind: "path", path: `${"a".repeat(4097)}.workflow.json` },
		{ ...paths, allowPath: true },
		/path text/i,
	);
	await rejects(
		{ kind: "path", path: "workflow.json" },
		{ ...paths, allowPath: true },
		/\.workflow\.json/i,
	);

	const directory = join(paths.cwd, "directory.workflow.json");
	await mkdir(directory);
	await rejects(
		{ kind: "path", path: directory },
		{ ...paths, allowPath: true },
		/regular file/i,
	);

	if (process.platform !== "win32") {
		const fifo = join(paths.cwd, "pipe.workflow.json");
		const created = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
		assert.equal(created.status, 0, created.stderr);
		await rejects(
			{ kind: "path", path: fifo },
			{ ...paths, allowPath: true },
			/regular file/i,
		);
	}
});

test("file resolution rejects symlinked path components and final links", async (t) => {
	const paths = await fixture();
	t.after(() => rm(paths.root, { recursive: true, force: true }));
	const realDirectory = join(paths.cwd, "real");
	const target = join(realDirectory, "target.workflow.json");
	await writeDefinition(target);
	await symlink(
		realDirectory,
		join(paths.cwd, "linked-directory"),
		process.platform === "win32" ? "junction" : "dir",
	);
	await symlink(target, join(paths.cwd, "linked.workflow.json"), "file");

	await rejects(
		{
			kind: "path",
			path: join(paths.cwd, "linked-directory", "target.workflow.json"),
		},
		{ ...paths, allowPath: true },
		/symbolic link|reparse/i,
	);
	await rejects(
		{ kind: "path", path: join(paths.cwd, "linked.workflow.json") },
		{ ...paths, allowPath: true },
		/symbolic link|reparse|too many symbolic links/i,
	);
	assert.equal((await lstat(target)).isFile(), true);
});

test("deterministic race seams fail closed on content change and path replacement", async (t) => {
	const paths = await fixture();
	t.after(() => rm(paths.root, { recursive: true, force: true }));
	const changed = join(paths.cwd, "changed.workflow.json");
	await writeDefinition(changed);
	await assert.rejects(
		resolveWorkflowDefinition(
			{ kind: "path", path: changed },
			{
				...paths,
				allowPath: true,
				testHooks: {
					afterOpen: async () =>
						writeFile(changed, JSON.stringify(definition("changedFlow"))),
				},
			},
		),
		/changed|replaced|truncated|grew/i,
	);

	const replaced = join(paths.cwd, "replaced.workflow.json");
	const replacement = join(paths.cwd, "replacement.workflow.json");
	await writeDefinition(replaced);
	await writeDefinition(replacement, definition("replacementFlow"));
	await assert.rejects(
		resolveWorkflowDefinition(
			{ kind: "path", path: replaced },
			{
				...paths,
				allowPath: true,
				testHooks: {
					afterRead: async () => {
						await rm(replaced);
						await import("node:fs/promises").then(({ rename }) =>
							rename(replacement, replaced),
						);
					},
				},
			},
		),
		/changed|replaced|identity/i,
	);
});

test("strict file JSON rejects duplicate keys including escaped aliases", async (t) => {
	const paths = await fixture();
	t.after(() => rm(paths.root, { recursive: true, force: true }));
	for (const [name, text] of [
		["duplicate", '{"version":1,"id":"first","id":"second"}'],
		["escaped", '{"version":1,"id":"first","\\u0069d":"second"}'],
	] as const) {
		const path = join(paths.cwd, `${name}.workflow.json`);
		await writeFile(path, text);
		await rejects(
			{ kind: "path", path },
			{ ...paths, allowPath: true },
			/duplicate object key/i,
		);
	}
});

test("saved definition listing is nonrecursive, provenance-aware, sorted, and immutable", async (t) => {
	const paths = await fixture();
	t.after(() => rm(paths.root, { recursive: true, force: true }));
	await writeDefinition(
		join(
			paths.agentDir,
			"pi-subagents-workflows",
			"definitions",
			"both.workflow.json",
		),
	);
	await writeDefinition(
		join(paths.cwd, ".pi", "workflows", "both.workflow.json"),
	);
	await writeDefinition(
		join(paths.cwd, ".pi", "workflows", "project.workflow.json"),
	);
	await writeDefinition(
		join(paths.cwd, ".pi", "workflows", "nested", "ignored.workflow.json"),
	);
	await writeFile(join(paths.cwd, ".pi", "workflows", "notes.txt"), "ignored");

	const listed = await listSavedWorkflowDefinitions(paths);
	assert.deepEqual(listed, [
		{ name: "both", user: true, project: true, ambiguous: true },
		{ name: "project", user: false, project: true, ambiguous: false },
	]);
	assert.ok(Object.isFrozen(listed));
	assert.ok(listed.every(Object.isFrozen));
});

test("source selector itself is strict safe JSON", async (t) => {
	const paths = await fixture();
	t.after(() => rm(paths.root, { recursive: true, force: true }));
	await rejects(
		{ kind: "saved", name: "x", extra: true },
		{ ...paths, allowPath: false },
		/unknown source field/i,
	);
	await assert.rejects(
		resolveWorkflowDefinition(
			{ kind: "path", path: "x.workflow.json" },
			{ ...paths, allowPath: "yes" as unknown as boolean },
		),
		/allowPath.*boolean/i,
	);
	const source = { kind: "saved" };
	Object.defineProperty(source, "name", {
		enumerable: true,
		get() {
			throw new Error("secret");
		},
	});
	await rejects(
		source,
		{ ...paths, allowPath: false },
		/data properties|safely inspected/,
	);
	await assert.rejects(
		readFile(join(paths.root, "definitely-missing")),
		/ENOENT/,
	);
});
