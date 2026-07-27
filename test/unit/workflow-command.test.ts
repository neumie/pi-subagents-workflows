import assert from "node:assert/strict";
import { test } from "node:test";

import { parseWorkflowCommand } from "../../src/extension/workflow-command.ts";

test("command parser accepts exact run, list, status, and cancel forms", () => {
	assert.deepEqual(
		parseWorkflowCommand('run --name release --args {"message":"hello world"}'),
		{
			action: "run",
			source: { kind: "saved", name: "release" },
			args: { message: "hello world" },
		},
	);
	assert.deepEqual(
		parseWorkflowCommand('run --path "plans/release workflow.workflow.json"'),
		{
			action: "run",
			source: {
				kind: "path",
				path: "plans/release workflow.workflow.json",
			},
			args: {},
		},
	);
	assert.deepEqual(
		parseWorkflowCommand(
			String.raw`run --path "C:\work dir\release.workflow.json"`,
		),
		{
			action: "run",
			source: {
				kind: "path",
				path: String.raw`C:\work dir\release.workflow.json`,
			},
			args: {},
		},
	);
	assert.deepEqual(
		parseWorkflowCommand(
			String.raw`run --path "\\server\share\release.workflow.json"`,
		),
		{
			action: "run",
			source: {
				kind: "path",
				path: String.raw`\\server\share\release.workflow.json`,
			},
			args: {},
		},
	);
	assert.deepEqual(parseWorkflowCommand("list"), { action: "list" });
	assert.deepEqual(parseWorkflowCommand("status"), {
		action: "status",
	});
	assert.deepEqual(parseWorkflowCommand("status run-1"), {
		action: "status",
		runId: "run-1",
	});
	assert.deepEqual(parseWorkflowCommand("cancel run-1"), {
		action: "cancel",
		runId: "run-1",
	});
});

test("command parser rejects ambiguous, malformed, and durability-expanding forms", () => {
	for (const input of [
		"run --name a --path b.workflow.json",
		"run --name",
		"run --path a.txt",
		"run --name a --args []",
		"run --name a --args {broken",
		"run --name a --args {} --path b.workflow.json",
		"cancel",
		"cancel one two",
		"save x",
		"resume x",
		"detach x",
		"run --inline {}",
	]) {
		assert.throws(() => parseWorkflowCommand(input), Error, input);
	}
});
