import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "node:test";

import {
	executeWorkflow,
	parseWorkflowDefinition,
	type LeafRunner,
	type ParallelStepOutcomeV1,
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

function task(
	id: string,
	prompt = id,
	meta?: { phase?: string; log?: string },
) {
	return {
		id,
		agent: "worker",
		prompt: { template: prompt, values: {} },
		output: { mode: "text" },
		limits: { timeoutMs: 5_000, maxTurns: 3, maxToolCalls: 4 },
		...(meta === undefined ? {} : { meta }),
	};
}

function parallelDefinition(
	options: {
		concurrency?: number;
		maxCalls?: number;
		tasks?: ReturnType<typeof task>[];
		stepsAfter?: unknown[];
		result?: Record<string, unknown>;
		meta?: { phase?: string; log?: string };
	} = {},
) {
	const tasks = options.tasks ?? [task("a"), task("b"), task("c")];
	return parseWorkflowDefinition({
		version: 1,
		id: "parallel-workflow",
		args: {},
		limits: {
			concurrency: options.concurrency ?? 2,
			maxCalls:
				options.maxCalls ?? tasks.length + (options.stepsAfter?.length ?? 0),
			maxItems: 1,
		},
		steps: [
			{
				type: "parallel",
				id: "group",
				tasks,
				...(options.meta === undefined ? {} : { meta: options.meta }),
			},
			...(options.stepsAfter ?? []),
		],
		result: options.result ?? { ref: "step", stepId: "group" },
	});
}

function sequentialAgent(
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

function parallelAt(outcome: { steps: readonly unknown[] }, index = 0) {
	const step = outcome.steps[index];
	if (
		typeof step !== "object" ||
		step === null ||
		(step as { type?: string }).type !== "parallel"
	)
		throw new Error(`missing parallel step ${index}`);
	return step as ParallelStepOutcomeV1;
}

function completed(text: string, overrides: Record<string, unknown> = {}) {
	return {
		status: "completed" as const,
		result: { mode: "text" as const, text },
		usage,
		...overrides,
	};
}

test("parallel tasks obey the workflow cap and queued FIFO work starts only after release", async () => {
	const definition = parallelDefinition();
	const starts: string[] = [];
	const releases = new Map<string, () => void>();
	let active = 0;
	let maximumActive = 0;
	const runner: LeafRunner = async (request) => {
		const taskId = request.identity.taskId!;
		starts.push(taskId);
		active += 1;
		maximumActive = Math.max(maximumActive, active);
		await new Promise<void>((resolve) => releases.set(taskId, resolve));
		active -= 1;
		return completed(taskId);
	};

	const execution = executeWorkflow(definition, {}, runner, {});
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(starts, ["a", "b"]);
	assert.equal(maximumActive, 2);
	assert.equal(releases.has("c"), false, "task c must not start above the cap");

	releases.get("b")!();
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(starts, ["a", "b", "c"]);
	assert.equal(maximumActive, 2);

	releases.get("a")!();
	releases.get("c")!();
	const outcome = await execution;
	assert.equal(outcome.status, "succeeded");
	assert.equal(outcome.steps[0]?.type, "parallel");
	assert.deepEqual(outcome.counters, {
		reservedCallSlots: 3,
		actualLeafCalls: 3,
		admittedItems: 0,
	});
});

test("parallel completion is a full barrier with source-aligned outcomes, stable identities, and exact usage", async () => {
	const after = sequentialAgent("after");
	const definition = parallelDefinition({
		concurrency: 3,
		stepsAfter: [after],
		result: { ref: "step", stepId: "after" },
	});
	const releases = new Map<
		string,
		(value: Awaited<ReturnType<LeafRunner>>) => void
	>();
	const starts: string[] = [];
	const runner: LeafRunner = async (request) => {
		const id = request.identity.taskId ?? request.identity.stepId;
		starts.push(id);
		if (id === "after")
			return completed("after", { usage: { ...usage, output: 4 } });
		return new Promise((resolve) => releases.set(id, resolve));
	};

	const execution = executeWorkflow(definition, {}, runner, {});
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(starts, ["a", "b", "c"]);
	releases.get("c")!(completed("C", { usage: { ...usage, input: 3 } }));
	releases.get("b")!({
		status: "failed",
		error: { code: "ordinary", message: "B failed", retryable: false },
		usage: { ...usage, input: 2 },
	});
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(
		starts.includes("after"),
		false,
		"the next step must wait for all slots",
	);
	releases.get("a")!(completed("A", { usage: { ...usage, input: 1 } }));

	const outcome = await execution;
	assert.deepEqual(starts, ["a", "b", "c", "after"]);
	const parallel = parallelAt(outcome);
	assert.deepEqual(
		parallel.slots.map((leaf) => leaf.identity.taskId),
		["a", "b", "c"],
	);
	assert.deepEqual(
		parallel.slots.map((leaf) => leaf.status),
		["succeeded", "failed", "succeeded"],
	);
	assert.deepEqual(
		parallel.slots.map((leaf) => ({
			nodeId: leaf.identity.nodeId,
			stepId: leaf.identity.stepId,
			taskId: leaf.identity.taskId,
			slot: leaf.identity.slot,
			runId: leaf.identity.runId,
		})),
		[
			{
				nodeId: "parallel:group:task:a",
				stepId: "group",
				taskId: "a",
				slot: 0,
				runId: outcome.runId,
			},
			{
				nodeId: "parallel:group:task:b",
				stepId: "group",
				taskId: "b",
				slot: 1,
				runId: outcome.runId,
			},
			{
				nodeId: "parallel:group:task:c",
				stepId: "group",
				taskId: "c",
				slot: 2,
				runId: outcome.runId,
			},
		],
	);
	assert.deepEqual(outcome.usage, { ...usage, input: 6, output: 4 });
	assert.deepEqual(outcome.counters, {
		reservedCallSlots: 4,
		actualLeafCalls: 4,
		admittedItems: 0,
	});
});

test("parallel usage accounting and terminal outcomes are deterministic in source order", async () => {
	async function run(completionOrder: readonly string[]) {
		const releases = new Map<
			string,
			(value: Awaited<ReturnType<LeafRunner>>) => void
		>();
		const terminalTaskIds: string[] = [];
		const execution = executeWorkflow(
			parallelDefinition({
				concurrency: 2,
				tasks: [task("a"), task("b")],
			}),
			{},
			async (request) =>
				new Promise((resolve) =>
					releases.set(request.identity.taskId!, resolve),
				),
			{
				onEvent(event) {
					if (event.type === "leaf_terminal")
						terminalTaskIds.push(event.outcome.identity.taskId!);
				},
			},
		);
		await new Promise((resolve) => setImmediate(resolve));
		const terminals = {
			a: completed("A", {
				usage: { ...usage, input: Number.MAX_SAFE_INTEGER, cost: 1e16 },
			}),
			b: completed("B", {
				usage: { ...usage, input: 1, cost: 1 },
			}),
		};
		for (const id of completionOrder) {
			releases.get(id)!(terminals[id as keyof typeof terminals]);
			await new Promise((resolve) => setImmediate(resolve));
			if (id !== completionOrder.at(-1)) assert.deepEqual(terminalTaskIds, []);
		}
		return { outcome: await execution, terminalTaskIds };
	}

	const forward = await run(["a", "b"]);
	const reverse = await run(["b", "a"]);
	for (const result of [forward, reverse]) {
		assert.deepEqual(
			parallelAt(result.outcome).slots.map((leaf) => [
				leaf.identity.taskId,
				leaf.status,
				leaf.status === "failed" ? leaf.error.code : undefined,
			]),
			[
				["a", "succeeded", undefined],
				["b", "failed", "provider_contract_violation"],
			],
		);
		assert.deepEqual(result.outcome.usage, {
			...usage,
			input: Number.MAX_SAFE_INTEGER,
			cost: 1e16,
		});
		assert.deepEqual(result.terminalTaskIds, ["a", "b"]);
		assert.deepEqual(result.outcome.counters, {
			reservedCallSlots: 2,
			actualLeafCalls: 2,
			admittedItems: 0,
		});
	}
	assert.deepEqual(forward.outcome.usage, reverse.outcome.usage);
	assert.deepEqual(forward.outcome.counters, reverse.outcome.counters);
});

test("successful payload caps are derived from maxCalls and independent of completion order", async () => {
	async function run(completionOrder: readonly string[]) {
		const releases = new Map<
			string,
			(value: Awaited<ReturnType<LeafRunner>>) => void
		>();
		const execution = executeWorkflow(
			parallelDefinition({
				concurrency: 2,
				maxCalls: 1_000,
				tasks: [task("large"), task("small")],
			}),
			{},
			async (request) =>
				new Promise((resolve) =>
					releases.set(request.identity.taskId!, resolve),
				),
			{},
		);
		await new Promise((resolve) => setImmediate(resolve));
		for (const id of completionOrder) {
			releases.get(id)!(
				completed("x".repeat(id === "large" ? 70 * 1024 : 60 * 1024)),
			);
		}
		return execution;
	}

	for (const outcome of [
		await run(["large", "small"]),
		await run(["small", "large"]),
	]) {
		assert.deepEqual(
			parallelAt(outcome).slots.map((leaf) => [
				leaf.identity.taskId,
				leaf.status,
				leaf.status === "failed" ? leaf.error.code : undefined,
			]),
			[
				["large", "failed", "provider_contract_violation"],
				["small", "succeeded", undefined],
			],
		);
	}

	const legacyBoundary = await executeWorkflow(
		parallelDefinition({ maxCalls: 64, tasks: [task("boundary")] }),
		{},
		async () => completed("x".repeat(1024 * 1024)),
		{},
	);
	assert.equal(parallelAt(legacyBoundary).slots[0]?.status, "succeeded");

	const structuredTask = {
		...task("structured"),
		output: {
			mode: "structured" as const,
			schema: {
				type: "object" as const,
				properties: {
					a: { type: "string" as const, maxLength: 65_536 },
					b: { type: "string" as const, maxLength: 65_536 },
				},
				required: ["a", "b"],
				additionalProperties: false as const,
			},
		},
	};
	const structured = await executeWorkflow(
		parallelDefinition({ maxCalls: 1_000, tasks: [structuredTask] }),
		{},
		async () => ({
			status: "completed",
			result: {
				mode: "structured",
				value: { a: "x".repeat(40 * 1024), b: "y".repeat(40 * 1024) },
			},
			usage,
		}),
		{},
	);
	const structuredLeaf = parallelAt(structured).slots[0];
	assert.equal(structuredLeaf?.status, "failed");
	assert.equal(
		structuredLeaf?.status === "failed" ? structuredLeaf.error.code : undefined,
		"provider_contract_violation",
	);
});

test("group and task references use deterministic bounded data projections and unavailable tasks skip", async () => {
	const groupConsumer = sequentialAgent("groupConsumer", {
		template: "group={{group}}",
		values: { group: { ref: "step", stepId: "group" } },
	});
	const taskConsumer = sequentialAgent("taskConsumer", {
		template: "task={{good}}",
		values: { good: { ref: "task", stepId: "group", taskId: "good" } },
	});
	const unavailable = sequentialAgent("unavailable", {
		template: "bad={{bad}}",
		values: { bad: { ref: "task", stepId: "group", taskId: "bad" } },
	});
	const definition = parallelDefinition({
		tasks: [task("good"), task("bad")],
		stepsAfter: [groupConsumer, taskConsumer, unavailable],
		result: { ref: "step", stepId: "taskConsumer" },
	});
	const prompts = new Map<string, string>();
	const outcome = await executeWorkflow(
		definition,
		{},
		async (request) => {
			const id = request.identity.taskId ?? request.identity.stepId;
			prompts.set(id, request.prompt);
			if (id === "bad") {
				return {
					status: "failed",
					error: { code: "bad_code", message: "nope", retryable: false },
					usage: { ...usage, input: 7 },
					model: "must-not-project",
				};
			}
			return completed(id === "good" ? "GOOD" : "done", {
				usage: { ...usage, output: 1 },
				model: "also-hidden",
			});
		},
		{},
	);

	assert.equal(outcome.status, "succeeded");
	assert.equal(
		prompts.get("groupConsumer"),
		'group={"slots":[{"status":"succeeded","taskId":"good","value":"GOOD"},{"error":{"code":"bad_code","message":"nope"},"status":"failed","taskId":"bad"}]}',
	);
	assert.equal(prompts.get("taskConsumer"), "task=GOOD");
	assert.equal(prompts.has("unavailable"), false);
	const unavailableStep = outcome.steps[3];
	assert.equal(unavailableStep?.type, "agent");
	if (unavailableStep?.type === "agent") {
		assert.equal(unavailableStep.leaf.status, "skipped");
		assert.equal(
			unavailableStep.leaf.status === "skipped"
				? unavailableStep.leaf.reason
				: "",
			"unavailable_reference",
		);
	}
	assert.deepEqual(outcome.usage, { ...usage, input: 7, output: 3 });
	assert.deepEqual(outcome.counters, {
		reservedCallSlots: 5,
		actualLeafCalls: 4,
		admittedItems: 0,
	});
});

test("hostile repeated group aliases stay bounded by the prompt ceiling", async () => {
	const aliasCount = 5_000;
	const values: Record<string, unknown> = {};
	const placeholders: string[] = [];
	for (let index = 0; index < aliasCount; index += 1) {
		const name = `v${index}`;
		values[name] = { ref: "step", stepId: "group" };
		placeholders.push(`{{${name}}}`);
	}
	const definition = parallelDefinition({
		tasks: [task("source")],
		stepsAfter: [
			sequentialAgent("consumer", {
				template: placeholders.join(""),
				values,
			}),
		],
		result: { ref: "step", stepId: "consumer" },
	});
	assert.ok(Buffer.byteLength(JSON.stringify(definition)) < 256 * 1024);

	const calls: string[] = [];
	const outcome = await executeWorkflow(
		definition,
		{},
		async (request) => {
			calls.push(request.identity.taskId ?? request.identity.stepId);
			return completed("x");
		},
		{},
	);
	const consumer = leafAtParallelConsumer(outcome);
	assert.equal(consumer.status, "skipped");
	assert.equal(
		consumer.status === "skipped" ? consumer.reason : undefined,
		"prompt_too_large",
	);
	assert.deepEqual(calls, ["source"]);
});

test("large group projections stop at the prompt ceiling without dispatching the consumer", async () => {
	const tasks = Array.from({ length: 8 }, (_, index) => task(`task${index}`));
	const consumer = sequentialAgent("consumer", {
		template: "prefix={{group}}:suffix",
		values: { group: { ref: "step", stepId: "group" } },
	});
	const definition = parallelDefinition({
		concurrency: 8,
		tasks,
		stepsAfter: [consumer],
		result: { ref: "step", stepId: "consumer" },
	});
	const calls: string[] = [];
	const outcome = await executeWorkflow(
		definition,
		{},
		async (request) => {
			const id = request.identity.taskId ?? request.identity.stepId;
			calls.push(id);
			return completed("x".repeat(40 * 1024));
		},
		{},
	);

	assert.deepEqual(
		calls,
		tasks.map(({ id }) => id),
	);
	assert.equal(leafAtParallelConsumer(outcome).status, "skipped");
	const leaf = leafAtParallelConsumer(outcome);
	assert.equal(
		leaf.status === "skipped" ? leaf.reason : undefined,
		"prompt_too_large",
	);
});

function leafAtParallelConsumer(
	outcome: Awaited<ReturnType<typeof executeWorkflow>>,
) {
	const step = outcome.steps[1];
	if (step?.type !== "agent") throw new Error("missing group consumer");
	return step.leaf;
}

test("final group references succeed through partial failures while final task references require that task success", async () => {
	const tasks = [task("good"), task("bad")];
	for (const [result, expectedStatus] of [
		[{ ref: "step", stepId: "group" }, "succeeded"],
		[{ ref: "task", stepId: "group", taskId: "good" }, "succeeded"],
		[{ ref: "task", stepId: "group", taskId: "bad" }, "failed"],
	] as const) {
		const outcome = await executeWorkflow(
			parallelDefinition({ tasks, result }),
			{},
			async (request) =>
				request.identity.taskId === "bad"
					? {
							status: "failed",
							error: { code: "failed", message: "bad", retryable: false },
							usage,
						}
					: completed("good"),
			{},
		);
		assert.equal(outcome.status, expectedStatus);
		if (result.ref === "step") {
			assert.equal(
				outcome.result !== null && "type" in outcome.result.outcome
					? outcome.result.outcome.type
					: undefined,
				"parallel",
			);
		} else {
			assert.equal(
				outcome.result !== null && "status" in outcome.result.outcome
					? outcome.result.outcome.status
					: undefined,
				result.taskId === "good" ? "succeeded" : "failed",
			);
		}
	}
});

test("caller cancellation aborts active tasks, removes queued acquisitions, aligns every slot, and leaks no listeners", async () => {
	const definition = parallelDefinition({ concurrency: 1 });
	const controller = new AbortController();
	const events: WorkflowEventV1[] = [];
	let activeSignal: AbortSignal | undefined;
	let started!: () => void;
	const didStart = new Promise<void>((resolve) => (started = resolve));
	const execution = executeWorkflow(
		definition,
		{},
		async (request) => {
			activeSignal = request.signal;
			started();
			return new Promise(() => undefined);
		},
		{
			signal: controller.signal,
			onEvent(event) {
				events.push(event);
			},
		},
	);
	await didStart;
	controller.abort("caller");
	const outcome = await execution;

	assert.equal(outcome.status, "cancelled");
	assert.equal(activeSignal?.aborted, true);
	const slots = parallelAt(outcome).slots;
	assert.deepEqual(
		slots.map((leaf) => leaf.status),
		["cancelled", "skipped", "skipped"],
	);
	assert.deepEqual(
		slots.map((leaf) => (leaf.status === "skipped" ? leaf.reason : undefined)),
		[undefined, "cancelled", "cancelled"],
	);
	assert.equal(
		events.filter((event) => event.type === "leaf_terminal").length,
		3,
	);
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);
	assert.deepEqual(outcome.counters, {
		reservedCallSlots: 3,
		actualLeafCalls: 1,
		admittedItems: 0,
	});
});

test("group metadata emits once, task metadata waits for permit acquisition, and hooks stay serialized", async () => {
	const definition = parallelDefinition({
		concurrency: 1,
		meta: { phase: "group-phase", log: "group-log" },
		tasks: [
			task("a", "a", { phase: "a-phase", log: "a-log" }),
			task("b", "b", { phase: "b-phase", log: "b-log" }),
		],
	});
	const events: WorkflowEventV1[] = [];
	let releaseA!: () => void;
	const outcomePromise = executeWorkflow(
		definition,
		{},
		async (request) => {
			if (request.identity.taskId === "a")
				await new Promise<void>((resolve) => (releaseA = resolve));
			return completed(request.identity.taskId!);
		},
		{
			async onEvent(event) {
				events.push(event);
				await Promise.resolve();
			},
		},
	);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(
		events.some((event) => event.type === "phase" && event.taskId === "b"),
		false,
		"queued task metadata must wait for its permit",
	);
	releaseA();
	const outcome = await outcomePromise;
	assert.equal(outcome.status, "succeeded");
	assert.deepEqual(
		events
			.filter((event) => event.type === "phase" || event.type === "log")
			.map((event) => [event.type, event.taskId ?? "group"]),
		[
			["phase", "group"],
			["log", "group"],
			["phase", "a"],
			["log", "a"],
			["phase", "b"],
			["log", "b"],
		],
	);
	assert.deepEqual(
		events.map((event) => event.sequence),
		Array.from({ length: events.length }, (_, index) => index + 1),
	);
});

test("timeout and ordinary failure each release the shared permit for the next FIFO task", async () => {
	const timedTask = {
		...task("timeout"),
		limits: { timeoutMs: 1_000, maxTurns: 3, maxToolCalls: 4 },
	};
	const definition = parallelDefinition({
		concurrency: 1,
		tasks: [timedTask, task("failure"), task("success")],
	});
	const starts: string[] = [];
	const outcome = await executeWorkflow(
		definition,
		{},
		async (request) => {
			starts.push(request.identity.taskId!);
			if (request.identity.taskId === "timeout")
				return new Promise(() => undefined);
			if (request.identity.taskId === "failure") {
				return {
					status: "failed",
					error: { code: "ordinary", message: "failed", retryable: false },
					usage,
				};
			}
			return completed("success");
		},
		{},
	);

	assert.deepEqual(starts, ["timeout", "failure", "success"]);
	assert.deepEqual(
		parallelAt(outcome).slots.map((leaf) => leaf.status),
		["timed_out", "failed", "succeeded"],
	);
	assert.equal(outcome.status, "succeeded");
});

test("a hook failure aborts the cohort and returns hook_error with every slot aligned", async () => {
	const definition = parallelDefinition({ concurrency: 2 });
	const signals: AbortSignal[] = [];
	const outcome = await executeWorkflow(
		definition,
		{},
		async (request) => {
			signals.push(request.signal);
			if (request.identity.taskId === "a")
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
	assert.equal(parallelAt(outcome).slots.length, 3);
	assert.equal(
		parallelAt(outcome).slots.every(
			(leaf) => leaf.status === "cancelled" || leaf.status === "skipped",
		),
		true,
	);
	assert.equal(
		signals.every((signal) => signal.aborted),
		true,
	);
});

test("caller cancellation abandons a stuck progress hook and bounds unawaited progress", async () => {
	const controller = new AbortController();
	let inspectedUpdates = 0;
	let hookStarted!: () => void;
	const didStartHook = new Promise<void>((resolve) => (hookStarted = resolve));
	const execution = executeWorkflow(
		parallelDefinition({ concurrency: 1, tasks: [task("flood")] }),
		{},
		async (request) => {
			void request.progress({ message: "held" });
			for (let index = 0; index < 100; index += 1) {
				const update = new Proxy(
					{ message: `ignored-${index}` },
					{
						ownKeys(target) {
							inspectedUpdates += 1;
							return Reflect.ownKeys(target);
						},
					},
				);
				void request.progress(update);
			}
			return new Promise(() => undefined);
		},
		{
			signal: controller.signal,
			onEvent(event) {
				if (event.type !== "leaf_progress") return;
				hookStarted();
				return new Promise(() => undefined);
			},
		},
	);
	await didStartHook;
	controller.abort("caller");
	const outcome = await Promise.race([
		execution,
		new Promise<never>((_, reject) =>
			setTimeout(() => reject(new Error("cancelled execution hung")), 500),
		),
	]);

	assert.equal(outcome.status, "cancelled");
	assert.ok(
		inspectedUpdates <= 7,
		`inspected ${inspectedUpdates} excess updates`,
	);
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);
	assert.deepEqual(outcome.counters, {
		reservedCallSlots: 1,
		actualLeafCalls: 1,
		admittedItems: 0,
	});
});

test("caller cancellation releases an existing stuck drain after the runner settles", async () => {
	const controller = new AbortController();
	let activeSignal: AbortSignal | undefined;
	let hookStarted!: () => void;
	const didStartHook = new Promise<void>((resolve) => (hookStarted = resolve));
	let runnerSettled!: () => void;
	const didSettleRunner = new Promise<void>(
		(resolve) => (runnerSettled = resolve),
	);
	let rejectHook!: (error: Error) => void;
	const execution = executeWorkflow(
		parallelDefinition({
			concurrency: 1,
			tasks: [task("settled"), task("queued")],
		}),
		{},
		async (request) => {
			if (request.identity.taskId === "queued")
				throw new Error("queued task acquired a leaked permit");
			activeSignal = request.signal;
			void request.progress({ message: "held-after-settlement" });
			await didStartHook;
			runnerSettled();
			return completed("done");
		},
		{
			signal: controller.signal,
			onEvent(event) {
				if (event.type !== "leaf_progress") return;
				hookStarted();
				return new Promise<void>((_, reject) => (rejectHook = reject));
			},
		},
	);
	await didSettleRunner;
	await new Promise((resolve) => setImmediate(resolve));
	controller.abort("caller");
	const outcome = await Promise.race([
		execution,
		new Promise<never>((_, reject) =>
			setTimeout(() => reject(new Error("stuck drain was not abandoned")), 500),
		),
	]);

	assert.equal(outcome.status, "cancelled");
	assert.deepEqual(
		parallelAt(outcome).slots.map((leaf) => leaf.status),
		["succeeded", "skipped"],
	);
	assert.equal(activeSignal?.aborted, true);
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);
	assert.equal(
		activeSignal === undefined
			? -1
			: getEventListeners(activeSignal, "abort").length,
		0,
	);
	assert.deepEqual(outcome.counters, {
		reservedCallSlots: 2,
		actualLeafCalls: 1,
		admittedItems: 0,
	});

	rejectHook(new Error("late hook rejection"));
	await new Promise((resolve) => setImmediate(resolve));
});

test("caller cancellation preserves parallel slot alignment despite terminal hook rejection", async () => {
	const controller = new AbortController();
	controller.abort("caller");
	const outcome = await executeWorkflow(
		parallelDefinition(),
		{},
		async () => {
			throw new Error("cancelled tasks must not dispatch");
		},
		{
			signal: controller.signal,
			onEvent(event) {
				if (event.type === "leaf_terminal")
					throw new Error("terminal hook failed");
			},
		},
	);

	assert.equal(outcome.status, "cancelled");
	assert.equal(outcome.error?.code, "cancelled");
	assert.deepEqual(
		parallelAt(outcome).slots.map((leaf) =>
			leaf.status === "skipped" ? leaf.reason : leaf.status,
		),
		["cancelled", "cancelled", "cancelled"],
	);
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("caller cancellation preserves a cancelled agent step despite terminal hook rejection", async () => {
	const definition = parseWorkflowDefinition({
		version: 1,
		id: "cancelled-agent",
		args: {},
		limits: { concurrency: 1, maxCalls: 1, maxItems: 1 },
		steps: [sequentialAgent("agent")],
		result: { ref: "step", stepId: "agent" },
	});
	const controller = new AbortController();
	controller.abort("caller");
	const outcome = await executeWorkflow(
		definition,
		{},
		async () => {
			throw new Error("cancelled agent must not dispatch");
		},
		{
			signal: controller.signal,
			onEvent(event) {
				if (event.type === "leaf_terminal")
					throw new Error("terminal hook failed");
			},
		},
	);

	assert.equal(outcome.status, "cancelled");
	assert.equal(outcome.error?.code, "cancelled");
	assert.equal(outcome.steps[0]?.type, "agent");
	if (outcome.steps[0]?.type === "agent") {
		assert.equal(outcome.steps[0].leaf.status, "skipped");
		assert.equal(
			outcome.steps[0].leaf.status === "skipped"
				? outcome.steps[0].leaf.reason
				: undefined,
			"cancelled",
		);
	}
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("caller cancellation wins a simultaneous hook failure", async () => {
	const controller = new AbortController();
	const outcome = await executeWorkflow(
		parallelDefinition({ concurrency: 1 }),
		{},
		async (request) => {
			await request.progress({ message: "cancel-and-fail" });
			return new Promise(() => undefined);
		},
		{
			signal: controller.signal,
			onEvent(event) {
				if (event.type === "leaf_progress") {
					controller.abort("caller won");
					throw new Error("hook also failed");
				}
			},
		},
	);

	assert.equal(outcome.status, "cancelled");
	assert.equal(outcome.error?.code, "cancelled");
	assert.deepEqual(
		parallelAt(outcome).slots.map((leaf) => leaf.status),
		["cancelled", "skipped", "skipped"],
	);
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});
