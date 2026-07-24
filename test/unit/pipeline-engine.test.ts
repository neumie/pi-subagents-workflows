import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "node:test";

import {
	executeWorkflow,
	parseWorkflowDefinition,
	type LeafRunner,
	type PipelineStepOutcomeV1,
	type WorkflowEventV1,
} from "../../src/index.ts";

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

function stage(
	id: string,
	prompt: { template: string; values: Record<string, unknown> } = {
		template: id,
		values: {},
	},
	overrides: Record<string, unknown> = {},
) {
	return {
		id,
		agent: "worker",
		prompt,
		output: { mode: "text" },
		limits: { timeoutMs: 5_000, maxTurns: 3, maxToolCalls: 4 },
		...overrides,
	};
}

function pipelineDefinition(
	options: {
		itemsMaximum?: number;
		maxItems?: number;
		maxCalls?: number;
		concurrency?: number;
		stages?: ReturnType<typeof stage>[];
		itemSchema?: unknown;
		steps?: unknown[];
		result?: Record<string, unknown>;
	} = {},
) {
	const stages = options.stages ?? [stage("first"), stage("second")];
	const pipeline = {
		type: "pipeline",
		id: "lanes",
		items: { ref: "arg", name: "items" },
		onFailure: "stop-item",
		stages,
	};
	return parseWorkflowDefinition({
		version: 1,
		id: "pipeline-workflow",
		args: {
			items: {
				type: "array",
				items: options.itemSchema ?? { type: "string" },
				maxItems: options.itemsMaximum ?? 4,
			},
		},
		limits: {
			concurrency: options.concurrency ?? 2,
			maxCalls: options.maxCalls ?? 20,
			maxItems: options.maxItems ?? 4,
		},
		steps: options.steps ?? [pipeline],
		result: options.result ?? { ref: "step", stepId: "lanes" },
	});
}

function agent(
	id: string,
	prompt: { template: string; values: Record<string, unknown> } = {
		template: id,
		values: {},
	},
) {
	return {
		type: "agent",
		id,
		agent: "worker",
		prompt,
		output: { mode: "text" },
		limits: { timeoutMs: 5_000, maxTurns: 3, maxToolCalls: 4 },
	};
}

function completed(text: string, overrides: Record<string, unknown> = {}) {
	return {
		status: "completed" as const,
		result: { mode: "text" as const, text },
		usage,
		...overrides,
	};
}

function pipelineAt(
	outcome: Awaited<ReturnType<typeof executeWorkflow>>,
	index = 0,
): PipelineStepOutcomeV1 {
	const stepOutcome = outcome.steps[index];
	if (stepOutcome?.type !== "pipeline")
		throw new Error(`missing pipeline step ${index}`);
	return stepOutcome;
}

test("pipeline advances each item locally without a stage-wide barrier and keeps each lane serial", async () => {
	const definition = pipelineDefinition();
	const starts: string[] = [];
	let releaseItem0First!: () => void;
	let releaseItem1First!: () => void;
	const runner: LeafRunner = async (request) => {
		const key = `${request.identity.itemIndex}:${request.identity.stageId}`;
		starts.push(key);
		if (key === "0:first")
			await new Promise<void>((resolve) => (releaseItem0First = resolve));
		if (key === "1:first")
			await new Promise<void>((resolve) => (releaseItem1First = resolve));
		return completed(key);
	};

	const execution = executeWorkflow(
		definition,
		{ items: ["zero", "one"] },
		runner,
		{},
	);
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(starts, ["0:first", "1:first"]);

	releaseItem0First();
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(starts, ["0:first", "1:first", "0:second"]);
	assert.equal(
		starts.includes("1:second"),
		false,
		"a lane must not start its second stage before its own first stage settles",
	);

	releaseItem1First();
	const outcome = await execution;
	assert.deepEqual(starts, ["0:first", "1:first", "0:second", "1:second"]);
	assert.equal(outcome.status, "succeeded");
	assert.deepEqual(
		pipelineAt(outcome).items.map((item) =>
			item.stages.map((leaf) => [leaf.identity.itemIndex, leaf.identity.stageId]),
		),
		[
			[
				[0, "first"],
				[0, "second"],
			],
			[
				[1, "first"],
				[1, "second"],
			],
		],
	);
});

test("an over-cap pipeline terminal stops its lane before the next stage dispatches", async () => {
	const maximumUsageValue = Math.floor(Number.MAX_SAFE_INTEGER / 3);
	const calls: string[] = [];
	const outcome = await executeWorkflow(
		pipelineDefinition({
			maxCalls: 3,
			maxItems: 1,
			itemsMaximum: 1,
			stages: [stage("first"), stage("second"), stage("third")],
		}),
		{ items: ["only"] },
		async (request) => {
			const stageId = request.identity.stageId!;
			calls.push(stageId);
			return completed(stageId, {
				usage: {
					...usage,
					input:
						stageId === "first" ? maximumUsageValue : maximumUsageValue + 1,
				},
			});
		},
		{},
	);

	const item = pipelineAt(outcome).items[0]!;
	assert.deepEqual(calls, ["first", "second"]);
	assert.equal(outcome.status, "succeeded");
	assert.equal(item.status, "failed");
	assert.deepEqual(
		item.stages.map((leaf) => [
			leaf.identity.stageId,
			leaf.status,
			leaf.status === "failed" ? leaf.error.code : undefined,
			leaf.status === "skipped" ? leaf.reason : undefined,
		]),
		[
			["first", "succeeded", undefined, undefined],
			["second", "failed", "provider_contract_violation", undefined],
			["third", "skipped", undefined, "upstream_failed"],
		],
	);
	assert.deepEqual(outcome.usage, { ...usage, input: maximumUsageValue });
	assert.deepEqual(outcome.counters, {
		reservedCallSlots: 3,
		actualLeafCalls: 2,
		admittedItems: 1,
	});
});

test("pipeline group metadata emits once and stage metadata carries stable item/stage identity", async () => {
	const definition = pipelineDefinition({
		stages: [
			stage("only", { template: "only", values: {} }, {
				meta: { phase: "stage-phase", log: "stage-log" },
			}),
		],
		steps: [
			{
				type: "pipeline",
				id: "lanes",
				items: { ref: "arg", name: "items" },
				onFailure: "stop-item",
				meta: { phase: "group-phase", log: "group-log" },
				stages: [
					stage("only", { template: "only", values: {} }, {
						meta: { phase: "stage-phase", log: "stage-log" },
					}),
				],
			},
		],
	});
	const events: WorkflowEventV1[] = [];
	const outcome = await executeWorkflow(
		definition,
		{ items: ["a", "b"] },
		async (request) => completed(request.prompt),
		{
			onEvent(event) {
				events.push(event);
			},
		},
	);

	assert.equal(outcome.status, "succeeded");
	assert.deepEqual(
		events
			.filter((event) => event.type === "phase" || event.type === "log")
			.map((event) => ({
				type: event.type,
				phase:
					event.type === "phase"
						? event.phase
						: event.type === "log"
							? event.message
							: undefined,
				itemIndex: "itemIndex" in event ? event.itemIndex : undefined,
				stageIndex: "stageIndex" in event ? event.stageIndex : undefined,
				stageId: "stageId" in event ? event.stageId : undefined,
			})),
		[
			{ type: "phase", phase: "group-phase", itemIndex: undefined, stageIndex: undefined, stageId: undefined },
			{ type: "log", phase: "group-log", itemIndex: undefined, stageIndex: undefined, stageId: undefined },
			{ type: "phase", phase: "stage-phase", itemIndex: 0, stageIndex: 0, stageId: "only" },
			{ type: "phase", phase: "stage-phase", itemIndex: 1, stageIndex: 0, stageId: "only" },
			{ type: "log", phase: "stage-log", itemIndex: 0, stageIndex: 0, stageId: "only" },
			{ type: "log", phase: "stage-log", itemIndex: 1, stageIndex: 0, stageId: "only" },
		],
	);
});

test("pipeline identities and item/index/previous bindings preserve exact values without a second interpolation pass", async () => {
	const structuredStage = stage(
		"inspect",
		{
			template: "item={{item}}|index={{index}}",
			values: { item: { ref: "item" }, index: { ref: "index" } },
		},
		{
			output: {
				mode: "structured",
				schema: {
					type: "object",
					properties: { answer: { type: "string" } },
					required: ["answer"],
					additionalProperties: false,
				},
			},
		},
	);
	const verifyStage = stage("verify", {
		template: "original={{item}}|index={{index}}|previous={{previous}}|again={{previous}}",
		values: {
			item: { ref: "item" },
			index: { ref: "index" },
			previous: { ref: "previous" },
		},
	});
	const definition = pipelineDefinition({
		stages: [structuredStage, verifyStage],
		itemSchema: {
			type: "object",
			properties: {
				z: { type: "string" },
				a: { type: "number" },
			},
			required: ["z", "a"],
			additionalProperties: false,
		},
	});
	const prompts: string[] = [];
	const outcome = await executeWorkflow(
		definition,
		{ items: [{ z: "{{previous}}", a: 1 }] },
		async (request) => {
			prompts.push(request.prompt);
			assert.deepEqual(request.identity, {
				runId: request.identity.runId,
				nodeId: `pipeline:lanes:item:0:stage:${request.identity.stageId}`,
				stepId: "lanes",
				itemIndex: 0,
				stageIndex: request.identity.stageId === "inspect" ? 0 : 1,
				stageId: request.identity.stageId,
			});
			return request.identity.stageId === "inspect"
				? {
						status: "completed",
						result: {
							mode: "structured",
							value: { answer: "{{item}}" },
						},
						usage,
					}
				: completed("verified");
		},
		{},
	);

	assert.deepEqual(prompts, [
		'item={"a":1,"z":"{{previous}}"}|index=0',
		'original={"a":1,"z":"{{previous}}"}|index=0|previous={"answer":"{{item}}"}|again={"answer":"{{item}}"}',
	]);
	assert.equal(pipelineAt(outcome).items[0]?.status, "succeeded");
	assert.deepEqual(outcome.counters, {
		reservedCallSlots: 2,
		actualLeafCalls: 2,
		admittedItems: 1,
	});
});

test("a failed lane stops with upstream skips while peers continue, and terminals/accounting stay source aligned", async () => {
	let failItem0!: (value: Awaited<ReturnType<LeafRunner>>) => void;
	const calls: string[] = [];
	const terminalOrder: string[] = [];
	const execution = executeWorkflow(
		pipelineDefinition(),
		{ items: ["zero", "one"] },
		async (request) => {
			const key = `${request.identity.itemIndex}:${request.identity.stageId}`;
			calls.push(key);
			if (key === "0:first")
				return new Promise((resolve) => (failItem0 = resolve));
			return completed(key, {
				usage: { ...usage, input: request.identity.stageId === "first" ? 2 : 3 },
			});
		},
		{
			onEvent(event) {
				if (event.type === "leaf_terminal")
					terminalOrder.push(
						`${event.outcome.identity.itemIndex}:${event.outcome.identity.stageId}`,
					);
			},
		},
	);
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(calls, ["0:first", "1:first", "1:second"]);
	assert.deepEqual(terminalOrder, []);
	failItem0({
		status: "failed",
		error: { code: "ordinary", message: "lane failed", retryable: false },
		usage: { ...usage, input: 1 },
	});
	const outcome = await execution;

	assert.deepEqual(calls, ["0:first", "1:first", "1:second"]);
	assert.deepEqual(
		pipelineAt(outcome).items.map((item) => ({
			index: item.index,
			status: item.status,
			stages: item.stages.map((leaf) =>
				leaf.status === "skipped" ? leaf.reason : leaf.status,
			),
		})),
		[
			{ index: 0, status: "failed", stages: ["failed", "upstream_failed"] },
			{ index: 1, status: "succeeded", stages: ["succeeded", "succeeded"] },
		],
	);
	assert.deepEqual(terminalOrder, [
		"0:first",
		"0:second",
		"1:first",
		"1:second",
	]);
	assert.deepEqual(outcome.usage, { ...usage, input: 6 });
	assert.equal(outcome.status, "succeeded", "a final group retains partial failures");
});

test("pipeline stages use the shared fair FIFO semaphore", async () => {
	const starts: string[] = [];
	const outcome = await executeWorkflow(
		pipelineDefinition({ concurrency: 1 }),
		{ items: ["zero", "one", "two"] },
		async (request) => {
			starts.push(`${request.identity.itemIndex}:${request.identity.stageId}`);
			return completed("ok");
		},
		{},
	);
	assert.equal(outcome.status, "succeeded");
	assert.deepEqual(starts, [
		"0:first",
		"1:first",
		"2:first",
		"0:second",
		"1:second",
		"2:second",
	]);
});

test("dynamic maxItems and maxCalls admission rejects atomically and later top-level work continues", async () => {
	const pipeline = {
		type: "pipeline",
		id: "lanes",
		items: { ref: "arg", name: "items" },
		onFailure: "stop-item",
		stages: [stage("first"), stage("second")],
	};
	for (const [kind, definition] of [
		[
			"items",
			pipelineDefinition({
				maxItems: 1,
				maxCalls: 3,
				steps: [pipeline, agent("after")],
				result: { ref: "step", stepId: "lanes" },
			}),
		],
		[
			"calls",
			pipelineDefinition({
				maxItems: 4,
				maxCalls: 4,
				steps: [agent("before"), pipeline, agent("after")],
				result: { ref: "step", stepId: "lanes" },
			}),
		],
	] as const) {
		const calls: string[] = [];
		const outcome = await executeWorkflow(
			definition,
			{ items: ["zero", "one"] },
			async (request) => {
				calls.push(request.identity.stepId);
				return completed("ok");
			},
			{},
		);
		const pipelineIndex = kind === "items" ? 0 : 1;
		const group = pipelineAt(outcome, pipelineIndex);
		assert.equal(group.error?.code, "limit_exceeded");
		assert.equal(
			group.items.every((item) =>
				item.stages.every(
					(leaf) => leaf.status === "skipped" && leaf.reason === "not_admitted",
				),
			),
			true,
		);
		assert.deepEqual(calls, kind === "items" ? ["after"] : ["before", "after"]);
		assert.deepEqual(outcome.counters, {
			reservedCallSlots: kind === "items" ? 1 : 2,
			actualLeafCalls: kind === "items" ? 1 : 2,
			admittedItems: 0,
		});
		assert.equal(outcome.status, "succeeded");
		assert.equal(outcome.result?.outcome, group);
	}
});

test("maxItems is cumulative across pipelines and a rejected pipeline remains available as a group reference", async () => {
	const pipeline = (id: string, items: string, stageId: string) => ({
		type: "pipeline",
		id,
		items: { ref: "arg", name: items },
		onFailure: "stop-item",
		stages: [stage(stageId)],
	});
	const definition = parseWorkflowDefinition({
		version: 1,
		id: "cumulative-items",
		args: {
			firstItems: { type: "array", items: { type: "string" }, maxItems: 2 },
			secondItems: { type: "array", items: { type: "string" }, maxItems: 2 },
		},
		limits: { concurrency: 2, maxCalls: 10, maxItems: 3 },
		steps: [
			pipeline("firstPipeline", "firstItems", "stageA"),
			pipeline("secondPipeline", "secondItems", "stageB"),
			agent("consumer", {
				template: "group={{group}}",
				values: { group: { ref: "step", stepId: "secondPipeline" } },
			}),
		],
		result: { ref: "step", stepId: "secondPipeline" },
	});
	const prompts = new Map<string, string>();
	const outcome = await executeWorkflow(
		definition,
		{ firstItems: ["a", "b"], secondItems: ["c", "d"] },
		async (request) => {
			prompts.set(
				`${request.identity.stepId}:${request.identity.itemIndex ?? "agent"}`,
				request.prompt,
			);
			return completed("ok");
		},
		{},
	);

	assert.equal(pipelineAt(outcome, 1).error?.code, "limit_exceeded");
	assert.deepEqual(outcome.counters, {
		reservedCallSlots: 3,
		actualLeafCalls: 3,
		admittedItems: 2,
	});
	assert.equal(prompts.has("secondPipeline:0"), false);
	assert.equal(
		prompts.get("consumer:agent"),
		'group={"items":[{"index":0,"stages":[{"error":{"code":"not_admitted","message":"leaf skipped: not_admitted"},"stageId":"stageB","status":"skipped"}],"status":"skipped"},{"index":1,"stages":[{"error":{"code":"not_admitted","message":"leaf skipped: not_admitted"},"stageId":"stageB","status":"skipped"}],"status":"skipped"}]}',
	);
	assert.equal(outcome.status, "succeeded");
});

test("an empty admitted pipeline succeeds with no calls and a complete empty group outcome", async () => {
	let calls = 0;
	const outcome = await executeWorkflow(
		pipelineDefinition(),
		{ items: [] },
		async () => {
			calls += 1;
			return completed("unexpected");
		},
		{},
	);
	assert.equal(outcome.status, "succeeded");
	assert.deepEqual(pipelineAt(outcome).items, []);
	assert.equal(outcome.result?.outcome, outcome.steps[0]);
	assert.equal(calls, 0);
	assert.deepEqual(outcome.counters, {
		reservedCallSlots: 0,
		actualLeafCalls: 0,
		admittedItems: 0,
	});
});

test("pipeline group projection is canonical, bounded, and omits provider and usage metadata", async () => {
	const pipeline = {
		type: "pipeline",
		id: "lanes",
		items: { ref: "arg", name: "items" },
		onFailure: "stop-item",
		stages: [stage("first"), stage("second")],
	};
	const consumer = agent("consumer", {
		template: "group={{group}}",
		values: { group: { ref: "step", stepId: "lanes" } },
	});
	const definition = pipelineDefinition({
		maxCalls: 5,
		steps: [pipeline, consumer],
		result: { ref: "step", stepId: "consumer" },
	});
	let consumerPrompt = "";
	const outcome = await executeWorkflow(
		definition,
		{ items: ["zero", "one"] },
		async (request) => {
			if (request.identity.stepId === "consumer") {
				consumerPrompt = request.prompt;
				return completed("summary");
			}
			const key = `${request.identity.itemIndex}:${request.identity.stageId}`;
			if (key === "0:second") {
				return {
					status: "failed",
					error: { code: "ordinary", message: "nope", retryable: false },
					usage: { ...usage, input: 7 },
					model: "hidden-model",
				};
			}
			return completed(key === "0:first" ? "A" : key === "1:first" ? "B" : "C", {
				usage: { ...usage, output: 2 },
				model: "also-hidden",
			});
		},
		{},
	);

	assert.equal(
		consumerPrompt,
		'group={"items":[{"index":0,"stages":[{"stageId":"first","status":"succeeded","value":"A"},{"error":{"code":"ordinary","message":"nope"},"stageId":"second","status":"failed"}],"status":"failed"},{"index":1,"stages":[{"stageId":"first","status":"succeeded","value":"B"},{"stageId":"second","status":"succeeded","value":"C"}],"status":"succeeded"}]}',
	);
	assert.equal(outcome.status, "succeeded");
	assert.deepEqual(outcome.usage, { ...usage, input: 7, output: 6 });
});

test("an oversized pipeline projection skips its consumer without another runner call", async () => {
	const pipeline = {
		type: "pipeline",
		id: "lanes",
		items: { ref: "arg", name: "items" },
		onFailure: "stop-item",
		stages: [stage("first"), stage("second")],
	};
	const definition = pipelineDefinition({
		maxCalls: 9,
		steps: [
			pipeline,
			agent("consumer", {
				template: "{{group}}",
				values: { group: { ref: "step", stepId: "lanes" } },
			}),
		],
		result: { ref: "step", stepId: "consumer" },
	});
	const calls: string[] = [];
	const outcome = await executeWorkflow(
		definition,
		{ items: ["a", "b", "c", "d"] },
		async (request) => {
			calls.push(request.identity.stepId);
			return completed("x".repeat(40 * 1024));
		},
		{},
	);
	assert.equal(calls.length, 8);
	assert.equal(calls.includes("consumer"), false);
	const consumerOutcome = outcome.steps[1];
	assert.equal(consumerOutcome?.type, "agent");
	if (consumerOutcome?.type === "agent") {
		assert.equal(consumerOutcome.leaf.status, "skipped");
		assert.equal(
			consumerOutcome.leaf.status === "skipped"
				? consumerOutcome.leaf.reason
				: undefined,
			"prompt_too_large",
		);
	}
});

test("caller cancellation aligns active, queued, and not-yet-reached pipeline stages and removes listeners", async () => {
	const controller = new AbortController();
	let activeSignal: AbortSignal | undefined;
	let started!: () => void;
	const didStart = new Promise<void>((resolve) => (started = resolve));
	const execution = executeWorkflow(
		pipelineDefinition({ concurrency: 1 }),
		{ items: ["zero", "one"] },
		async (request) => {
			activeSignal = request.signal;
			started();
			return new Promise(() => undefined);
		},
		{ signal: controller.signal },
	);
	await didStart;
	controller.abort("caller");
	const outcome = await execution;

	assert.equal(outcome.status, "cancelled");
	assert.equal(activeSignal?.aborted, true);
	assert.deepEqual(
		pipelineAt(outcome).items.map((item) =>
			item.stages.map((leaf) =>
				leaf.status === "skipped" ? leaf.reason : leaf.status,
			),
		),
		[
			["cancelled", "cancelled"],
			["cancelled", "cancelled"],
		],
	);
	assert.deepEqual(outcome.counters, {
		reservedCallSlots: 4,
		actualLeafCalls: 1,
		admittedItems: 2,
	});
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("a hook failure aborts all pipeline lanes and preserves complete typed alignment", async () => {
	const signals: AbortSignal[] = [];
	const outcome = await executeWorkflow(
		pipelineDefinition(),
		{ items: ["zero", "one"] },
		async (request) => {
			signals.push(request.signal);
			if (request.identity.itemIndex === 0)
				await request.progress({ message: "break-hook" });
			return new Promise(() => undefined);
		},
		{
			onEvent(event) {
				if (event.type === "leaf_progress") throw new Error("hook exploded");
			},
		},
	);
	assert.equal(outcome.status, "failed");
	assert.equal(outcome.error?.code, "hook_error");
	assert.equal(pipelineAt(outcome).items.length, 2);
	assert.equal(
		pipelineAt(outcome).items.every((item) => item.stages.length === 2),
		true,
	);
	assert.equal(signals.every((signal) => signal.aborted), true);
});

test("a timed-out pipeline stage releases its permit and a late runner settlement is ignored", async () => {
	const timedStage = stage("only", { template: "only", values: {} }, {
		limits: { timeoutMs: 1_000, maxTurns: 3, maxToolCalls: 4 },
	});
	let resolveLate!: (value: Awaited<ReturnType<LeafRunner>>) => void;
	const starts: number[] = [];
	const events: WorkflowEventV1[] = [];
	const outcome = await executeWorkflow(
		pipelineDefinition({ concurrency: 1, stages: [timedStage] }),
		{ items: ["zero", "one"] },
		async (request) => {
			starts.push(request.identity.itemIndex!);
			if (request.identity.itemIndex === 0)
				return new Promise((resolve) => (resolveLate = resolve));
			return completed("one", { usage: { ...usage, input: 2 } });
		},
		{
			onEvent(event) {
				events.push(event);
			},
		},
	);
	assert.deepEqual(starts, [0, 1]);
	assert.deepEqual(
		pipelineAt(outcome).items.map((item) => item.status),
		["timed_out", "succeeded"],
	);
	assert.deepEqual(outcome.usage, { ...usage, input: 2 });
	const eventCount = events.length;
	resolveLate(completed("late", { usage: { ...usage, input: 99 } }));
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(events.length, eventCount);
	assert.deepEqual(outcome.usage, { ...usage, input: 2 });
});
