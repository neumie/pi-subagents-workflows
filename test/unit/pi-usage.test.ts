import assert from "node:assert/strict";
import { test } from "node:test";

import { toPiUsage } from "../../src/extension/pi-usage.ts";

test("workflow usage maps exactly to Pi nested usage without invented cost splits", () => {
	assert.deepEqual(
		toPiUsage({
			input: 11,
			output: 13,
			cacheRead: 17,
			cacheWrite: 19,
			cost: 1.25,
			turns: 3,
			toolCalls: 4,
			durationMs: 50,
		}),
		{
			input: 11,
			output: 13,
			cacheRead: 17,
			cacheWrite: 19,
			totalTokens: 60,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 1.25,
			},
		},
	);
});

test("Pi nested usage rejects an unsafe token subtotal", () => {
	assert.throws(
		() =>
			toPiUsage({
				input: Number.MAX_SAFE_INTEGER,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
				turns: 0,
				toolCalls: 0,
				durationMs: 0,
			}),
		/token subtotal.*safe integer/i,
	);
});
