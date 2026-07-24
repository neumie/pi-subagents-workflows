import assert from "node:assert/strict";
import { test } from "node:test";

import { createPiSubagentsLeafAdapterCore } from "../../src/adapters/pi-subagents-core.ts";
import {
	createPiSubagentsLeafAdapter,
	PiSubagentsV2UnavailableError,
	type DelegationEventBus,
} from "../../src/adapters/pi-subagents.ts";
import type { LeafRunnerRequestV1 } from "../../src/engine/index.ts";

const contract = {
	version: 2,
	requestEvent: "request",
	startedEvent: "started",
	updateEvent: "update",
	responseEvent: "response",
	cancelEvent: "cancel",
} as const;

class FakeBus implements DelegationEventBus {
	readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
	readonly emitted: Array<{ event: string; payload: unknown }> = [];
	readonly handlerDeliveries = new Map<string, number>();
	onEmit?: (event: string, payload: unknown) => void;

	on(event: string, listener: (payload: unknown) => void): () => void {
		let listeners = this.listeners.get(event);
		if (!listeners) {
			listeners = new Set();
			this.listeners.set(event, listeners);
		}
		listeners.add(listener);
		return () => listeners?.delete(listener);
	}

	emit(event: string, payload: unknown): void {
		this.emitted.push({ event, payload });
		for (const listener of this.listeners.get(event) ?? []) {
			this.handlerDeliveries.set(
				event,
				(this.handlerDeliveries.get(event) ?? 0) + 1,
			);
			listener(payload);
		}
		this.onEmit?.(event, payload);
	}

	listenerCount(event: string): number {
		return this.listeners.get(event)?.size ?? 0;
	}
}

function request(
	overrides: Partial<LeafRunnerRequestV1> = {},
): LeafRunnerRequestV1 {
	return {
		identity: { runId: "run-1", nodeId: "step:only", stepId: "only" },
		agent: "reviewer",
		prompt: '{"literal":true}',
		output: { mode: "text" },
		limits: { timeoutMs: 1_000, maxTurns: 3, maxToolCalls: 0 },
		signal: new AbortController().signal,
		progress: async () => undefined,
		...overrides,
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
	durationMs: 9,
};

function ids(): () => string {
	let next = 0;
	return () => `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`;
}

function responseFor(
	payload: unknown,
	overrides: Record<string, unknown>,
): Record<string, unknown> {
	const sent = payload as Record<string, unknown>;
	return {
		version: 2,
		requestId: sent.requestId,
		ownerRunId: sent.ownerRunId,
		nodeId: sent.nodeId,
		...overrides,
	};
}

test("projects an exact V2 request including hard zero and preserves literal JSON text", async () => {
	const bus = new FakeBus();
	const adapter = createPiSubagentsLeafAdapterCore(
		{ events: bus, cwd: "/workspace" },
		contract,
		() => "00000000-0000-4000-8000-000000000001",
	);
	bus.onEmit = (event, payload) => {
		if (event !== contract.requestEvent) return;
		const sent = payload as Record<string, unknown>;
		bus.emit(contract.responseEvent, {
			version: 2,
			requestId: sent.requestId,
			ownerRunId: "run-1",
			nodeId: "step:only",
			status: "completed",
			result: { kind: "text", text: '{"answer":42}' },
			usage,
		});
	};

	const terminal = await adapter.leafRunner(request());
	const sent = bus.emitted[0];
	assert.equal(sent?.event, contract.requestEvent);
	assert.deepEqual(sent?.payload, {
		version: 2,
		requestId: "00000000-0000-4000-8000-000000000001",
		ownerRunId: "run-1",
		nodeId: "step:only",
		agent: "reviewer",
		task: '{"literal":true}',
		context: "fresh",
		cwd: "/workspace",
		timeoutMs: 1_000,
		turnBudget: { maxTurns: 3, graceTurns: 0 },
		toolBudget: { hard: 0, block: "*" },
		result: { kind: "text" },
	});
	assert.deepEqual(terminal, {
		status: "completed",
		result: { mode: "text", text: '{"answer":42}' },
		usage,
	});
	assert.equal(bus.listenerCount(contract.responseEvent), 1);
	assert.equal(bus.listenerCount(contract.updateEvent), 1);
	adapter.dispose();
	assert.equal(bus.listenerCount(contract.responseEvent), 0);
	assert.equal(bus.listenerCount(contract.updateEvent), 0);
});

test("maps structured values, effective metadata, every status, and usage", async () => {
	const bus = new FakeBus();
	const adapter = createPiSubagentsLeafAdapterCore(
		{ events: bus, cwd: "/workspace", context: "fork" },
		contract,
		ids(),
	);
	const terminals = [
		{
			wire: {
				status: "completed",
				result: { kind: "structured", value: { answer: "yes" } },
				usage,
				model: "provider/model",
				thinking: "high",
			},
			expected: {
				status: "completed",
				result: { mode: "structured", value: { answer: "yes" } },
				usage,
				model: "provider/model",
				thinking: "high",
			},
		},
		{
			wire: { status: "failed", error: "ordinary", usage },
			expected: {
				status: "failed",
				error: {
					code: "provider_failed",
					message: "ordinary",
					retryable: false,
				},
				usage,
			},
		},
		{
			wire: { status: "acceptance_failed", error: "rejected", usage },
			expected: {
				status: "failed",
				error: {
					code: "acceptance_failed",
					message: "rejected",
					retryable: false,
				},
				usage,
			},
		},
		...[
			"timed_out",
			"cancelled",
			"interrupted",
			"turn_budget_exhausted",
			"tool_budget_exhausted",
			"duplicate_node",
			"unavailable_context",
		].map((status) => ({
			wire: { status, usage, model: "effective", thinking: "medium" },
			expected: { status, usage, model: "effective", thinking: "medium" },
		})),
	];
	let index = 0;
	bus.onEmit = (event, payload) => {
		if (event !== contract.requestEvent) return;
		bus.emit(
			contract.responseEvent,
			responseFor(payload, terminals[index++]?.wire ?? {}),
		);
	};

	for (const [terminalIndex, fixture] of terminals.entries()) {
		const leafRequest =
			terminalIndex === 0
				? request({
						output: {
							mode: "structured",
							schema: {
								type: "object",
								properties: { answer: { type: "string" } },
								required: ["answer"],
								additionalProperties: false,
							},
						},
					})
				: request();
		assert.deepEqual(await adapter.leafRunner(leafRequest), fixture.expected);
	}
	const structuredRequest = bus.emitted.find(
		({ event, payload }) =>
			event === contract.requestEvent &&
			(payload as { result?: { kind?: string } }).result?.kind === "structured",
	);
	assert.deepEqual(
		(structuredRequest?.payload as { context?: string }).context,
		"fork",
	);
	adapter.dispose();
});

test("fails matching malformed terminals instead of hanging and ignores V1 traffic", async () => {
	const malformedCases: Array<(base: Record<string, unknown>) => unknown> = [
		(base) => ({
			...base,
			status: "completed",
			result: { kind: "text", text: "x", unknown: true },
			usage,
		}),
		(base) => ({ ...base, status: "mystery", usage }),
		(base) => ({ ...base, status: "failed", usage, unknown: true }),
		(base) => {
			const hostile = { ...base, status: "failed", usage };
			Object.defineProperty(hostile, "error", {
				enumerable: true,
				get() {
					throw new Error("getter must not run");
				},
			});
			return hostile;
		},
		(base) => ({ ...base, status: "failed", usage, toJSON: () => base }),
		(base) => ({
			...base,
			status: "completed",
			result: { kind: "text", text: "x".repeat(2 * 1024 * 1024) },
			usage,
		}),
	];
	for (const makeMalformed of malformedCases) {
		const bus = new FakeBus();
		const adapter = createPiSubagentsLeafAdapterCore(
			{ events: bus, cwd: "/workspace" },
			contract,
			ids(),
		);
		bus.onEmit = (event, payload) => {
			if (event !== contract.requestEvent) return;
			bus.emit(contract.responseEvent, { version: 1, requestId: "legacy" });
			bus.emit(contract.responseEvent, makeMalformed(responseFor(payload, {})));
		};
		const terminal = await adapter.leafRunner(request());
		assert.equal(terminal.status, "failed");
		assert.equal(
			terminal.status === "failed" ? terminal.error.code : undefined,
			"provider_contract",
		);
		assert.deepEqual(terminal.usage, {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			turns: 0,
			toolCalls: 0,
			durationMs: 0,
		});
		adapter.dispose();
	}
});

test("locally cancels before a response and ignores duplicate and late terminals", async () => {
	const bus = new FakeBus();
	const controller = new AbortController();
	const idGenerator = ids();
	const adapter = createPiSubagentsLeafAdapterCore(
		{ events: bus, cwd: "/workspace" },
		contract,
		idGenerator,
	);
	let sentRequest: unknown;
	bus.onEmit = (event, payload) => {
		if (event === contract.requestEvent) {
			sentRequest = payload;
			controller.abort();
		}
		if (event === contract.cancelEvent) {
			bus.emit(
				contract.responseEvent,
				responseFor(payload, {
					status: "completed",
					result: { kind: "text", text: "cancel-race" },
					usage,
				}),
			);
		}
	};
	const cancelled = await adapter.leafRunner(
		request({ signal: controller.signal }),
	);
	assert.deepEqual(cancelled, {
		status: "cancelled",
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
	});
	assert.deepEqual(bus.emitted[1], {
		event: contract.cancelEvent,
		payload: responseFor(sentRequest, {}),
	});
	bus.emit(
		contract.responseEvent,
		responseFor(sentRequest, {
			status: "completed",
			result: { kind: "text", text: "late" },
			usage,
		}),
	);

	const secondController = new AbortController();
	bus.onEmit = (event, payload) => {
		if (event !== contract.requestEvent) return;
		const terminal = responseFor(payload, {
			status: "completed",
			result: { kind: "text", text: "first" },
			usage,
		});
		bus.emit(contract.responseEvent, terminal);
		bus.emit(contract.responseEvent, {
			...terminal,
			result: { kind: "text", text: "duplicate" },
		});
		secondController.abort();
	};
	assert.equal(
		(await adapter.leafRunner(request({ signal: secondController.signal })))
			.status,
		"completed",
	);
	assert.equal(
		bus.emitted.filter(({ event }) => event === contract.cancelEvent).length,
		1,
	);
	adapter.dispose();
});

test("emits at most one cancel when abort and request emission failure combine", async () => {
	const bus = new FakeBus();
	const controller = new AbortController();
	const adapter = createPiSubagentsLeafAdapterCore(
		{ events: bus, cwd: "/workspace" },
		contract,
		ids(),
	);
	bus.onEmit = (event) => {
		if (event !== contract.requestEvent) return;
		controller.abort();
		throw new Error("request emit failed after delivery");
	};
	assert.equal(
		(await adapter.leafRunner(request({ signal: controller.signal }))).status,
		"cancelled",
	);
	assert.deepEqual(
		bus.emitted.map(({ event }) => event),
		[contract.requestEvent, contract.cancelEvent],
	);
	assert.equal(
		(await adapter.leafRunner(request())).status,
		"unavailable_context",
	);
	adapter.dispose();
});

test("maps the provider request-id-only invalid_request response", async () => {
	const bus = new FakeBus();
	const adapter = createPiSubagentsLeafAdapterCore(
		{ events: bus, cwd: "/workspace" },
		contract,
		ids(),
	);
	bus.onEmit = (event, payload) => {
		if (event !== contract.requestEvent) return;
		bus.emit(contract.responseEvent, {
			version: 2,
			requestId: (payload as { requestId: string }).requestId,
			status: "invalid_request",
			error: "invalid",
		});
	};
	assert.deepEqual(await adapter.leafRunner(request()), {
		status: "invalid_request",
		error: { code: "invalid_request", message: "invalid", retryable: false },
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
	});
	adapter.dispose();
});

test("shares two listeners across adapters and concurrent leaves and scopes disposal", async () => {
	const bus = new FakeBus();
	const idGenerator = ids();
	const first = createPiSubagentsLeafAdapterCore(
		{ events: bus, cwd: "/workspace" },
		contract,
		idGenerator,
	);
	const second = createPiSubagentsLeafAdapterCore(
		{ events: bus, cwd: "/workspace" },
		contract,
		idGenerator,
	);
	assert.equal(bus.listenerCount(contract.responseEvent), 1);
	assert.equal(bus.listenerCount(contract.updateEvent), 1);
	const payloads: unknown[] = [];
	bus.onEmit = (event, payload) => {
		if (event === contract.requestEvent) payloads.push(payload);
	};
	const pending = Array.from({ length: 50 }, (_, index) =>
		(index % 2 === 0 ? first : second).leafRunner(
			request({
				identity: {
					runId: `run-${index}`,
					nodeId: `node-${index}`,
					stepId: `step-${index}`,
				},
			}),
		),
	);
	assert.equal(payloads.length, 50);
	first.dispose();
	for (let index = 1; index < payloads.length; index += 2) {
		const payload = payloads[index];
		bus.emit(
			contract.responseEvent,
			responseFor(payload, {
				status: "completed",
				result: { kind: "text", text: `result-${index}` },
				usage,
			}),
		);
	}
	const terminals = await Promise.all(pending);
	assert.equal(
		terminals.filter(({ status }) => status === "interrupted").length,
		25,
	);
	assert.equal(
		terminals.filter(({ status }) => status === "completed").length,
		25,
	);
	assert.equal(bus.handlerDeliveries.get(contract.responseEvent), 25);
	assert.equal(bus.listenerCount(contract.responseEvent), 1);
	assert.equal(
		(await first.leafRunner(request())).status,
		"unavailable_context",
	);
	second.dispose();
	assert.equal(bus.listenerCount(contract.responseEvent), 0);
	assert.equal(bus.listenerCount(contract.updateEvent), 0);

	const reloaded = createPiSubagentsLeafAdapterCore(
		{ events: bus, cwd: "/workspace" },
		contract,
		ids(),
	);
	assert.equal(bus.listenerCount(contract.responseEvent), 1);
	reloaded.dispose();
});

test("fails with a bounded typed error when the unpublished provider is absent", async () => {
	await assert.rejects(
		createPiSubagentsLeafAdapter({ events: new FakeBus(), cwd: "/workspace" }),
		(error: unknown) =>
			error instanceof PiSubagentsV2UnavailableError &&
			Buffer.byteLength(error.message, "utf8") <= 1024,
	);
});

test("forwards only bounded exact-tuple updates and swallows progress rejection", async () => {
	const bus = new FakeBus();
	const updates: string[] = [];
	const adapter = createPiSubagentsLeafAdapterCore(
		{ events: bus, cwd: "/workspace" },
		contract,
		ids(),
	);
	bus.onEmit = (event, payload) => {
		if (event !== contract.requestEvent) return;
		const exact = responseFor(payload, {});
		bus.emit(contract.updateEvent, { ...exact, recentOutput: "working" });
		bus.emit(contract.updateEvent, {
			...exact,
			nodeId: "other",
			recentOutput: "wrong",
		});
		bus.emit(contract.updateEvent, {
			...exact,
			recentOutput: "bad",
			unknown: true,
		});
		bus.emit(contract.updateEvent, { ...exact, currentTool: "read" });
		bus.emit(
			contract.responseEvent,
			responseFor(payload, {
				status: "failed",
				error: "done",
			}),
		);
	};
	const terminal = await adapter.leafRunner(
		request({
			progress: async (update) => {
				updates.push(update.message);
				if (update.message === "Using read")
					throw new Error("presentation failed");
			},
		}),
	);
	assert.equal(terminal.status, "failed");
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(updates, ["working"]);
	adapter.dispose();
});

test("does not emit an orphan cancel for a pre-aborted request", async () => {
	const bus = new FakeBus();
	const controller = new AbortController();
	controller.abort();
	const adapter = createPiSubagentsLeafAdapterCore(
		{ events: bus, cwd: "/workspace" },
		contract,
		ids(),
	);
	assert.deepEqual(
		await adapter.leafRunner(request({ signal: controller.signal })),
		{
			status: "cancelled",
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
		},
	);
	assert.deepEqual(bus.emitted, []);
	adapter.dispose();
});

test("preserves an own __proto__ key without prototype injection", async () => {
	const bus = new FakeBus();
	const adapter = createPiSubagentsLeafAdapterCore(
		{ events: bus, cwd: "/workspace" },
		contract,
		ids(),
	);
	const structured = Object.create(null) as Record<string, unknown>;
	Object.defineProperty(structured, "__proto__", {
		value: { polluted: true },
		enumerable: true,
		configurable: true,
		writable: true,
	});
	bus.onEmit = (event, payload) => {
		if (event !== contract.requestEvent) return;
		bus.emit(
			contract.responseEvent,
			responseFor(payload, {
				status: "completed",
				result: { kind: "structured", value: structured },
				usage,
			}),
		);
	};
	const terminal = await adapter.leafRunner(
		request({
			output: {
				mode: "structured",
				schema: {
					type: "object",
					properties: {},
					required: [],
					additionalProperties: false,
				},
			},
		}),
	);
	assert.equal(terminal.status, "completed");
	if (terminal.status !== "completed" || terminal.result.mode !== "structured")
		throw new Error("expected a structured completion");
	assert.equal(Object.hasOwn(terminal.result.value, "__proto__"), true);
	assert.deepEqual(terminal.result.value.__proto__, { polluted: true });
	assert.equal(
		(terminal.result.value as Record<string, unknown>).polluted,
		undefined,
	);
	adapter.dispose();
});

test("serializes progress callbacks and coalesces a bounded pending update", async () => {
	const bus = new FakeBus();
	const adapter = createPiSubagentsLeafAdapterCore(
		{ events: bus, cwd: "/workspace" },
		contract,
		ids(),
	);
	let sent: unknown;
	bus.onEmit = (event, payload) => {
		if (event === contract.requestEvent) sent = payload;
	};
	let active = 0;
	let maximumActive = 0;
	const messages: string[] = [];
	const releases: Array<() => void> = [];
	const pending = adapter.leafRunner(
		request({
			progress: (update) =>
				new Promise<void>((resolve) => {
					active += 1;
					maximumActive = Math.max(maximumActive, active);
					messages.push(update.message);
					releases.push(() => {
						active -= 1;
						resolve();
					});
				}),
		}),
	);
	const exact = responseFor(sent, {});
	bus.emit(contract.updateEvent, { ...exact, recentOutput: "first" });
	bus.emit(contract.updateEvent, { ...exact, recentOutput: "second" });
	bus.emit(contract.updateEvent, { ...exact, recentOutput: "latest" });
	assert.deepEqual(messages, ["first"]);
	assert.equal(maximumActive, 1);
	releases.shift()?.();
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(messages, ["first", "latest"]);
	assert.equal(maximumActive, 1);
	releases.shift()?.();
	bus.emit(
		contract.responseEvent,
		responseFor(sent, {
			status: "completed",
			result: { kind: "text", text: "done" },
			usage,
		}),
	);
	assert.equal((await pending).status, "completed");
	adapter.dispose();
});

test("maps public optional usage to zero and enforces invalid_request closure", async () => {
	const bus = new FakeBus();
	const adapter = createPiSubagentsLeafAdapterCore(
		{ events: bus, cwd: "/workspace" },
		contract,
		ids(),
	);
	let attempt = 0;
	bus.onEmit = (event, payload) => {
		if (event !== contract.requestEvent) return;
		attempt += 1;
		bus.emit(
			contract.responseEvent,
			attempt === 1
				? responseFor(payload, {
						status: "completed",
						result: { kind: "text", text: "without usage" },
					})
				: {
						version: 2,
						requestId: (payload as { requestId: string }).requestId,
						status: "invalid_request",
						error: "invalid",
						usage,
					},
		);
	};
	const completed = await adapter.leafRunner(request());
	assert.deepEqual(completed, {
		status: "completed",
		result: { mode: "text", text: "without usage" },
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
	});
	const malformed = await adapter.leafRunner(request());
	assert.equal(malformed.status, "failed");
	assert.equal(
		malformed.status === "failed" ? malformed.error.code : undefined,
		"provider_contract",
	);
	adapter.dispose();
});

test("accepts provider-bound text independently of wrapper encoding", async () => {
	const bus = new FakeBus();
	const adapter = createPiSubagentsLeafAdapterCore(
		{ events: bus, cwd: "/workspace" },
		contract,
		ids(),
	);
	const text = '"'.repeat(1024 * 1024);
	bus.onEmit = (event, payload) => {
		if (event !== contract.requestEvent) return;
		bus.emit(
			contract.responseEvent,
			responseFor(payload, {
				status: "completed",
				result: { kind: "text", text },
				usage,
			}),
		);
	};
	const terminal = await adapter.leafRunner(request());
	assert.equal(terminal.status, "completed");
	assert.equal(
		terminal.status === "completed" && terminal.result.mode === "text"
			? terminal.result.text.length
			: 0,
		text.length,
	);
	adapter.dispose();
});

test("bounds update arrays before allocation", async () => {
	const bus = new FakeBus();
	const adapter = createPiSubagentsLeafAdapterCore(
		{ events: bus, cwd: "/workspace" },
		contract,
		ids(),
	);
	let sent: unknown;
	bus.onEmit = (event, payload) => {
		if (event === contract.requestEvent) sent = payload;
	};
	const pending = adapter.leafRunner(request());
	const sparse: string[] = [];
	sparse.length = 0xffff_ffff;
	bus.emit(contract.updateEvent, {
		...responseFor(sent, {}),
		recentOutputLines: sparse,
	});
	bus.emit(
		contract.responseEvent,
		responseFor(sent, {
			status: "completed",
			result: { kind: "text", text: "safe" },
			usage,
		}),
	);
	assert.equal((await pending).status, "completed");
	adapter.dispose();
});

test("contains hostile option and thrown-error getters", async () => {
	let optionGetterCalls = 0;
	const hostileOptions = { cwd: "/workspace" } as Record<string, unknown>;
	Object.defineProperty(hostileOptions, "events", {
		enumerable: true,
		get() {
			optionGetterCalls += 1;
			throw new Error("must not run");
		},
	});
	assert.throws(
		() =>
			createPiSubagentsLeafAdapterCore(
				hostileOptions as unknown as Parameters<
					typeof createPiSubagentsLeafAdapterCore
				>[0],
				contract,
				ids(),
			),
		PiSubagentsV2UnavailableError,
	);
	assert.equal(optionGetterCalls, 0);

	const bus = new FakeBus();
	const adapter = createPiSubagentsLeafAdapterCore(
		{ events: bus, cwd: "/workspace" },
		contract,
		ids(),
	);
	let messageGetterCalls = 0;
	bus.onEmit = (event) => {
		if (event !== contract.requestEvent) return;
		const hostile = new Error("hidden");
		Object.defineProperty(hostile, "message", {
			get() {
				messageGetterCalls += 1;
				throw new Error("must not run");
			},
		});
		throw hostile;
	};
	assert.equal(
		(await adapter.leafRunner(request())).status,
		"unavailable_context",
	);
	assert.equal(messageGetterCalls, 0);
	assert.deepEqual(
		bus.emitted.map(({ event }) => event),
		[contract.requestEvent, contract.cancelEvent],
	);
	assert.equal(
		(await adapter.leafRunner(request())).status,
		"unavailable_context",
	);
	assert.equal(bus.emitted.length, 2);
	adapter.dispose();
});

test("poisons ambiguous partial subscription teardown without accumulating listeners", () => {
	class BrokenSetupBus extends FakeBus {
		onCalls = 0;

		override on(
			event: string,
			listener: (payload: unknown) => void,
		): () => void {
			this.onCalls += 1;
			const unsubscribe = super.on(event, listener);
			if (event === contract.updateEvent)
				throw new Error("partial update setup");
			return () => {
				if (event === contract.responseEvent)
					throw new Error("teardown failed");
				unsubscribe();
			};
		}
	}
	const bus = new BrokenSetupBus();
	assert.throws(
		() =>
			createPiSubagentsLeafAdapterCore(
				{ events: bus, cwd: "/workspace" },
				contract,
				ids(),
			),
		PiSubagentsV2UnavailableError,
	);
	assert.equal(bus.onCalls, 2);
	assert.equal(bus.listenerCount(contract.responseEvent), 1);
	assert.equal(bus.listenerCount(contract.updateEvent), 1);
	assert.throws(
		() =>
			createPiSubagentsLeafAdapterCore(
				{ events: bus, cwd: "/workspace" },
				contract,
				ids(),
			),
		PiSubagentsV2UnavailableError,
	);
	assert.equal(bus.onCalls, 2);
	assert.equal(bus.listenerCount(contract.responseEvent), 1);
	assert.equal(bus.listenerCount(contract.updateEvent), 1);
});

test("blocks reentrant adapter creation before final unsubscribe begins", () => {
	class ReentrantTeardownBus extends FakeBus {
		reentryError: unknown;
		private attemptedReentry = false;

		override on(
			event: string,
			listener: (payload: unknown) => void,
		): () => void {
			const unsubscribe = super.on(event, listener);
			return () => {
				unsubscribe();
				if (!this.attemptedReentry) {
					this.attemptedReentry = true;
					try {
						createPiSubagentsLeafAdapterCore(
							{ events: this, cwd: "/workspace" },
							contract,
							ids(),
						);
					} catch (error) {
						this.reentryError = error;
					}
				}
				if (event === contract.responseEvent)
					throw new Error("unsubscribe failed");
			};
		}
	}
	const bus = new ReentrantTeardownBus();
	const adapter = createPiSubagentsLeafAdapterCore(
		{ events: bus, cwd: "/workspace" },
		contract,
		ids(),
	);
	adapter.dispose();
	assert.ok(bus.reentryError instanceof PiSubagentsV2UnavailableError);
	assert.equal(bus.listenerCount(contract.responseEvent), 0);
	assert.equal(bus.listenerCount(contract.updateEvent), 0);
	assert.throws(
		() =>
			createPiSubagentsLeafAdapterCore(
				{ events: bus, cwd: "/workspace" },
				contract,
				ids(),
			),
		PiSubagentsV2UnavailableError,
	);
});

test("truncates maximum-sized progress text in linear bounded work", async () => {
	const bus = new FakeBus();
	let progressMessage = "";
	const adapter = createPiSubagentsLeafAdapterCore(
		{ events: bus, cwd: "/workspace" },
		contract,
		ids(),
	);
	bus.onEmit = (event, payload) => {
		if (event !== contract.requestEvent) return;
		const identity = responseFor(payload, {});
		bus.emit(contract.updateEvent, {
			...identity,
			currentTool: "x".repeat(256 * 1024),
		});
		bus.emit(
			contract.responseEvent,
			responseFor(payload, {
				status: "completed",
				result: { kind: "text", text: "done" },
				usage,
			}),
		);
	};
	const terminal = await adapter.leafRunner(
		request({
			progress: async ({ message }) => {
				progressMessage = message;
			},
		}),
	);
	assert.equal(terminal.status, "completed");
	assert.ok(Buffer.byteLength(progressMessage, "utf8") <= 256 * 1024);
	assert.match(progressMessage, /\.\.\.$/);
	adapter.dispose();
});

test("blocks reentrant adapter creation while the shared hub is attaching", () => {
	class ReentrantSetupBus extends FakeBus {
		reentryError: unknown;
		private attemptedReentry = false;

		override on(
			event: string,
			listener: (payload: unknown) => void,
		): () => void {
			const unsubscribe = super.on(event, listener);
			if (!this.attemptedReentry) {
				this.attemptedReentry = true;
				try {
					createPiSubagentsLeafAdapterCore(
						{ events: this, cwd: "/workspace" },
						contract,
						ids(),
					);
				} catch (error) {
					this.reentryError = error;
				}
			}
			return unsubscribe;
		}
	}
	const bus = new ReentrantSetupBus();
	const adapter = createPiSubagentsLeafAdapterCore(
		{ events: bus, cwd: "/workspace" },
		contract,
		ids(),
	);
	assert.ok(bus.reentryError instanceof PiSubagentsV2UnavailableError);
	assert.equal(bus.listenerCount(contract.responseEvent), 1);
	assert.equal(bus.listenerCount(contract.updateEvent), 1);
	adapter.dispose();
	assert.equal(bus.listenerCount(contract.responseEvent), 0);
	assert.equal(bus.listenerCount(contract.updateEvent), 0);
	const reloaded = createPiSubagentsLeafAdapterCore(
		{ events: bus, cwd: "/workspace" },
		contract,
		ids(),
	);
	assert.equal(bus.listenerCount(contract.responseEvent), 1);
	reloaded.dispose();
});

test("rejects duplicate event contracts and ignores eager subscription traffic", () => {
	assert.throws(
		() =>
			createPiSubagentsLeafAdapterCore(
				{ events: new FakeBus(), cwd: "/workspace" },
				{ ...contract, updateEvent: contract.responseEvent },
				ids(),
			),
		PiSubagentsV2UnavailableError,
	);
	class EagerBus extends FakeBus {
		override on(
			event: string,
			listener: (payload: unknown) => void,
		): () => void {
			const unsubscribe = super.on(event, listener);
			listener({ version: 2, requestId: "eager-before-hub" });
			return unsubscribe;
		}
	}
	const adapter = createPiSubagentsLeafAdapterCore(
		{ events: new EagerBus(), cwd: "/workspace" },
		contract,
		ids(),
	);
	adapter.dispose();
});
