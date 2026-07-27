import { types as utilTypes } from "node:util";

import {
	BorderedLoader,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { JsonValue } from "../ir/index.ts";
import { cloneSafeJson } from "../ir/json.ts";
import {
	projectWorkflowTerminal,
	type WorkflowRunTerminalV1,
} from "./audit-codec.ts";
import {
	createForegroundRunService,
	type ForegroundRunResultV1,
	type ForegroundRunService,
	type ForegroundRunServiceOptions,
	type ForegroundSessionPointerV1,
} from "./foreground-run.ts";
import { toPiUsage } from "./pi-usage.ts";
import {
	boundWorkflowText,
	createWorkflowProgressProjector,
	renderWorkflowOutcome,
	type WorkflowProgressSnapshotV1,
} from "./render.ts";
import {
	inspectWorkflowRun,
	listWorkflowRuns,
	type WorkflowRunInspectionV1,
} from "./run-store.ts";
import { assertBoundedSafeText } from "./safe-filesystem.ts";
import { parseWorkflowCommand } from "./workflow-command.ts";
import {
	listSavedWorkflowDefinitions,
	resolveWorkflowDefinition,
	type ResolvedWorkflowDefinitionV1,
} from "./workflow-source.ts";

const ENTRY_TYPE = "pi-subagents-workflows.run";
const STATUS_KEY = "pi-subagents-workflows";
const MAXIMUM_SESSION_CWDS = 64;
const MAXIMUM_BRANCH_POINTERS = 256;
const MAXIMUM_BRANCH_SCAN_ENTRIES = 2_048;

const WorkflowToolParameters = Type.Object(
	{
		source: Type.Union([
			Type.Object(
				{
					kind: Type.Literal("inline"),
					definition: Type.Unknown(),
				},
				{ additionalProperties: false },
			),
			Type.Object(
				{
					kind: Type.Literal("saved"),
					name: Type.String({ minLength: 1, maxLength: 128 }),
				},
				{ additionalProperties: false },
			),
		]),
		args: Type.Object({}, { additionalProperties: true }),
	},
	{ additionalProperties: false },
);

interface WorkflowToolDetailsV1 {
	readonly version: 1;
	readonly pointer?: ForegroundRunResultV1["pointer"];
	readonly terminal?: WorkflowRunTerminalV1;
	readonly source?: {
		readonly kind: ResolvedWorkflowDefinitionV1["sourceKind"];
		readonly display: string;
		readonly sha256: string;
	};
	readonly progress?: WorkflowProgressSnapshotV1;
	readonly error?: {
		readonly code: "workflow_extension_error";
		readonly message: string;
	};
	readonly truncated?: boolean;
}

export interface WorkflowExtensionDependencies {
	readonly getAgentDir?: () => string;
	readonly createService?: (
		options: ForegroundRunServiceOptions,
	) => ForegroundRunService;
	readonly resolveDefinition?: typeof resolveWorkflowDefinition;
	readonly listDefinitions?: typeof listSavedWorkflowDefinitions;
	readonly listRuns?: typeof listWorkflowRuns;
	readonly inspectRun?: typeof inspectWorkflowRun;
}

interface SessionBinding {
	readonly sessionId: string;
	readonly services: Map<string, ForegroundRunService>;
}

interface CommandEnvelope {
	readonly result?: ForegroundRunResultV1;
	readonly error?: unknown;
	readonly aborted?: true;
}

function record(value: unknown): value is Record<string, JsonValue> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		(Object.getPrototypeOf(value) === Object.prototype ||
			Object.getPrototypeOf(value) === null)
	);
}

function pointerEntryData(entry: unknown): unknown | undefined {
	if (typeof entry !== "object" || entry === null || utilTypes.isProxy(entry))
		return undefined;
	try {
		const prototype = Object.getPrototypeOf(entry);
		if (prototype !== Object.prototype && prototype !== null) return undefined;
		const type = Object.getOwnPropertyDescriptor(entry, "type");
		const customType = Object.getOwnPropertyDescriptor(entry, "customType");
		const data = Object.getOwnPropertyDescriptor(entry, "data");
		if (
			type === undefined ||
			!("value" in type) ||
			type.value !== "custom" ||
			customType === undefined ||
			!("value" in customType) ||
			customType.value !== ENTRY_TYPE ||
			data === undefined ||
			!("value" in data)
		)
			return undefined;
		return data.value;
	} catch {
		return undefined;
	}
}

function decodePointer(value: unknown): ForegroundSessionPointerV1 | undefined {
	let cloned: JsonValue;
	try {
		cloned = cloneSafeJson(value, {
			maximumBytes: 8 * 1024,
			maximumDepth: 8,
			maximumEntries: 32,
			sizeLabel: "8 KiB",
			subject: "workflow session pointer",
			rejectProxies: true,
		});
	} catch {
		return undefined;
	}
	if (!record(cloned)) return undefined;
	const allowed = new Set([
		"version",
		"phase",
		"sessionKey",
		"runId",
		"workflowId",
		"sourceSha256",
		"displaySource",
		"relativeLocator",
		"status",
	]);
	if (Object.keys(cloned).some((key) => !allowed.has(key))) return undefined;
	if (
		cloned.version !== 1 ||
		(cloned.phase !== "started" && cloned.phase !== "terminal") ||
		typeof cloned.sessionKey !== "string" ||
		typeof cloned.runId !== "string" ||
		typeof cloned.workflowId !== "string" ||
		typeof cloned.sourceSha256 !== "string" ||
		typeof cloned.displaySource !== "string" ||
		typeof cloned.relativeLocator !== "string" ||
		(cloned.status !== undefined &&
			cloned.status !== "succeeded" &&
			cloned.status !== "failed" &&
			cloned.status !== "cancelled")
	)
		return undefined;
	try {
		assertBoundedSafeText(cloned.sessionKey, "pointer session key", 128);
		assertBoundedSafeText(cloned.runId, "pointer run ID", 128);
		assertBoundedSafeText(cloned.workflowId, "pointer workflow ID", 128);
		assertBoundedSafeText(cloned.sourceSha256, "pointer source hash", 64);
		assertBoundedSafeText(cloned.displaySource, "pointer display source", 4096);
		assertBoundedSafeText(cloned.relativeLocator, "pointer locator", 512);
	} catch {
		return undefined;
	}
	return Object.freeze({
		version: 1,
		phase: cloned.phase,
		sessionKey: cloned.sessionKey,
		runId: cloned.runId,
		workflowId: cloned.workflowId,
		sourceSha256: cloned.sourceSha256,
		displaySource: cloned.displaySource,
		relativeLocator: cloned.relativeLocator,
		...(cloned.status === undefined ? {} : { status: cloned.status }),
	});
}

function progressText(progress: WorkflowProgressSnapshotV1): string {
	const counts = `${progress.completedLeaves} complete, ${progress.activeLeaves} active`;
	return progress.message === undefined
		? `Workflow ${progress.runId}: ${counts}`
		: `Workflow ${progress.runId}: ${counts} — ${progress.message}`;
}

function errorText(error: unknown): string {
	if (typeof error !== "object" || error === null || utilTypes.isProxy(error))
		return "workflow operation failed";
	try {
		const descriptor = Object.getOwnPropertyDescriptor(error, "message");
		if (
			descriptor !== undefined &&
			"value" in descriptor &&
			typeof descriptor.value === "string" &&
			descriptor.value.trim().length > 0
		)
			return boundWorkflowText(descriptor.value, 2_048).text;
	} catch {
		// Error projection is best-effort and must never invoke accessors.
	}
	return "workflow operation failed";
}

function boundedLines(lines: readonly string[]): string {
	const maximumItems = 100;
	const maximumBytes = 16 * 1024;
	const kept: string[] = [];
	for (const line of lines.slice(0, maximumItems)) {
		const candidate = [...kept, line].join("\n");
		if (Buffer.byteLength(candidate, "utf8") > maximumBytes - 64) break;
		kept.push(line);
	}
	let omitted = lines.length - kept.length;
	let suffix = omitted > 0 ? `… ${omitted} more omitted` : "";
	while (
		kept.length > 0 &&
		Buffer.byteLength([...kept, ...(suffix ? [suffix] : [])].join("\n"), "utf8") >
			maximumBytes
	) {
		kept.pop();
		omitted = lines.length - kept.length;
		suffix = `… ${omitted} more omitted`;
	}
	return [...kept, ...(suffix ? [suffix] : [])].join("\n");
}

function advisoryStatus(
	ctx: ExtensionContext,
	value: string | undefined,
): void {
	try {
		ctx.ui.setStatus(STATUS_KEY, value);
	} catch {
		// UI presentation cannot change execution or audit success.
	}
}

function advisoryNotify(
	ctx: ExtensionContext,
	message: string,
	level: "info" | "warning" | "error",
): void {
	try {
		ctx.ui.notify(boundWorkflowText(message, 16 * 1024).text, level);
	} catch {
		// UI presentation cannot change execution or audit success.
	}
}

export function registerWorkflowExtension(
	pi: ExtensionAPI,
	dependencies: WorkflowExtensionDependencies = {},
): void {
	const agentDir = (dependencies.getAgentDir ?? getAgentDir)();
	const makeService = dependencies.createService ?? createForegroundRunService;
	const resolveDefinition =
		dependencies.resolveDefinition ?? resolveWorkflowDefinition;
	const listDefinitions =
		dependencies.listDefinitions ?? listSavedWorkflowDefinitions;
	const listRuns = dependencies.listRuns ?? listWorkflowRuns;
	const inspectRun = dependencies.inspectRun ?? inspectWorkflowRun;
	const pointers = new Map<string, ForegroundSessionPointerV1>();
	let binding: SessionBinding | undefined;
	let acceptingHostInvocations = true;

	const retainPointer = (pointer: ForegroundSessionPointerV1): void => {
		if (!pointers.has(pointer.runId) && pointers.size >= MAXIMUM_BRANCH_POINTERS) {
			const oldest = pointers.keys().next().value;
			if (oldest !== undefined) pointers.delete(oldest);
		}
		pointers.set(pointer.runId, pointer);
	};

	const restorePointers = (ctx: ExtensionContext): void => {
		pointers.clear();
		const branch = ctx.sessionManager.getBranch();
		const start = Math.max(0, branch.length - MAXIMUM_BRANCH_SCAN_ENTRIES);
		for (let index = start; index < branch.length; index += 1) {
			const pointer = decodePointer(pointerEntryData(branch[index]));
			if (pointer !== undefined) retainPointer(pointer);
		}
	};

	const bindSession = (ctx: ExtensionContext): SessionBinding => {
		if (!acceptingHostInvocations)
			throw new Error("workflow extension is shut down for this session");
		const nextSessionId = ctx.sessionManager.getSessionId();
		if (binding !== undefined) {
			if (binding.sessionId !== nextSessionId)
				throw new Error("stale workflow extension session binding");
			return binding;
		}
		const created: SessionBinding = {
			sessionId: nextSessionId,
			services: new Map(),
		};
		binding = created;
		return created;
	};

	const serviceFor = (ctx: ExtensionContext): ForegroundRunService => {
		const current = bindSession(ctx);
		const existing = current.services.get(ctx.cwd);
		if (existing !== undefined) return existing;
		if (current.services.size >= MAXIMUM_SESSION_CWDS)
			throw new Error(
				`workflow session cwd limit of ${MAXIMUM_SESSION_CWDS} exceeded`,
			);
		const service = makeService({
			agentDir,
			sessionId: current.sessionId,
			cwd: ctx.cwd,
			events: pi.events,
		});
		current.services.set(ctx.cwd, service);
		return service;
	};

	const services = (): readonly ForegroundRunService[] =>
		binding === undefined ? [] : [...new Set(binding.services.values())];

	const activeRuns = () => services().flatMap((service) => service.activeRuns);

	const cancelRun = (runId: string): boolean => {
		const owners = services().filter((service) =>
			service.activeRuns.some((run) => run.runId === runId),
		);
		if (owners.length !== 1) return false;
		const [owner] = owners;
		return owner?.cancel(runId) ?? false;
	};

	const savePointer = (pointer: ForegroundSessionPointerV1): void => {
		retainPointer(pointer);
		pi.appendEntry(ENTRY_TYPE, pointer);
	};

	const executeResolved = async (
		ctx: ExtensionContext,
		source: ResolvedWorkflowDefinitionV1,
		args: unknown,
		invocation: "tool" | "command",
		options: {
			readonly toolCallId?: string;
			readonly signal?: AbortSignal;
			readonly onProgress?: (progress: WorkflowProgressSnapshotV1) => void;
		} = {},
	): Promise<ForegroundRunResultV1> => {
		const project = createWorkflowProgressProjector();
		let previousProgressKey: string | undefined;
		return serviceFor(ctx).execute({
			source,
			args,
			invocation,
			...(options.toolCallId === undefined
				? {}
				: { toolCallId: options.toolCallId }),
			...(options.signal === undefined ? {} : { signal: options.signal }),
			recordPointer: savePointer,
			present: (event) => {
				const progress = project(event);
				const key = JSON.stringify([
					progress.runId,
					progress.workflowId ?? null,
					progress.activeLeaves,
					progress.completedLeaves,
					progress.latestNodeId ?? null,
					progress.phase ?? null,
					progress.message ?? null,
					progress.terminalStatus ?? null,
				]);
				if (key === previousProgressKey) return;
				previousProgressKey = key;
				options.onProgress?.(progress);
			},
		});
	};

	pi.on("session_start", async (_event, ctx) => {
		bindSession(ctx);
		restorePointers(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => {
		bindSession(ctx);
		restorePointers(ctx);
	});
	pi.on("session_shutdown", async (event) => {
		acceptingHostInvocations = false;
		const owned = binding;
		binding = undefined;
		pointers.clear();
		if (owned === undefined) return;
		const results = await Promise.allSettled(
			[...new Set(owned.services.values())].map((service) =>
				service.shutdown(event.reason),
			),
		);
		const failures = results.flatMap((result) =>
			result.status === "rejected" ? [result.reason] : [],
		);
		if (failures.length > 0)
			throw new AggregateError(
				failures,
				"one or more foreground workflow services failed to shut down",
			);
	});

	pi.registerTool({
		name: "pi_workflow",
		label: "Pi Workflow",
		description:
			"Run a strict JSON workflow in the foreground from an inline or saved definition. Paths, resume, and detach are not available to this model tool.",
		promptSnippet:
			"Run a bounded strict-JSON multi-agent workflow in the foreground",
		promptGuidelines: [
			"Use pi_workflow only for foreground orchestration; it does not resume, detach, or grant filesystem path authority.",
		],
		parameters: WorkflowToolParameters,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			let source: ResolvedWorkflowDefinitionV1 | undefined;
			try {
				source = await resolveDefinition(params.source, {
					agentDir,
					cwd: ctx.cwd,
					allowPath: false,
				});
				const result = await executeResolved(ctx, source, params.args, "tool", {
					toolCallId,
					...(signal === undefined ? {} : { signal }),
					onProgress: (progress) => {
						onUpdate?.({
							content: [{ type: "text", text: progressText(progress) }],
							details: {
								version: 1,
								progress,
							} satisfies WorkflowToolDetailsV1,
						});
					},
				});
				const rendered = renderWorkflowOutcome(result.outcome);
				const terminal = projectWorkflowTerminal(
					result.outcome,
					source.definition,
				);
				return {
					content: [{ type: "text", text: rendered.text }],
					details: {
						version: 1,
						pointer: result.pointer,
						terminal,
						source: {
							kind: source.sourceKind,
							display: source.displaySource,
							sha256: source.sha256,
						},
						truncated: rendered.truncated,
					} satisfies WorkflowToolDetailsV1,
					usage: toPiUsage(result.outcome.usage),
					isError: result.outcome.status !== "succeeded",
				};
			} catch (error) {
				const message = errorText(error);
				return {
					content: [{ type: "text", text: `Workflow error: ${message}` }],
					details: {
						version: 1,
						...(source === undefined
							? {}
							: {
									source: {
										kind: source.sourceKind,
										display: source.displaySource,
										sha256: source.sha256,
									},
								}),
						error: { code: "workflow_extension_error", message },
					} satisfies WorkflowToolDetailsV1,
					isError: true,
				};
			}
		},
	});

	const runCommand = async (
		command: Extract<
			ReturnType<typeof parseWorkflowCommand>,
			{ action: "run" }
		>,
		ctx: ExtensionCommandContext,
	): Promise<void> => {
		const source = await resolveDefinition(command.source, {
			agentDir,
			cwd: ctx.cwd,
			allowPath: true,
		});
		const execute = (signal?: AbortSignal): Promise<ForegroundRunResultV1> =>
			executeResolved(ctx, source, command.args, "command", {
				...(signal === undefined ? {} : { signal }),
				onProgress: (progress) => {
					advisoryStatus(ctx, progressText(progress));
				},
			});
		let result: ForegroundRunResultV1;
		try {
			if (ctx.mode === "tui") {
				let pendingExecution: Promise<ForegroundRunResultV1> | undefined;
				const envelope = await ctx.ui.custom<CommandEnvelope>(
					(tui, theme, _keybindings, done) => {
						const loader = new BorderedLoader(
							tui,
							theme,
							"Running foreground workflow (Escape cancels)…",
							{ cancellable: true },
						);
						let modalSettled = false;
						const complete = (value: CommandEnvelope): void => {
							if (modalSettled) return;
							modalSettled = true;
							done(value);
						};
						loader.onAbort = () => complete({ aborted: true });
						pendingExecution = execute(loader.signal);
						void pendingExecution.then(
							(value) => complete({ result: value }),
							(error: unknown) => complete({ error }),
						);
						return loader;
					},
				);
				if (envelope?.error !== undefined) throw envelope.error;
				if (envelope?.aborted === true) {
					if (pendingExecution === undefined)
						throw new Error("foreground workflow cancellation lost its execution");
					result = await pendingExecution;
				} else {
					if (envelope?.result === undefined)
						throw new Error("foreground workflow command did not return a result");
					result = envelope.result;
				}
			} else result = await execute();
		} finally {
			advisoryStatus(ctx, undefined);
		}
		const rendered = renderWorkflowOutcome(result.outcome, {
			maximumBytes: 2_048,
		});
		let notificationLevel: "info" | "warning" | "error" = "error";
		if (result.outcome.status === "succeeded") notificationLevel = "info";
		else if (result.outcome.status === "cancelled")
			notificationLevel = "warning";
		advisoryNotify(ctx, rendered.text, notificationLevel);
	};

	pi.registerCommand("pi-workflow", {
		description:
			"Run, list, inspect, or cancel foreground strict-JSON workflows",
		handler: async (input, ctx) => {
			try {
				const command = parseWorkflowCommand(input);
				if (command.action === "run") {
					await runCommand(command, ctx);
					return;
				}
				if (command.action === "cancel") {
					const cancelled = cancelRun(command.runId);
					advisoryNotify(
						ctx,
						cancelled
							? `Cancelling foreground workflow ${command.runId}`
							: `No active foreground workflow ${command.runId}`,
						cancelled ? "info" : "error",
					);
					return;
				}
				const currentSession = bindSession(ctx);
				if (command.action === "list") {
					const definitions = await listDefinitions({ agentDir, cwd: ctx.cwd });
					const lines = definitions.map((item) => {
						const roots = [
							...(item.user ? ["user"] : []),
							...(item.project ? ["project"] : []),
						];
						return `${item.name} [${roots.join("+")}]${item.ambiguous ? " ambiguous" : ""}`;
					});
					advisoryNotify(
						ctx,
						lines.length === 0
							? "No saved workflow definitions"
							: boundedLines(lines),
						"info",
					);
					return;
				}
				if (command.runId !== undefined) {
					const activeRun = activeRuns().find(
						(item) => item.runId === command.runId,
					);
					if (activeRun !== undefined) {
						advisoryNotify(
							ctx,
							`${activeRun.runId}: running (foreground only)`,
							"info",
						);
						return;
					}
					const stored = await inspectRun({
						agentDir,
						sessionId: currentSession.sessionId,
						runId: command.runId,
					});
					advisoryNotify(ctx, `${stored.runId}: ${stored.status}`, "info");
					return;
				}
				const currentActiveRuns = activeRuns();
				const storedRuns: readonly WorkflowRunInspectionV1[] = await listRuns({
					agentDir,
					sessionId: currentSession.sessionId,
				});
				const activeIds = new Set(
					currentActiveRuns.map(({ runId }) => runId),
				);
				const lines = [
					...currentActiveRuns.map(
						({ runId }) => `${runId}: running (foreground only)`,
					),
					...storedRuns.flatMap(({ runId, status }) =>
						activeIds.has(runId) ? [] : [`${runId}: ${status}`],
					),
				];
				advisoryNotify(
					ctx,
					lines.length === 0 ? "No workflow runs" : boundedLines(lines),
					"info",
				);
			} catch (error) {
				advisoryNotify(ctx, errorText(error), "error");
			}
		},
	});
}

export default function piSubagentsWorkflows(pi: ExtensionAPI): void {
	registerWorkflowExtension(pi);
}
