import { randomUUID } from "node:crypto";

import {
	boundedCanonicalJson,
	cloneSafeJson,
	utf8Bytes,
	validateJsonValue,
} from "../ir/json.ts";
import { isParsedWorkflowDefinition } from "../ir/parser.ts";
import type {
	AgentStepV1,
	JsonValue,
	ParallelTaskV1,
	PipelineStageV1,
	RefV1,
	WorkflowDefinitionV1,
} from "../ir/index.ts";
import type {
	AgentStepOutcomeV1,
	LeafErrorV1,
	LeafIdentityV1,
	LeafOutcomeV1,
	LeafProgressUpdateV1,
	LeafResultV1,
	LeafRunner,
	LeafRunnerTerminalV1,
	ParallelStepOutcomeV1,
	PipelineItemOutcomeV1,
	PipelineStepOutcomeV1,
	StepOutcomeV1,
	WorkflowErrorV1,
	WorkflowEventV1,
	WorkflowHooksV1,
	WorkflowOutcomeV1,
	WorkflowUsageV1,
} from "./types.ts";

type LeafDefinitionV1 = AgentStepV1 | ParallelTaskV1 | PipelineStageV1;
type GroupStepOutcomeV1 = ParallelStepOutcomeV1 | PipelineStepOutcomeV1;
type PriorStepOutcomeV1 = AgentStepOutcomeV1 | GroupStepOutcomeV1;

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

const TERMINAL_STATUSES = new Set([
	"completed",
	"failed",
	"timed_out",
	"cancelled",
	"interrupted",
	"turn_budget_exhausted",
	"tool_budget_exhausted",
	"duplicate_node",
	"invalid_request",
	"unavailable_context",
]);

const MIB = 1024 * 1024;
const WORKFLOW_SUCCESS_PAYLOAD_BUDGET = 64 * MIB;
const MAX_PENDING_PROGRESS_PER_LEAF = 8;

const JSON_MIB_LIMITS = {
	maximumBytes: MIB,
	maximumDepth: 32,
	maximumEntries: 20_000,
	subject: "value",
	sizeLabel: "1 MiB",
} as const;

class HookFailure extends Error {
	constructor(cause: unknown) {
		super(boundedMessage(cause, "workflow hook failed"));
		this.name = "HookFailure";
	}
}

class ProviderContractFailure extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProviderContractFailure";
	}
}

function boundedText(value: string, maximumBytes: number): string {
	if (utf8Bytes(value) <= maximumBytes) return value;
	let output = "";
	let bytes = 0;
	for (const character of value) {
		const next = utf8Bytes(character);
		if (bytes + next > maximumBytes - 3) break;
		output += character;
		bytes += next;
	}
	return `${output}...`;
}

function boundedMessage(error: unknown, fallback: string): string {
	const message =
		error instanceof Error
			? error.message
			: typeof error === "string"
				? error
				: fallback;
	return boundedText(message || fallback, 1024);
}

function workflowError(code: string, message: string): WorkflowErrorV1 {
	return { code, message: boundedText(message, 1024) };
}

function identityFor(runId: string, stepId: string): LeafIdentityV1 {
	return Object.freeze({ runId, nodeId: `step:${stepId}`, stepId });
}

function freezeObservable<T>(value: T): T {
	if (value === null || typeof value !== "object" || Object.isFrozen(value))
		return value;
	for (const key of Reflect.ownKeys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor !== undefined && "value" in descriptor)
			freezeObservable(descriptor.value);
	}
	return Object.freeze(value);
}

function skipped(
	identity: LeafIdentityV1,
	reason:
		| "upstream_failed"
		| "unavailable_reference"
		| "not_admitted"
		| "prompt_too_large"
		| "cancelled",
	reference?: RefV1,
): LeafOutcomeV1 {
	return reference === undefined
		? { status: "skipped", identity, usage: ZERO_USAGE, reason }
		: { status: "skipped", identity, usage: ZERO_USAGE, reason, reference };
}

function addUsage(
	target: WorkflowUsageV1,
	usage: WorkflowUsageV1,
): WorkflowUsageV1 {
	const aggregate = {
		input: target.input + usage.input,
		output: target.output + usage.output,
		cacheRead: target.cacheRead + usage.cacheRead,
		cacheWrite: target.cacheWrite + usage.cacheWrite,
		cost: target.cost + usage.cost,
		turns: target.turns + usage.turns,
		toolCalls: target.toolCalls + usage.toolCalls,
		durationMs: target.durationMs + usage.durationMs,
	};
	for (const value of Object.values(aggregate)) {
		if (!Number.isFinite(value) || value < 0) {
			throw new ProviderContractFailure(
				"reported usage would overflow workflow aggregate usage",
			);
		}
	}
	for (const field of [
		"input",
		"output",
		"cacheRead",
		"cacheWrite",
		"turns",
		"toolCalls",
	] as const) {
		if (!Number.isSafeInteger(aggregate[field])) {
			throw new ProviderContractFailure(
				`reported usage would overflow aggregate ${field}`,
			);
		}
	}
	return aggregate;
}

function isRecord(value: JsonValue): value is { [key: string]: JsonValue } {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
	value: { [key: string]: JsonValue },
	allowed: readonly string[],
): void {
	const allowedSet = new Set(allowed);
	for (const key of Object.keys(value)) {
		if (!allowedSet.has(key))
			throw new ProviderContractFailure(`unexpected terminal field ${key}`);
	}
}

function validateUsage(
	value: JsonValue,
	limits: AgentStepV1["limits"],
	maximumUsageValue: number,
): WorkflowUsageV1 {
	if (!isRecord(value))
		throw new ProviderContractFailure("usage must be a plain object");
	const fields = [
		"input",
		"output",
		"cacheRead",
		"cacheWrite",
		"cost",
		"turns",
		"toolCalls",
		"durationMs",
	] as const;
	exactKeys(value, fields);
	for (const field of fields) {
		const item = value[field];
		if (typeof item !== "number" || !Number.isFinite(item) || item < 0) {
			throw new ProviderContractFailure(
				`usage.${field} must be finite and nonnegative`,
			);
		}
		if (item > maximumUsageValue) {
			throw new ProviderContractFailure(
				`usage.${field} exceeds the effective per-leaf usage cap`,
			);
		}
	}
	for (const field of [
		"input",
		"output",
		"cacheRead",
		"cacheWrite",
		"turns",
		"toolCalls",
	] as const) {
		if (!Number.isSafeInteger(value[field])) {
			throw new ProviderContractFailure(
				`usage.${field} must be a safe integer`,
			);
		}
	}
	let tokenSubtotal = 0;
	for (const field of [
		"input",
		"output",
		"cacheRead",
		"cacheWrite",
	] as const) {
		const item = value[field] as number;
		if (item > maximumUsageValue - tokenSubtotal)
			throw new ProviderContractFailure(
				"usage token subtotal exceeds the effective per-leaf usage cap",
			);
		tokenSubtotal += item;
	}
	if ((value.turns as number) > limits.maxTurns) {
		throw new ProviderContractFailure(
			"reported turns exceed the declared leaf limit",
		);
	}
	if ((value.toolCalls as number) > limits.maxToolCalls) {
		throw new ProviderContractFailure(
			"reported tool calls exceed the declared leaf limit",
		);
	}
	return value as unknown as WorkflowUsageV1;
}

function validateProviderError(value: JsonValue): LeafErrorV1 {
	if (!isRecord(value))
		throw new ProviderContractFailure("terminal error must be an object");
	exactKeys(value, ["code", "message", "retryable"]);
	if (
		typeof value.code !== "string" ||
		value.code.length === 0 ||
		utf8Bytes(value.code) > 128
	) {
		throw new ProviderContractFailure("terminal error code is invalid");
	}
	if (typeof value.message !== "string" || utf8Bytes(value.message) > 1024) {
		throw new ProviderContractFailure("terminal error message is invalid");
	}
	if (typeof value.retryable !== "boolean") {
		throw new ProviderContractFailure(
			"terminal error retryable flag is invalid",
		);
	}
	return value as unknown as LeafErrorV1;
}

function validateResult(
	value: JsonValue,
	step: LeafDefinitionV1,
	maximumResultBytes: number,
): LeafResultV1 {
	if (!isRecord(value))
		throw new ProviderContractFailure(
			"completed terminal result must be an object",
		);
	if (value.mode !== step.output.mode)
		throw new ProviderContractFailure(
			"terminal result mode does not match the declaration",
		);
	if (value.mode === "text") {
		exactKeys(value, ["mode", "text"]);
		if (
			typeof value.text !== "string" ||
			utf8Bytes(value.text) > maximumResultBytes
		) {
			throw new ProviderContractFailure(
				`text result exceeds the effective ${maximumResultBytes}-byte cap ` +
					"(min(1 MiB, floor(64 MiB / maxCalls))) or is invalid",
			);
		}
		return { mode: "text", text: value.text };
	}
	if (value.mode === "structured") {
		exactKeys(value, ["mode", "value"]);
		const structured = value.value;
		if (structured === undefined || !isRecord(structured)) {
			throw new ProviderContractFailure("structured result must be an object");
		}
		if (step.output.mode !== "structured") {
			throw new ProviderContractFailure(
				"terminal result mode does not match the declaration",
			);
		}
		const issue = validateJsonValue(step.output.schema, structured);
		if (issue !== undefined)
			throw new ProviderContractFailure(
				`structured result is schema-invalid: ${issue}`,
			);
		if (boundedCanonicalJson(structured, maximumResultBytes) === undefined) {
			throw new ProviderContractFailure(
				`structured result exceeds the effective ${maximumResultBytes}-byte cap ` +
					"(min(1 MiB, floor(64 MiB / maxCalls)))",
			);
		}
		return { mode: "structured", value: structured };
	}
	throw new ProviderContractFailure("terminal result mode is invalid");
}

function validateTerminal(
	terminal: unknown,
	step: LeafDefinitionV1,
	identity: LeafIdentityV1,
	maximumResultBytes: number,
	maximumUsageValue: number,
): LeafOutcomeV1 {
	let cloned: JsonValue;
	try {
		cloned = cloneSafeJson(terminal, {
			...JSON_MIB_LIMITS,
			maximumBytes: 2 * 1024 * 1024,
			sizeLabel: "2 MiB",
			subject: "terminal",
		});
	} catch (error) {
		throw new ProviderContractFailure(
			boundedMessage(error, "terminal is not safe JSON"),
		);
	}
	if (
		!isRecord(cloned) ||
		typeof cloned.status !== "string" ||
		!TERMINAL_STATUSES.has(cloned.status)
	) {
		throw new ProviderContractFailure("terminal status is invalid");
	}
	exactKeys(cloned, [
		"status",
		"result",
		"usage",
		"model",
		"thinking",
		"error",
	]);
	const usage = validateUsage(
		cloned.usage as JsonValue,
		step.limits,
		maximumUsageValue,
	);
	if (
		cloned.model !== undefined &&
		(typeof cloned.model !== "string" || utf8Bytes(cloned.model) > 1024)
	) {
		throw new ProviderContractFailure("terminal model is invalid");
	}
	if (
		cloned.thinking !== undefined &&
		(typeof cloned.thinking !== "string" ||
			utf8Bytes(cloned.thinking) > 64 * 1024)
	) {
		throw new ProviderContractFailure("terminal thinking is invalid");
	}
	const details = {
		...(cloned.model === undefined ? {} : { model: cloned.model as string }),
		...(cloned.thinking === undefined
			? {}
			: { thinking: cloned.thinking as string }),
	};

	if (cloned.status === "completed") {
		if (cloned.error !== undefined)
			throw new ProviderContractFailure(
				"completed terminal must not include an error",
			);
		return {
			status: "succeeded",
			identity,
			result: validateResult(
				cloned.result as JsonValue,
				step,
				maximumResultBytes,
			),
			usage,
			...details,
		};
	}
	if (cloned.result !== undefined)
		throw new ProviderContractFailure(
			"non-completed terminal must not include a result",
		);
	const error =
		cloned.error === undefined
			? undefined
			: validateProviderError(cloned.error);
	if (cloned.status === "failed") {
		if (error === undefined)
			throw new ProviderContractFailure(
				"failed terminal must include an error",
			);
		return { status: "failed", identity, error, usage, ...details };
	}
	return {
		status: cloned.status as Exclude<
			LeafRunnerTerminalV1["status"],
			"completed" | "failed"
		>,
		identity,
		usage,
		...details,
		...(error === undefined ? {} : { error }),
	};
}

function providerContractOutcome(
	identity: LeafIdentityV1,
	error: unknown,
): LeafOutcomeV1 {
	return {
		status: "failed",
		identity,
		usage: ZERO_USAGE,
		error: {
			code: "provider_contract_violation",
			message: boundedMessage(
				error,
				"leaf runner violated its public contract",
			),
			retryable: false,
		},
	};
}

function cloneInvocationArgs(
	definition: WorkflowDefinitionV1,
	args: unknown,
): Record<string, JsonValue> {
	const cloned = cloneSafeJson(args, {
		...JSON_MIB_LIMITS,
		subject: "invocation arguments",
	});
	if (!isRecord(cloned))
		throw new Error("invocation arguments must be a plain JSON object");
	const declared = Object.keys(definition.args);
	const supplied = Object.keys(cloned);
	for (const name of declared) {
		if (!Object.hasOwn(cloned, name))
			throw new Error(`missing declared argument ${name}`);
	}
	for (const name of supplied) {
		if (!Object.hasOwn(definition.args, name))
			throw new Error(`unknown invocation argument ${name}`);
	}
	for (const name of declared) {
		const issue = validateJsonValue(
			definition.args[name]!,
			cloned[name]!,
			`$.${name}`,
		);
		if (issue !== undefined) throw new Error(issue);
	}
	return freezeObservable(cloned);
}

function progressEvent(
	update: unknown,
): { message: string; payload?: JsonValue } | undefined {
	try {
		const cloned = cloneSafeJson(update, {
			maximumBytes: 16 * 1024,
			maximumDepth: 8,
			maximumEntries: 500,
			subject: "progress payload",
			sizeLabel: "16 KiB",
		});
		if (!isRecord(cloned)) return undefined;
		for (const key of Object.keys(cloned))
			if (key !== "message" && key !== "payload") return undefined;
		if (typeof cloned.message !== "string") return undefined;
		return cloned.payload === undefined
			? { message: boundedText(cloned.message, 4096) }
			: { message: boundedText(cloned.message, 4096), payload: cloned.payload };
	} catch {
		return undefined;
	}
}

type WorkflowEventInput = WorkflowEventV1 extends infer Event
	? Event extends WorkflowEventV1
		? Omit<Event, "runId" | "sequence">
		: never
	: never;

class EventEmitter {
	private sequence = 0;
	private queue: Promise<void> = Promise.resolve();
	private failure: HookFailure | undefined;
	private stopped = false;
	private activeEventType: WorkflowEventV1["type"] | undefined;
	private readonly failurePromiseValue: Promise<HookFailure>;
	private resolveFailure!: (failure: HookFailure) => void;
	private readonly abandonmentPromise: Promise<void>;
	private resolveAbandonment!: () => void;
	private readonly runId: string;
	private readonly callback:
		| ((event: WorkflowEventV1) => void | Promise<void>)
		| undefined;
	private readonly onFailure: ((failure: HookFailure) => void) | undefined;

	constructor(
		runId: string,
		callback: ((event: WorkflowEventV1) => void | Promise<void>) | undefined,
		onFailure?: (failure: HookFailure) => void,
	) {
		this.runId = runId;
		this.callback = callback;
		this.onFailure = onFailure;
		this.failurePromiseValue = new Promise((resolve) => {
			this.resolveFailure = resolve;
		});
		this.abandonmentPromise = new Promise((resolve) => {
			this.resolveAbandonment = resolve;
		});
	}

	get failurePromise(): Promise<HookFailure> {
		return this.failurePromiseValue;
	}

	emit(event: WorkflowEventInput): Promise<void> {
		if (this.callback === undefined || this.stopped) return Promise.resolve();
		if (this.failure !== undefined) return Promise.reject(this.failure);
		const sequenced = freezeObservable({
			...event,
			runId: this.runId,
			sequence: ++this.sequence,
		} as WorkflowEventV1);
		const operation = this.queue.then(async () => {
			if (this.stopped) return;
			if (this.failure !== undefined) throw this.failure;
			this.activeEventType = sequenced.type;
			try {
				await this.callback?.(sequenced);
			} finally {
				if (this.activeEventType === sequenced.type)
					this.activeEventType = undefined;
			}
		});
		this.queue = operation.catch((error: unknown) => {
			if (this.stopped) return;
			if (this.failure === undefined) {
				this.failure =
					error instanceof HookFailure ? error : new HookFailure(error);
				this.resolveFailure(this.failure);
				this.onFailure?.(this.failure);
			}
		});
		return operation.catch((error: unknown) => {
			if (this.stopped) return;
			throw error instanceof HookFailure ? error : new HookFailure(error);
		});
	}

	abandonActiveProgress(): void {
		if (this.activeEventType !== "leaf_progress" || this.stopped) return;
		this.stopped = true;
		this.resolveAbandonment();
	}

	async drain(): Promise<void> {
		await Promise.race([this.queue, this.abandonmentPromise]);
		if (!this.stopped && this.failure !== undefined) throw this.failure;
	}
}

function isAbortSignal(value: unknown): value is AbortSignal {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as AbortSignal).aborted === "boolean" &&
		typeof (value as AbortSignal).addEventListener === "function" &&
		typeof (value as AbortSignal).removeEventListener === "function"
	);
}

interface MutableCounters {
	reservedCallSlots: number;
	actualLeafCalls: number;
	admittedItems: number;
}

function parallelIdentity(
	runId: string,
	stepId: string,
	taskId: string,
	slot: number,
): LeafIdentityV1 {
	return Object.freeze({
		runId,
		nodeId: `parallel:${stepId}:task:${taskId}`,
		stepId,
		taskId,
		slot,
	});
}

function pipelineIdentity(
	runId: string,
	stepId: string,
	itemIndex: number,
	stageIndex: number,
	stageId: string,
): LeafIdentityV1 {
	return Object.freeze({
		runId,
		nodeId: `pipeline:${stepId}:item:${itemIndex}:stage:${stageId}`,
		stepId,
		itemIndex,
		stageIndex,
		stageId,
	});
}

function projectedLeafValue(leaf: LeafOutcomeV1): JsonValue | undefined {
	if (leaf.status !== "succeeded") return undefined;
	return leaf.result.mode === "text" ? leaf.result.text : leaf.result.value;
}

function projectedLeafError(
	leaf: LeafOutcomeV1,
): { code: string; message: string } | undefined {
	if (leaf.status === "succeeded") return undefined;
	if ("error" in leaf && leaf.error !== undefined) {
		return {
			code: boundedText(leaf.error.code, 128),
			message: boundedText(leaf.error.message, 1024),
		};
	}
	if (leaf.status === "skipped") {
		return { code: leaf.reason, message: `leaf skipped: ${leaf.reason}` };
	}
	return {
		code: leaf.status,
		message: `leaf ended with status ${leaf.status}`,
	};
}

function parallelProjection(outcome: ParallelStepOutcomeV1): JsonValue {
	return {
		slots: outcome.slots.map((leaf) => {
			const value = projectedLeafValue(leaf);
			const error = projectedLeafError(leaf);
			return {
				taskId: leaf.identity.taskId!,
				status: leaf.status,
				...(value === undefined ? {} : { value }),
				...(error === undefined ? {} : { error }),
			};
		}),
	};
}

function pipelineProjection(outcome: PipelineStepOutcomeV1): JsonValue {
	return {
		items: outcome.items.map((item) => ({
			index: item.index,
			status: item.status,
			stages: item.stages.map((leaf) => {
				const value = projectedLeafValue(leaf);
				const error = projectedLeafError(leaf);
				return {
					stageId: leaf.identity.stageId!,
					status: leaf.status,
					...(value === undefined ? {} : { value }),
					...(error === undefined ? {} : { error }),
				};
			}),
		})),
	};
}

interface PipelineLocalValues {
	readonly item: JsonValue;
	readonly index: number;
	readonly previous?: JsonValue;
}

function referenceIdentity(reference: RefV1): string {
	if (reference.ref === "arg") return `arg:${reference.name}`;
	if (reference.ref === "step") return `step:${reference.stepId}`;
	if (reference.ref === "task")
		return `task:${reference.stepId}:${reference.taskId}`;
	return `local:${reference.ref}`;
}

function unavailableReference(
	reference: RefV1,
	prior: ReadonlyMap<string, PriorStepOutcomeV1>,
	local?: PipelineLocalValues,
): RefV1 | undefined {
	if (reference.ref === "arg") return undefined;
	if (reference.ref === "step") {
		const producer = prior.get(reference.stepId);
		if (producer?.type === "parallel" || producer?.type === "pipeline")
			return undefined;
		return producer?.type === "agent" &&
			projectedLeafValue(producer.leaf) !== undefined
			? undefined
			: reference;
	}
	if (reference.ref === "task") {
		const producer = prior.get(reference.stepId);
		const leaf =
			producer?.type === "parallel"
				? producer.slots.find(
						(candidate) => candidate.identity.taskId === reference.taskId,
					)
				: undefined;
		return leaf !== undefined && projectedLeafValue(leaf) !== undefined
			? undefined
			: reference;
	}
	if (local === undefined)
		throw new Error(`local reference ${reference.ref} reached a non-pipeline leaf`);
	if (reference.ref === "previous" && local.previous === undefined)
		return reference;
	return undefined;
}

function resolveAvailableReference(
	reference: RefV1,
	args: Readonly<Record<string, JsonValue>>,
	prior: ReadonlyMap<string, PriorStepOutcomeV1>,
	local?: PipelineLocalValues,
): JsonValue {
	if (reference.ref === "arg") return args[reference.name]!;
	if (reference.ref === "step") {
		const producer = prior.get(reference.stepId)!;
		if (producer.type === "parallel") return parallelProjection(producer);
		if (producer.type === "pipeline") return pipelineProjection(producer);
		return projectedLeafValue(producer.leaf)!;
	}
	if (reference.ref === "task") {
		const producer = prior.get(reference.stepId)!;
		if (producer.type !== "parallel")
			throw new Error("available task reference has no parallel producer");
		const leaf = producer.slots.find(
			(candidate) => candidate.identity.taskId === reference.taskId,
		)!;
		return projectedLeafValue(leaf)!;
	}
	if (local === undefined)
		throw new Error(`local reference ${reference.ref} reached a non-pipeline leaf`);
	if (reference.ref === "item") return local.item;
	if (reference.ref === "index") return local.index;
	return local.previous!;
}

function renderLeafPrompt(
	leaf: LeafDefinitionV1,
	args: Readonly<Record<string, JsonValue>>,
	prior: ReadonlyMap<string, PriorStepOutcomeV1>,
	local?: PipelineLocalValues,
): { prompt?: string; unavailable?: RefV1; tooLarge?: true } {
	const availability = new Map<string, RefV1 | null>();
	for (const reference of Object.values(leaf.prompt.values)) {
		const identity = referenceIdentity(reference);
		let unavailable = availability.get(identity);
		if (unavailable === undefined) {
			unavailable = unavailableReference(reference, prior, local) ?? null;
			availability.set(identity, unavailable);
		}
		if (unavailable !== null) return { unavailable };
	}

	const maximumBytes = 256 * 1024;
	let bytes = 0;
	const parts: string[] = [];
	const resolvedValues = new Map<string, JsonValue>();
	const renderedValues = new Map<string, { text: string; bytes: number }>();
	const append = (text: string, knownBytes?: number): boolean => {
		const nextBytes = knownBytes ?? utf8Bytes(text);
		if (bytes + nextBytes > maximumBytes) return false;
		bytes += nextBytes;
		parts.push(text);
		return true;
	};
	const appendValue = (name: string): boolean => {
		const reference = leaf.prompt.values[name]!;
		const identity = referenceIdentity(reference);
		let rendered = renderedValues.get(identity);
		if (rendered === undefined) {
			let value = resolvedValues.get(identity);
			if (value === undefined) {
				value = resolveAvailableReference(reference, args, prior, local);
				resolvedValues.set(identity, value);
			}
			const text =
				typeof value === "string"
					? value
					: boundedCanonicalJson(value, maximumBytes - bytes);
			if (text === undefined) return false;
			rendered = { text, bytes: utf8Bytes(text) };
			renderedValues.set(identity, rendered);
		}
		return append(rendered.text, rendered.bytes);
	};

	const source = leaf.prompt.template;
	for (let index = 0; index < source.length; ) {
		const opening = source.indexOf("{{", index);
		if (opening < 0) {
			if (!append(source.slice(index))) return { tooLarge: true };
			break;
		}
		if (!append(source.slice(index, opening))) return { tooLarge: true };
		const closing = source.indexOf("}}", opening + 2);
		const name = source.slice(opening + 2, closing);
		if (!appendValue(name)) return { tooLarge: true };
		index = closing + 2;
	}
	return { prompt: parts.join("") };
}

type PermitRelease = () => void;

class FifoSemaphore {
	private active = 0;
	private cancelled = false;
	private readonly capacity: number;
	private readonly queue: Array<(release: PermitRelease | null) => void> = [];

	constructor(capacity: number) {
		this.capacity = capacity;
	}

	acquire(): Promise<PermitRelease | null> {
		if (this.cancelled) return Promise.resolve(null);
		if (this.active < this.capacity) {
			this.active += 1;
			return Promise.resolve(this.releaseFunction());
		}
		return new Promise((resolve) => this.queue.push(resolve));
	}

	cancelQueued(): void {
		this.cancelled = true;
		for (const resolve of this.queue.splice(0)) resolve(null);
	}

	private releaseFunction(): PermitRelease {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.active -= 1;
			this.dispatch();
		};
	}

	private dispatch(): void {
		while (!this.cancelled && this.active < this.capacity) {
			const resolve = this.queue.shift();
			if (resolve === undefined) break;
			this.active += 1;
			resolve(this.releaseFunction());
		}
	}
}

async function emitMeta(
	emitter: EventEmitter,
	stepId: string,
	meta: LeafDefinitionV1["meta"],
	signal?: AbortSignal,
	identity?: LeafIdentityV1,
): Promise<void> {
	const identityFields =
		identity?.taskId !== undefined
			? { taskId: identity.taskId, slot: identity.slot! }
			: identity?.stageId !== undefined
				? {
						itemIndex: identity.itemIndex!,
						stageIndex: identity.stageIndex!,
						stageId: identity.stageId,
					}
				: {};
	if (meta?.phase !== undefined) {
		await emitter.emit({
			type: "phase",
			stepId,
			...identityFields,
			phase: meta.phase,
		});
	}
	if (signal?.aborted === true) return;
	if (meta?.log !== undefined) {
		await emitter.emit({
			type: "log",
			stepId,
			...identityFields,
			message: meta.log,
		});
	}
}

async function executeScheduledLeaf(
	leafDefinition: LeafDefinitionV1,
	identity: LeafIdentityV1,
	args: Readonly<Record<string, JsonValue>>,
	prior: ReadonlyMap<string, PriorStepOutcomeV1>,
	leafRunner: LeafRunner,
	emitter: EventEmitter,
	semaphore: FifoSemaphore,
	workflowSignal: AbortSignal,
	counters: MutableCounters,
	maximumResultBytes: number,
	maximumUsageValue: number,
	local?: PipelineLocalValues,
): Promise<LeafOutcomeV1> {
	if (workflowSignal.aborted) return skipped(identity, "cancelled");
	const rendered = renderLeafPrompt(leafDefinition, args, prior, local);
	if (rendered.unavailable !== undefined) {
		return skipped(identity, "unavailable_reference", rendered.unavailable);
	}
	if (rendered.tooLarge === true) return skipped(identity, "prompt_too_large");

	const release = await semaphore.acquire();
	if (release === null) return skipped(identity, "cancelled");
	if (workflowSignal.aborted) {
		release();
		return skipped(identity, "cancelled");
	}

	try {
		await emitMeta(
			emitter,
			identity.stepId,
			leafDefinition.meta,
			workflowSignal,
			identity,
		);
		if (workflowSignal.aborted) return skipped(identity, "cancelled");
		await emitter.emit({
			type: "leaf_started",
			identity,
			agent: leafDefinition.agent,
		});
		if (workflowSignal.aborted) {
			return { status: "cancelled", identity, usage: ZERO_USAGE };
		}

		const controller = new AbortController();
		let timedOut = false;
		let active = true;
		const abortFromWorkflow = (): void =>
			controller.abort(workflowSignal.reason);
		workflowSignal.addEventListener("abort", abortFromWorkflow, { once: true });
		if (workflowSignal.aborted) abortFromWorkflow();
		let onControllerAbort!: () => void;
		const abortPromise = new Promise<
			{ kind: "timeout" } | { kind: "cancelled" }
		>((resolve) => {
			onControllerAbort = (): void =>
				resolve({ kind: timedOut ? "timeout" : "cancelled" });
			controller.signal.addEventListener("abort", onControllerAbort, {
				once: true,
			});
			if (controller.signal.aborted) onControllerAbort();
		});
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let pendingProgress = 0;
		try {
			if (controller.signal.aborted) {
				return { status: "cancelled", identity, usage: ZERO_USAGE };
			}
			timeout = setTimeout(() => {
				timedOut = true;
				controller.abort(new Error("leaf timeout"));
			}, leafDefinition.limits.timeoutMs);
			counters.actualLeafCalls += 1;
			const progress = async (update: LeafProgressUpdateV1): Promise<void> => {
				if (!active || pendingProgress >= MAX_PENDING_PROGRESS_PER_LEAF) return;
				pendingProgress += 1;
				try {
					const bounded = progressEvent(update);
					if (bounded === undefined) return;
					await emitter.emit({
						type: "leaf_progress",
						identity,
						...bounded,
					});
				} finally {
					pendingProgress -= 1;
				}
			};
			const request = Object.freeze({
				identity,
				agent: leafDefinition.agent,
				prompt: rendered.prompt!,
				output: leafDefinition.output,
				limits: leafDefinition.limits,
				signal: controller.signal,
				progress,
			});
			const runnerPromise = Promise.resolve()
				.then(() => leafRunner(request))
				.then(
					(terminal) => ({ kind: "terminal" as const, terminal }),
					(error: unknown) => ({ kind: "runner_rejection" as const, error }),
				);
			const hookPromise = emitter.failurePromise.then((error) => ({
				kind: "hook" as const,
				error,
			}));
			const settled = await Promise.race([
				runnerPromise,
				abortPromise,
				hookPromise,
			]);
			active = false;
			if (settled.kind === "hook") throw settled.error;
			if (settled.kind === "cancelled") {
				return { status: "cancelled", identity, usage: ZERO_USAGE };
			}
			if (settled.kind === "timeout") {
				return { status: "timed_out", identity, usage: ZERO_USAGE };
			}
			if (settled.kind === "runner_rejection") {
				return providerContractOutcome(identity, settled.error);
			}
			await emitter.drain();
			try {
				return validateTerminal(
					settled.terminal,
					leafDefinition,
					identity,
					maximumResultBytes,
					maximumUsageValue,
				);
			} catch (error) {
				return providerContractOutcome(identity, error);
			}
		} finally {
			active = false;
			if (timeout !== undefined) clearTimeout(timeout);
			controller.signal.removeEventListener("abort", onControllerAbort);
			workflowSignal.removeEventListener("abort", abortFromWorkflow);
		}
	} finally {
		release();
	}
}

async function executeScheduledWorkflow(
	definition: WorkflowDefinitionV1,
	argsInput: unknown,
	leafRunner: LeafRunner,
	hooksInput: WorkflowHooksV1,
	runId: string,
): Promise<WorkflowOutcomeV1> {
	const steps: StepOutcomeV1[] = [];
	const prior = new Map<string, PriorStepOutcomeV1>();
	const counters: MutableCounters = {
		reservedCallSlots: 0,
		actualLeafCalls: 0,
		admittedItems: 0,
	};
	const maximumResultBytes = Math.min(
		MIB,
		Math.floor(WORKFLOW_SUCCESS_PAYLOAD_BUDGET / definition.limits.maxCalls),
	);
	const maximumUsageValue = Math.floor(
		Number.MAX_SAFE_INTEGER / definition.limits.maxCalls,
	);
	let aggregate = ZERO_USAGE;
	let callerCancelled = false;
	let hookFailure: HookFailure | undefined;
	const workflowController = new AbortController();
	const semaphore = new FifoSemaphore(definition.limits.concurrency);
	const abortWorkflow = (reason: unknown): void => {
		if (!workflowController.signal.aborted) workflowController.abort(reason);
		semaphore.cancelQueued();
	};

	let callback: WorkflowHooksV1["onEvent"];
	let callerSignal: AbortSignal | undefined;
	try {
		if (typeof hooksInput !== "object" || hooksInput === null)
			throw new HookFailure("invalid workflow hooks");
		callback = hooksInput.onEvent;
		callerSignal = hooksInput.signal;
		if (callback !== undefined && typeof callback !== "function")
			throw new HookFailure("invalid workflow hooks");
		if (callerSignal !== undefined && !isAbortSignal(callerSignal))
			throw new HookFailure("invalid workflow hooks");
	} catch (error) {
		hookFailure = error instanceof HookFailure ? error : new HookFailure(error);
		callback = undefined;
		callerSignal = undefined;
	}
	const emitter = new EventEmitter(runId, callback, (failure) => {
		hookFailure ??= failure;
		abortWorkflow(failure);
	});

	const base = (): Omit<WorkflowOutcomeV1, "status" | "result"> => ({
		version: 1,
		runId,
		workflowId: definition.id,
		steps,
		usage: aggregate,
		counters: { ...counters },
	});
	const finalize = async (
		outcome: WorkflowOutcomeV1,
	): Promise<WorkflowOutcomeV1> => {
		if (hookFailure !== undefined) {
			if (callerCancelled) return outcome;
			return {
				...base(),
				status: "failed",
				result: null,
				error: workflowError("hook_error", hookFailure.message),
			};
		}
		try {
			await emitter.emit({
				type: "workflow_terminal",
				status: outcome.status,
				...(outcome.error === undefined ? {} : { error: outcome.error }),
			});
			return outcome;
		} catch (error) {
			return {
				...base(),
				status: "failed",
				result: null,
				error: workflowError(
					"hook_error",
					boundedMessage(error, "workflow hook failed"),
				),
			};
		}
	};

	if (hookFailure !== undefined) {
		return finalize({
			...base(),
			status: "failed",
			result: null,
			error: workflowError("hook_error", hookFailure.message),
		});
	}

	const callerAbort = (): void => {
		callerCancelled = true;
		emitter.abandonActiveProgress();
		abortWorkflow(callerSignal?.reason);
	};
	try {
		callerSignal?.addEventListener("abort", callerAbort, { once: true });
		if (callerSignal?.aborted === true) callerAbort();
		await emitter.emit({ type: "workflow_started", workflowId: definition.id });

		let args: Record<string, JsonValue>;
		try {
			args = cloneInvocationArgs(definition, argsInput);
		} catch (error) {
			if (callerCancelled) {
				return finalize({
					...base(),
					status: "cancelled",
					result: null,
					error: workflowError("cancelled", "workflow cancelled by caller"),
				});
			}
			return finalize({
				...base(),
				status: "failed",
				result: null,
				error: workflowError(
					"invalid_arguments",
					boundedMessage(error, "invalid invocation arguments"),
				),
			});
		}

		const settleRawLeaf = async (
			leafDefinition: LeafDefinitionV1,
			identity: LeafIdentityV1,
			local?: PipelineLocalValues,
		): Promise<LeafOutcomeV1> => {
			try {
				return await executeScheduledLeaf(
					leafDefinition,
					identity,
					args,
					prior,
					leafRunner,
					emitter,
					semaphore,
					workflowController.signal,
					counters,
					maximumResultBytes,
					maximumUsageValue,
					local,
				);
			} catch (error) {
				if (!(error instanceof HookFailure)) throw error;
				hookFailure ??= error;
				abortWorkflow(error);
				return { status: "cancelled", identity, usage: ZERO_USAGE };
			}
		};

		const accountLeaf = async (
			rawOutcome: LeafOutcomeV1,
		): Promise<LeafOutcomeV1> => {
			let outcome = rawOutcome;
			if (outcome.status !== "skipped") {
				try {
					aggregate = addUsage(aggregate, outcome.usage);
				} catch (error) {
					outcome = providerContractOutcome(outcome.identity, error);
				}
			}
			outcome = freezeObservable(outcome);
			if (hookFailure === undefined) {
				try {
					await emitter.emit({ type: "leaf_terminal", outcome });
				} catch (error) {
					if (!(error instanceof HookFailure)) throw error;
					hookFailure ??= error;
					abortWorkflow(error);
				}
			}
			return outcome;
		};

		const settleLeaf = async (
			leafDefinition: LeafDefinitionV1,
			identity: LeafIdentityV1,
		): Promise<LeafOutcomeV1> =>
			accountLeaf(await settleRawLeaf(leafDefinition, identity));

		for (const candidate of definition.steps) {
			if (candidate.type === "pipeline") {
				const itemValues = args[candidate.items.name];
				if (!Array.isArray(itemValues))
					throw new Error("validated pipeline items are not an array");
				const identities = itemValues.map((_item, itemIndex) =>
					candidate.stages.map((stage, stageIndex) =>
						pipelineIdentity(
							runId,
							candidate.id,
							itemIndex,
							stageIndex,
							stage.id,
						),
					),
				);
				let groupError: WorkflowErrorV1 | undefined;
				let materialized: LeafOutcomeV1[][];
				if (workflowController.signal.aborted) {
					materialized = [];
					for (const lane of identities) {
						const stages: LeafOutcomeV1[] = [];
						for (const identity of lane)
							stages.push(await accountLeaf(skipped(identity, "cancelled")));
						materialized.push(stages);
					}
				} else {
					const itemCount = itemValues.length;
					const callSlots = itemCount * candidate.stages.length;
					const exceedsItems =
						counters.admittedItems + itemCount > definition.limits.maxItems;
					const exceedsCalls =
						counters.reservedCallSlots + callSlots >
						definition.limits.maxCalls;
					if (exceedsItems || exceedsCalls) {
						groupError = workflowError(
							"limit_exceeded",
							exceedsItems
								? `pipeline step ${candidate.id} would exceed maxItems`
								: `pipeline step ${candidate.id} would exceed maxCalls`,
						);
						materialized = [];
						for (const lane of identities) {
							const stages: LeafOutcomeV1[] = [];
							for (const identity of lane)
								stages.push(
									await accountLeaf(skipped(identity, "not_admitted")),
								);
							materialized.push(stages);
						}
					} else {
						counters.admittedItems += itemCount;
						counters.reservedCallSlots += callSlots;
						try {
							await emitMeta(
								emitter,
								candidate.id,
								candidate.meta,
								workflowController.signal,
							);
						} catch (error) {
							if (!(error instanceof HookFailure)) throw error;
							hookFailure ??= error;
							abortWorkflow(error);
						}
						const rawLanes = await Promise.all(
							itemValues.map(async (item, itemIndex) => {
								const stages: LeafOutcomeV1[] = [];
								let previous: JsonValue | undefined;
								for (
									let stageIndex = 0;
									stageIndex < candidate.stages.length;
									stageIndex += 1
								) {
									const stage = candidate.stages[stageIndex]!;
									const raw = await settleRawLeaf(
										stage,
										identities[itemIndex]![stageIndex]!,
										{
											item,
											index: itemIndex,
											...(previous === undefined ? {} : { previous }),
										},
									);
									stages.push(raw);
									if (raw.status !== "succeeded") {
										const reason = workflowController.signal.aborted
											? "cancelled"
											: "upstream_failed";
										for (
											let skippedIndex = stageIndex + 1;
											skippedIndex < candidate.stages.length;
											skippedIndex += 1
										) {
											stages.push(
												skipped(
													identities[itemIndex]![skippedIndex]!,
													reason,
												),
											);
										}
										break;
									}
									previous = projectedLeafValue(raw);
								}
								return stages;
							}),
						);
						materialized = [];
						for (const rawLane of rawLanes) {
							const stages: LeafOutcomeV1[] = [];
							for (const raw of rawLane)
								stages.push(await accountLeaf(raw));
							materialized.push(stages);
						}
					}
				}
				const items: PipelineItemOutcomeV1[] = materialized.map(
					(stages, index) => ({
						index,
						status:
							stages.find((stage) => stage.status !== "succeeded")?.status ??
							"succeeded",
						stages,
					}),
				);
				const outcome: PipelineStepOutcomeV1 = {
					type: "pipeline",
					stepId: candidate.id,
					items,
					...(groupError === undefined ? {} : { error: groupError }),
				};
				steps.push(outcome);
				prior.set(candidate.id, outcome);
				if (hookFailure !== undefined) break;
				continue;
			}

			if (candidate.type === "agent") {
				const identity = identityFor(runId, candidate.id);
				let leaf: LeafOutcomeV1;
				if (workflowController.signal.aborted) {
					leaf = await accountLeaf(skipped(identity, "cancelled"));
				} else if (
					counters.reservedCallSlots + 1 >
					definition.limits.maxCalls
				) {
					leaf = await accountLeaf(skipped(identity, "not_admitted"));
				} else {
					counters.reservedCallSlots += 1;
					leaf = await settleLeaf(candidate, identity);
				}
				const outcome: AgentStepOutcomeV1 = {
					type: "agent",
					stepId: candidate.id,
					leaf,
				};
				steps.push(outcome);
				prior.set(candidate.id, outcome);
				if (hookFailure !== undefined) break;
				continue;
			}

			const identities = candidate.tasks.map((task, slot) =>
				parallelIdentity(runId, candidate.id, task.id, slot),
			);
			let slots: LeafOutcomeV1[];
			if (workflowController.signal.aborted) {
				slots = [];
				for (const identity of identities)
					slots.push(await accountLeaf(skipped(identity, "cancelled")));
			} else if (
				counters.reservedCallSlots + candidate.tasks.length >
				definition.limits.maxCalls
			) {
				slots = [];
				for (const identity of identities)
					slots.push(await accountLeaf(skipped(identity, "not_admitted")));
			} else {
				counters.reservedCallSlots += candidate.tasks.length;
				try {
					await emitMeta(
						emitter,
						candidate.id,
						candidate.meta,
						workflowController.signal,
					);
				} catch (error) {
					if (!(error instanceof HookFailure)) throw error;
					hookFailure ??= error;
					abortWorkflow(error);
				}
				const rawSlots = await Promise.all(
					candidate.tasks.map((task, slot) =>
						settleRawLeaf(task, identities[slot]!),
					),
				);
				slots = [];
				for (const rawOutcome of rawSlots)
					slots.push(await accountLeaf(rawOutcome));
			}
			const outcome: ParallelStepOutcomeV1 = {
				type: "parallel",
				stepId: candidate.id,
				slots,
			};
			steps.push(outcome);
			prior.set(candidate.id, outcome);
			if (hookFailure !== undefined) break;
		}

		if (callerCancelled) {
			return finalize({
				...base(),
				status: "cancelled",
				result: null,
				error: workflowError("cancelled", "workflow cancelled by caller"),
			});
		}
		if (hookFailure !== undefined) {
			return finalize({
				...base(),
				status: "failed",
				result: null,
				error: workflowError("hook_error", hookFailure.message),
			});
		}

		const final = definition.result;
		if (final.ref === "task") {
			const producer = prior.get(final.stepId);
			const selected =
				producer?.type === "parallel"
					? producer.slots.find((leaf) => leaf.identity.taskId === final.taskId)
					: undefined;
			if (selected === undefined) {
				return finalize({
					...base(),
					status: "failed",
					result: null,
					error: workflowError(
						"engine_error",
						"final task result was not materialized",
					),
				});
			}
			const result = { ref: final, outcome: selected } as const;
			return selected.status === "succeeded"
				? finalize({ ...base(), status: "succeeded", result })
				: finalize({
						...base(),
						status: "failed",
						result,
						error: workflowError(
							"final_result_failed",
							"selected final leaf did not succeed",
						),
					});
		}

		const selected = prior.get(final.stepId);
		if (selected === undefined) {
			return finalize({
				...base(),
				status: "failed",
				result: null,
				error: workflowError(
					"engine_error",
					"final result was not materialized",
				),
			});
		}
		if (selected.type === "parallel" || selected.type === "pipeline") {
			return finalize({
				...base(),
				status: "succeeded",
				result: { ref: final, outcome: selected },
			});
		}
		const result = { ref: final, outcome: selected.leaf } as const;
		return selected.leaf.status === "succeeded"
			? finalize({ ...base(), status: "succeeded", result })
			: finalize({
					...base(),
					status: "failed",
					result,
					error: workflowError(
						"final_result_failed",
						"selected final leaf did not succeed",
					),
				});
	} catch (error) {
		const code = error instanceof HookFailure ? "hook_error" : "engine_error";
		return finalize({
			...base(),
			status: "failed",
			result: null,
			error: workflowError(
				code,
				boundedMessage(error, "workflow engine failed"),
			),
		});
	} finally {
		try {
			callerSignal?.removeEventListener("abort", callerAbort);
		} catch {
			// A hostile AbortSignal is reported through the established hook boundary.
		}
	}
}

export function executeWorkflow(
	definition: WorkflowDefinitionV1,
	args: unknown,
	leafRunner: LeafRunner,
	hooks: WorkflowHooksV1,
): Promise<WorkflowOutcomeV1> {
	if (!isParsedWorkflowDefinition(definition)) {
		throw new TypeError(
			"executeWorkflow requires a parsed workflow definition",
		);
	}
	if (typeof leafRunner !== "function") {
		throw new TypeError("executeWorkflow requires a LeafRunner function");
	}
	return executeScheduledWorkflow(
		definition,
		args,
		leafRunner,
		hooks,
		randomUUID(),
	);
}
