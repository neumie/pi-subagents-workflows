import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	initTheme,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Check } from "typebox/value";

import type { WorkflowOutcomeV1 } from "../../src/engine/index.ts";
import type {
	ForegroundRunRequestV1,
	ForegroundRunService,
} from "../../src/extension/foreground-run.ts";
import {
	registerWorkflowExtension,
	type WorkflowExtensionDependencies,
} from "../../src/extension/index.ts";
import { resolveWorkflowDefinition } from "../../src/extension/workflow-source.ts";

function definition(): Record<string, unknown> {
	return {
		version: 1,
		id: "extensionTest",
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

const usage = {
	input: 1,
	output: 2,
	cacheRead: 3,
	cacheWrite: 4,
	cost: 0.5,
	turns: 1,
	toolCalls: 0,
	durationMs: 5,
};

function outcome(): WorkflowOutcomeV1 {
	const leaf = {
		status: "succeeded" as const,
		identity: { runId: "run-host", nodeId: "step:only", stepId: "only" },
		result: { mode: "text" as const, text: '{"literal":true}' },
		usage,
	};
	return {
		version: 1,
		runId: "run-host",
		workflowId: "extensionTest",
		status: "succeeded",
		steps: [{ type: "agent", stepId: "only", leaf }],
		result: { ref: { ref: "step", stepId: "only" }, outcome: leaf },
		usage,
		counters: { reservedCallSlots: 1, actualLeafCalls: 1, admittedItems: 0 },
	};
}

interface CapturedTool {
	readonly parameters: TSchema;
	execute(
		toolCallId: string,
		params: { source: unknown; args: Record<string, unknown> },
		signal: AbortSignal,
		onUpdate: ((update: unknown) => void) | undefined,
		ctx: unknown,
	): Promise<{
		content: Array<{ type: string; text: string }>;
		details: unknown;
		usage?: unknown;
		isError?: boolean;
	}>;
}

interface CapturedCommand {
	handler(args: string, ctx: unknown): Promise<void>;
}

interface FakeContext {
	readonly cwd: string;
	readonly mode: "print";
	readonly hasUI: false;
	readonly sessionManager: {
		getSessionId(): string;
		getBranch(): readonly unknown[];
	};
	readonly ui: {
		notify(message: string, level?: string): void;
		setStatus(key: string, value: string | undefined): void;
	};
}

test("extension registers bounded foreground tool and command paths with exact lifecycle", async (t) => {
	const root = await mkdtemp(
		join(await realpath(tmpdir()), "workflow-extension-"),
	);
	t.after(() => rm(root, { recursive: true, force: true }));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	await Promise.all([mkdir(agentDir), mkdir(cwd)]);
	const pathDefinition = join(cwd, "command.workflow.json");
	const savedDirectory = join(
		agentDir,
		"pi-subagents-workflows",
		"definitions",
	);
	await mkdir(savedDirectory, { recursive: true });
	await Promise.all([
		writeFile(pathDefinition, JSON.stringify(definition())),
		writeFile(
			join(savedDirectory, "extension-test.workflow.json"),
			JSON.stringify(definition()),
		),
	]);

	let tool: CapturedTool | undefined;
	const commands = new Map<string, CapturedCommand>();
	const handlers = new Map<
		string,
		(event: unknown, ctx: unknown) => Promise<void>
	>();
	const entries: Array<{ type: string; data: unknown }> = [];
	const notifications: string[] = [];
	const updates: unknown[] = [];
	const createdServiceCwds: string[] = [];
	const host = {
		events: { on: () => () => undefined, emit: () => undefined },
		registerTool(value: unknown) {
			tool = value as CapturedTool;
		},
		registerCommand(name: string, value: unknown) {
			commands.set(name, value as CapturedCommand);
		},
		on(event: string, handler: unknown) {
			handlers.set(
				event,
				handler as (event: unknown, ctx: unknown) => Promise<void>,
			);
		},
		appendEntry(type: string, data: unknown) {
			entries.push({ type, data });
		},
	};
	const requests: ForegroundRunRequestV1[] = [];
	const cancelled: string[] = [];
	let exposeActiveRun = false;
	let executeFailure: unknown;
	let executionGate: Promise<void> | undefined;
	let resolutionGate: Promise<void> | undefined;
	let resolutionEntered: () => void = () => undefined;
	let shutdownCount = 0;
	const service: ForegroundRunService = {
		get activeRuns() {
			return exposeActiveRun
				? [
						{
							runId: "run-host",
							workflowId: "extensionTest",
							invocation: "command" as const,
							sourceKind: "inline" as const,
							displaySource: "inline",
						},
					]
				: [];
		},
		async execute(request) {
			if (executeFailure !== undefined) {
				const error = executeFailure;
				executeFailure = undefined;
				throw error;
			}
			requests.push(request);
			await request.recordPointer?.({
				version: 1,
				phase: "started",
				sessionKey: "session-key",
				runId: "run-host",
				workflowId: "extensionTest",
				sourceSha256: request.source.sha256,
				displaySource: request.source.displaySource,
				relativeLocator: "session-key/run-host",
			});
			await request.present?.(
				{
					type: "workflow_started",
					runId: "run-host",
					sequence: 1,
					workflowId: "extensionTest",
				},
				[],
			);
			await request.present?.(
				{
					type: "workflow_started",
					runId: "run-host",
					sequence: 2,
					workflowId: "extensionTest",
				},
				[],
			);
			await executionGate;
			await request.recordPointer?.({
				version: 1,
				phase: "terminal",
				sessionKey: "session-key",
				runId: "run-host",
				workflowId: "extensionTest",
				sourceSha256: request.source.sha256,
				displaySource: request.source.displaySource,
				relativeLocator: "session-key/run-host",
				status: "succeeded",
			});
			return {
				outcome: outcome(),
				pointer: {
					sessionKey: "session-key",
					runId: "run-host",
					workflowId: "extensionTest",
					relativeLocator: "session-key/run-host",
				},
			};
		},
		cancel(runId) {
			cancelled.push(runId);
			return runId === "run-host";
		},
		async shutdown() {
			shutdownCount += 1;
		},
	};
	const dependencies: WorkflowExtensionDependencies = {
		getAgentDir: () => agentDir,
		createService: (options) => {
			createdServiceCwds.push(options.cwd);
			return service;
		},
		resolveDefinition: async (input, options) => {
			if (resolutionGate !== undefined) {
				resolutionEntered();
				await resolutionGate;
			}
			return resolveWorkflowDefinition(input, options);
		},
		listDefinitions: async () =>
			Array.from({ length: 500 }, (_, index) => ({
				name: `definition-${String(index).padStart(4, "0")}`,
				user: true,
				project: false,
				ambiguous: false,
			})),
	};
	initTheme(undefined, false);
	registerWorkflowExtension(host as unknown as ExtensionAPI, dependencies);

	assert.ok(tool);
	assert.equal(
		Check(tool.parameters, {
			source: { kind: "inline", definition: definition() },
			args: {},
		}),
		true,
	);
	assert.equal(
		Check(tool.parameters, {
			source: { kind: "saved", name: "extension-test" },
			args: {},
		}),
		true,
	);
	for (const source of [
		{ kind: "inline" },
		{ kind: "saved" },
		{ kind: "inline", name: "extension-test" },
		{ kind: "saved", definition: definition() },
		{ kind: "path", path: pathDefinition },
	]) {
		assert.equal(Check(tool.parameters, { source, args: {} }), false);
	}
	assert.deepEqual([...commands.keys()], ["pi-workflow"]);
	assert.equal(commands.has("resume"), false);
	assert.equal(commands.has("detach"), false);
	let branchGetterCalls = 0;
	const hostileBranchEntry = {};
	Object.defineProperty(hostileBranchEntry, "type", {
		enumerable: true,
		get: () => {
			branchGetterCalls += 1;
			return "custom";
		},
	});
	let branchEntries: readonly unknown[] = [
		...Array.from({ length: 3_000 }, () => ({ type: "message" })),
		hostileBranchEntry,
	];
	const ctx: FakeContext = {
		cwd,
		mode: "print",
		hasUI: false,
		sessionManager: {
			getSessionId: () => "session-1",
			getBranch: () => branchEntries,
		},
		ui: {
			notify: (message) => notifications.push(message),
			setStatus: () => undefined,
		},
	};
	await handlers.get("session_start")?.(
		{ type: "session_start", reason: "startup" },
		ctx,
	);
	assert.equal(branchGetterCalls, 0);
	branchEntries = [];

	const signal = new AbortController().signal;
	const result = await tool.execute(
		"tool-call-1",
		{ source: { kind: "inline", definition: definition() }, args: {} },
		signal,
		(update) => updates.push(update),
		ctx,
	);
	assert.equal(requests[0]?.invocation, "tool");
	assert.equal(requests[0]?.toolCallId, "tool-call-1");
	assert.equal(requests[0]?.signal, signal);
	assert.equal(requests[0]?.source.sourceKind, "inline");
	assert.match(result.content[0]?.text ?? "", /\{"literal":true\}/);
	assert.doesNotMatch(JSON.stringify(result.details), /\{"literal":true\}/);
	assert.match(JSON.stringify(result.details), /"terminal"/);
	assert.deepEqual(result.usage, {
		input: 1,
		output: 2,
		cacheRead: 3,
		cacheWrite: 4,
		totalTokens: 10,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 },
	});
	assert.equal(updates.length, 1);
	assert.equal(entries.length, 2);
	assert.equal(entries[0]?.type, "pi-subagents-workflows.run");
	assert.deepEqual(createdServiceCwds, [cwd]);

	const movedCwd = join(root, "moved-project");
	await mkdir(movedCwd);
	const movedCtx: FakeContext = { ...ctx, cwd: movedCwd };
	await tool.execute(
		"tool-call-moved-cwd",
		{ source: { kind: "inline", definition: definition() }, args: {} },
		signal,
		undefined,
		movedCtx,
	);
	assert.deepEqual(createdServiceCwds, [cwd, movedCwd]);

	await tool.execute(
		"tool-call-saved",
		{ source: { kind: "saved", name: "extension-test" }, args: {} },
		signal,
		undefined,
		ctx,
	);
	assert.equal(requests[2]?.source.sourceKind, "saved-user");

	const deniedPath = await tool.execute(
		"tool-call-path",
		{ source: { kind: "path", path: pathDefinition }, args: {} },
		signal,
		undefined,
		ctx,
	);
	assert.equal(deniedPath.isError, true);
	assert.match(
		deniedPath.content[0]?.text ?? "",
		/path.*(?:not available|not allowed)|path capability/i,
	);
	executeFailure = new Error("provider setup failed 😀 ".repeat(500));
	const setupFailure = await tool.execute(
		"tool-call-failure",
		{ source: { kind: "inline", definition: definition() }, args: {} },
		signal,
		undefined,
		ctx,
	);
	assert.equal(setupFailure.isError, true);
	assert.ok(
		Buffer.byteLength(setupFailure.content[0]?.text ?? "", "utf8") <= 2_080,
	);
	assert.match(JSON.stringify(setupFailure.details), /workflow_extension_error/);
	let errorGetterCalls = 0;
	const hostileError = (): Error => {
		const error = new Error();
		Object.defineProperty(error, "message", {
			configurable: true,
			get: () => {
				errorGetterCalls += 1;
				throw new Error("message getter executed");
			},
		});
		return error;
	};
	executeFailure = hostileError();
	const hostileToolFailure = await tool.execute(
		"tool-call-hostile-error",
		{ source: { kind: "inline", definition: definition() }, args: {} },
		signal,
		undefined,
		ctx,
	);
	assert.equal(hostileToolFailure.isError, true);
	assert.match(hostileToolFailure.content[0]?.text ?? "", /operation failed/);
	assert.equal(errorGetterCalls, 0);
	await commands
		.get("pi-workflow")
		?.handler(`run --path "${pathDefinition}"`, ctx);
	assert.equal(requests[3]?.invocation, "command");
	assert.equal(requests[3]?.toolCallId, undefined);
	assert.equal(requests[3]?.source.sourceKind, "path");
	executeFailure = hostileError();
	await commands
		.get("pi-workflow")
		?.handler(`run --path "${pathDefinition}"`, ctx);
	assert.match(notifications.at(-1) ?? "", /operation failed/);
	assert.equal(errorGetterCalls, 0);

	let releaseExecution: () => void = () => undefined;
	executionGate = new Promise<void>((resolve) => {
		releaseExecution = resolve;
	});
	let modalClosed: () => void = () => undefined;
	const didCloseModal = new Promise<void>((resolve) => {
		modalClosed = resolve;
	});
	const tuiCtx = {
		...ctx,
		mode: "tui",
		hasUI: true,
		ui: {
			...ctx.ui,
			custom: async (
				factory: (
					tui: { requestRender(): void },
					theme: { fg(color: string, text: string): string },
					keybindings: unknown,
					done: (value: unknown) => void,
				) => { handleInput(data: string): void; dispose?(): void },
			) => {
				let finish: (value: unknown) => void = () => undefined;
				const result = new Promise<unknown>((resolve) => {
					finish = resolve;
				});
				const component = factory(
					{ requestRender: () => undefined },
					{ fg: (_color, text) => text },
					{},
					finish,
				);
				component.handleInput("\u001b");
				const value = await result;
				modalClosed();
				component.dispose?.();
				return value;
			},
		},
	};
	const tuiCommand = commands
		.get("pi-workflow")
		?.handler(`run --path "${pathDefinition}"`, tuiCtx);
	let modalTimer: ReturnType<typeof setTimeout> | undefined;
	const closedBeforeCleanup = await Promise.race([
		didCloseModal.then(() => true),
		new Promise<boolean>((resolve) => {
			modalTimer = setTimeout(() => resolve(false), 100);
		}),
	]);
	if (modalTimer !== undefined) clearTimeout(modalTimer);
	releaseExecution();
	executionGate = undefined;
	await tuiCommand;
	assert.equal(closedBeforeCleanup, true);
	assert.equal(requests[4]?.signal?.aborted, true);

	exposeActiveRun = true;
	await commands.get("pi-workflow")?.handler("cancel run-host", ctx);
	assert.deepEqual(cancelled, ["run-host"]);
	await commands.get("pi-workflow")?.handler("list", ctx);
	const listNotification = notifications.at(-1) ?? "";
	assert.ok(Buffer.byteLength(listNotification, "utf8") <= 16 * 1024);
	assert.match(listNotification, /more omitted/);

	let releaseResolution: () => void = () => undefined;
	resolutionGate = new Promise<void>((resolve) => {
		releaseResolution = resolve;
	});
	const didEnterResolution = new Promise<void>((resolve) => {
		resolutionEntered = resolve;
	});
	const staleInvocation = tool.execute(
		"tool-call-stale-session",
		{ source: { kind: "inline", definition: definition() }, args: {} },
		signal,
		undefined,
		ctx,
	);
	await didEnterResolution;
	const servicesBeforeShutdown = createdServiceCwds.length;
	await handlers.get("session_shutdown")?.(
		{ type: "session_shutdown", reason: "reload" },
		ctx,
	);
	releaseResolution();
	resolutionGate = undefined;
	const staleResult = await staleInvocation;
	assert.equal(staleResult.isError, true);
	assert.match(staleResult.content[0]?.text ?? "", /shut down|stale/i);
	assert.equal(createdServiceCwds.length, servicesBeforeShutdown);
	assert.equal(shutdownCount, 1);
	assert.ok(notifications.some((message) => /succeeded/i.test(message)));
});
