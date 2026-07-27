import assert from "node:assert/strict";
import { test } from "node:test";

import type {
	LeafOutcomeV1,
	WorkflowEventV1,
	WorkflowOutcomeV1,
} from "../../src/engine/index.ts";
import type { JsonValue } from "../../src/ir/index.ts";
import {
	createWorkflowProgressProjector,
	renderWorkflowOutcome,
} from "../../src/extension/render.ts";

const usage = {
	input: 1,
	output: 2,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0.01,
	turns: 1,
	toolCalls: 0,
	durationMs: 1,
};

function outcome(result: LeafOutcomeV1): WorkflowOutcomeV1 {
	return {
		version: 1,
		runId: "run-render",
		workflowId: "renderTest",
		status: result.status === "succeeded" ? "succeeded" : "failed",
		steps: [{ type: "agent", stepId: "only", leaf: result }],
		result: {
			ref: { ref: "step", stepId: "only" },
			outcome: result,
		},
		usage,
		counters: { reservedCallSlots: 1, actualLeafCalls: 1, admittedItems: 0 },
	};
}

function succeeded(
	result:
		| { mode: "text"; text: string }
		| { mode: "structured"; value: Record<string, JsonValue> },
): LeafOutcomeV1 {
	return {
		status: "succeeded",
		identity: { runId: "run-render", nodeId: "step:only", stepId: "only" },
		result,
		usage,
	};
}

test("terminal rendering preserves literal text and formats structured values", () => {
	const literal = renderWorkflowOutcome(
		outcome(succeeded({ mode: "text", text: '{"answer":42}' })),
	);
	assert.match(literal.text, /\{"answer":42\}/);
	assert.doesNotMatch(literal.text, /\{\n\s+"answer"/);
	assert.equal(literal.truncated, false);
	assert.equal(literal.isError, false);

	const structured = renderWorkflowOutcome(
		outcome(succeeded({ mode: "structured", value: { answer: 42, ok: true } })),
	);
	assert.match(structured.text, /\{"answer":42,"ok":true\}/);
});

test("terminal rendering projects parallel and pipeline final results in source order", () => {
	const parallel = {
		type: "parallel" as const,
		stepId: "checks",
		slots: [
			{
				...succeeded({ mode: "text" as const, text: "first literal" }),
				identity: {
					runId: "run-render",
					nodeId: "parallel:checks:task:first",
					stepId: "checks",
					taskId: "first",
					slot: 0,
				},
			},
			{
				...succeeded({
					mode: "structured" as const,
					value: { answer: 42 },
				}),
				identity: {
					runId: "run-render",
					nodeId: "parallel:checks:task:second",
					stepId: "checks",
					taskId: "second",
					slot: 1,
				},
			},
		],
	};
	const parallelRendered = renderWorkflowOutcome({
		version: 1,
		runId: "run-render",
		workflowId: "parallelRender",
		status: "succeeded",
		steps: [parallel],
		result: { ref: { ref: "step", stepId: "checks" }, outcome: parallel },
		usage,
		counters: { reservedCallSlots: 2, actualLeafCalls: 2, admittedItems: 0 },
	});
	assert.match(parallelRendered.text, /"type":"parallel"/);
	assert.match(parallelRendered.text, /"mode":"text","text":"first literal"/);
	assert.match(parallelRendered.text, /"mode":"structured","value":\{"answer":42\}/);
	assert.ok(
		parallelRendered.text.indexOf('"taskId":"first"') <
			parallelRendered.text.indexOf('"taskId":"second"'),
	);

	const stage = {
		...succeeded({ mode: "text" as const, text: "pipeline literal" }),
		identity: {
			runId: "run-render",
			nodeId: "pipeline:map:item:0:stage:finish",
			stepId: "map",
			itemIndex: 0,
			stageIndex: 0,
			stageId: "finish",
		},
	};
	const pipeline = {
		type: "pipeline" as const,
		stepId: "map",
		items: [{ index: 0, status: "succeeded" as const, stages: [stage] }],
	};
	const pipelineRendered = renderWorkflowOutcome({
		version: 1,
		runId: "run-render",
		workflowId: "pipelineRender",
		status: "succeeded",
		steps: [pipeline],
		result: { ref: { ref: "step", stepId: "map" }, outcome: pipeline },
		usage,
		counters: { reservedCallSlots: 1, actualLeafCalls: 1, admittedItems: 1 },
	});
	assert.match(pipelineRendered.text, /"type":"pipeline"/);
	assert.match(pipelineRendered.text, /"stageId":"finish"/);
	assert.match(pipelineRendered.text, /pipeline literal/);
});

test("terminal and progress rendering remain bounded", () => {
	const terminal = renderWorkflowOutcome(
		outcome(succeeded({ mode: "text", text: "x".repeat(10_000) })),
		{ maximumBytes: 256 },
	);
	assert.equal(terminal.truncated, true);
	assert.ok(Buffer.byteLength(terminal.text, "utf8") <= 256);
	assert.match(terminal.text, /truncated/);

	const structuredTerminal = renderWorkflowOutcome(
		outcome(
			succeeded({
				mode: "structured",
				value: { answer: "😀".repeat(10_000) },
			}),
		),
		{ maximumBytes: 256 },
	);
	assert.equal(structuredTerminal.truncated, true);
	assert.ok(Buffer.byteLength(structuredTerminal.text, "utf8") <= 256);
	assert.match(structuredTerminal.text, /truncated/);

	const project = createWorkflowProgressProjector({ maximumMessageBytes: 64 });
	const events: WorkflowEventV1[] = [
		{
			type: "workflow_started",
			runId: "run-render",
			sequence: 1,
			workflowId: "renderTest",
		},
		{
			type: "leaf_started",
			runId: "run-render",
			sequence: 2,
			identity: {
				runId: "run-render",
				nodeId: "step:only",
				stepId: "only",
			},
			agent: "reviewer",
		},
		{
			type: "leaf_progress",
			runId: "run-render",
			sequence: 3,
			identity: {
				runId: "run-render",
				nodeId: "step:only",
				stepId: "only",
			},
			message: "progress ".repeat(20),
		},
		{
			type: "leaf_terminal",
			runId: "run-render",
			sequence: 4,
			outcome: succeeded({ mode: "text", text: "done" }),
		},
	];
	let snapshot;
	for (const event of events) snapshot = project(event);
	assert.deepEqual(
		{
			activeLeaves: snapshot?.activeLeaves,
			completedLeaves: snapshot?.completedLeaves,
			latestNodeId: snapshot?.latestNodeId,
		},
		{ activeLeaves: 0, completedLeaves: 1, latestNodeId: "step:only" },
	);
	assert.ok(Buffer.byteLength(snapshot?.message ?? "", "utf8") <= 64);
});
