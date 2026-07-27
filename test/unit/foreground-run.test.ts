import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { PiSubagentsLeafAdapter } from "../../src/adapters/pi-subagents.ts";
import type {
	LeafRunnerTerminalV1,
	WorkflowEventV1,
	WorkflowOutcomeV1,
} from "../../src/engine/index.ts";
import {
	createForegroundRunService,
	type ForegroundRunServiceDependencies,
} from "../../src/extension/foreground-run.ts";
import type {
	BeginWorkflowRunV1,
	WorkflowRunStore,
} from "../../src/extension/run-store.ts";
import { resolveWorkflowDefinition } from "../../src/extension/workflow-source.ts";

function definition(): Record<string, unknown> {
	return {
		version: 1,
		id: "foregroundTest",
		args: {},
		limits: { concurrency: 1, maxCalls: 1, maxItems: 1 },
		steps: [
			{
				type: "agent",
				id: "only",
				agent: "reviewer",
				prompt: { template: "literal", values: {} },
				output: { mode: "text" },
				limits: { timeoutMs: 1_000, maxTurns: 1, maxToolCalls: 0 },
			},
		],
		result: { ref: "step", stepId: "only" },
	};
}

async function fixture() {
	const root = await mkdtemp(join(await realpath(tmpdir()), "foreground-run-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	await Promise.all([mkdir(agentDir), mkdir(cwd)]);
	const source = await resolveWorkflowDefinition(
		{ kind: "inline", definition: definition() },
		{ agentDir, cwd, allowPath: false },
	);
	return { root, agentDir, cwd, source };
}

class RecordingStore implements WorkflowRunStore {
	readonly sessionKey = "session-key";
	runDirectory: string | undefined = "/audit/session/run";
	readonly order: string[];
	private readonly failAt: "begin" | "append" | "finish" | "close" | undefined;

	constructor(
		order: string[],
		failAt?: "begin" | "append" | "finish" | "close",
	) {
		this.order = order;
		this.failAt = failAt;
	}

	async beginRun(_input: BeginWorkflowRunV1): Promise<void> {
		this.order.push("store:begin");
		if (this.failAt === "begin") throw new Error("begin failed");
	}

	async appendEvent(event: WorkflowEventV1): Promise<void> {
		this.order.push(`store:event:${event.type}`);
		if (this.failAt === "append") throw new Error("append failed");
	}

	async finishRun(_runId: string, _outcome: WorkflowOutcomeV1): Promise<void> {
		this.order.push("store:finish");
		if (this.failAt === "finish") throw new Error("finish failed");
	}

	async close(): Promise<void> {
		this.order.push("store:close");
		if (this.failAt === "close") throw new Error("close failed");
	}
}

function completedTerminal(): LeafRunnerTerminalV1 {
	return {
		status: "completed",
		result: { mode: "text", text: "done" },
		usage: {
			input: 1,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0.01,
			turns: 1,
			toolCalls: 0,
			durationMs: 1,
		},
	};
}

test("foreground service cancels only the exact active run", async (t) => {
	const paths = await fixture();
	t.after(() => rm(paths.root, { recursive: true, force: true }));
	const stores: RecordingStore[] = [];
	const releases = new Map<string, (terminal: LeafRunnerTerminalV1) => void>();
	let bothLeavesStarted = (): void => undefined;
	const started = new Promise<void>((resolve) => {
		bothLeavesStarted = resolve;
	});
	const adapter: PiSubagentsLeafAdapter = {
		leafRunner: async (request) =>
			new Promise<LeafRunnerTerminalV1>((resolve) => {
				releases.set(request.identity.runId, resolve);
				request.signal.addEventListener(
					"abort",
					() =>
						resolve({ status: "cancelled", usage: completedTerminal().usage }),
					{ once: true },
				);
				if (releases.size === 2) bothLeavesStarted();
			}),
		dispose: () => undefined,
	};
	const service = createForegroundRunService(
		{
			agentDir: paths.agentDir,
			sessionId: "session-concurrent",
			cwd: paths.cwd,
			events: { on: () => () => undefined, emit: () => undefined },
		},
		{
			createStore: () => {
				const store = new RecordingStore([]);
				stores.push(store);
				return store;
			},
			createAdapter: async () => adapter,
		},
	);
	let firstRunId: string | undefined;
	let secondRunId: string | undefined;
	const first = service.execute({
		source: paths.source,
		args: {},
		invocation: "tool",
		toolCallId: "tool-a",
		present: (event) => {
			if (event.type === "workflow_started") firstRunId = event.runId;
		},
	});
	const second = service.execute({
		source: paths.source,
		args: {},
		invocation: "tool",
		toolCallId: "tool-b",
		present: (event) => {
			if (event.type === "workflow_started") secondRunId = event.runId;
		},
	});
	await started;

	assert.ok(firstRunId);
	assert.ok(secondRunId);
	assert.notEqual(firstRunId, secondRunId);
	assert.equal(service.activeRuns.length, 2);
	assert.equal(service.cancel("foregroundTest"), false);
	assert.equal(service.cancel(firstRunId), true);
	releases.get(secondRunId)?.(completedTerminal());

	const [firstResult, secondResult] = await Promise.all([first, second]);
	assert.equal(firstResult.outcome.status, "cancelled");
	assert.equal(secondResult.outcome.status, "succeeded");
	assert.deepEqual(service.activeRuns, []);
	assert.equal(stores.length, 2);
	await service.shutdown();
});

test("caller abort propagates to the exact foreground leaf", async (t) => {
	const paths = await fixture();
	t.after(() => rm(paths.root, { recursive: true, force: true }));
	let leafStarted: () => void = () => undefined;
	const started = new Promise<void>((resolve) => {
		leafStarted = resolve;
	});
	const service = createForegroundRunService(
		{
			agentDir: paths.agentDir,
			sessionId: "session-caller-abort",
			cwd: paths.cwd,
			events: { on: () => () => undefined, emit: () => undefined },
		},
		{
			createStore: () => new RecordingStore([]),
			createAdapter: async () => ({
				leafRunner: async (request) =>
					new Promise<LeafRunnerTerminalV1>((resolve) => {
						leafStarted();
						request.signal.addEventListener(
							"abort",
							() =>
								resolve({
									status: "cancelled",
									usage: completedTerminal().usage,
								}),
							{ once: true },
						);
					}),
				dispose: () => undefined,
			}),
		},
	);
	const controller = new AbortController();
	const execution = service.execute({
		source: paths.source,
		args: {},
		invocation: "tool",
		toolCallId: "caller-abort",
		signal: controller.signal,
	});
	await started;
	controller.abort("caller cancelled");
	assert.equal((await execution).outcome.status, "cancelled");
	await service.shutdown();
});

test("required audit failures stop or reject runs while presentation stays advisory", async (t) => {
	const paths = await fixture();
	t.after(() => rm(paths.root, { recursive: true, force: true }));
	let leafCalls = 0;
	const adapter: PiSubagentsLeafAdapter = {
		leafRunner: async () => {
			leafCalls += 1;
			return completedTerminal();
		},
		dispose: () => undefined,
	};
	const beginFailure = createForegroundRunService(
		{
			agentDir: paths.agentDir,
			sessionId: "session-begin-failure",
			cwd: paths.cwd,
			events: { on: () => () => undefined, emit: () => undefined },
		},
		{
			createStore: () => new RecordingStore([], "begin"),
			createAdapter: async () => adapter,
		},
	);
	const failed = await beginFailure.execute({
		source: paths.source,
		args: {},
		invocation: "command",
	});
	assert.equal(failed.outcome.status, "failed");
	assert.equal(failed.outcome.error?.code, "hook_error");
	assert.equal(leafCalls, 0);
	await beginFailure.shutdown();

	const appendFailure = createForegroundRunService(
		{
			agentDir: paths.agentDir,
			sessionId: "session-append-failure",
			cwd: paths.cwd,
			events: { on: () => () => undefined, emit: () => undefined },
		},
		{
			createStore: () => new RecordingStore([], "append"),
			createAdapter: async () => adapter,
		},
	);
	const appendFailed = await appendFailure.execute({
		source: paths.source,
		args: {},
		invocation: "command",
	});
	assert.equal(appendFailed.outcome.status, "failed");
	assert.equal(appendFailed.outcome.error?.code, "hook_error");
	assert.equal(leafCalls, 0);
	await appendFailure.shutdown();

	const finishFailure = createForegroundRunService(
		{
			agentDir: paths.agentDir,
			sessionId: "session-finish-failure",
			cwd: paths.cwd,
			events: { on: () => () => undefined, emit: () => undefined },
		},
		{
			createStore: () => new RecordingStore([], "finish"),
			createAdapter: async () => adapter,
		},
	);
	await assert.rejects(
		finishFailure.execute({
			source: paths.source,
			args: {},
			invocation: "tool",
			toolCallId: "tool-finish",
		}),
		/finish failed/,
	);
	await finishFailure.shutdown();

	const advisory = createForegroundRunService(
		{
			agentDir: paths.agentDir,
			sessionId: "session-presentation",
			cwd: paths.cwd,
			events: { on: () => () => undefined, emit: () => undefined },
		},
		{
			createStore: () => new RecordingStore([]),
			createAdapter: async () => adapter,
		},
	);
	const succeeded = await advisory.execute({
		source: paths.source,
		args: {},
		invocation: "command",
		present: () => {
			throw new Error("UI failed");
		},
	});
	assert.equal(succeeded.outcome.status, "succeeded");
	await advisory.shutdown();

	const combinedOrder: string[] = [];
	const adapterFailure = createForegroundRunService(
		{
			agentDir: paths.agentDir,
			sessionId: "session-adapter-close-failure",
			cwd: paths.cwd,
			events: { on: () => () => undefined, emit: () => undefined },
		},
		{
			createStore: () => new RecordingStore(combinedOrder, "close"),
			createAdapter: async () => {
				throw new Error("adapter setup failed");
			},
		},
	);
	await assert.rejects(
		adapterFailure.execute({
			source: paths.source,
			args: {},
			invocation: "command",
		}),
		(error: unknown) =>
			error instanceof AggregateError &&
			error.errors.length === 2 &&
			error.errors.some((item) => /adapter setup failed/.test(String(item))) &&
			error.errors.some((item) => /close failed/.test(String(item))),
	);
	assert.deepEqual(combinedOrder, ["store:close"]);
	await adapterFailure.shutdown();
});

test("shutdown stops admission, settles owned work, and disposes one shared adapter", async (t) => {
	const paths = await fixture();
	t.after(() => rm(paths.root, { recursive: true, force: true }));
	let leafStarted = (): void => undefined;
	const started = new Promise<void>((resolve) => {
		leafStarted = resolve;
	});
	let adapterCreations = 0;
	let disposeCount = 0;
	const adapter: PiSubagentsLeafAdapter = {
		leafRunner: async (request) =>
			new Promise<LeafRunnerTerminalV1>((resolve) => {
				leafStarted();
				request.signal.addEventListener(
					"abort",
					() =>
						resolve({ status: "cancelled", usage: completedTerminal().usage }),
					{ once: true },
				);
			}),
		dispose: () => {
			disposeCount += 1;
		},
	};
	const service = createForegroundRunService(
		{
			agentDir: paths.agentDir,
			sessionId: "session-shutdown",
			cwd: paths.cwd,
			events: { on: () => () => undefined, emit: () => undefined },
		},
		{
			createStore: () => new RecordingStore([]),
			createAdapter: async () => {
				adapterCreations += 1;
				return adapter;
			},
		},
	);
	const running = service.execute({
		source: paths.source,
		args: {},
		invocation: "command",
	});
	await started;
	await service.shutdown("reload");
	assert.equal((await running).outcome.status, "cancelled");
	assert.equal(adapterCreations, 1);
	assert.equal(disposeCount, 1);
	await service.shutdown("again");
	assert.equal(disposeCount, 1);
	await assert.rejects(
		service.execute({ source: paths.source, args: {}, invocation: "command" }),
		/shut down/i,
	);
});

test("shutdown remains bounded when public adapter creation never settles", async (t) => {
	const paths = await fixture();
	t.after(() => rm(paths.root, { recursive: true, force: true }));
	let releaseAdapter: (adapter: PiSubagentsLeafAdapter) => void = () => undefined;
	let disposeCount = 0;
	const pendingAdapter = new Promise<PiSubagentsLeafAdapter>((resolve) => {
		releaseAdapter = resolve;
	});
	const service = createForegroundRunService(
		{
			agentDir: paths.agentDir,
			sessionId: "session-adapter-hang",
			cwd: paths.cwd,
			events: { on: () => () => undefined, emit: () => undefined },
			shutdownTimeoutMs: 10,
		},
		{
			createStore: () => new RecordingStore([]),
			createAdapter: () => pendingAdapter,
		},
	);
	void service
		.execute({ source: paths.source, args: {}, invocation: "command" })
		.catch(() => undefined);
	await assert.rejects(
		Promise.race([
			service.shutdown("reload"),
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("shutdown test itself timed out")), 250),
			),
		]),
		/shutdown exceeded 10 milliseconds/,
	);
	releaseAdapter({
		leafRunner: async () => completedTerminal(),
		dispose: () => {
			disposeCount += 1;
		},
	});
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(disposeCount, 1);
});

test("foreground service persists lifecycle before dispatch and result publication", async (t) => {
	const paths = await fixture();
	t.after(() => rm(paths.root, { recursive: true, force: true }));
	const order: string[] = [];
	const store = new RecordingStore(order);
	let disposeCount = 0;
	const adapter: PiSubagentsLeafAdapter = {
		leafRunner: async () => {
			order.push("leaf:dispatch");
			return completedTerminal();
		},
		dispose: () => {
			disposeCount += 1;
		},
	};
	const dependencies: ForegroundRunServiceDependencies = {
		createStore: () => store,
		createAdapter: async () => adapter,
	};
	const service = createForegroundRunService(
		{
			agentDir: paths.agentDir,
			sessionId: "session-1",
			cwd: paths.cwd,
			events: { on: () => () => undefined, emit: () => undefined },
		},
		dependencies,
	);

	const result = await service.execute({
		source: paths.source,
		args: {},
		invocation: "tool",
		toolCallId: "tool-call-1",
		recordPointer: (pointer) => {
			order.push(`pointer:${pointer.phase}`);
		},
	});

	assert.equal(result.outcome.status, "succeeded");
	assert.ok(order.indexOf("store:begin") < order.indexOf("pointer:started"));
	assert.ok(order.indexOf("pointer:started") < order.indexOf("leaf:dispatch"));
	assert.ok(
		order.indexOf("store:event:workflow_terminal") <
			order.indexOf("store:finish"),
	);
	assert.ok(order.indexOf("store:finish") < order.indexOf("pointer:terminal"));
	assert.equal(order.at(-1), "store:close");
	assert.deepEqual(service.activeRuns, []);
	assert.equal(disposeCount, 0);
	await service.shutdown();
	assert.equal(disposeCount, 1);
});
