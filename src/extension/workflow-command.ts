import { assertBoundedSafeText } from "./safe-filesystem.ts";
import { parseStrictJson } from "./strict-json.ts";
import type { WorkflowDefinitionSourceV1 } from "./workflow-source.ts";

const MAXIMUM_COMMAND_CODE_UNITS = 64 * 1024;

export type WorkflowCommandV1 =
	| {
			readonly action: "run";
			readonly source: Extract<
				WorkflowDefinitionSourceV1,
				{ readonly kind: "saved" | "path" }
			>;
			readonly args: Readonly<Record<string, unknown>>;
	  }
	| { readonly action: "list" }
	| { readonly action: "status"; readonly runId?: string }
	| { readonly action: "cancel"; readonly runId: string };

interface ScannedPrefix {
	readonly tokens: readonly string[];
	readonly argsText?: string;
}

function scanPrefix(input: string): ScannedPrefix {
	if (input.length > MAXIMUM_COMMAND_CODE_UNITS)
		throw new Error("workflow command exceeds 64 KiB");
	const tokens: string[] = [];
	let index = 0;
	while (index < input.length) {
		while (index < input.length && /\s/u.test(input[index] ?? "")) index += 1;
		if (index >= input.length) break;
		let word = "";
		let quote: "'" | '"' | undefined;
		let quoted = false;
		while (index < input.length) {
			const character = input[index] ?? "";
			if (quote !== undefined) {
				if (character === quote) {
					quote = undefined;
					quoted = true;
					index += 1;
					continue;
				}
				if (character === "\\" && quote === '"') {
					index += 1;
					if (index >= input.length)
						throw new Error("workflow command has a trailing escape");
					word += input[index] ?? "";
					index += 1;
					continue;
				}
				word += character;
				index += 1;
				continue;
			}
			if (character === "'" || character === '"') {
				quote = character;
				index += 1;
				continue;
			}
			if (/\s/u.test(character)) break;
			if (character === "\\") {
				index += 1;
				if (index >= input.length)
					throw new Error("workflow command has a trailing escape");
				word += input[index] ?? "";
				index += 1;
				continue;
			}
			word += character;
			index += 1;
		}
		if (quote !== undefined)
			throw new Error("workflow command contains an unterminated quote");
		if (word.length === 0 && !quoted)
			throw new Error("workflow command contains an empty token");
		if (word === "--args" && !quoted) {
			const argsText = input.slice(index).trim();
			if (argsText.length === 0)
				throw new Error("--args requires a strict JSON object");
			return { tokens, argsText };
		}
		tokens.push(word);
		if (tokens.length > 4)
			throw new Error("workflow command has too many arguments");
	}
	return { tokens };
}

function parseArgs(
	text: string | undefined,
): Readonly<Record<string, unknown>> {
	if (text === undefined) return {};
	const parsed = parseStrictJson(text, "workflow command arguments");
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		Array.isArray(parsed) ||
		Object.getPrototypeOf(parsed) !== Object.prototype
	)
		throw new Error("workflow command arguments must be a JSON object");
	return parsed as Record<string, unknown>;
}

function safeRunId(value: string): string {
	assertBoundedSafeText(value, "workflow run ID", 128);
	return value;
}

export function parseWorkflowCommand(input: string): WorkflowCommandV1 {
	assertBoundedSafeText(input, "workflow command", MAXIMUM_COMMAND_CODE_UNITS, {
		allowEmpty: false,
	});
	const { tokens, argsText } = scanPrefix(input.trim());
	const [action, option, value] = tokens;
	if (action === "list" && tokens.length === 1 && argsText === undefined)
		return { action: "list" };
	if (action === "status" && argsText === undefined) {
		if (tokens.length === 1) return { action: "status" };
		if (tokens.length === 2 && option !== undefined)
			return { action: "status", runId: safeRunId(option) };
	}
	if (
		action === "cancel" &&
		tokens.length === 2 &&
		option !== undefined &&
		argsText === undefined
	)
		return { action: "cancel", runId: safeRunId(option) };
	if (action === "run" && tokens.length === 3 && value !== undefined) {
		if (option === "--name") {
			assertBoundedSafeText(value, "saved workflow name", 128);
			return {
				action: "run",
				source: { kind: "saved", name: value },
				args: parseArgs(argsText),
			};
		}
		if (option === "--path") {
			assertBoundedSafeText(value, "workflow path", 4096);
			if (!value.endsWith(".workflow.json"))
				throw new Error("workflow path must end with .workflow.json");
			return {
				action: "run",
				source: { kind: "path", path: value },
				args: parseArgs(argsText),
			};
		}
	}
	throw new Error(
		"usage: /pi-workflow run (--name <name> | --path <path>) [--args <JSON-object>] | list | status [runId] | cancel <runId>",
	);
}
