import { types as utilTypes } from "node:util";

import type {
	LeafErrorV1,
	LeafIdentityV1,
	LeafOutcomeV1,
	LeafResultV1,
	StepOutcomeV1,
	WorkflowCountersV1,
	WorkflowErrorV1,
	WorkflowEventV1,
	WorkflowOutcomeV1,
	WorkflowUsageV1,
} from "../engine/index.ts";
import { canonicalJson, cloneSafeJson } from "../ir/json.ts";
import type {
	FinalRefV1,
	JsonValue,
	RefV1,
	WorkflowDefinitionV1,
} from "../ir/index.ts";

export interface AuditCloneLimits {
	readonly maximumBytes: number;
	readonly maximumDepth: number;
	readonly maximumEntries: number;
	readonly sizeLabel: string;
}

type JsonObject = { [key: string]: JsonValue };

const unsafeIdentifierText =
	/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const distinctLeafStatuses = new Set([
	"timed_out",
	"cancelled",
	"interrupted",
	"turn_budget_exhausted",
	"tool_budget_exhausted",
	"duplicate_node",
	"invalid_request",
	"unavailable_context",
]);
const allLeafStatuses = new Set([
	"succeeded",
	"failed",
	...distinctLeafStatuses,
	"skipped",
]);

function object(value: JsonValue | undefined, label: string): JsonObject {
	if (
		value === undefined ||
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value)
	)
		throw new Error(`${label} must be an object`);
	return value;
}

function exactKeys(
	value: JsonObject,
	required: readonly string[],
	optional: readonly string[] = [],
): void {
	const allowed = new Set([...required, ...optional]);
	for (const key of Object.keys(value))
		if (!allowed.has(key)) throw new Error(`unknown ${key} in audit value`);
	for (const key of required)
		if (!Object.hasOwn(value, key))
			throw new Error(`missing ${key} in audit value`);
}

function string(
	value: JsonValue | undefined,
	label: string,
	maximum = 64 * 1024,
	identifier = false,
	allowEmpty = false,
): string {
	if (
		typeof value !== "string" ||
		(!allowEmpty && value.length === 0) ||
		Buffer.byteLength(value, "utf8") > maximum ||
		(identifier && unsafeIdentifierText.test(value))
	)
		throw new Error(`${label} is invalid`);
	return value;
}

function safeInteger(value: JsonValue | undefined, label: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		throw new Error(`${label} must be a nonnegative safe integer`);
	return value;
}

function finiteNumber(value: JsonValue | undefined, label: string): number {
	if (
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		value < 0 ||
		value > Number.MAX_SAFE_INTEGER
	)
		throw new Error(`${label} must be finite, nonnegative, and bounded`);
	return value;
}

function decodeUsage(value: JsonValue | undefined): WorkflowUsageV1 {
	const usage = object(value, "workflow usage");
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
	exactKeys(usage, fields);
	for (const field of [
		"input",
		"output",
		"cacheRead",
		"cacheWrite",
		"turns",
		"toolCalls",
	] as const)
		safeInteger(usage[field], `usage.${field}`);
	finiteNumber(usage.cost, "usage.cost");
	finiteNumber(usage.durationMs, "usage.durationMs");
	return usage as unknown as WorkflowUsageV1;
}

function decodeLeafError(value: JsonValue | undefined): LeafErrorV1 {
	const error = object(value, "leaf error");
	exactKeys(error, ["code", "message", "retryable"]);
	string(error.code, "leaf error code", 128);
	string(error.message, "leaf error message", 1024, false, true);
	if (typeof error.retryable !== "boolean")
		throw new Error("leaf error retryable is invalid");
	return error as unknown as LeafErrorV1;
}

function decodeWorkflowError(value: JsonValue | undefined): WorkflowErrorV1 {
	const error = object(value, "workflow error");
	exactKeys(error, ["code", "message"]);
	string(error.code, "workflow error code", 128);
	string(error.message, "workflow error message", 1024, false, true);
	return error as unknown as WorkflowErrorV1;
}

function decodeIdentity(
	value: JsonValue | undefined,
	expectedRunId?: string,
	expectedStepId?: string,
): LeafIdentityV1 {
	const identity = object(value, "leaf identity");
	exactKeys(
		identity,
		["runId", "nodeId", "stepId"],
		["slot", "taskId", "itemIndex", "stageIndex", "stageId"],
	);
	const runId = string(identity.runId, "identity run ID", 128, true);
	const stepId = string(identity.stepId, "identity step ID", 128, true);
	string(identity.nodeId, "identity node ID", 512, true);
	if (expectedRunId !== undefined && runId !== expectedRunId)
		throw new Error("leaf identity belongs to the wrong run");
	if (expectedStepId !== undefined && stepId !== expectedStepId)
		throw new Error("leaf identity belongs to the wrong step");
	for (const field of ["slot", "itemIndex", "stageIndex"] as const)
		if (identity[field] !== undefined)
			safeInteger(identity[field], `identity.${field}`);
	for (const field of ["taskId", "stageId"] as const)
		if (identity[field] !== undefined)
			string(identity[field], `identity.${field}`, 128, true);
	return identity as unknown as LeafIdentityV1;
}

function decodeResult(value: JsonValue | undefined): LeafResultV1 {
	const result = object(value, "leaf result");
	if (result.mode === "text") {
		exactKeys(result, ["mode", "text"]);
		if (typeof result.text !== "string")
			throw new Error("text leaf result is invalid");
		return result as unknown as LeafResultV1;
	}
	if (result.mode === "structured") {
		exactKeys(result, ["mode", "value"]);
		object(result.value, "structured leaf result");
		return result as unknown as LeafResultV1;
	}
	throw new Error("leaf result mode is invalid");
}

function decodeRef(value: JsonValue | undefined): RefV1 {
	const ref = object(value, "reference");
	if (ref.ref === "step") {
		exactKeys(ref, ["ref", "stepId"]);
		string(ref.stepId, "reference step ID", 128, true);
		return ref as unknown as FinalRefV1;
	}
	if (ref.ref === "task") {
		exactKeys(ref, ["ref", "stepId", "taskId"]);
		string(ref.stepId, "reference step ID", 128, true);
		string(ref.taskId, "reference task ID", 128, true);
		return ref as unknown as FinalRefV1;
	}
	if (ref.ref === "arg") {
		exactKeys(ref, ["ref", "name"]);
		string(ref.name, "argument reference name", 128, true);
		return ref as unknown as RefV1;
	}
	if (ref.ref === "item" || ref.ref === "index" || ref.ref === "previous") {
		exactKeys(ref, ["ref"]);
		return ref as unknown as RefV1;
	}
	throw new Error("reference is invalid");
}

function decodeFinalRef(value: JsonValue | undefined): FinalRefV1 {
	const ref = decodeRef(value);
	if (ref.ref !== "step" && ref.ref !== "task")
		throw new Error("final reference is invalid");
	return ref;
}

function decodeLeafOutcome(
	value: JsonValue | undefined,
	expectedRunId: string,
	expectedStepId?: string,
): LeafOutcomeV1 {
	const outcome = object(value, "leaf outcome");
	if (
		typeof outcome.status !== "string" ||
		!allLeafStatuses.has(outcome.status)
	)
		throw new Error("leaf outcome status is invalid");
	const common = ["status", "identity", "usage"] as const;
	if (outcome.status === "succeeded")
		exactKeys(outcome, [...common, "result"], ["model", "thinking"]);
	else if (outcome.status === "failed")
		exactKeys(outcome, [...common, "error"], ["model", "thinking"]);
	else if (outcome.status === "skipped")
		exactKeys(outcome, [...common, "reason"], ["reference"]);
	else exactKeys(outcome, common, ["error", "model", "thinking"]);
	decodeIdentity(outcome.identity, expectedRunId, expectedStepId);
	decodeUsage(outcome.usage);
	for (const field of ["model", "thinking"] as const)
		if (outcome[field] !== undefined)
			string(outcome[field], `leaf ${field}`, 64 * 1024, false, true);
	if (outcome.status === "succeeded") decodeResult(outcome.result);
	if (outcome.status === "failed") decodeLeafError(outcome.error);
	if (distinctLeafStatuses.has(outcome.status) && outcome.error !== undefined)
		decodeLeafError(outcome.error);
	if (outcome.status === "skipped") {
		if (
			outcome.reason !== "upstream_failed" &&
			outcome.reason !== "unavailable_reference" &&
			outcome.reason !== "not_admitted" &&
			outcome.reason !== "prompt_too_large" &&
			outcome.reason !== "cancelled"
		)
			throw new Error("leaf skip reason is invalid");
		if (outcome.reference !== undefined) decodeRef(outcome.reference);
	}
	return outcome as unknown as LeafOutcomeV1;
}

function decodeStepOutcome(
	value: JsonValue | undefined,
	expectedRunId: string,
): StepOutcomeV1 {
	const step = object(value, "step outcome");
	const stepId = string(step.stepId, "outcome step ID", 128, true);
	if (step.type === "agent") {
		exactKeys(step, ["type", "stepId", "leaf"]);
		decodeLeafOutcome(step.leaf, expectedRunId, stepId);
		return step as unknown as StepOutcomeV1;
	}
	if (step.type === "parallel") {
		exactKeys(step, ["type", "stepId", "slots"]);
		if (!Array.isArray(step.slots))
			throw new Error("parallel slots must be an array");
		for (const leaf of step.slots)
			decodeLeafOutcome(leaf, expectedRunId, stepId);
		return step as unknown as StepOutcomeV1;
	}
	if (step.type === "pipeline") {
		exactKeys(step, ["type", "stepId", "items"], ["error"]);
		if (!Array.isArray(step.items))
			throw new Error("pipeline items must be an array");
		for (const itemValue of step.items) {
			const item = object(itemValue, "pipeline item outcome");
			exactKeys(item, ["index", "status", "stages"]);
			safeInteger(item.index, "pipeline item index");
			if (typeof item.status !== "string" || !allLeafStatuses.has(item.status))
				throw new Error("pipeline item status is invalid");
			if (!Array.isArray(item.stages))
				throw new Error("pipeline stages must be an array");
			for (const leaf of item.stages)
				decodeLeafOutcome(leaf, expectedRunId, stepId);
		}
		if (step.error !== undefined) decodeWorkflowError(step.error);
		return step as unknown as StepOutcomeV1;
	}
	throw new Error("step outcome type is invalid");
}

function decodeCounters(value: JsonValue | undefined): WorkflowCountersV1 {
	const counters = object(value, "workflow counters");
	exactKeys(counters, [
		"reservedCallSlots",
		"actualLeafCalls",
		"admittedItems",
	]);
	for (const field of [
		"reservedCallSlots",
		"actualLeafCalls",
		"admittedItems",
	] as const)
		safeInteger(counters[field], `counters.${field}`);
	return counters as unknown as WorkflowCountersV1;
}

export function decodeWorkflowOutcome(
	input: unknown,
	limits: AuditCloneLimits,
): WorkflowOutcomeV1 {
	const cloned = cloneSafeJson(input, {
		...limits,
		subject: "workflow outcome",
		rejectProxies: true,
	});
	const outcome = object(cloned, "workflow outcome");
	exactKeys(
		outcome,
		[
			"version",
			"runId",
			"workflowId",
			"status",
			"steps",
			"result",
			"usage",
			"counters",
		],
		["error"],
	);
	if (outcome.version !== 1)
		throw new Error("workflow outcome version must be 1");
	const runId = string(outcome.runId, "outcome run ID", 128, true);
	string(outcome.workflowId, "outcome workflow ID", 128, true);
	if (
		outcome.status !== "succeeded" &&
		outcome.status !== "failed" &&
		outcome.status !== "cancelled"
	)
		throw new Error("workflow outcome status is invalid");
	if (!Array.isArray(outcome.steps))
		throw new Error("workflow outcome steps must be an array");
	for (const step of outcome.steps) decodeStepOutcome(step, runId);
	if (outcome.result !== null) {
		const result = object(outcome.result, "workflow final result");
		exactKeys(result, ["ref", "outcome"]);
		decodeFinalRef(result.ref);
		const selected = object(result.outcome, "selected workflow outcome");
		if (Object.hasOwn(selected, "type")) decodeStepOutcome(selected, runId);
		else decodeLeafOutcome(selected, runId);
	}
	decodeUsage(outcome.usage);
	decodeCounters(outcome.counters);
	if (outcome.error !== undefined) decodeWorkflowError(outcome.error);
	return outcome as unknown as WorkflowOutcomeV1;
}

export function decodeWorkflowEvent(
	input: unknown,
	limits: AuditCloneLimits,
): WorkflowEventV1 {
	const cloned = cloneSafeJson(input, {
		...limits,
		subject: "workflow event",
		rejectProxies: true,
	});
	const event = object(cloned, "workflow event");
	if (typeof event.type !== "string")
		throw new Error("workflow event type is invalid");
	const common = ["type", "runId", "sequence"] as const;
	if (event.type === "workflow_started")
		exactKeys(event, [...common, "workflowId"]);
	else if (event.type === "workflow_terminal")
		exactKeys(event, [...common, "status"], ["error"]);
	else if (event.type === "phase")
		exactKeys(
			event,
			[...common, "stepId", "phase"],
			["taskId", "slot", "itemIndex", "stageIndex", "stageId"],
		);
	else if (event.type === "log")
		exactKeys(
			event,
			[...common, "stepId", "message"],
			["taskId", "slot", "itemIndex", "stageIndex", "stageId"],
		);
	else if (event.type === "leaf_started")
		exactKeys(event, [...common, "identity", "agent"]);
	else if (event.type === "leaf_progress")
		exactKeys(event, [...common, "identity", "message"], ["payload"]);
	else if (event.type === "leaf_terminal")
		exactKeys(event, [...common, "outcome"]);
	else throw new Error(`unknown workflow event type: ${event.type}`);
	const runId = string(event.runId, "event run ID", 128, true);
	safeInteger(event.sequence, "event sequence");
	if ((event.sequence as number) < 1)
		throw new Error("event sequence must be positive");
	if (event.type === "workflow_started")
		string(event.workflowId, "event workflow ID", 128, true);
	else if (event.type === "workflow_terminal") {
		if (
			event.status !== "succeeded" &&
			event.status !== "failed" &&
			event.status !== "cancelled"
		)
			throw new Error("workflow terminal status is invalid");
		if (event.error !== undefined) decodeWorkflowError(event.error);
	} else if (event.type === "phase" || event.type === "log") {
		string(event.stepId, "event step ID", 128, true);
		if (event.type === "phase") string(event.phase, "event phase", 1024);
		else string(event.message, "event log message", 64 * 1024);
		for (const field of ["slot", "itemIndex", "stageIndex"] as const)
			if (event[field] !== undefined)
				safeInteger(event[field], `event.${field}`);
		for (const field of ["taskId", "stageId"] as const)
			if (event[field] !== undefined)
				string(event[field], `event.${field}`, 128, true);
	} else if (event.type === "leaf_started") {
		decodeIdentity(event.identity, runId);
		string(event.agent, "event agent", 1024, true);
	} else if (event.type === "leaf_progress") {
		decodeIdentity(event.identity, runId);
		string(event.message, "event progress message", 16 * 1024, false, true);
	} else if (event.type === "leaf_terminal")
		decodeLeafOutcome(event.outcome, runId);
	return event as unknown as WorkflowEventV1;
}

export interface WorkflowRunTerminalV1 {
	readonly version: 1;
	readonly runId: string;
	readonly workflowId: string;
	readonly status: WorkflowOutcomeV1["status"];
	readonly resultRef: FinalRefV1 | null;
	readonly usage: WorkflowUsageV1;
	readonly counters: WorkflowCountersV1;
	readonly error?: WorkflowErrorV1;
}

function snapshotDataObject(
	input: unknown,
	label: string,
): Record<string, unknown> {
	if (typeof input !== "object" || input === null || utilTypes.isProxy(input))
		throw new Error(`${label} must be a plain non-proxy object`);
	let prototype: object | null;
	let keys: (string | symbol)[];
	let descriptors: PropertyDescriptorMap;
	try {
		prototype = Object.getPrototypeOf(input) as object | null;
		keys = Reflect.ownKeys(input);
		descriptors = Object.getOwnPropertyDescriptors(input);
	} catch {
		throw new Error(`${label} cannot be safely inspected`);
	}
	if (prototype !== Object.prototype && prototype !== null)
		throw new Error(`${label} must be a plain object`);
	const output: Record<string, unknown> = Object.create(null) as Record<
		string,
		unknown
	>;
	for (const key of keys) {
		if (typeof key !== "string") throw new Error(`${label} has a symbol field`);
		const descriptor = descriptors[key];
		if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
			throw new Error(`${label}.${key} must be an enumerable data property`);
		Object.defineProperty(output, key, {
			value: descriptor.value,
			enumerable: true,
			configurable: true,
			writable: true,
		});
	}
	return output;
}

function exactSnapshotKeys(
	value: Record<string, unknown>,
	required: readonly string[],
	optional: readonly string[] = [],
): void {
	const allowed = new Set([...required, ...optional]);
	for (const key of Object.keys(value))
		if (!allowed.has(key))
			throw new Error(`unknown ${key} in workflow outcome`);
	for (const key of required)
		if (!Object.hasOwn(value, key))
			throw new Error(`missing ${key} in workflow outcome`);
}

export function projectWorkflowTerminal(
	input: unknown,
	definition: WorkflowDefinitionV1,
): WorkflowRunTerminalV1 {
	const top = snapshotDataObject(input, "workflow outcome");
	exactSnapshotKeys(
		top,
		[
			"version",
			"runId",
			"workflowId",
			"status",
			"steps",
			"result",
			"usage",
			"counters",
		],
		["error"],
	);
	if (utilTypes.isProxy(top.steps) || !Array.isArray(top.steps))
		throw new Error("workflow outcome steps must be an array");
	let resultRef: unknown = null;
	if (top.result !== null) {
		const result = snapshotDataObject(top.result, "workflow final result");
		exactSnapshotKeys(result, ["ref", "outcome"]);
		resultRef = result.ref;
	}
	if (top.status === "succeeded" && top.result === null)
		throw new Error("succeeded workflow outcome must have a final result");
	if (top.status === "succeeded" && top.error !== undefined)
		throw new Error("succeeded workflow outcome has an error");
	const projection = cloneSafeJson(
		{
			version: top.version,
			runId: top.runId,
			workflowId: top.workflowId,
			status: top.status,
			resultRef,
			usage: top.usage,
			counters: top.counters,
			...(top.error === undefined ? {} : { error: top.error }),
		},
		{
			maximumBytes: 1024 * 1024,
			maximumDepth: 16,
			maximumEntries: 1_000,
			subject: "workflow terminal summary",
			sizeLabel: "1 MiB",
			rejectProxies: true,
		},
	);
	const terminal = object(projection, "workflow terminal summary");
	exactKeys(
		terminal,
		[
			"version",
			"runId",
			"workflowId",
			"status",
			"resultRef",
			"usage",
			"counters",
		],
		["error"],
	);
	if (terminal.version !== 1)
		throw new Error("workflow outcome version must be 1");
	string(terminal.runId, "outcome run ID", 128, true);
	string(terminal.workflowId, "outcome workflow ID", 128, true);
	if (
		terminal.status !== "succeeded" &&
		terminal.status !== "failed" &&
		terminal.status !== "cancelled"
	)
		throw new Error("workflow outcome status is invalid");
	let decodedRef: FinalRefV1 | null = null;
	if (terminal.resultRef !== null)
		decodedRef = decodeFinalRef(terminal.resultRef);
	if (
		decodedRef !== null &&
		canonicalJson(decodedRef as unknown as JsonValue) !==
			canonicalJson(definition.result as unknown as JsonValue)
	)
		throw new Error(
			"workflow outcome final reference does not match the definition",
		);
	decodeUsage(terminal.usage);
	decodeCounters(terminal.counters);
	if (terminal.error !== undefined) decodeWorkflowError(terminal.error);
	return terminal as unknown as WorkflowRunTerminalV1;
}
