import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

import type { WorkflowUsageV1 } from "../engine/index.ts";

export type PiNestedUsage = NonNullable<AgentToolResult<unknown>["usage"]>;

function checkedTokenSubtotal(usage: WorkflowUsageV1): number {
	let subtotal = 0;
	for (const field of [
		"input",
		"output",
		"cacheRead",
		"cacheWrite",
	] as const) {
		const value = usage[field];
		if (!Number.isSafeInteger(value) || value < 0)
			throw new TypeError(`workflow usage ${field} must be a nonnegative safe integer`);
		if (value > Number.MAX_SAFE_INTEGER - subtotal)
			throw new TypeError("workflow usage token subtotal must be a safe integer");
		subtotal += value;
	}
	return subtotal;
}

/** Map aggregate workflow usage into Pi's nested-tool accounting shape. */
export function toPiUsage(usage: WorkflowUsageV1): PiNestedUsage {
	const totalTokens = checkedTokenSubtotal(usage);
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		totalTokens,
		cost: {
			// The provider gives the workflow only an aggregate cost, not category splits.
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: usage.cost,
		},
	};
}
