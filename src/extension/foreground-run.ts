import {
	createPiSubagentsLeafAdapter,
	type DelegationEventBus,
	type PiSubagentsLeafAdapter,
	type PiSubagentsLeafAdapterOptions,
} from "../adapters/pi-subagents.ts";
import {
	executeWorkflow,
	type WorkflowEventV1,
	type WorkflowOutcomeV1,
} from "../engine/index.ts";
import {
	createWorkflowRunStore,
	type CreateWorkflowRunStoreOptions,
	type WorkflowRunStore,
} from "./run-store.ts";
import {
	isResolvedWorkflowDefinition,
	type ResolvedWorkflowDefinitionV1,
} from "./workflow-source.ts";

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

export interface ForegroundRunServiceOptions {
	readonly agentDir: string;
	readonly sessionId: string;
	readonly cwd: string;
	readonly events: DelegationEventBus;
	readonly context?: "fresh" | "fork";
	readonly shutdownTimeoutMs?: number;
}

export interface ForegroundRunRequestV1 {
	readonly source: ResolvedWorkflowDefinitionV1;
	readonly args: unknown;
	readonly invocation: "tool" | "command";
	readonly toolCallId?: string;
	readonly signal?: AbortSignal;
	readonly present?: (
		event: WorkflowEventV1,
		active: readonly ForegroundActiveRunV1[],
	) => void | Promise<void>;
	readonly recordPointer?: (
		pointer: ForegroundSessionPointerV1,
	) => void | Promise<void>;
}

interface ForegroundActiveRunV1 {
	readonly runId: string;
	readonly workflowId: string;
	readonly invocation: "tool" | "command";
	readonly sourceKind: ResolvedWorkflowDefinitionV1["sourceKind"];
	readonly displaySource: string;
}

export interface ForegroundSessionPointerV1 {
	readonly version: 1;
	readonly phase: "started" | "terminal";
	readonly sessionKey: string;
	readonly runId: string;
	readonly workflowId: string;
	readonly sourceSha256: string;
	readonly displaySource: string;
	readonly relativeLocator: string;
	readonly status?: WorkflowOutcomeV1["status"];
}

interface ForegroundRunPointerV1 {
	readonly sessionKey: string;
	readonly runId: string;
	readonly workflowId: string;
	readonly relativeLocator: string;
}

export interface ForegroundRunResultV1 {
	readonly outcome: WorkflowOutcomeV1;
	readonly pointer: ForegroundRunPointerV1;
}

export interface ForegroundRunServiceDependencies {
	readonly createStore?: (
		options: CreateWorkflowRunStoreOptions,
	) => WorkflowRunStore;
	readonly createAdapter?: (
		options: PiSubagentsLeafAdapterOptions,
	) => Promise<PiSubagentsLeafAdapter>;
	readonly execute?: typeof executeWorkflow;
}

export interface ForegroundRunService {
	execute(request: ForegroundRunRequestV1): Promise<ForegroundRunResultV1>;
	cancel(runId: string, reason?: unknown): boolean;
	shutdown(reason?: unknown): Promise<void>;
	readonly activeRuns: readonly ForegroundActiveRunV1[];
}

interface ActiveRun {
	readonly snapshot: ForegroundActiveRunV1;
	readonly controller: AbortController;
}

interface Deferred {
	readonly promise: Promise<void>;
	resolve(): void;
}

function deferred(): Deferred {
	let resolve = (): void => undefined;
	const promise = new Promise<void>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

function shutdownTimeout(value: number | undefined): number {
	const timeout = value ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
	if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000)
		throw new TypeError(
			"foreground shutdown timeout must be 1 to 60000 milliseconds",
		);
	return timeout;
}

function safeReason(reason: unknown, fallback: string): unknown {
	return reason === undefined ? new Error(fallback) : reason;
}

export function createForegroundRunService(
	options: ForegroundRunServiceOptions,
	dependencies: ForegroundRunServiceDependencies = {},
): ForegroundRunService {
	const timeoutMs = shutdownTimeout(options.shutdownTimeoutMs);
	const createStore = dependencies.createStore ?? createWorkflowRunStore;
	const createAdapter =
		dependencies.createAdapter ?? createPiSubagentsLeafAdapter;
	const execute = dependencies.execute ?? executeWorkflow;
	const lifecycleController = new AbortController();
	const active = new Map<string, ActiveRun>();
	const settlements = new Set<Promise<void>>();
	let adapterPromise: Promise<PiSubagentsLeafAdapter> | undefined;
	let accepting = true;
	let shutdownPromise: Promise<void> | undefined;

	const activeSnapshots = (): readonly ForegroundActiveRunV1[] =>
		Object.freeze([...active.values()].map(({ snapshot }) => snapshot));

	const acquireAdapter = (): Promise<PiSubagentsLeafAdapter> => {
		adapterPromise ??= createAdapter({
			events: options.events,
			cwd: options.cwd,
			...(options.context === undefined ? {} : { context: options.context }),
		});
		return adapterPromise;
	};

	const executeRun = async (
		request: ForegroundRunRequestV1,
	): Promise<ForegroundRunResultV1> => {
		if (!accepting) throw new Error("foreground workflow service is shut down");
		if (!isResolvedWorkflowDefinition(request.source))
			throw new TypeError(
				"foreground workflow source must come from the strict resolver",
			);
		if (request.invocation !== "tool" && request.invocation !== "command")
			throw new TypeError(
				"foreground workflow invocation must be tool or command",
			);
		if (request.invocation === "command" && request.toolCallId !== undefined)
			throw new TypeError(
				"command workflow invocation cannot include a tool call ID",
			);

		const controller = new AbortController();
		const signal = AbortSignal.any([
			controller.signal,
			lifecycleController.signal,
			...(request.signal === undefined ? [] : [request.signal]),
		]);
		const store = createStore({
			agentDir: options.agentDir,
			sessionId: options.sessionId,
		});
		const completion = deferred();
		settlements.add(completion.promise);
		let runId: string | undefined;
		let workflowId = request.source.definition.id;
		let terminalRecorded = false;
		let result: ForegroundRunResultV1 | undefined;
		let failure: unknown;

		try {
			const adapter = await acquireAdapter();
			const outcome = await execute(
				request.source.definition,
				request.args,
				adapter.leafRunner,
				{
					signal,
					onEvent: async (event) => {
						if (event.type === "workflow_started") {
							await store.beginRun({
								event,
								source: request.source,
								args: request.args,
								invocation: request.invocation,
								...(request.toolCallId === undefined
									? {}
									: { toolCallId: request.toolCallId }),
								cwd: options.cwd,
							});
							runId = event.runId;
							workflowId = event.workflowId;
							if (active.has(event.runId))
								throw new Error("duplicate active workflow run ID");
							active.set(event.runId, {
								controller,
								snapshot: Object.freeze({
									runId: event.runId,
									workflowId: event.workflowId,
									invocation: request.invocation,
									sourceKind: request.source.sourceKind,
									displaySource: request.source.displaySource,
								}),
							});
							try {
								await request.recordPointer?.({
									version: 1,
									phase: "started",
									sessionKey: store.sessionKey,
									runId: event.runId,
									workflowId: event.workflowId,
									sourceSha256: request.source.sha256,
									displaySource: request.source.displaySource,
									relativeLocator: `${store.sessionKey}/${event.runId}`,
								});
							} catch {
								// Session pointers are branch UI hints, never audit authority.
							}
						} else {
							await store.appendEvent(event);
							if (event.type === "workflow_terminal") terminalRecorded = true;
						}
						try {
							await request.present?.(event, activeSnapshots());
						} catch {
							// Presentation is advisory; required audit writes already completed.
						}
					},
				},
			);
			runId = outcome.runId;
			workflowId = outcome.workflowId;
			if (terminalRecorded) {
				await store.finishRun(outcome.runId, outcome);
				try {
					await request.recordPointer?.({
						version: 1,
						phase: "terminal",
						sessionKey: store.sessionKey,
						runId: outcome.runId,
						workflowId: outcome.workflowId,
						sourceSha256: request.source.sha256,
						displaySource: request.source.displaySource,
						relativeLocator: `${store.sessionKey}/${outcome.runId}`,
						status: outcome.status,
					});
				} catch {
					// Session pointers are branch UI hints, never audit authority.
				}
			}
			result = Object.freeze({
				outcome,
				pointer: Object.freeze({
					sessionKey: store.sessionKey,
					runId: outcome.runId,
					workflowId: outcome.workflowId,
					relativeLocator: `${store.sessionKey}/${outcome.runId}`,
				}),
			});
		} catch (error) {
			failure = error;
		}

		try {
			await store.close();
		} catch (error) {
			failure =
				failure === undefined
					? error
					: new AggregateError(
							[failure, error],
							"foreground workflow execution and audit close both failed",
						);
		} finally {
			if (runId !== undefined) {
				const owned = active.get(runId);
				if (owned?.controller === controller) active.delete(runId);
			}
			completion.resolve();
			settlements.delete(completion.promise);
		}

		if (failure !== undefined) throw failure;
		if (result === undefined)
			throw new Error(
				`foreground workflow ${workflowId} ended without a terminal result`,
			);
		return result;
	};

	const shutdown = (reason?: unknown): Promise<void> => {
		shutdownPromise ??= (async () => {
			accepting = false;
			lifecycleController.abort(
				safeReason(reason, "foreground workflow session shut down"),
			);
			for (const { controller } of active.values())
				controller.abort(
					safeReason(reason, "foreground workflow session shut down"),
				);

			let timeout: ReturnType<typeof setTimeout> | undefined;
			const timedOut = new Promise<"timeout">((resolve) => {
				timeout = setTimeout(() => resolve("timeout"), timeoutMs);
				timeout.unref?.();
			});
			const settled = Promise.allSettled([...settlements]).then(
				() => "settled" as const,
			);
			const state = await Promise.race([settled, timedOut]);
			if (timeout !== undefined) clearTimeout(timeout);

			const pendingAdapter = adapterPromise;
			if (state === "timeout") {
				if (pendingAdapter !== undefined) {
					void pendingAdapter.then(
						(adapter) => {
							try {
								adapter.dispose();
							} catch {
								// Timed-out shutdown can no longer report deferred disposal.
							}
						},
						() => undefined,
					);
				}
				throw new Error(
					`foreground workflow shutdown exceeded ${timeoutMs} milliseconds`,
				);
			}
			const adapter = await pendingAdapter?.catch(() => undefined);
			adapter?.dispose();
		})();
		return shutdownPromise;
	};

	return {
		execute: executeRun,
		cancel(runId, reason): boolean {
			const owned = active.get(runId);
			if (owned === undefined) return false;
			owned.controller.abort(
				safeReason(reason, `foreground workflow ${runId} cancelled`),
			);
			return true;
		},
		shutdown,
		get activeRuns(): readonly ForegroundActiveRunV1[] {
			return activeSnapshots();
		},
	};
}
