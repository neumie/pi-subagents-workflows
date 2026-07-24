import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "node:test";

import {
	executeWorkflow,
	parseWorkflowDefinition,
	type LeafOutcomeV1,
	type LeafRunner,
	type LeafRunnerStatusV1,
	type WorkflowEventV1,
	type WorkflowOutcomeV1,
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

function definition(overrides: Record<string, unknown> = {}) {
	return {
		version: 1,
		id: "sequential",
		args: { topic: { type: "string", minLength: 1 } },
		limits: { concurrency: 1, maxCalls: 10, maxItems: 1 },
		steps: [
			{
				type: "agent",
				id: "draft",
				agent: "writer",
				prompt: {
					template: "Write {{topic}}",
					values: { topic: { ref: "arg", name: "topic" } },
				},
				output: { mode: "text" },
				limits: { timeoutMs: 1_000, maxTurns: 3, maxToolCalls: 4 },
			},
		],
		result: { ref: "step", stepId: "draft" },
		...overrides,
	};
}

function leafAt(outcome: WorkflowOutcomeV1, index: number): LeafOutcomeV1 {
	const step = outcome.steps[index];
	if (step?.type !== "agent") throw new Error(`missing agent step ${index}`);
	return step.leaf;
}

function agent(
	id: string,
	prompt: Record<string, unknown>,
	overrides: Record<string, unknown> = {},
) {
	return {
		type: "agent",
		id,
		agent: "writer",
		prompt,
		output: { mode: "text" },
		limits: { timeoutMs: 1_000, maxTurns: 3, maxToolCalls: 4 },
		...overrides,
	};
}

function parsedSequential(
	steps: unknown[],
	resultStepId: string,
	args: Record<string, unknown> = {},
) {
	return parseWorkflowDefinition({
		version: 1,
		id: "sequence",
		args,
		limits: {
			concurrency: 1,
			maxCalls: Math.max(steps.length, 1),
			maxItems: 1,
		},
		steps,
		result: { ref: "step", stepId: resultStepId },
	});
}

test("rejects programmer misuse and returns typed invalid arguments without calling a leaf", async () => {
	const runner = async () =>
		({
			status: "completed",
			result: { mode: "text", text: "ok" },
			usage,
		}) as const;

	assert.throws(
		() => executeWorkflow(definition() as never, { topic: "x" }, runner, {}),
		/parsed workflow definition/,
	);
	assert.throws(
		() =>
			executeWorkflow(
				parseWorkflowDefinition(definition()),
				{ topic: "x" },
				null as never,
				{},
			),
		/LeafRunner/,
	);

	let calls = 0;
	const outcome = await executeWorkflow(
		parseWorkflowDefinition(definition()),
		{},
		async () => {
			calls += 1;
			return {
				status: "completed",
				result: { mode: "text", text: "ok" },
				usage,
			};
		},
		{},
	);

	assert.equal(calls, 0);
	assert.equal(outcome.status, "failed");
	assert.equal(outcome.error?.code, "invalid_arguments");
	assert.deepEqual(outcome.steps, []);
	assert.deepEqual(outcome.counters, {
		reservedCallSlots: 0,
		actualLeafCalls: 0,
		admittedItems: 0,
	});

	for (const invalid of [{ topic: "x", unknown: true }, { topic: "" }, null]) {
		const rejected = await executeWorkflow(
			parseWorkflowDefinition(definition()),
			invalid,
			async () => {
				calls += 1;
				return {
					status: "completed",
					result: { mode: "text", text: "unexpected" },
					usage,
				};
			},
			{},
		);
		assert.equal(rejected.error?.code, "invalid_arguments");
	}
	assert.equal(calls, 0);
});

test("renders arguments and prior values in one lexical pass and runs agents sequentially", async () => {
	const parsed = parsedSequential(
		[
			agent("draft", {
				template: "{{literal}}|{{count}}|{{flag}}|{{record}}",
				values: {
					literal: { ref: "arg", name: "literal" },
					count: { ref: "arg", name: "count" },
					flag: { ref: "arg", name: "flag" },
					record: { ref: "arg", name: "record" },
				},
			}),
			agent("final", {
				template: "Prior={{draft}}",
				values: { draft: { ref: "step", stepId: "draft" } },
			}),
		],
		"final",
		{
			literal: { type: "string" },
			count: { type: "number" },
			flag: { type: "boolean" },
			record: {
				type: "object",
				properties: { z: { type: "number" }, a: { type: "string" } },
				required: ["z", "a"],
				additionalProperties: false,
			},
		},
	);

	const prompts: string[] = [];
	let active = 0;
	const runner: LeafRunner = async (request) => {
		active += 1;
		assert.equal(active, 1);
		prompts.push(request.prompt);
		assert.equal(request.identity.nodeId, `step:${request.identity.stepId}`);
		assert.equal(request.limits.maxTurns, 3);
		assert.equal(request.output.mode, "text");
		active -= 1;
		return request.identity.stepId === "draft"
			? {
					status: "completed",
					result: { mode: "text", text: '{"looks":"{{literal}}"}' },
					usage,
				}
			: {
					status: "completed",
					result: { mode: "text", text: "selected" },
					usage,
				};
	};

	const outcome = await executeWorkflow(
		parsed,
		{
			literal: "{{count}}",
			count: -0,
			flag: true,
			record: { z: 2, a: "x" },
		},
		runner,
		{},
	);

	assert.deepEqual(prompts, [
		'{{count}}|0|true|{"a":"x","z":2}',
		'Prior={"looks":"{{literal}}"}',
	]);
	assert.equal(outcome.status, "succeeded");
	assert.equal(
		outcome.result !== null && "status" in outcome.result.outcome
			? outcome.result.outcome.status
			: undefined,
		"succeeded",
	);
	assert.deepEqual(outcome.counters, {
		reservedCallSlots: 2,
		actualLeafCalls: 2,
		admittedItems: 0,
	});
});

test("keeps every provider terminal status distinct and aggregates accepted usage", async () => {
	const statuses: Exclude<LeafRunnerStatusV1, "completed">[] = [
		"failed",
		"timed_out",
		"cancelled",
		"interrupted",
		"turn_budget_exhausted",
		"tool_budget_exhausted",
		"duplicate_node",
		"invalid_request",
		"unavailable_context",
	];
	const terminalUsage = {
		...usage,
		input: 2,
		output: 3,
		cost: 0.25,
		turns: 1,
		toolCalls: 1,
		durationMs: 9,
	};

	for (const status of statuses) {
		const outcome = await executeWorkflow(
			parseWorkflowDefinition(definition()),
			{ topic: "x" },
			async () =>
				status === "failed"
					? {
							status,
							error: {
								code: "provider_failed",
								message: "no",
								retryable: false,
							},
							usage: terminalUsage,
						}
					: { status, usage: terminalUsage },
			{},
		);
		assert.equal(leafAt(outcome, 0).status, status);
		assert.deepEqual(outcome.usage, terminalUsage);
		assert.equal(outcome.status, "failed");
	}
});

test("validates structured results, usage, output mode, and leaf limit reports defensively", async () => {
	const parsed = parsedSequential(
		[
			agent(
				"only",
				{ template: "literal", values: {} },
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
			),
		],
		"only",
	);

	const invalidTerminals: unknown[] = [
		{
			status: "completed",
			result: { mode: "text", text: "wrong mode" },
			usage,
		},
		{
			status: "completed",
			result: { mode: "structured", value: { wrong: "field" } },
			usage,
		},
		{
			status: "completed",
			result: { mode: "structured", value: { answer: "ok" } },
			usage: { ...usage, input: -1 },
		},
		{
			status: "completed",
			result: { mode: "structured", value: { answer: "ok" } },
			usage: { ...usage, turns: 4 },
		},
		{
			status: "completed",
			result: { mode: "structured", value: { answer: "ok" } },
			usage: { ...usage, toolCalls: 5 },
		},
	];

	for (const terminal of invalidTerminals) {
		const outcome = await executeWorkflow(
			parsed,
			{},
			async () => terminal as never,
			{},
		);
		const leaf = leafAt(outcome, 0);
		assert.equal(leaf?.status, "failed");
		assert.equal(leaf?.error?.code, "provider_contract_violation");
		assert.deepEqual(outcome.usage, usage);
	}

	const valid = await executeWorkflow(
		parsed,
		{},
		async () => ({
			status: "completed",
			result: { mode: "structured", value: { answer: '{"literal":true}' } },
			usage: { ...usage, turns: 1 },
			model: "provider/model",
			thinking: "medium",
		}),
		{},
	);
	assert.equal(valid.status, "succeeded");
	const validLeaf = leafAt(valid, 0);
	assert.deepEqual(
		validLeaf.status === "succeeded" ? validLeaf.result : null,
		{
			mode: "structured",
			value: { answer: '{"literal":true}' },
		},
	);
	assert.equal(
		validLeaf.status === "succeeded" ? validLeaf.model : undefined,
		"provider/model",
	);
	assert.equal(
		validLeaf.status === "succeeded" ? validLeaf.thinking : undefined,
		"medium",
	);
});

test("skips failed references while continuing independent later agents", async () => {
	const parsed = parsedSequential(
		[
			agent("producer", { template: "fail", values: {} }),
			agent("dependent", {
				template: "Use {{producer}}",
				values: { producer: { ref: "step", stepId: "producer" } },
			}),
			agent("independent", {
				template: "Still {{topic}}",
				values: { topic: { ref: "arg", name: "topic" } },
			}),
		],
		"independent",
		{ topic: { type: "string" } },
	);
	const called: string[] = [];
	const outcome = await executeWorkflow(
		parsed,
		{ topic: "run" },
		async (request) => {
			called.push(request.identity.stepId);
			if (request.identity.stepId === "producer") {
				return {
					status: "failed",
					error: {
						code: "ordinary_failure",
						message: "failed",
						retryable: false,
					},
					usage: { ...usage, input: 1 },
				};
			}
			return {
				status: "completed",
				result: { mode: "text", text: "done" },
				usage: { ...usage, output: 2 },
			};
		},
		{},
	);

	assert.deepEqual(called, ["producer", "independent"]);
	const dependentLeaf = leafAt(outcome, 1);
	assert.equal(dependentLeaf.status, "skipped");
	assert.equal(
		dependentLeaf.status === "skipped" ? dependentLeaf.reason : "",
		"unavailable_reference",
	);
	assert.equal(outcome.status, "succeeded");
	assert.deepEqual(outcome.usage, { ...usage, input: 1, output: 2 });
	assert.deepEqual(outcome.counters, {
		reservedCallSlots: 3,
		actualLeafCalls: 2,
		admittedItems: 0,
	});
});

test("serializes bounded hook events and turns a throwing active hook into hook_error", async () => {
	const parsed = parseWorkflowDefinition({
		...definition(),
		steps: [
			{
				...(definition().steps as Record<string, unknown>[])[0],
				meta: { phase: "Drafting", log: "Starting draft" },
			},
		],
	});
	const events: WorkflowEventV1[] = [];
	const outcome = await executeWorkflow(
		parsed,
		{ topic: "x" },
		async (request) => {
			await request.progress({ message: "working", payload: { safe: true } });
			return {
				status: "completed",
				result: { mode: "text", text: "ok" },
				usage,
			};
		},
		{
			onEvent: async (event) => {
				events.push(event);
			},
		},
	);

	assert.equal(outcome.status, "succeeded");
	assert.deepEqual(
		events.map((event) => event.type),
		[
			"workflow_started",
			"phase",
			"log",
			"leaf_started",
			"leaf_progress",
			"leaf_terminal",
			"workflow_terminal",
		],
	);
	assert.deepEqual(
		events.map((event) => event.sequence),
		[1, 2, 3, 4, 5, 6, 7],
	);
	assert.equal(
		events.every((event) => event.runId === outcome.runId),
		true,
	);

	let activeSignal: AbortSignal | undefined;
	const hookFailure = await executeWorkflow(
		parsed,
		{ topic: "x" },
		async (request) => {
			activeSignal = request.signal;
			await request.progress({ message: "explode" });
			return {
				status: "completed",
				result: { mode: "text", text: "late" },
				usage,
			};
		},
		{
			onEvent(event) {
				if (event.type === "leaf_progress")
					throw new Error("presentation failed");
			},
		},
	);
	assert.equal(hookFailure.status, "failed");
	assert.equal(hookFailure.error?.code, "hook_error");
	assert.equal(activeSignal?.aborted, true);
});

test("starts timeout at dispatch after a slow leaf_started hook and observes an abort race", async () => {
	const parsed = parseWorkflowDefinition({
		...definition(),
		steps: [
			{
				...(definition().steps as Record<string, unknown>[])[0],
				limits: { timeoutMs: 1_000, maxTurns: 3, maxToolCalls: 4 },
			},
		],
	});
	let dispatchedAt = 0;
	let abortedAt = 0;
	const startedAt = Date.now();
	const execution = executeWorkflow(
		parsed,
		{ topic: "x" },
		async (request) => {
			dispatchedAt = Date.now();
			await new Promise<void>((resolve) => {
				const observeAbort = (): void => {
					abortedAt = Date.now();
					resolve();
				};
				request.signal.addEventListener("abort", observeAbort, { once: true });
				if (request.signal.aborted) observeAbort();
			});
			return new Promise(() => undefined);
		},
		{
			async onEvent(event) {
				if (event.type === "leaf_started")
					await new Promise((resolve) => setTimeout(resolve, 1_100));
			},
		},
	);
	const outcome = await Promise.race([
		execution,
		new Promise<never>((_, reject) =>
			setTimeout(() => reject(new Error("execution hung")), 2_500),
		),
	]);

	assert.ok(dispatchedAt - startedAt >= 1_000);
	assert.ok(abortedAt - dispatchedAt >= 900);
	assert.equal(leafAt(outcome, 0).status, "timed_out");
});

test("removes caller abort listeners after every sequential leaf", async () => {
	const steps = Array.from({ length: 25 }, (_, index) =>
		agent(`step${index}`, { template: "literal", values: {} }),
	);
	const parsed = parsedSequential(steps, "step24");
	const controller = new AbortController();
	const observedCounts: number[] = [];
	const outcome = await executeWorkflow(
		parsed,
		{},
		async () => {
			observedCounts.push(
				getEventListeners(controller.signal, "abort").length,
			);
			return {
				status: "completed",
				result: { mode: "text", text: "ok" },
				usage,
			};
		},
		{ signal: controller.signal },
	);

	assert.equal(outcome.status, "succeeded");
	assert.equal(Math.max(...observedCounts), 1);
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("prevents hooks and runners from mutating stable engine identities and outcomes", async () => {
	const parsed = parsedSequential(
		[
			agent("first", { template: "literal", values: {} }),
			agent("final", {
				template: "{{first}}",
				values: { first: { ref: "step", stepId: "first" } },
			}),
		],
		"final",
	);
	const eventMutationResults: boolean[] = [];
	const runnerMutationResults: boolean[] = [];
	const outcome = await executeWorkflow(
		parsed,
		{},
		async (request) => {
			runnerMutationResults.push(
				Reflect.set(request.identity, "stepId", "corrupted"),
				Reflect.set(request.limits, "maxTurns", 999),
			);
			return {
				status: "completed",
				result: { mode: "text", text: request.identity.stepId },
				usage,
			};
		},
		{
			onEvent(event) {
				if (event.type === "leaf_started") {
					eventMutationResults.push(
						Reflect.set(event.identity, "stepId", "corrupted"),
					);
				}
				if (event.type === "leaf_terminal") {
					eventMutationResults.push(
						Reflect.set(event.outcome.identity, "nodeId", "corrupted"),
						Reflect.set(event.outcome.usage, "input", 999),
					);
					if (event.outcome.status === "succeeded")
						eventMutationResults.push(
							Reflect.set(event.outcome.result, "text", "corrupted"),
						);
				}
			},
		},
	);

	assert.equal(outcome.status, "succeeded");
	assert.equal(runnerMutationResults.every((result) => result === false), true);
	assert.equal(eventMutationResults.every((result) => result === false), true);
	assert.deepEqual(
		outcome.steps.map((step) => {
			if (step.type !== "agent") throw new Error("unexpected unsupported step");
			const { stepId, leaf } = step;
			return {
				stepId,
				nodeId: leaf.identity.nodeId,
				text:
					leaf.status === "succeeded" && leaf.result.mode === "text"
						? leaf.result.text
						: undefined,
			};
		}),
		[
			{ stepId: "first", nodeId: "step:first", text: "first" },
			{ stepId: "final", nodeId: "step:final", text: "final" },
		],
	);
	const finalOutcome = outcome.result?.outcome;
	assert.equal(
		finalOutcome !== undefined &&
			"status" in finalOutcome &&
			finalOutcome.status === "succeeded" &&
			finalOutcome.result.mode === "text"
			? finalOutcome.result.text
			: undefined,
		"final",
	);
	assert.deepEqual(outcome.usage, usage);
});

test("represents throwing workflow hook access as hook_error after assigning a run", async () => {
	for (const property of ["onEvent", "signal"] as const) {
		const hooks = new Proxy(
			{},
			{
				get(_target, key) {
					if (key === property) throw new Error(`${property} getter exploded`);
					return undefined;
				},
			},
		);
		const outcome = await executeWorkflow(
			parseWorkflowDefinition(definition()),
			{ topic: "x" },
			async () => ({
				status: "completed",
				result: { mode: "text", text: "unexpected" },
				usage,
			}),
			hooks,
		);
		assert.match(outcome.runId, /^[0-9a-f-]{36}$/);
		assert.equal(outcome.status, "failed");
		assert.equal(outcome.error?.code, "hook_error");
		assert.deepEqual(outcome.steps, []);
	}
});

test("rechecks cancellation after each awaited hook and emits one terminal per materialized leaf", async () => {
	for (const cancelAt of ["phase", "log", "leaf_started"] as const) {
		const parsed = parsedSequential(
			[
				agent(
					"first",
					{ template: "literal", values: {} },
					{ meta: { phase: "phase", log: "log" } },
				),
				agent("second", { template: "literal", values: {} }),
			],
			"second",
		);
		const controller = new AbortController();
		const events: WorkflowEventV1[] = [];
		let calls = 0;
		const outcome = await executeWorkflow(
			parsed,
			{},
			async () => {
				calls += 1;
				return new Promise(() => undefined);
			},
			{
				signal: controller.signal,
				onEvent(event) {
					events.push(event);
					if (event.type === cancelAt) controller.abort(cancelAt);
				},
			},
		);

		assert.equal(calls, 0, cancelAt);
		assert.equal(outcome.status, "cancelled", cancelAt);
		assert.equal(outcome.steps.length, 2, cancelAt);
		assert.equal(
			leafAt(outcome, 0).status,
			cancelAt === "leaf_started" ? "cancelled" : "skipped",
			cancelAt,
		);
		assert.equal(leafAt(outcome, 1).status, "skipped", cancelAt);
		assert.equal(
			events.filter((event) => event.type === "leaf_terminal").length,
			2,
			cancelAt,
		);
		if (cancelAt === "phase")
			assert.equal(events.some((event) => event.type === "log"), false);
		if (cancelAt !== "leaf_started")
			assert.equal(
				events.some((event) => event.type === "leaf_started"),
				false,
			);
	}
});

test("times out a non-cooperative runner once and ignores its late terminal", async () => {
	let resolveTerminal!: (value: Awaited<ReturnType<LeafRunner>>) => void;
	const runnerPromise = new Promise<Awaited<ReturnType<LeafRunner>>>(
		(resolve) => {
			resolveTerminal = resolve;
		},
	);
	const events: WorkflowEventV1[] = [];
	const started = Date.now();
	const execution = executeWorkflow(
		parseWorkflowDefinition(definition()),
		{ topic: "x" },
		async () => runnerPromise,
		{
			onEvent(event) {
				events.push(event);
			},
		},
	);
	const outcome = await execution;
	assert.ok(Date.now() - started >= 900);
	assert.equal(leafAt(outcome, 0).status, "timed_out");
	assert.deepEqual(outcome.usage, usage);
	const terminalEvents = events.length;

	resolveTerminal({
		status: "completed",
		result: { mode: "text", text: "late" },
		usage: { ...usage, input: 99 },
	});
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(events.length, terminalEvents);
	assert.deepEqual(outcome.usage, usage);
});

test("caller cancellation aborts active work and materializes remaining agents as skipped", async () => {
	const parsed = parsedSequential(
		[
			agent("active", { template: "active", values: {} }),
			agent("queued", { template: "queued", values: {} }),
		],
		"queued",
	);
	const controller = new AbortController();
	let requestSignal: AbortSignal | undefined;
	let started!: () => void;
	const didStart = new Promise<void>((resolve) => {
		started = resolve;
	});
	const execution = executeWorkflow(
		parsed,
		{},
		async (request) => {
			requestSignal = request.signal;
			started();
			return new Promise(() => undefined);
		},
		{ signal: controller.signal },
	);
	await didStart;
	controller.abort("caller");
	const outcome = await execution;

	assert.equal(outcome.status, "cancelled");
	assert.equal(requestSignal?.aborted, true);
	assert.equal(leafAt(outcome, 0).status, "cancelled");
	const queuedLeaf = leafAt(outcome, 1);
	assert.equal(queuedLeaf.status, "skipped");
	assert.equal(
		queuedLeaf.status === "skipped" ? queuedLeaf.reason : "",
		"cancelled",
	);
	assert.deepEqual(outcome.counters, {
		reservedCallSlots: 1,
		actualLeafCalls: 1,
		admittedItems: 0,
	});
});

test("enforces invocation, prompt, and terminal output bounds without dispatch/accounting leaks", async () => {
	let calls = 0;
	const boundedRunner: LeafRunner = async () => {
		calls += 1;
		return { status: "completed", result: { mode: "text", text: "ok" }, usage };
	};
	const largeArgsDefinition = parseWorkflowDefinition({
		...definition(),
		args: {
			topic: {
				type: "array",
				items: { type: "string", maxLength: 65_536 },
				maxItems: 20,
			},
		},
	});
	const invalidArgs = await executeWorkflow(
		largeArgsDefinition,
		{ topic: Array.from({ length: 17 }, () => "x".repeat(65_536)) },
		boundedRunner,
		{},
	);
	assert.equal(invalidArgs.error?.code, "invalid_arguments");
	assert.equal(calls, 0);

	const promptDefinition = parseWorkflowDefinition({
		...definition(),
		args: { topic: { type: "string", maxLength: 65_536 } },
		steps: [
			{
				...(definition().steps as Record<string, unknown>[])[0],
				prompt: {
					template: "{{topic}}!",
					values: { topic: { ref: "arg", name: "topic" } },
				},
			},
		],
	});
	const prompt = await executeWorkflow(
		promptDefinition,
		{ topic: "😀".repeat(65_536) },
		boundedRunner,
		{},
	);
	const promptLeaf = leafAt(prompt, 0);
	assert.equal(promptLeaf.status, "skipped");
	assert.equal(
		promptLeaf.status === "skipped" ? promptLeaf.reason : "",
		"prompt_too_large",
	);
	assert.equal(calls, 0);

	const output = await executeWorkflow(
		parseWorkflowDefinition(definition()),
		{ topic: "x" },
		async () => ({
			status: "completed",
			result: { mode: "text", text: "x".repeat(1024 * 1024 + 1) },
			usage: { ...usage, input: 50 },
		}),
		{},
	);
	const outputLeaf = leafAt(output, 0);
	assert.equal(outputLeaf.status, "failed");
	assert.equal(
		outputLeaf.status === "failed" ? outputLeaf.error.code : undefined,
		"provider_contract_violation",
	);
	assert.deepEqual(output.usage, usage);
});

test("returns unsupported_step before dispatching a parsed pipeline step", async () => {
	const parsed = parseWorkflowDefinition({
		version: 1,
		id: "unsupported",
		args: {
			items: { type: "array", items: { type: "string" }, maxItems: 1 },
		},
		limits: { concurrency: 2, maxCalls: 2, maxItems: 1 },
		steps: [
			{
				type: "pipeline",
				id: "group",
				items: { ref: "arg", name: "items" },
				onFailure: "stop-item",
				stages: [
					{
						id: "stage",
						agent: "worker",
						prompt: {
							template: "{{item}}",
							values: { item: { ref: "item" } },
						},
						output: { mode: "text" },
						limits: { timeoutMs: 1_000, maxTurns: 1, maxToolCalls: 0 },
					},
				],
			},
		],
		result: { ref: "step", stepId: "group" },
	});
	let calls = 0;
	const outcome = await executeWorkflow(
		parsed,
		{ items: [] },
		async () => {
			calls += 1;
			return {
				status: "completed",
				result: { mode: "text", text: "no" },
				usage,
			};
		},
		{},
	);
	assert.equal(outcome.error?.code, "unsupported_step");
	assert.deepEqual(outcome.steps, [
		{
			type: "unsupported",
			stepId: "group",
			stepType: "pipeline",
			error: {
				code: "unsupported_step",
				message: "pipeline step group is not supported by this engine",
			},
		},
	]);
	assert.equal(calls, 0);
	assert.deepEqual(outcome.counters, {
		reservedCallSlots: 0,
		actualLeafCalls: 0,
		admittedItems: 0,
	});
});
