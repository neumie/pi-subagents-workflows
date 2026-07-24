import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	realpath,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { executeWorkflow } from "../../src/engine/index.ts";
import type {
	WorkflowEventV1,
	WorkflowOutcomeV1,
} from "../../src/engine/index.ts";
import {
	createWorkflowRunStore,
	inspectWorkflowRun,
	listWorkflowRuns,
} from "../../src/extension/run-store.ts";
import { resolveWorkflowDefinition } from "../../src/extension/workflow-source.ts";
import { PACKAGE_VERSION } from "../../src/version.ts";

function definition(): Record<string, unknown> {
	return {
		version: 1,
		id: "storeTest",
		args: { label: { type: "string", minLength: 1, maxLength: 20 } },
		limits: { concurrency: 1, maxCalls: 1, maxItems: 1 },
		steps: [
			{
				type: "agent",
				id: "only",
				agent: "reviewer",
				prompt: {
					template: "{{label}}",
					values: { label: { ref: "arg", name: "label" } },
				},
				output: { mode: "text" },
				limits: { timeoutMs: 1_000, maxTurns: 1, maxToolCalls: 0 },
			},
		],
		result: { ref: "step", stepId: "only" },
	};
}

async function fixture() {
	const root = await mkdtemp(join(await realpath(tmpdir()), "workflow-store-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	await Promise.all([mkdir(agentDir), mkdir(cwd)]);
	const source = await resolveWorkflowDefinition(
		{ kind: "inline", definition: definition() },
		{ agentDir, cwd, allowPath: false },
	);
	return { root, agentDir, cwd, source };
}

const runId = "123e4567-e89b-12d3-a456-426614174000";

function started(
	id = runId,
): Extract<WorkflowEventV1, { readonly type: "workflow_started" }> {
	return {
		type: "workflow_started",
		runId: id,
		sequence: 1,
		workflowId: "storeTest",
	};
}

function phase(sequence: number, id = runId): WorkflowEventV1 {
	return {
		type: "phase",
		runId: id,
		sequence,
		stepId: "only",
		phase: `phase-${sequence}`,
	};
}

function progress(sequence: number, id = runId): WorkflowEventV1 {
	return {
		type: "leaf_progress",
		runId: id,
		sequence,
		identity: { runId: id, nodeId: "only", stepId: "only" },
		message: "transient",
	};
}

function outcome(id = runId): WorkflowOutcomeV1 {
	const usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		turns: 0,
		toolCalls: 0,
		durationMs: 0,
	};
	const leaf = {
		status: "succeeded" as const,
		identity: { runId: id, nodeId: "only", stepId: "only" },
		result: { mode: "text" as const, text: "done" },
		usage,
	};
	const step = { type: "agent" as const, stepId: "only", leaf };
	return {
		version: 1,
		runId: id,
		workflowId: "storeTest",
		status: "succeeded",
		steps: [step],
		result: { ref: { ref: "step", stepId: "only" }, outcome: step },
		usage,
		counters: { reservedCallSlots: 1, actualLeafCalls: 1, admittedItems: 0 },
	};
}

function terminal(
	sequence: number,
	status: WorkflowOutcomeV1["status"] = "succeeded",
): WorkflowEventV1 {
	return { type: "workflow_terminal", runId, sequence, status };
}

function terminalSummary(id = runId) {
	const value = outcome(id);
	return {
		version: 1,
		terminal: {
			version: 1,
			runId: id,
			workflowId: "storeTest",
			status: "succeeded",
			resultRef: { ref: "step", stepId: "only" },
			usage: value.usage,
			counters: value.counters,
		},
	};
}

async function begin(
	store: ReturnType<typeof createWorkflowRunStore>,
	paths: Awaited<ReturnType<typeof fixture>>,
	overrides: Record<string, unknown> = {},
) {
	await store.beginRun({
		event: started(),
		source: paths.source,
		args: { label: "literal text" },
		invocation: "tool",
		toolCallId: "tool-call-1",
		cwd: paths.cwd,
		...overrides,
	});
}

async function json(path: string): Promise<unknown> {
	return JSON.parse(await readFile(path, "utf8")) as unknown;
}

test("session identity is a stable directory-safe hash and never derives from cwd", async (t) => {
	const paths = await fixture();
	t.after(() => rm(paths.root, { recursive: true, force: true }));
	const first = createWorkflowRunStore({
		agentDir: paths.agentDir,
		sessionId: "stable/session:id",
	});
	const same = createWorkflowRunStore({
		agentDir: paths.agentDir,
		sessionId: "stable/session:id",
	});
	const other = createWorkflowRunStore({
		agentDir: paths.agentDir,
		sessionId: "other-session",
	});
	assert.equal(
		first.sessionKey,
		createHash("sha256").update("stable/session:id").digest("hex"),
	);
	assert.equal(first.sessionKey, same.sessionKey);
	assert.notEqual(first.sessionKey, other.sessionKey);
	assert.match(first.sessionKey, /^[a-f0-9]{64}$/);
	await Promise.all([first.close(), same.close(), other.close()]);
});

test("beginRun writes exact restrictive layout, manifest provenance, snapshot, args, and started journal", async (t) => {
	const paths = await fixture();
	t.after(() => rm(paths.root, { recursive: true, force: true }));
	const store = createWorkflowRunStore({
		agentDir: paths.agentDir,
		sessionId: "session-one",
	});
	await begin(store, paths);
	const directory = store.runDirectory;
	assert.ok(directory);
	assert.deepEqual((await readdir(directory)).sort(), [
		"args.json",
		"journal.jsonl",
		"manifest.json",
		"source.workflow.json",
	]);
	assert.equal(
		await readFile(join(directory, "source.workflow.json"), "utf8"),
		paths.source.sourceText,
	);
	assert.equal(
		await readFile(join(directory, "args.json"), "utf8"),
		'{"label":"literal text"}',
	);
	assert.deepEqual(await json(join(directory, "manifest.json")), {
		version: 1,
		runId,
		workflowId: "storeTest",
		sessionKey: store.sessionKey,
		invocation: "tool",
		toolCallId: "tool-call-1",
		cwd: paths.cwd,
		sourceKind: "inline",
		displaySource: "inline workflow definition",
		sourceSha256: paths.source.sha256,
		packageVersion: PACKAGE_VERSION,
		irVersion: 1,
		executionMode: "foreground-only",
		replayPolicy: "disabled",
	});
	const records = (await readFile(join(directory, "journal.jsonl"), "utf8"))
		.trimEnd()
		.split("\n");
	assert.equal(records.length, 1);
	assert.deepEqual(JSON.parse(records[0]!), {
		version: 1,
		eventSequence: 1,
		event: started(),
	});

	if (process.platform !== "win32") {
		assert.equal((await lstat(directory)).mode & 0o777, 0o700);
		for (const name of await readdir(directory))
			assert.equal((await lstat(join(directory, name))).mode & 0o777, 0o600);
	}
	await store.close();
});

test("file sources include canonical provenance and preserve the exact source snapshot", async (t) => {
	const paths = await fixture();
	t.after(() => rm(paths.root, { recursive: true, force: true }));
	const sourcePath = join(paths.cwd, "audit.workflow.json");
	const sourceText = `${JSON.stringify(definition(), null, 2)}\n`;
	await writeFile(sourcePath, sourceText);
	const source = await resolveWorkflowDefinition(
		{ kind: "path", path: sourcePath },
		{ ...paths, allowPath: true },
	);
	const store = createWorkflowRunStore({
		agentDir: paths.agentDir,
		sessionId: "file-session",
	});
	await begin(store, { ...paths, source });
	const manifest = (await json(
		join(store.runDirectory!, "manifest.json"),
	)) as Record<string, unknown>;
	assert.equal(manifest.canonicalPath, sourcePath);
	assert.equal(
		manifest.sourceSha256,
		createHash("sha256").update(sourceText).digest("hex"),
	);
	assert.equal(
		await readFile(join(store.runDirectory!, "source.workflow.json"), "utf8"),
		sourceText,
	);
	await store.close();
});

test("arguments are strictly validated, canonicalized, and isolated before filesystem writes", async (t) => {
	const paths = await fixture();
	t.after(() => rm(paths.root, { recursive: true, force: true }));
	for (const args of [{}, { label: "ok", extra: true }, { label: 1 }]) {
		const store = createWorkflowRunStore({
			agentDir: paths.agentDir,
			sessionId: `args-${JSON.stringify(args)}`,
		});
		await assert.rejects(
			begin(store, paths, { args }),
			/argument|expected string|missing|unknown/i,
		);
		await store.close();
	}
	let calls = 0;
	const hostile = {};
	Object.defineProperty(hostile, "label", {
		enumerable: true,
		get() {
			calls += 1;
			return "secret";
		},
	});
	const store = createWorkflowRunStore({
		agentDir: paths.agentDir,
		sessionId: "hostile-args",
	});
	await assert.rejects(
		begin(store, paths, { args: hostile }),
		/data properties|safely inspected/,
	);
	assert.equal(calls, 0);
	await store.close();
});

test("journal omits progress while enforcing full engine sequence and serializing concurrent appends", async (t) => {
	const paths = await fixture();
	t.after(() => rm(paths.root, { recursive: true, force: true }));
	const store = createWorkflowRunStore({
		agentDir: paths.agentDir,
		sessionId: "journal-session",
	});
	await begin(store, paths);
	await store.appendEvent(progress(2));
	await Promise.all([
		store.appendEvent(phase(3)),
		store.appendEvent(phase(4)),
		store.appendEvent(phase(5)),
	]);
	const lines = (
		await readFile(join(store.runDirectory!, "journal.jsonl"), "utf8")
	)
		.trimEnd()
		.split("\n");
	assert.deepEqual(
		lines.map(
			(line) => (JSON.parse(line) as { eventSequence: number }).eventSequence,
		),
		[1, 3, 4, 5],
	);
	assert.equal(
		lines.some((line) => line.includes("leaf_progress")),
		false,
	);
	for (const line of lines) {
		assert.equal(/[\r\n]/u.test(line), false);
		assert.equal(line.includes(": "), false);
		assert.match(
			line,
			/^\{"event":\{.*\},"eventSequence":[0-9]+,"version":1\}$/u,
		);
	}
	await store.close();
});

test("events are safely cloned before queueing and hostile event/outcome objects are rejected", async (t) => {
	const paths = await fixture();
	t.after(() => rm(paths.root, { recursive: true, force: true }));
	const store = createWorkflowRunStore({
		agentDir: paths.agentDir,
		sessionId: "clone-session",
	});
	await begin(store, paths);
	const event = phase(2);
	const append = store.appendEvent(event);
	(event as { phase: string }).phase = "mutated";
	await append;
	const journal = await readFile(
		join(store.runDirectory!, "journal.jsonl"),
		"utf8",
	);
	assert.match(journal, /"phase":"phase-2"/u);
	assert.doesNotMatch(journal, /mutated/u);

	let getterCalls = 0;
	const hostileEvent = phase(3) as unknown as Record<string, unknown>;
	Object.defineProperty(hostileEvent, "secret", {
		enumerable: true,
		get() {
			getterCalls += 1;
			return "leak";
		},
	});
	await assert.rejects(
		store.appendEvent(hostileEvent as unknown as WorkflowEventV1),
		/data properties|safely inspected/,
	);
	assert.equal(getterCalls, 0);
	await store.appendEvent(terminal(3));
	const hostileOutcome = new Proxy(outcome(), {
		ownKeys() {
			throw new Error("secret");
		},
	});
	await assert.rejects(
		store.finishRun(runId, hostileOutcome),
		/proxy|safely inspected/,
	);
	await store.close();
});

test("journal bounds the complete persisted record before writing", async (t) => {
	const paths = await fixture();
	t.after(() => rm(paths.root, { recursive: true, force: true }));
	const sessionId = "wrapped-record-bound";
	const shortRunId = "r";
	const store = createWorkflowRunStore({ agentDir: paths.agentDir, sessionId });
	await begin(store, paths, { event: started(shortRunId) });
	const oversizedWrappedRecord: WorkflowEventV1 = {
		type: "leaf_terminal",
		runId: shortRunId,
		sequence: 2,
		outcome: {
			status: "succeeded",
			identity: { runId: shortRunId, nodeId: "only", stepId: "only" },
			result: { mode: "text", text: "x".repeat(4_194_010) },
			usage: outcome().usage,
		},
	};
	await assert.rejects(
		store.appendEvent(oversizedWrappedRecord),
		/complete workflow journal record exceeds 4 MiB/i,
	);
	await assert.rejects(
		store.close(),
		/complete workflow journal record exceeds 4 MiB/i,
	);
	const inspection = await inspectWorkflowRun({
		agentDir: paths.agentDir,
		sessionId,
		runId: shortRunId,
	});
	assert.equal(inspection.status, "incomplete (not running; rerun explicitly)");
});

test("journal rejects duplicate, out-of-order, and wrong-run events", async (t) => {
	const paths = await fixture();
	t.after(() => rm(paths.root, { recursive: true, force: true }));
	for (const bad of [phase(1), phase(3), phase(2, "wrong-run")]) {
		const store = createWorkflowRunStore({
			agentDir: paths.agentDir,
			sessionId: `bad-${bad.sequence}-${bad.runId}`,
		});
		await begin(store, paths);
		await assert.rejects(store.appendEvent(bad), /sequence|wrong run/i);
		await store.close();
	}
});

test("awaited workflow_started persistence completes before the engine can dispatch a leaf", async (t) => {
	const paths = await fixture();
	t.after(() => rm(paths.root, { recursive: true, force: true }));
	const store = createWorkflowRunStore({
		agentDir: paths.agentDir,
		sessionId: "dispatch-order",
	});
	const result = await executeWorkflow(
		paths.source.definition,
		{ label: "ordered" },
		async () => {
			const directory = store.runDirectory;
			assert.ok(directory);
			assert.deepEqual((await readdir(directory)).sort(), [
				"args.json",
				"journal.jsonl",
				"manifest.json",
				"source.workflow.json",
			]);
			assert.equal(
				(await readFile(join(directory, "journal.jsonl"), "utf8")).includes(
					"workflow_started",
				),
				true,
			);
			return {
				status: "completed",
				result: { mode: "text", text: "done" },
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					cost: 0,
					turns: 1,
					toolCalls: 0,
					durationMs: 1,
				},
			};
		},
		{
			onEvent: async (event) => {
				if (event.type === "workflow_started") {
					await store.beginRun({
						event,
						source: paths.source,
						args: { label: "ordered" },
						invocation: "command",
						cwd: paths.cwd,
					});
				} else {
					await store.appendEvent(event);
				}
			},
		},
	);
	await store.finishRun(result.runId, result);
	await store.close();
	assert.equal(result.status, "succeeded");
});

test("audit codecs preserve every leaf error code accepted by the engine", async (t) => {
	const paths = await fixture();
	t.after(() => rm(paths.root, { recursive: true, force: true }));
	const store = createWorkflowRunStore({
		agentDir: paths.agentDir,
		sessionId: "engine-error-code",
	});
	const result = await executeWorkflow(
		paths.source.definition,
		{ label: "error" },
		async () => ({
			status: "failed",
			error: { code: "provider\ncode", message: "", retryable: false },
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
				turns: 0,
				toolCalls: 0,
				durationMs: 0,
			},
		}),
		{
			onEvent: async (event) => {
				if (event.type === "workflow_started")
					await store.beginRun({
						event,
						source: paths.source,
						args: { label: "error" },
						invocation: "command",
						cwd: paths.cwd,
					});
				else await store.appendEvent(event);
			},
		},
	);
	assert.equal(result.status, "failed");
	await store.finishRun(result.runId, result);
	await store.close();
	assert.equal(
		(
			await inspectWorkflowRun({
				agentDir: paths.agentDir,
				sessionId: "engine-error-code",
				runId: result.runId,
			})
		).status,
		"failed",
	);
});

test("finishRun drains queued appends and atomically publishes at most one immutable result", async (t) => {
	const paths = await fixture();
	t.after(() => rm(paths.root, { recursive: true, force: true }));
	const store = createWorkflowRunStore({
		agentDir: paths.agentDir,
		sessionId: "finish-session",
	});
	await begin(store, paths);
	const append = store.appendEvent(phase(2));
	const terminalAppend = store.appendEvent(terminal(3));
	const finalOutcome = outcome();
	const finish = store.finishRun(runId, finalOutcome);
	(finalOutcome as { status: string }).status = "failed";
	await Promise.all([append, terminalAppend, finish]);
	assert.deepEqual(
		await json(join(store.runDirectory!, "result.json")),
		terminalSummary(),
	);
	assert.equal(
		(await readdir(store.runDirectory!)).some((name) => name.includes(".tmp-")),
		false,
	);
	await assert.rejects(store.finishRun(runId, outcome()), /already.*finish/i);
	await store.close();
});

test("wrong-run finish, writes after close, and duplicate run directories fail closed", async (t) => {
	const paths = await fixture();
	t.after(() => rm(paths.root, { recursive: true, force: true }));
	const store = createWorkflowRunStore({
		agentDir: paths.agentDir,
		sessionId: "closed-session",
	});
	await begin(store, paths);
	await assert.rejects(store.finishRun("wrong-run", outcome()), /wrong run/i);
	await store.close();
	await assert.rejects(store.appendEvent(phase(2)), /closed/i);
	await assert.rejects(store.finishRun(runId, outcome()), /closed/i);

	const duplicate = createWorkflowRunStore({
		agentDir: paths.agentDir,
		sessionId: "closed-session",
	});
	await assert.rejects(
		begin(duplicate, paths),
		/already exists|exclusive|EEXIST/i,
	);
	await duplicate.close();
});

test("replacing a journal with a symlink is rejected rather than followed", async (t) => {
	if (process.platform === "win32")
		t.skip(
			"ordinary file symlink creation requires privileges on some Windows workers",
		);
	const paths = await fixture();
	t.after(() => rm(paths.root, { recursive: true, force: true }));
	const store = createWorkflowRunStore({
		agentDir: paths.agentDir,
		sessionId: "nofollow-session",
	});
	await begin(store, paths);
	const journal = join(store.runDirectory!, "journal.jsonl");
	const moved = join(store.runDirectory!, "journal.original");
	await rename(journal, moved);
	await symlink(moved, journal);
	await assert.rejects(
		store.appendEvent(phase(2)),
		/symbolic link|replaced|identity/i,
	);
	await assert.rejects(store.close(), /symbolic link|replaced|identity/i);
});

test("symlinked store roots are rejected without writing through them", async (t) => {
	const paths = await fixture();
	t.after(() => rm(paths.root, { recursive: true, force: true }));
	const outside = join(paths.root, "outside");
	await mkdir(outside);
	await symlink(
		outside,
		join(paths.agentDir, "pi-subagents-workflows"),
		process.platform === "win32" ? "junction" : "dir",
	);
	const store = createWorkflowRunStore({
		agentDir: paths.agentDir,
		sessionId: "attacked-session",
	});
	await assert.rejects(begin(store, paths), /symbolic link|reparse/i);
	assert.deepEqual(await readdir(outside), []);
	await store.close();
});

test("inspection labels a record without result as incomplete, never running or resumable", async (t) => {
	const paths = await fixture();
	t.after(() => rm(paths.root, { recursive: true, force: true }));
	const store = createWorkflowRunStore({
		agentDir: paths.agentDir,
		sessionId: "inspection-session",
	});
	await begin(store, paths);
	await store.close();
	const sessionKey = createHash("sha256")
		.update("inspection-session")
		.digest("hex");
	assert.deepEqual(
		await inspectWorkflowRun({
			agentDir: paths.agentDir,
			sessionId: "inspection-session",
			runId,
		}),
		{
			sessionKey,
			relativeLocator: `${sessionKey}/${runId}`,
			runId,
			workflowId: "storeTest",
			invocation: "tool",
			sourceKind: "inline",
			displaySource: "inline workflow definition",
			sourceSha256: paths.source.sha256,
			status: "incomplete (not running; rerun explicitly)",
			running: false,
			resumable: false,
			resultPresent: false,
		},
	);
});

test("atomic publication never replaces a competing destination", async (t) => {
	const paths = await fixture();
	t.after(() => rm(paths.root, { recursive: true, force: true }));
	const store = createWorkflowRunStore({
		agentDir: paths.agentDir,
		sessionId: "no-replace-session",
		testHooks: {
			beforePublish: async (name, destination) => {
				if (name === "result.json")
					await writeFile(destination, "competing result", { flag: "wx" });
			},
		},
	});
	await begin(store, paths);
	await store.appendEvent(terminal(2));
	await assert.rejects(store.finishRun(runId, outcome()), /EEXIST|exist/i);
	assert.equal(
		await readFile(join(store.runDirectory!, "result.json"), "utf8"),
		"competing result",
	);
	await assert.rejects(store.close(), /EEXIST|exist/i);
});

test("atomic publication rejects a replaced temporary inode", async (t) => {
	const paths = await fixture();
	t.after(() => rm(paths.root, { recursive: true, force: true }));
	const store = createWorkflowRunStore({
		agentDir: paths.agentDir,
		sessionId: "replaced-temporary",
		testHooks: {
			beforePublish: async (name, _destination, temporary) => {
				if (name === "result.json") {
					await rename(temporary, `${temporary}.original`);
					await writeFile(temporary, "attacker bytes");
				}
			},
		},
	});
	await begin(store, paths);
	await store.appendEvent(terminal(2));
	await assert.rejects(
		store.finishRun(runId, outcome()),
		/temporary file was replaced/i,
	);
	await assert.rejects(
		readFile(join(store.runDirectory!, "result.json")),
		/ENOENT/,
	);
	await assert.rejects(store.close(), /temporary file was replaced/i);
});

test("concurrent beginRun calls claim a single-run store before filesystem awaits", async (t) => {
	const paths = await fixture();
	t.after(() => rm(paths.root, { recursive: true, force: true }));
	let entered!: () => void;
	let release!: () => void;
	const enteredPromise = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const store = createWorkflowRunStore({
		agentDir: paths.agentDir,
		sessionId: "concurrent-begin",
		testHooks: {
			beforePublish: async (name) => {
				if (name === "manifest.json") {
					entered();
					await gate;
				}
			},
		},
	});
	const first = begin(store, paths);
	await enteredPromise;
	await assert.rejects(
		begin(store, paths, { event: started("other-run") }),
		/already.*begin/i,
	);
	release();
	await first;
	await store.close();
});

test("close waits for an in-flight beginRun and closes the journal it opens", async (t) => {
	const paths = await fixture();
	t.after(() => rm(paths.root, { recursive: true, force: true }));
	let entered!: () => void;
	let release!: () => void;
	const enteredPromise = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const store = createWorkflowRunStore({
		agentDir: paths.agentDir,
		sessionId: "begin-close",
		testHooks: {
			beforePublish: async (name) => {
				if (name === "manifest.json") {
					entered();
					await gate;
				}
			},
		},
	});
	const beginning = begin(store, paths);
	await enteredPromise;
	let closeSettled = false;
	const closing = store.close().then(() => {
		closeSettled = true;
	});
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(closeSettled, false);
	release();
	await Promise.all([beginning, closing]);
	assert.equal(closeSettled, true);
	await assert.rejects(store.appendEvent(phase(2)), /closed/i);
});

test("beginRun accepts only opaque resolver output without invoking forged getters", async (t) => {
	const paths = await fixture();
	t.after(() => rm(paths.root, { recursive: true, force: true }));
	let getterCalls = 0;
	const forged = {} as Record<string, unknown>;
	Object.defineProperty(forged, "definition", {
		enumerable: true,
		get() {
			getterCalls += 1;
			return paths.source.definition;
		},
	});
	const store = createWorkflowRunStore({
		agentDir: paths.agentDir,
		sessionId: "forged-source",
	});
	await assert.rejects(
		begin(store, paths, { source: forged }),
		/strict resolver/i,
	);
	assert.equal(getterCalls, 0);
	await store.close();
});

test("audit codecs reject malformed nested events and outcomes", async (t) => {
	const paths = await fixture();
	t.after(() => rm(paths.root, { recursive: true, force: true }));
	const store = createWorkflowRunStore({
		agentDir: paths.agentDir,
		sessionId: "strict-audit",
	});
	await begin(store, paths);
	await assert.rejects(
		store.appendEvent({
			...phase(2),
			slot: "wrong",
		} as unknown as WorkflowEventV1),
		/slot|safe integer/i,
	);
	await store.appendEvent(phase(2));
	await store.appendEvent(terminal(3));
	const malformed = {
		...outcome(),
		usage: { ...outcome().usage, input: "wrong" },
	} as unknown as WorkflowOutcomeV1;
	await assert.rejects(
		store.finishRun(runId, malformed),
		/usage\.input|safe integer/i,
	);
	await store.finishRun(runId, outcome());
	await store.close();
});

test("workflow_terminal is final and must agree with a recorded result status", async (t) => {
	const paths = await fixture();
	t.after(() => rm(paths.root, { recursive: true, force: true }));
	const store = createWorkflowRunStore({
		agentDir: paths.agentDir,
		sessionId: "terminal-lifecycle",
	});
	await begin(store, paths);
	await store.appendEvent({
		type: "workflow_terminal",
		runId,
		sequence: 2,
		status: "succeeded",
	});
	await assert.rejects(store.appendEvent(phase(3)), /terminal.*final/i);
	await assert.rejects(
		store.finishRun(runId, {
			...outcome(),
			status: "failed",
			result: null,
			error: { code: "test_failure", message: "failed" },
		}),
		/disagrees with|does not match.*terminal/i,
	);
	await store.finishRun(runId, outcome());
	await store.close();
});

test("journal namespace replacement after a write is detected before append resolves", async (t) => {
	const paths = await fixture();
	t.after(() => rm(paths.root, { recursive: true, force: true }));
	let writes = 0;
	const store = createWorkflowRunStore({
		agentDir: paths.agentDir,
		sessionId: "post-write-journal-race",
		testHooks: {
			afterJournalWrite: async (path) => {
				writes += 1;
				if (writes === 2) {
					await rename(path, `${path}.moved`);
					await writeFile(path, "replacement");
				}
			},
		},
	});
	await begin(store, paths);
	await assert.rejects(store.appendEvent(phase(2)), /identity.*replaced/i);
	await assert.rejects(store.close(), /identity.*replaced/i);
});

test("inspection strictly rejects duplicate or malformed stored JSON", async (t) => {
	const paths = await fixture();
	t.after(() => rm(paths.root, { recursive: true, force: true }));
	const manifestStore = createWorkflowRunStore({
		agentDir: paths.agentDir,
		sessionId: "bad-manifest",
	});
	await begin(manifestStore, paths);
	await manifestStore.close();
	await writeFile(
		join(manifestStore.runDirectory!, "manifest.json"),
		'{"version":1,"version":1}',
	);
	await assert.rejects(
		inspectWorkflowRun({
			agentDir: paths.agentDir,
			sessionId: "bad-manifest",
			runId,
		}),
		/duplicate object key/i,
	);

	const resultStore = createWorkflowRunStore({
		agentDir: paths.agentDir,
		sessionId: "bad-result",
	});
	await begin(resultStore, paths);
	await resultStore.appendEvent(terminal(2));
	await resultStore.finishRun(runId, outcome());
	await resultStore.close();
	await writeFile(
		join(resultStore.runDirectory!, "result.json"),
		'{"version":1,"terminal":{"status":"running"}}',
	);
	await assert.rejects(
		inspectWorkflowRun({
			agentDir: paths.agentDir,
			sessionId: "bad-result",
			runId,
		}),
		/missing|outcome|status/i,
	);

	const journalStore = createWorkflowRunStore({
		agentDir: paths.agentDir,
		sessionId: "bad-journal",
	});
	await begin(journalStore, paths);
	await journalStore.appendEvent(terminal(2));
	await journalStore.finishRun(runId, outcome());
	await journalStore.close();
	const journalPath = join(journalStore.runDirectory!, "journal.jsonl");
	const startedOnly = (await readFile(journalPath, "utf8")).split("\n")[0];
	await writeFile(journalPath, `${startedOnly}\n`);
	await assert.rejects(
		inspectWorkflowRun({
			agentDir: paths.agentDir,
			sessionId: "bad-journal",
			runId,
		}),
		/no workflow_terminal/i,
	);

	const sourceStore = createWorkflowRunStore({
		agentDir: paths.agentDir,
		sessionId: "bad-source",
	});
	await begin(sourceStore, paths);
	await sourceStore.close();
	await writeFile(
		join(sourceStore.runDirectory!, "source.workflow.json"),
		JSON.stringify(definition()),
	);
	await assert.rejects(
		inspectWorkflowRun({
			agentDir: paths.agentDir,
			sessionId: "bad-source",
			runId,
		}),
		/source hash/i,
	);
});

test("inspection lists validated terminal and incomplete records without recovery semantics", async (t) => {
	const paths = await fixture();
	t.after(() => rm(paths.root, { recursive: true, force: true }));
	const sessionId = "list-runs";
	const firstRunId = "00000000-0000-4000-8000-000000000001";
	const incomplete = createWorkflowRunStore({
		agentDir: paths.agentDir,
		sessionId,
	});
	await begin(incomplete, paths, { event: started(firstRunId) });
	await incomplete.close();
	const terminalStore = createWorkflowRunStore({
		agentDir: paths.agentDir,
		sessionId,
	});
	await begin(terminalStore, paths);
	await terminalStore.appendEvent(terminal(2));
	await terminalStore.finishRun(runId, outcome());
	await terminalStore.close();

	const listed = await listWorkflowRuns({
		agentDir: paths.agentDir,
		sessionId,
	});
	assert.deepEqual(
		listed.map(({ runId: id, status, running, resumable }) => ({
			id,
			status,
			running,
			resumable,
		})),
		[
			{
				id: firstRunId,
				status: "incomplete (not running; rerun explicitly)",
				running: false,
				resumable: false,
			},
			{ id: runId, status: "succeeded", running: false, resumable: false },
		],
	);
	assert.ok(Object.isFrozen(listed));
});

test("a run never creates or changes the physically distinct saved-definition roots", async (t) => {
	const paths = await fixture();
	t.after(() => rm(paths.root, { recursive: true, force: true }));
	const userSaved = join(
		paths.agentDir,
		"pi-subagents-workflows",
		"definitions",
		"kept.workflow.json",
	);
	const projectSaved = join(
		paths.cwd,
		".pi",
		"workflows",
		"kept.workflow.json",
	);
	await mkdir(join(paths.agentDir, "pi-subagents-workflows", "definitions"), {
		recursive: true,
	});
	await mkdir(join(paths.cwd, ".pi", "workflows"), { recursive: true });
	await Promise.all([
		writeFile(userSaved, "user literal"),
		writeFile(projectSaved, "project literal"),
	]);
	const before = await Promise.all([
		readFile(userSaved, "utf8"),
		readFile(projectSaved, "utf8"),
	]);

	const store = createWorkflowRunStore({
		agentDir: paths.agentDir,
		sessionId: "distinct-roots",
	});
	await begin(store, paths);
	await store.appendEvent(terminal(2));
	await store.finishRun(runId, outcome());
	await store.close();
	assert.deepEqual(
		await Promise.all([
			readFile(userSaved, "utf8"),
			readFile(projectSaved, "utf8"),
		]),
		before,
	);
	assert.equal(
		(
			await readdir(
				join(paths.agentDir, "pi-subagents-workflows", "definitions"),
			)
		).length,
		1,
	);
});

test("unsafe IDs and text are rejected before store creation", async (t) => {
	const paths = await fixture();
	t.after(() => rm(paths.root, { recursive: true, force: true }));
	assert.throws(
		() =>
			createWorkflowRunStore({
				agentDir: paths.agentDir,
				sessionId: "bad\u0000session",
			}),
		/session/i,
	);
	const badId = createWorkflowRunStore({
		agentDir: paths.agentDir,
		sessionId: "safe-session-id",
	});
	await assert.rejects(
		begin(badId, paths, { event: started("../escape") }),
		/run ID/i,
	);
	await badId.close();
	const badCwd = createWorkflowRunStore({
		agentDir: paths.agentDir,
		sessionId: "safe-session-cwd",
	});
	await assert.rejects(begin(badCwd, paths, { cwd: "bad\u202epath" }), /cwd/i);
	await badCwd.close();
	await chmod(paths.agentDir, 0o700);
});
