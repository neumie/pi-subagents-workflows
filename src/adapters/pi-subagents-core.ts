import { types as utilTypes } from "node:util";

import type { JsonValue, ObjectSchemaV1 } from "../ir/index.ts";
import { cloneSafeJson } from "../ir/json.ts";
import type {
	LeafProgressUpdateV1,
	LeafRunner,
	LeafRunnerRequestV1,
	LeafRunnerTerminalV1,
	WorkflowUsageV1,
} from "../engine/index.ts";
import type {
	DelegationEventBus,
	PiSubagentsLeafAdapter,
	PiSubagentsLeafAdapterOptions,
} from "./pi-subagents.ts";
import {
	PiSubagentsV2UnavailableError,
	safeErrorMessage,
} from "./pi-subagents-errors.ts";

const MIB = 1024 * 1024;
const MAX_TERMINAL_ENVELOPE_BYTES = 8 * MIB;
const MAX_PROGRESS_ENVELOPE_BYTES = 2 * MIB;
const MAX_RESULT_BYTES = MIB;
const MAX_SCHEMA_BYTES = 64 * 1024;
const MAX_PROGRESS_BYTES = 256 * 1024;
const MAX_ERROR_BYTES = 1024;
const MAX_ID_BYTES = 256;
const MAX_METADATA_BYTES = 1024;
const MAX_CWD_BYTES = 32 * 1024;
const MAX_EVENT_BYTES = 256;
const MAX_JSON_ENTRIES = 100_256;
const PROHIBITED_TEXT =
	/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

const USAGE_FIELDS = [
	"input",
	"output",
	"cacheRead",
	"cacheWrite",
	"cost",
	"turns",
	"toolCalls",
	"durationMs",
] as const;

const ZERO_USAGE: WorkflowUsageV1 = Object.freeze({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
	turns: 0,
	toolCalls: 0,
	durationMs: 0,
});

export interface PiSubagentsV2Contract {
	readonly version: 2;
	readonly requestEvent: string;
	readonly startedEvent: string;
	readonly updateEvent: string;
	readonly responseEvent: string;
	readonly cancelEvent: string;
}

interface AdapterOwner {
	disposed: boolean;
}

interface Attempt {
	readonly owner: AdapterOwner;
	readonly requestId: string;
	readonly ownerRunId: string;
	readonly nodeId: string;
	readonly outputMode: "text" | "structured";
	readonly request: LeafRunnerRequestV1;
	readonly resolve: (terminal: LeafRunnerTerminalV1) => void;
	readonly abort: () => void;
	settled: boolean;
	requestEmissionStarted: boolean;
	progressActive: boolean;
	pendingProgress: LeafProgressUpdateV1 | undefined;
	cancellationSent: boolean;
}

interface Hub {
	readonly bus: DelegationEventBus;
	readonly emit: DelegationEventBus["emit"];
	readonly contract: PiSubagentsV2Contract;
	readonly attempts: Map<string, Attempt>;
	readonly unsubscribeResponse: () => void;
	readonly unsubscribeUpdate: () => void;
	refCount: number;
	broken: boolean;
}

interface AdapterOptionsSnapshot {
	readonly events: DelegationEventBus;
	readonly on: DelegationEventBus["on"];
	readonly emit: DelegationEventBus["emit"];
	readonly cwd: string;
	readonly context: "fresh" | "fork";
}

type JsonObject = { [key: string]: JsonValue };
type RequestIdGenerator = () => string;

const hubs = new WeakMap<DelegationEventBus, Hub>();
const poisonedBuses = new WeakSet<DelegationEventBus>();
const attachingBuses = new WeakSet<DelegationEventBus>();
const detachingBuses = new WeakSet<DelegationEventBus>();

function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function boundedText(value: string, maximum = MAX_ERROR_BYTES): string {
	if (byteLength(value) <= maximum) return value;
	const characters: string[] = [];
	let usedBytes = 0;
	for (const character of value) {
		const characterBytes = byteLength(character);
		if (usedBytes + characterBytes > maximum - 3) break;
		characters.push(character);
		usedBytes += characterBytes;
	}
	return `${characters.join("")}...`;
}

function contractFailure(message: string): LeafRunnerTerminalV1 {
	return {
		status: "failed",
		error: {
			code: "provider_contract",
			message: boundedText(message),
			retryable: false,
		},
		usage: ZERO_USAGE,
	};
}

function unavailable(message?: string): LeafRunnerTerminalV1 {
	return {
		status: "unavailable_context",
		...(message
			? {
					error: {
						code: "unavailable_context",
						message: boundedText(message),
						retryable: false,
					},
				}
			: {}),
		usage: ZERO_USAGE,
	};
}

function cloneJson(
	input: unknown,
	maximumBytes: number,
	subject = "provider payload",
	maximumDepth = 72,
	maximumEntries = MAX_JSON_ENTRIES,
): JsonValue {
	return cloneSafeJson(input, {
		maximumBytes,
		maximumDepth,
		maximumEntries,
		subject,
		sizeLabel: `${Math.ceil(maximumBytes / 1024)} KiB`,
		rejectProxies: true,
	});
}

function dataMethod(input: object, name: "on" | "emit"): Function {
	let current: object | null = input;
	while (current !== null) {
		if (utilTypes.isProxy(current))
			throw new PiSubagentsV2UnavailableError(
				"adapter event bus must not be a proxy",
			);
		let descriptor: PropertyDescriptor | undefined;
		try {
			descriptor = Object.getOwnPropertyDescriptor(current, name);
		} catch {
			throw new PiSubagentsV2UnavailableError(
				`adapter event bus ${name} method cannot be safely inspected`,
			);
		}
		if (descriptor !== undefined) {
			if (!("value" in descriptor) || typeof descriptor.value !== "function")
				throw new PiSubagentsV2UnavailableError(
					`adapter event bus ${name} must be a data method`,
				);
			return descriptor.value as Function;
		}
		try {
			current = Object.getPrototypeOf(current) as object | null;
		} catch {
			throw new PiSubagentsV2UnavailableError(
				`adapter event bus ${name} method cannot be safely inspected`,
			);
		}
	}
	throw new PiSubagentsV2UnavailableError(
		`adapter event bus is missing its ${name} method`,
	);
}

function snapshotOptions(input: unknown): AdapterOptionsSnapshot {
	if (typeof input !== "object" || input === null || utilTypes.isProxy(input))
		throw new PiSubagentsV2UnavailableError(
			"adapter options must be a plain object",
		);
	let prototype: object | null;
	let keys: (string | symbol)[];
	let descriptors: PropertyDescriptorMap;
	try {
		prototype = Object.getPrototypeOf(input) as object | null;
		keys = Reflect.ownKeys(input);
		descriptors = Object.getOwnPropertyDescriptors(input);
	} catch {
		throw new PiSubagentsV2UnavailableError(
			"adapter options cannot be safely inspected",
		);
	}
	if (prototype !== Object.prototype && prototype !== null)
		throw new PiSubagentsV2UnavailableError(
			"adapter options must be a plain object",
		);
	const allowed = new Set(["events", "cwd", "context"]);
	for (const key of keys) {
		if (typeof key !== "string" || !allowed.has(key))
			throw new PiSubagentsV2UnavailableError(
				"adapter options contain an unknown field",
			);
		const descriptor = descriptors[key];
		if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
			throw new PiSubagentsV2UnavailableError(
				`adapter option ${key} must be an enumerable data property`,
			);
	}
	const events = descriptors.events;
	const cwd = descriptors.cwd;
	const context = descriptors.context;
	if (
		!events ||
		!("value" in events) ||
		typeof events.value !== "object" ||
		events.value === null ||
		utilTypes.isProxy(events.value)
	)
		throw new PiSubagentsV2UnavailableError("adapter events are unavailable");
	if (
		!cwd ||
		!("value" in cwd) ||
		typeof cwd.value !== "string" ||
		cwd.value.trim().length === 0 ||
		byteLength(cwd.value) > MAX_CWD_BYTES ||
		PROHIBITED_TEXT.test(cwd.value)
	)
		throw new PiSubagentsV2UnavailableError(
			"adapter cwd must be safe, nonempty, and at most 32 KiB",
		);
	const selectedContext =
		context && "value" in context ? (context.value as unknown) : "fresh";
	if (selectedContext !== "fresh" && selectedContext !== "fork")
		throw new PiSubagentsV2UnavailableError(
			"adapter context must be fresh or fork",
		);
	const eventBus = events.value as DelegationEventBus;
	const onMethod = dataMethod(eventBus, "on");
	const emitMethod = dataMethod(eventBus, "emit");
	return {
		events: eventBus,
		on: (event, listener) =>
			Reflect.apply(onMethod, eventBus, [event, listener]) as () => void,
		emit: (event, payload) => {
			Reflect.apply(emitMethod, eventBus, [event, payload]);
		},
		cwd: cwd.value,
		context: selectedContext,
	};
}

function isJsonObject(value: JsonValue): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: JsonObject, allowed: readonly string[]): void {
	const accepted = new Set(allowed);
	for (const key of Object.keys(value)) {
		if (!accepted.has(key)) throw new Error(`unexpected field ${key}`);
	}
}

function validBoundedString(
	value: JsonValue | undefined,
	maximum = MAX_METADATA_BYTES,
): value is string {
	return typeof value === "string" && byteLength(value) <= maximum;
}

function validIdentity(value: JsonValue | undefined): value is string {
	return (
		typeof value === "string" &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
			value,
		) &&
		byteLength(value) <= MAX_ID_BYTES
	);
}

function ownData(input: unknown, key: string): unknown {
	if (typeof input !== "object" || input === null || utilTypes.isProxy(input))
		return undefined;
	try {
		const descriptor = Object.getOwnPropertyDescriptor(input, key);
		return descriptor && "value" in descriptor ? descriptor.value : undefined;
	} catch {
		return undefined;
	}
}

function validateContract(contract: PiSubagentsV2Contract): void {
	if (contract.version !== 2)
		throw new PiSubagentsV2UnavailableError(
			"pi-subagents/delegation does not export protocol version 2",
		);
	const events = Object.entries({
		request: contract.requestEvent,
		started: contract.startedEvent,
		update: contract.updateEvent,
		response: contract.responseEvent,
		cancel: contract.cancelEvent,
	});
	for (const [name, event] of events) {
		if (
			typeof event !== "string" ||
			event.trim().length === 0 ||
			byteLength(event) > MAX_EVENT_BYTES ||
			PROHIBITED_TEXT.test(event)
		)
			throw new PiSubagentsV2UnavailableError(
				`pi-subagents/delegation exports an invalid ${name} event`,
			);
	}
	if (new Set(events.map(([, event]) => event)).size !== events.length)
		throw new PiSubagentsV2UnavailableError(
			"pi-subagents/delegation exports duplicate V2 events",
		);
}

function sameContract(
	left: PiSubagentsV2Contract,
	right: PiSubagentsV2Contract,
): boolean {
	return (
		left.version === right.version &&
		left.requestEvent === right.requestEvent &&
		left.startedEvent === right.startedEvent &&
		left.updateEvent === right.updateEvent &&
		left.responseEvent === right.responseEvent &&
		left.cancelEvent === right.cancelEvent
	);
}

function parseUsage(value: JsonValue | undefined): WorkflowUsageV1 {
	if (value === undefined) return ZERO_USAGE;
	if (!isJsonObject(value)) throw new Error("invalid usage");
	exactKeys(value, USAGE_FIELDS);
	for (const field of USAGE_FIELDS) {
		const item = value[field];
		if (typeof item !== "number" || !Number.isFinite(item) || item < 0)
			throw new Error(`invalid usage.${field}`);
	}
	for (const field of [
		"input",
		"output",
		"cacheRead",
		"cacheWrite",
		"turns",
		"toolCalls",
	] as const) {
		if (!Number.isSafeInteger(value[field]))
			throw new Error(`invalid usage.${field}`);
	}
	return value as unknown as WorkflowUsageV1;
}

function parseOptionalMetadata(value: JsonObject): {
	model?: string;
	thinking?: string;
} {
	const metadata: { model?: string; thinking?: string } = {};
	if (value.model !== undefined) {
		if (!validBoundedString(value.model) || value.model.length === 0)
			throw new Error("invalid model");
		metadata.model = value.model;
	}
	if (value.thinking !== undefined) {
		if (!validBoundedString(value.thinking) || value.thinking.length === 0)
			throw new Error("invalid thinking");
		metadata.thinking = value.thinking;
	}
	return metadata;
}

function providerError(
	status: string,
	message: JsonValue | undefined,
): { code: string; message: string; retryable: boolean } {
	if (message !== undefined && !validBoundedString(message, 16 * 1024))
		throw new Error("invalid provider error");
	return {
		code: status === "failed" ? "provider_failed" : status,
		message: boundedText(
			typeof message === "string" && message.length > 0
				? message
				: `pi-subagents returned ${status}`,
		),
		retryable: false,
	};
}

function parseTerminal(attempt: Attempt, input: unknown): LeafRunnerTerminalV1 {
	const value = cloneJson(
		input,
		MAX_TERMINAL_ENVELOPE_BYTES,
		"delegation terminal",
	);
	if (!isJsonObject(value)) throw new Error("terminal must be an object");
	if (typeof value.status !== "string") throw new Error("invalid status");
	if (value.status === "invalid_request") {
		exactKeys(value, [
			"version",
			"requestId",
			"ownerRunId",
			"nodeId",
			"status",
			"error",
		]);
		if (
			value.version !== 2 ||
			value.requestId !== attempt.requestId ||
			(value.ownerRunId !== undefined &&
				value.ownerRunId !== attempt.ownerRunId) ||
			(value.nodeId !== undefined && value.nodeId !== attempt.nodeId)
		)
			throw new Error("terminal identity mismatch");
		return {
			status: "invalid_request",
			...(value.error !== undefined
				? { error: providerError("invalid_request", value.error) }
				: {}),
			usage: ZERO_USAGE,
		};
	}
	exactKeys(value, [
		"version",
		"requestId",
		"ownerRunId",
		"nodeId",
		"status",
		"error",
		"runId",
		"agent",
		"model",
		"thinking",
		"exitCode",
		"result",
		"usage",
	]);
	if (
		value.version !== 2 ||
		value.requestId !== attempt.requestId ||
		value.ownerRunId !== attempt.ownerRunId ||
		value.nodeId !== attempt.nodeId
	)
		throw new Error("terminal identity mismatch");
	for (const field of ["runId", "agent"] as const) {
		if (value[field] !== undefined && !validBoundedString(value[field]))
			throw new Error(`invalid ${field}`);
	}
	if (
		value.exitCode !== undefined &&
		(typeof value.exitCode !== "number" ||
			!Number.isSafeInteger(value.exitCode))
	)
		throw new Error("invalid exitCode");
	const metadata = parseOptionalMetadata(value);
	const usage = parseUsage(value.usage);
	if (value.status === "completed") {
		if (!value.result || !isJsonObject(value.result))
			throw new Error("completed terminal is missing result");
		exactKeys(value.result, ["kind", "text", "value"]);
		if (attempt.outputMode === "text") {
			if (
				value.result.kind !== "text" ||
				typeof value.result.text !== "string" ||
				Object.hasOwn(value.result, "value")
			)
				throw new Error("terminal result mode mismatch");
			if (byteLength(value.result.text) > MAX_RESULT_BYTES)
				throw new Error("terminal result too large");
			return {
				status: "completed",
				result: { mode: "text", text: value.result.text },
				usage,
				...metadata,
			};
		}
		if (
			value.result.kind !== "structured" ||
			!isJsonObject(value.result.value as JsonValue) ||
			Object.hasOwn(value.result, "text")
		)
			throw new Error("terminal result mode mismatch");
		if (byteLength(JSON.stringify(value.result.value)) > MAX_RESULT_BYTES)
			throw new Error("terminal result too large");
		return {
			status: "completed",
			result: {
				mode: "structured",
				value: value.result.value as Readonly<Record<string, JsonValue>>,
			},
			usage,
			...metadata,
		};
	}
	if (value.result !== undefined)
		throw new Error("noncompleted terminal has result");
	const distinct = new Set([
		"timed_out",
		"cancelled",
		"interrupted",
		"turn_budget_exhausted",
		"tool_budget_exhausted",
		"duplicate_node",
		"unavailable_context",
	]);
	if (value.status === "failed" || value.status === "acceptance_failed") {
		return {
			status: "failed",
			error: providerError(value.status, value.error),
			usage,
			...metadata,
		};
	}
	if (distinct.has(value.status)) {
		return {
			status: value.status as Exclude<
				LeafRunnerTerminalV1["status"],
				"completed" | "failed"
			>,
			...(value.error !== undefined
				? { error: providerError(value.status, value.error) }
				: {}),
			usage,
			...metadata,
		};
	}
	throw new Error(`unknown provider status ${boundedText(value.status, 128)}`);
}

function settle(
	hub: Hub,
	attempt: Attempt,
	terminal: LeafRunnerTerminalV1,
): void {
	if (attempt.settled) return;
	attempt.settled = true;
	attempt.pendingProgress = undefined;
	hub.attempts.delete(attempt.requestId);
	attempt.request.signal.removeEventListener("abort", attempt.abort);
	attempt.resolve(terminal);
}

function emitCancel(hub: Hub, attempt: Attempt): void {
	if (attempt.cancellationSent) return;
	attempt.cancellationSent = true;
	try {
		hub.emit(hub.contract.cancelEvent, {
			version: 2,
			requestId: attempt.requestId,
			ownerRunId: attempt.ownerRunId,
			nodeId: attempt.nodeId,
		});
	} catch {
		// Delivery is ambiguous: retain at-most-once semantics and fail the bus closed.
		hub.broken = true;
		poisonedBuses.add(hub.bus);
	}
}

function routeAttempt(hub: Hub, input: unknown): Attempt | undefined {
	if (ownData(input, "version") !== 2) return undefined;
	const requestId = ownData(input, "requestId");
	if (typeof requestId !== "string") return undefined;
	return hub.attempts.get(requestId);
}

function handleResponse(hub: Hub, input: unknown): void {
	const attempt = routeAttempt(hub, input);
	if (!attempt || attempt.settled) return;
	const ownerRunId = ownData(input, "ownerRunId");
	const nodeId = ownData(input, "nodeId");
	if (
		(typeof ownerRunId === "string" && ownerRunId !== attempt.ownerRunId) ||
		(typeof nodeId === "string" && nodeId !== attempt.nodeId)
	)
		return;
	try {
		settle(hub, attempt, parseTerminal(attempt, input));
	} catch (error) {
		settle(
			hub,
			attempt,
			contractFailure(
				`pi-subagents V2 terminal violated its contract: ${safeErrorMessage(
					error,
					"invalid terminal",
				)}`,
			),
		);
	}
}

function parseProgress(attempt: Attempt, input: unknown): LeafProgressUpdateV1 {
	const value = cloneJson(
		input,
		MAX_PROGRESS_ENVELOPE_BYTES,
		"delegation update",
	);
	if (!isJsonObject(value)) throw new Error("update must be an object");
	exactKeys(value, [
		"version",
		"requestId",
		"ownerRunId",
		"nodeId",
		"currentTool",
		"currentToolArgs",
		"recentOutput",
		"recentOutputLines",
		"recentTools",
		"model",
		"toolCount",
		"durationMs",
		"tokens",
	]);
	if (
		value.version !== 2 ||
		value.requestId !== attempt.requestId ||
		value.ownerRunId !== attempt.ownerRunId ||
		value.nodeId !== attempt.nodeId
	)
		throw new Error("update identity mismatch");
	for (const field of [
		"currentTool",
		"currentToolArgs",
		"recentOutput",
		"model",
	] as const) {
		if (
			value[field] !== undefined &&
			!validBoundedString(value[field], MAX_PROGRESS_BYTES)
		)
			throw new Error(`invalid update ${field}`);
	}
	for (const field of ["toolCount", "durationMs", "tokens"] as const) {
		if (
			value[field] !== undefined &&
			(typeof value[field] !== "number" ||
				!Number.isSafeInteger(value[field]) ||
				(value[field] as number) < 0)
		)
			throw new Error(`invalid update ${field}`);
	}
	if (value.recentOutputLines !== undefined) {
		if (
			!Array.isArray(value.recentOutputLines) ||
			value.recentOutputLines.some(
				(line) =>
					typeof line !== "string" || byteLength(line) > MAX_PROGRESS_BYTES,
			)
		)
			throw new Error("invalid recentOutputLines");
	}
	if (value.recentTools !== undefined) {
		if (!Array.isArray(value.recentTools))
			throw new Error("invalid recentTools");
		for (const tool of value.recentTools) {
			if (!isJsonObject(tool)) throw new Error("invalid recent tool");
			exactKeys(tool, ["tool", "args"]);
			if (
				!validBoundedString(tool.tool) ||
				!validBoundedString(tool.args, MAX_PROGRESS_BYTES)
			)
				throw new Error("invalid recent tool");
		}
	}
	let message = "Subagent working";
	if (typeof value.recentOutput === "string" && value.recentOutput.length > 0)
		message = value.recentOutput;
	else if (
		typeof value.currentTool === "string" &&
		value.currentTool.length > 0
	)
		message = `Using ${value.currentTool}`;
	return { message: boundedText(message, MAX_PROGRESS_BYTES) };
}

async function drainProgress(
	attempt: Attempt,
	initial: LeafProgressUpdateV1,
): Promise<void> {
	let update: LeafProgressUpdateV1 | undefined = initial;
	while (update !== undefined && !attempt.settled) {
		try {
			await attempt.request.progress(update);
		} catch {
			// Presentation failures do not alter provider execution.
		}
		if (attempt.settled) break;
		update = attempt.pendingProgress;
		attempt.pendingProgress = undefined;
	}
	attempt.progressActive = false;
}

function handleUpdate(hub: Hub, input: unknown): void {
	const attempt = routeAttempt(hub, input);
	if (!attempt || attempt.settled) return;
	if (
		ownData(input, "ownerRunId") !== attempt.ownerRunId ||
		ownData(input, "nodeId") !== attempt.nodeId
	)
		return;
	try {
		const update = parseProgress(attempt, input);
		if (attempt.progressActive) {
			attempt.pendingProgress = update;
			return;
		}
		attempt.progressActive = true;
		void drainProgress(attempt, update);
	} catch {
		// Updates are advisory; malformed and unrelated traffic is ignored.
	}
}

function createHub(
	options: AdapterOptionsSnapshot,
	contract: PiSubagentsV2Contract,
): Hub {
	let hub: Hub | undefined;
	const attempts = new Map<string, Attempt>();
	let unsubscribeResponse: unknown;
	try {
		unsubscribeResponse = options.on(contract.responseEvent, (input) => {
			if (hub) handleResponse(hub, input);
		});
	} catch (error) {
		poisonedBuses.add(options.events);
		throw new PiSubagentsV2UnavailableError(
			`could not subscribe to delegation V2 responses: ${safeErrorMessage(
				error,
				"invalid response subscription",
			)}`,
		);
	}
	if (typeof unsubscribeResponse !== "function") {
		poisonedBuses.add(options.events);
		throw new PiSubagentsV2UnavailableError(
			"delegation event bus did not return a response unsubscribe function",
		);
	}
	const releaseResponse = unsubscribeResponse as () => void;
	let unsubscribeUpdate: (() => void) | undefined;
	try {
		unsubscribeUpdate = options.on(contract.updateEvent, (input) => {
			if (hub) handleUpdate(hub, input);
		});
		if (typeof unsubscribeUpdate !== "function")
			throw new Error("missing update unsubscribe function");
	} catch (error) {
		poisonedBuses.add(options.events);
		try {
			releaseResponse();
		} catch {
			// The invalid event bus must not replace the typed adapter error.
		}
		throw new PiSubagentsV2UnavailableError(
			`could not subscribe to delegation V2 updates: ${safeErrorMessage(
				error,
				"invalid update subscription",
			)}`,
		);
	}
	const initializedHub: Hub = {
		bus: options.events,
		emit: options.emit,
		contract,
		attempts,
		unsubscribeResponse: releaseResponse,
		unsubscribeUpdate,
		refCount: 0,
		broken: false,
	};
	hub = initializedHub;
	return initializedHub;
}

function getHub(
	options: AdapterOptionsSnapshot,
	contract: PiSubagentsV2Contract,
): Hub {
	if (attachingBuses.has(options.events))
		throw new PiSubagentsV2UnavailableError(
			"delegation event bus setup is already in progress",
		);
	if (detachingBuses.has(options.events))
		throw new PiSubagentsV2UnavailableError(
			"delegation event bus teardown is in progress",
		);
	if (poisonedBuses.has(options.events))
		throw new PiSubagentsV2UnavailableError(
			"delegation event bus previously failed safe setup or delivery",
		);
	const existing = hubs.get(options.events);
	if (existing) {
		if (existing.broken)
			throw new PiSubagentsV2UnavailableError(
				"delegation event bus could not be safely detached",
			);
		if (!sameContract(existing.contract, contract))
			throw new PiSubagentsV2UnavailableError(
				"delegation event bus is already attached to a different V2 contract",
			);
		return existing;
	}
	attachingBuses.add(options.events);
	try {
		const hub = createHub(options, contract);
		hubs.set(options.events, hub);
		return hub;
	} finally {
		attachingBuses.delete(options.events);
	}
}

function structuredSchema(
	output: LeafRunnerRequestV1["output"],
): ObjectSchemaV1 {
	if (output.mode !== "structured")
		throw new Error("missing structured schema");
	const cloned = cloneJson(
		output.schema,
		MAX_SCHEMA_BYTES,
		"structured schema",
		32,
		20_000,
	);
	if (!isJsonObject(cloned))
		throw new Error("structured schema must be an object");
	return cloned as unknown as ObjectSchemaV1;
}

export function createPiSubagentsLeafAdapterCore(
	options: PiSubagentsLeafAdapterOptions,
	contract: PiSubagentsV2Contract,
	requestIdGenerator: RequestIdGenerator,
): PiSubagentsLeafAdapter {
	validateContract(contract);
	const selectedOptions = snapshotOptions(options);
	const hub = getHub(selectedOptions, contract);
	const owner: AdapterOwner = { disposed: false };
	hub.refCount += 1;

	const leafRunner: LeafRunner = (request) => {
		if (owner.disposed)
			return Promise.resolve(unavailable("pi-subagents adapter is disposed"));
		if (hub.broken)
			return Promise.resolve(
				unavailable("delegation event bus is unavailable"),
			);
		if (request.signal.aborted)
			return Promise.resolve({ status: "cancelled", usage: ZERO_USAGE });
		let requestId: string;
		do {
			requestId = requestIdGenerator();
			if (!validIdentity(requestId))
				return Promise.resolve(
					contractFailure("request ID generator returned an invalid UUID"),
				);
		} while (hub.attempts.has(requestId));
		let result: JsonObject;
		try {
			result =
				request.output.mode === "text"
					? { kind: "text" }
					: {
							kind: "structured",
							schema: structuredSchema(request.output) as unknown as JsonValue,
						};
		} catch (error) {
			return Promise.resolve(
				contractFailure(safeErrorMessage(error, "invalid structured schema")),
			);
		}
		return new Promise<LeafRunnerTerminalV1>((resolve) => {
			const attempt: Attempt = {
				owner,
				requestId,
				ownerRunId: request.identity.runId,
				nodeId: request.identity.nodeId,
				outputMode: request.output.mode,
				request,
				resolve,
				settled: false,
				requestEmissionStarted: false,
				progressActive: false,
				pendingProgress: undefined,
				cancellationSent: false,
				abort: () => {
					if (attempt.settled) return;
					const shouldNotifyProvider = attempt.requestEmissionStarted;
					settle(hub, attempt, { status: "cancelled", usage: ZERO_USAGE });
					if (shouldNotifyProvider) emitCancel(hub, attempt);
				},
			};
			hub.attempts.set(requestId, attempt);
			request.signal.addEventListener("abort", attempt.abort, { once: true });
			if (request.signal.aborted) {
				attempt.abort();
				return;
			}
			try {
				attempt.requestEmissionStarted = true;
				hub.emit(contract.requestEvent, {
					version: 2,
					requestId,
					ownerRunId: request.identity.runId,
					nodeId: request.identity.nodeId,
					agent: request.agent,
					task: request.prompt,
					context: selectedOptions.context,
					cwd: selectedOptions.cwd,
					timeoutMs: request.limits.timeoutMs,
					turnBudget: { maxTurns: request.limits.maxTurns, graceTurns: 0 },
					toolBudget: { hard: request.limits.maxToolCalls, block: "*" },
					result,
				});
			} catch (error) {
				hub.broken = true;
				poisonedBuses.add(hub.bus);
				settle(
					hub,
					attempt,
					unavailable(
						`could not emit delegation V2 request: ${safeErrorMessage(
							error,
							"event bus failure",
						)}`,
					),
				);
				emitCancel(hub, attempt);
			}
		});
	};

	return {
		leafRunner,
		dispose(): void {
			if (owner.disposed) return;
			owner.disposed = true;
			for (const attempt of hub.attempts.values()) {
				if (attempt.owner !== owner || attempt.settled) continue;
				settle(hub, attempt, { status: "interrupted", usage: ZERO_USAGE });
				emitCancel(hub, attempt);
			}
			hub.refCount -= 1;
			if (hub.refCount === 0) {
				const permanentlyBroken = hub.broken || poisonedBuses.has(hub.bus);
				hub.broken = true;
				detachingBuses.add(hub.bus);
				hubs.delete(hub.bus);
				let teardownFailed = false;
				try {
					hub.unsubscribeResponse();
				} catch {
					teardownFailed = true;
				}
				try {
					hub.unsubscribeUpdate();
				} catch {
					teardownFailed = true;
				}
				detachingBuses.delete(hub.bus);
				if (teardownFailed || permanentlyBroken) poisonedBuses.add(hub.bus);
			}
		},
	};
}
