import { randomUUID } from "node:crypto";

import {
	canonicalJson,
	cloneSafeJson,
	utf8Bytes,
	validateJsonValue,
} from "../ir/json.ts";
import { isParsedWorkflowDefinition } from "../ir/parser.ts";
import type {
	AgentStepV1,
	FinalRefV1,
	JsonValue,
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
	StepOutcomeV1,
	UnsupportedStepOutcomeV1,
	WorkflowErrorV1,
	WorkflowEventV1,
	WorkflowHooksV1,
	WorkflowOutcomeV1,
	WorkflowUsageV1,
} from "./types.ts";

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

const JSON_MIB_LIMITS = {
	maximumBytes: 1024 * 1024,
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
	reason: "unavailable_reference" | "prompt_too_large" | "cancelled",
	reference?: FinalRefV1,
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

function validateResult(value: JsonValue, step: AgentStepV1): LeafResultV1 {
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
		if (typeof value.text !== "string" || utf8Bytes(value.text) > 1024 * 1024) {
			throw new ProviderContractFailure(
				"text result exceeds 1 MiB or is invalid",
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
		if (utf8Bytes(canonicalJson(structured)) > 1024 * 1024) {
			throw new ProviderContractFailure("structured result exceeds 1 MiB");
		}
		return { mode: "structured", value: structured };
	}
	throw new ProviderContractFailure("terminal result mode is invalid");
}

function validateTerminal(
	terminal: unknown,
	step: AgentStepV1,
	identity: LeafIdentityV1,
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
	const usage = validateUsage(cloned.usage as JsonValue, step.limits);
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
			result: validateResult(cloned.result as JsonValue, step),
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
	return cloned;
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
	private readonly failurePromiseValue: Promise<HookFailure>;
	private resolveFailure!: (failure: HookFailure) => void;
	private readonly runId: string;
	private readonly callback:
		| ((event: WorkflowEventV1) => void | Promise<void>)
		| undefined;

	constructor(
		runId: string,
		callback: ((event: WorkflowEventV1) => void | Promise<void>) | undefined,
	) {
		this.runId = runId;
		this.callback = callback;
		this.failurePromiseValue = new Promise((resolve) => {
			this.resolveFailure = resolve;
		});
	}

	get failurePromise(): Promise<HookFailure> {
		return this.failurePromiseValue;
	}

	emit(event: WorkflowEventInput): Promise<void> {
		if (this.callback === undefined) return Promise.resolve();
		if (this.failure !== undefined) return Promise.reject(this.failure);
		const sequenced = freezeObservable({
			...event,
			runId: this.runId,
			sequence: ++this.sequence,
		} as WorkflowEventV1);
		const operation = this.queue.then(async () => {
			if (this.failure !== undefined) throw this.failure;
			await this.callback?.(sequenced);
		});
		this.queue = operation.catch((error: unknown) => {
			if (this.failure === undefined) {
				this.failure =
					error instanceof HookFailure ? error : new HookFailure(error);
				this.resolveFailure(this.failure);
			}
		});
		return operation.catch((error: unknown) => {
			throw error instanceof HookFailure ? error : new HookFailure(error);
		});
	}

	async drain(): Promise<void> {
		await this.queue;
		if (this.failure !== undefined) throw this.failure;
	}
}

function renderPrompt(
	step: AgentStepV1,
	args: Readonly<Record<string, JsonValue>>,
	prior: ReadonlyMap<string, AgentStepOutcomeV1>,
): { prompt?: string; unavailable?: FinalRefV1; tooLarge?: true } {
	const renderedValues = new Map<string, string>();
	for (const [name, reference] of Object.entries(step.prompt.values)) {
		let value: JsonValue;
		if (reference.ref === "arg") {
			value = args[reference.name]!;
		} else if (reference.ref === "step") {
			const producer = prior.get(reference.stepId);
			if (producer?.leaf.status !== "succeeded")
				return { unavailable: reference };
			value =
				producer.leaf.result.mode === "text"
					? producer.leaf.result.text
					: producer.leaf.result.value;
		} else if (reference.ref === "task") {
			return { unavailable: reference };
		} else {
			throw new Error(
				`local reference ${reference.ref} reached a sequential agent`,
			);
		}
		renderedValues.set(
			name,
			typeof value === "string" ? value : canonicalJson(value),
		);
	}

	let prompt = "";
	const source = step.prompt.template;
	for (let index = 0; index < source.length; ) {
		const opening = source.indexOf("{{", index);
		if (opening < 0) {
			prompt += source.slice(index);
			break;
		}
		prompt += source.slice(index, opening);
		const closing = source.indexOf("}}", opening + 2);
		const name = source.slice(opening + 2, closing);
		prompt += renderedValues.get(name) ?? "";
		if (utf8Bytes(prompt) > 256 * 1024) return { tooLarge: true };
		index = closing + 2;
	}
	return utf8Bytes(prompt) > 256 * 1024 ? { tooLarge: true } : { prompt };
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

async function executeStartedWorkflow(
	definition: WorkflowDefinitionV1,
	argsInput: unknown,
	leafRunner: LeafRunner,
	hooksInput: WorkflowHooksV1,
	runId: string,
): Promise<WorkflowOutcomeV1> {
	const steps: StepOutcomeV1[] = [];
	const prior = new Map<string, AgentStepOutcomeV1>();
	const counters: MutableCounters = {
		reservedCallSlots: 0,
		actualLeafCalls: 0,
		admittedItems: 0,
	};
	let aggregate = ZERO_USAGE;
	let callerCancelled = false;

	let callback: WorkflowHooksV1["onEvent"];
	let callerSignal: AbortSignal | undefined;
	let hookConfigurationFailure: HookFailure | undefined;
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
		hookConfigurationFailure =
			error instanceof HookFailure ? error : new HookFailure(error);
		callback = undefined;
		callerSignal = undefined;
	}
	const emitter = new EventEmitter(runId, callback);

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

	try {
		if (hookConfigurationFailure !== undefined) {
			return finalize({
				...base(),
				status: "failed",
				result: null,
				error: workflowError(
					"hook_error",
					boundedMessage(hookConfigurationFailure, "invalid workflow hooks"),
				),
			});
		}

		await emitter.emit({ type: "workflow_started", workflowId: definition.id });

		let args: Record<string, JsonValue>;
		try {
			args = cloneInvocationArgs(definition, argsInput);
		} catch (error) {
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

		const callerIsAborted = (): boolean => {
			try {
				return callerSignal?.aborted === true;
			} catch (error) {
				throw new HookFailure(error);
			}
		};
		const addCallerAbortListener = (listener: () => void): void => {
			try {
				callerSignal?.addEventListener("abort", listener, { once: true });
			} catch (error) {
				throw new HookFailure(error);
			}
		};
		const removeCallerAbortListener = (listener: () => void): void => {
			try {
				callerSignal?.removeEventListener("abort", listener);
			} catch (error) {
				throw new HookFailure(error);
			}
		};
		const refreshCancellation = (): void => {
			if (callerIsAborted()) callerCancelled = true;
		};
		const cancel = (): void => {
			callerCancelled = true;
		};
		addCallerAbortListener(cancel);
		refreshCancellation();

		try {
			for (const candidate of definition.steps) {
				if (candidate.type !== "agent") {
					const error = workflowError(
						"unsupported_step",
						`${candidate.type} step ${candidate.id} is not supported by the sequential engine`,
					);
					const unsupported: UnsupportedStepOutcomeV1 = {
						type: "unsupported",
						stepId: candidate.id,
						stepType: candidate.type,
						error,
					};
					steps.push(unsupported);
					return finalize({
						...base(),
						status: "failed",
						result: null,
						error,
					});
				}

				const identity = identityFor(runId, candidate.id);
				let leaf: LeafOutcomeV1 | undefined;
				refreshCancellation();
				if (callerCancelled) {
					leaf = skipped(identity, "cancelled");
				} else {
					counters.reservedCallSlots += 1;
					if (candidate.meta?.phase !== undefined) {
						await emitter.emit({
							type: "phase",
							stepId: candidate.id,
							phase: candidate.meta.phase,
						});
						refreshCancellation();
						if (callerCancelled) leaf = skipped(identity, "cancelled");
					}
					if (leaf === undefined && candidate.meta?.log !== undefined) {
						await emitter.emit({
							type: "log",
							stepId: candidate.id,
							message: candidate.meta.log,
						});
						refreshCancellation();
						if (callerCancelled) leaf = skipped(identity, "cancelled");
					}
				}

				const rendered =
					leaf === undefined ? renderPrompt(candidate, args, prior) : undefined;
				if (rendered?.unavailable !== undefined) {
					leaf = skipped(
						identity,
						"unavailable_reference",
						rendered.unavailable,
					);
				} else if (rendered?.tooLarge === true) {
					leaf = skipped(identity, "prompt_too_large");
				} else if (leaf === undefined && rendered !== undefined) {
					let active = true;
					await emitter.emit({
						type: "leaf_started",
						identity,
						agent: candidate.agent,
					});
					refreshCancellation();
					if (callerCancelled) {
						leaf = { status: "cancelled", identity, usage: ZERO_USAGE };
					} else {
						const controller = new AbortController();
						const abortForCaller = (): void => {
							callerCancelled = true;
							controller.abort();
						};
						let onControllerAbort!: () => void;
						const abortPromise = new Promise<
							{ kind: "timeout" } | { kind: "cancelled" }
						>((resolve) => {
							onControllerAbort = (): void =>
								resolve({
									kind: callerCancelled ? "cancelled" : "timeout",
								});
							controller.signal.addEventListener("abort", onControllerAbort, {
								once: true,
							});
							if (controller.signal.aborted) onControllerAbort();
						});
						let timeout: ReturnType<typeof setTimeout> | undefined;
						try {
							addCallerAbortListener(abortForCaller);
							if (callerIsAborted()) abortForCaller();
							if (controller.signal.aborted) {
								leaf = {
									status: "cancelled",
									identity,
									usage: ZERO_USAGE,
								};
							} else {
								timeout = setTimeout(
									() => controller.abort(new Error("leaf timeout")),
									candidate.limits.timeoutMs,
								);
								counters.actualLeafCalls += 1;
								const progress = async (
									update: LeafProgressUpdateV1,
								): Promise<void> => {
									if (!active) return;
									const bounded = progressEvent(update);
									if (bounded === undefined) return;
									await emitter.emit({
										type: "leaf_progress",
										identity,
										...bounded,
									});
								};
								const request = Object.freeze({
									identity,
									agent: candidate.agent,
									prompt: rendered.prompt!,
									output: candidate.output,
									limits: candidate.limits,
									signal: controller.signal,
									progress,
								});
								const runnerPromise = Promise.resolve()
									.then(() => leafRunner(request))
									.then(
										(terminal) => ({
											kind: "terminal" as const,
											terminal,
										}),
										(error: unknown) => ({
											kind: "runner_rejection" as const,
											error,
										}),
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
								if (settled.kind === "hook") {
									controller.abort(settled.error);
									throw settled.error;
								}
								if (settled.kind === "cancelled") {
									callerCancelled = true;
									leaf = {
										status: "cancelled",
										identity,
										usage: ZERO_USAGE,
									};
								} else if (settled.kind === "timeout") {
									leaf = {
										status: "timed_out",
										identity,
										usage: ZERO_USAGE,
									};
								} else if (settled.kind === "runner_rejection") {
									leaf = providerContractOutcome(identity, settled.error);
								} else {
									await emitter.drain();
									try {
										leaf = validateTerminal(
											settled.terminal,
											candidate,
											identity,
										);
									} catch (error) {
										leaf = providerContractOutcome(identity, error);
									}
								}
							}
						} finally {
							active = false;
							if (timeout !== undefined) clearTimeout(timeout);
							controller.signal.removeEventListener(
								"abort",
								onControllerAbort,
							);
							removeCallerAbortListener(abortForCaller);
						}
					}
				}

				if (leaf === undefined)
					throw new Error("leaf outcome was not materialized");
				if (leaf.status !== "skipped") {
					try {
						aggregate = addUsage(aggregate, leaf.usage);
					} catch (error) {
						leaf = providerContractOutcome(identity, error);
					}
				}
				const outcome: AgentStepOutcomeV1 = {
					type: "agent",
					stepId: candidate.id,
					leaf,
				};
				steps.push(outcome);
				prior.set(candidate.id, outcome);
				await emitter.emit({ type: "leaf_terminal", outcome: leaf });
			}
		} finally {
			removeCallerAbortListener(cancel);
		}

		if (callerCancelled) {
			return finalize({
				...base(),
				status: "cancelled",
				result: null,
				error: workflowError("cancelled", "workflow cancelled by caller"),
			});
		}

		const final = definition.result;
		if (final.ref !== "step") {
			return finalize({
				...base(),
				status: "failed",
				result: null,
				error: workflowError(
					"unsupported_step",
					"task final references require parallel scheduling",
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
		const result = { ref: final, outcome: selected.leaf } as const;
		if (selected.leaf.status !== "succeeded") {
			return finalize({
				...base(),
				status: "failed",
				result,
				error: workflowError(
					"final_result_failed",
					"selected final leaf did not succeed",
				),
			});
		}
		return finalize({ ...base(), status: "succeeded", result });
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
	return executeStartedWorkflow(
		definition,
		args,
		leafRunner,
		hooks,
		randomUUID(),
	);
}
