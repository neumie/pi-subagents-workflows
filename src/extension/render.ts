import type {
	LeafOutcomeV1,
	StepOutcomeV1,
	WorkflowEventV1,
	WorkflowOutcomeV1,
} from "../engine/index.ts";
import type { JsonValue } from "../ir/index.ts";
import { canonicalJsonPrefix } from "../ir/json.ts";

const DEFAULT_MAXIMUM_OUTPUT_BYTES = 16 * 1024;
const DEFAULT_MAXIMUM_MESSAGE_BYTES = 512;
const TRUNCATION_SUFFIX = "\n\n[output truncated]";

export interface RenderWorkflowOutcomeOptions {
	readonly maximumBytes?: number;
}

export interface RenderedWorkflowOutcomeV1 {
	readonly text: string;
	readonly truncated: boolean;
	readonly isError: boolean;
}

export interface WorkflowProgressProjectorOptions {
	readonly maximumMessageBytes?: number;
}

export interface WorkflowProgressSnapshotV1 {
	readonly runId: string;
	readonly workflowId?: string;
	readonly sequence: number;
	readonly activeLeaves: number;
	readonly completedLeaves: number;
	readonly latestNodeId?: string;
	readonly phase?: string;
	readonly message?: string;
	readonly terminalStatus?: WorkflowOutcomeV1["status"];
}

function byteLimit(
	value: number | undefined,
	fallback: number,
	label: string,
): number {
	const limit = value ?? fallback;
	if (!Number.isSafeInteger(limit) || limit < 64 || limit > 50 * 1024)
		throw new TypeError(`${label} must be 64 bytes to 50 KiB`);
	return limit;
}

function utf8Prefix(value: string, maximumBytes: number): string {
	if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
	let low = 0;
	let high = value.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maximumBytes)
			low = middle;
		else high = middle - 1;
	}
	let end = low;
	if (
		end > 0 &&
		end < value.length &&
		value.charCodeAt(end - 1) >= 0xd800 &&
		value.charCodeAt(end - 1) <= 0xdbff
	)
		end -= 1;
	return value.slice(0, end);
}

function bounded(
	value: string,
	maximumBytes: number,
): { text: string; truncated: boolean } {
	if (Buffer.byteLength(value, "utf8") <= maximumBytes)
		return { text: value, truncated: false };
	const suffixBytes = Buffer.byteLength(TRUNCATION_SUFFIX, "utf8");
	return {
		text: `${utf8Prefix(value, Math.max(0, maximumBytes - suffixBytes))}${TRUNCATION_SUFFIX}`,
		truncated: true,
	};
}

export function boundWorkflowText(
	value: string,
	maximumBytes = DEFAULT_MAXIMUM_OUTPUT_BYTES,
): { readonly text: string; readonly truncated: boolean } {
	return Object.freeze({
		...bounded(
			value,
			byteLimit(maximumBytes, DEFAULT_MAXIMUM_OUTPUT_BYTES, "workflow text limit"),
		),
	});
}

function leafProjection(leaf: LeafOutcomeV1): Record<string, JsonValue> {
	const identity: Record<string, JsonValue> = {
		nodeId: leaf.identity.nodeId,
		stepId: leaf.identity.stepId,
	};
	for (const key of [
		"taskId",
		"slot",
		"itemIndex",
		"stageIndex",
		"stageId",
	] as const) {
		const value = leaf.identity[key];
		if (value !== undefined) identity[key] = value;
	}
	const projection: Record<string, JsonValue> = {
		identity,
		status: leaf.status,
	};
	if (leaf.status === "succeeded") {
		projection.result =
			leaf.result.mode === "text"
				? { mode: "text", text: leaf.result.text }
				: { mode: "structured", value: leaf.result.value };
	} else if ("error" in leaf && leaf.error !== undefined) {
		projection.error = { code: leaf.error.code, message: leaf.error.message };
	} else if (leaf.status === "skipped") {
		projection.reason = leaf.reason;
	}
	return projection;
}

function stepProjection(outcome: StepOutcomeV1): JsonValue {
	if (outcome.type === "agent") return leafProjection(outcome.leaf);
	if (outcome.type === "parallel") {
		return {
			type: "parallel",
			stepId: outcome.stepId,
			slots: outcome.slots.map((leaf) => ({
				taskId: leaf.identity.taskId ?? "",
				...leafProjection(leaf),
			})),
		};
	}
	return {
		type: "pipeline",
		stepId: outcome.stepId,
		items: outcome.items.map((item) => ({
			index: item.index,
			status: item.status,
			stages: item.stages.map((leaf) => ({
				stageId: leaf.identity.stageId ?? "",
				...leafProjection(leaf),
			})),
		})),
		...(outcome.error === undefined
			? {}
			: {
					error: {
						code: outcome.error.code,
						message: outcome.error.message,
					},
				}),
	};
}

type SelectedContent =
	| { readonly mode: "text"; readonly text: string }
	| { readonly mode: "json"; readonly value: JsonValue };

function selectedContent(outcome: WorkflowOutcomeV1): SelectedContent | undefined {
	const selected = outcome.result?.outcome;
	if (selected === undefined) return undefined;
	if ("identity" in selected) {
		if (selected.status !== "succeeded")
			return { mode: "json", value: leafProjection(selected) };
		return selected.result.mode === "text"
			? { mode: "text", text: selected.result.text }
			: { mode: "json", value: selected.result.value };
	}
	if (selected.type === "agent") {
		if (selected.leaf.status !== "succeeded")
			return { mode: "json", value: leafProjection(selected.leaf) };
		return selected.leaf.result.mode === "text"
			? { mode: "text", text: selected.leaf.result.text }
			: { mode: "json", value: selected.leaf.result.value };
	}
	return { mode: "json", value: stepProjection(selected) };
}

export function renderWorkflowOutcome(
	outcome: WorkflowOutcomeV1,
	options: RenderWorkflowOutcomeOptions = {},
): RenderedWorkflowOutcomeV1 {
	const maximumBytes = byteLimit(
		options.maximumBytes,
		DEFAULT_MAXIMUM_OUTPUT_BYTES,
		"workflow output limit",
	);
	const header = `Workflow ${outcome.workflowId} ${outcome.status} (${outcome.runId})`;
	const content = selectedContent(outcome);
	const error = outcome.error?.message;
	if (content?.mode === "json") {
		const prefix = canonicalJsonPrefix(content.value, maximumBytes);
		const rendered = bounded(
			`${header}\n\n${prefix.text}${prefix.complete ? "" : TRUNCATION_SUFFIX}`,
			maximumBytes,
		);
		return Object.freeze({
			text: rendered.text,
			truncated: rendered.truncated || !prefix.complete,
			isError: outcome.status !== "succeeded",
		});
	}
	let body: string;
	if (content?.mode === "text") body = `${header}\n\n${content.text}`;
	else if (error !== undefined) body = `${header}\n\n${error}`;
	else
		body = `${header}\n${outcome.counters.actualLeafCalls} leaf call(s) completed`;
	const rendered = bounded(body, maximumBytes);
	return Object.freeze({
		...rendered,
		isError: outcome.status !== "succeeded",
	});
}

function identityKey(outcome: LeafOutcomeV1): string {
	return JSON.stringify([
		outcome.identity.runId,
		outcome.identity.nodeId,
		outcome.identity.itemIndex ?? null,
		outcome.identity.stageIndex ?? null,
	]);
}

export function createWorkflowProgressProjector(
	options: WorkflowProgressProjectorOptions = {},
): (event: WorkflowEventV1) => WorkflowProgressSnapshotV1 {
	const maximumMessageBytes = byteLimit(
		options.maximumMessageBytes,
		DEFAULT_MAXIMUM_MESSAGE_BYTES,
		"workflow progress message limit",
	);
	const active = new Set<string>();
	let workflowId: string | undefined;
	let completedLeaves = 0;
	let latestNodeId: string | undefined;
	let phase: string | undefined;
	let message: string | undefined;
	let terminalStatus: WorkflowOutcomeV1["status"] | undefined;

	return (event): WorkflowProgressSnapshotV1 => {
		if (event.type === "workflow_started") {
			workflowId = event.workflowId;
			message = "workflow started";
		} else if (event.type === "phase") {
			phase = event.phase;
			message = event.phase;
		} else if (event.type === "log") {
			message = event.message;
		} else if (event.type === "leaf_started") {
			active.add(
				JSON.stringify([
					event.identity.runId,
					event.identity.nodeId,
					event.identity.itemIndex ?? null,
					event.identity.stageIndex ?? null,
				]),
			);
			latestNodeId = event.identity.nodeId;
			message = `started ${event.identity.nodeId}`;
		} else if (event.type === "leaf_progress") {
			latestNodeId = event.identity.nodeId;
			message = event.message;
		} else if (event.type === "leaf_terminal") {
			active.delete(identityKey(event.outcome));
			completedLeaves += 1;
			latestNodeId = event.outcome.identity.nodeId;
			message = `${event.outcome.identity.nodeId}: ${event.outcome.status}`;
		} else if (event.type === "workflow_terminal") {
			terminalStatus = event.status;
			message = `workflow ${event.status}`;
		}
		const boundedMessage =
			message === undefined
				? undefined
				: bounded(message, maximumMessageBytes).text;
		return Object.freeze({
			runId: event.runId,
			...(workflowId === undefined ? {} : { workflowId }),
			sequence: event.sequence,
			activeLeaves: active.size,
			completedLeaves,
			...(latestNodeId === undefined ? {} : { latestNodeId }),
			...(phase === undefined ? {} : { phase }),
			...(boundedMessage === undefined ? {} : { message: boundedMessage }),
			...(terminalStatus === undefined ? {} : { terminalStatus }),
		});
	};
}
