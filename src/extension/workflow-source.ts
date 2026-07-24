import { createHash } from "node:crypto";
import { opendir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { canonicalJson, cloneSafeJson } from "../ir/json.ts";
import { parseWorkflowDefinition } from "../ir/index.ts";
import type { JsonValue, WorkflowDefinitionV1 } from "../ir/index.ts";
import { parseStrictJson } from "./strict-json.ts";
import {
	absolutePath,
	assertBoundedSafeText,
	inspectPathWithoutLinks,
	readBoundedRegularFile,
} from "./safe-filesystem.ts";

export const MAX_WORKFLOW_SOURCE_BYTES = 1024 * 1024;
const maximumPathCodeUnits = 4096;
const savedNamePattern = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const resolvedDefinitions = new WeakSet<object>();

export type WorkflowDefinitionSourceV1 =
	| { readonly kind: "inline"; readonly definition: unknown }
	| { readonly kind: "saved"; readonly name: string }
	| { readonly kind: "path"; readonly path: string };

export interface ResolvedWorkflowDefinitionV1 {
	readonly definition: WorkflowDefinitionV1;
	readonly sourceKind: "inline" | "saved-user" | "saved-project" | "path";
	readonly displaySource: string;
	readonly canonicalPath?: string;
	readonly sourceText: string;
	readonly sourceByteLength: number;
	readonly sha256: string;
}

export interface SavedWorkflowDefinitionV1 {
	readonly name: string;
	readonly user: boolean;
	readonly project: boolean;
	readonly ambiguous: boolean;
}

export interface WorkflowSourceTestHooks {
	readonly afterOpen?: (path: string) => void | Promise<void>;
	readonly afterRead?: (path: string) => void | Promise<void>;
}

export interface ResolveWorkflowDefinitionOptions {
	readonly cwd: string;
	readonly agentDir: string;
	readonly allowPath: boolean;
	/** Deterministic TOCTOU seam for unit tests; production callers omit it. */
	readonly testHooks?: WorkflowSourceTestHooks;
}

function isRecord(value: JsonValue): value is { [key: string]: JsonValue } {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function strictSource(source: unknown): {
	readonly kind: string;
	readonly value: { [key: string]: JsonValue };
} {
	const cloned = cloneSafeJson(source, {
		maximumBytes: MAX_WORKFLOW_SOURCE_BYTES,
		maximumDepth: 34,
		maximumEntries: 20_010,
		subject: "workflow source selector",
		sizeLabel: "1 MiB",
		rejectProxies: true,
	});
	if (!isRecord(cloned) || typeof cloned.kind !== "string") {
		throw new Error("workflow source must be a discriminated JSON object");
	}
	let allowed: ReadonlySet<string>;
	if (cloned.kind === "inline") allowed = new Set(["kind", "definition"]);
	else if (cloned.kind === "saved") allowed = new Set(["kind", "name"]);
	else if (cloned.kind === "path") allowed = new Set(["kind", "path"]);
	else throw new Error(`unknown workflow source kind: ${cloned.kind}`);
	for (const key of Object.keys(cloned)) {
		if (!allowed.has(key)) throw new Error(`unknown source field: ${key}`);
	}
	for (const key of allowed) {
		if (!Object.hasOwn(cloned, key))
			throw new Error(`missing source field: ${key}`);
	}
	return { kind: cloned.kind, value: cloned };
}

function hash(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function displayPath(path: string): string {
	const characters = [...path];
	return characters.length <= 512
		? path
		: `…${characters.slice(-511).join("")}`;
}

export function isResolvedWorkflowDefinition(
	value: unknown,
): value is ResolvedWorkflowDefinitionV1 {
	return (
		typeof value === "object" &&
		value !== null &&
		resolvedDefinitions.has(value)
	);
}

function resolved(
	definition: WorkflowDefinitionV1,
	sourceKind: ResolvedWorkflowDefinitionV1["sourceKind"],
	displaySource: string,
	sourceText: string,
	bytes: Uint8Array,
	canonicalPath?: string,
): ResolvedWorkflowDefinitionV1 {
	const value = Object.freeze({
		definition,
		sourceKind,
		displaySource,
		...(canonicalPath === undefined ? {} : { canonicalPath }),
		sourceText,
		sourceByteLength: bytes.byteLength,
		sha256: hash(bytes),
	});
	resolvedDefinitions.add(value);
	return value;
}

function parseFileText(bytes: Buffer): {
	readonly definition: WorkflowDefinitionV1;
	readonly text: string;
} {
	if (
		bytes.length >= 3 &&
		bytes[0] === 0xef &&
		bytes[1] === 0xbb &&
		bytes[2] === 0xbf
	) {
		throw new Error("workflow source UTF-8 BOM is not allowed");
	}
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new Error("workflow source must be strict UTF-8");
	}
	if (text.charCodeAt(0) === 0xfeff)
		throw new Error("workflow source BOM is not allowed");
	const input = parseStrictJson(text, "workflow source");
	return { definition: parseWorkflowDefinition(input), text };
}

async function readFileSource(
	path: string,
	sourceKind: Exclude<ResolvedWorkflowDefinitionV1["sourceKind"], "inline">,
	displaySource: string,
	hooks?: WorkflowSourceTestHooks,
): Promise<ResolvedWorkflowDefinitionV1> {
	if (!path.endsWith(".workflow.json"))
		throw new Error("workflow source path must end in .workflow.json");
	const read = await readBoundedRegularFile(
		path,
		MAX_WORKFLOW_SOURCE_BYTES,
		hooks,
	);
	const parsed = parseFileText(read.bytes);
	return resolved(
		parsed.definition,
		sourceKind,
		displaySource,
		parsed.text,
		read.bytes,
		read.canonicalPath,
	);
}

async function candidateExists(path: string): Promise<boolean> {
	const inspected = await inspectPathWithoutLinks(path);
	return inspected.exists;
}

async function savedNamesAt(root: string): Promise<Set<string>> {
	const inspected = await inspectPathWithoutLinks(root);
	if (!inspected.exists) return new Set();
	if (!inspected.components.at(-1)?.stats.isDirectory())
		throw new Error(`saved workflow root is not a directory: ${root}`);
	const names = new Set<string>();
	let entries = 0;
	for await (const entry of await opendir(root)) {
		entries += 1;
		if (entries > 10_000)
			throw new Error("saved workflow root exceeds 10,000 entries");
		if (!entry.name.endsWith(".workflow.json")) continue;
		const name = entry.name.slice(0, -".workflow.json".length);
		if (!savedNamePattern.test(name) || name === "." || name === "..") continue;
		if (entry.isSymbolicLink() || !entry.isFile())
			throw new Error(
				`saved workflow entry is not a regular no-link file: ${entry.name}`,
			);
		const candidate = await inspectPathWithoutLinks(join(root, entry.name));
		if (!candidate.exists || !candidate.components.at(-1)?.stats.isFile())
			throw new Error(
				`saved workflow entry changed during listing: ${entry.name}`,
			);
		names.add(name);
	}
	return names;
}

export async function listSavedWorkflowDefinitions(options: {
	readonly cwd: string;
	readonly agentDir: string;
}): Promise<readonly SavedWorkflowDefinitionV1[]> {
	assertBoundedSafeText(options.cwd, "cwd", maximumPathCodeUnits);
	assertBoundedSafeText(
		options.agentDir,
		"agent directory",
		maximumPathCodeUnits,
	);
	const userRoot = join(
		absolutePath(options.agentDir),
		"pi-subagents-workflows",
		"definitions",
	);
	const projectRoot = join(absolutePath(options.cwd), ".pi", "workflows");
	const [userNames, projectNames] = await Promise.all([
		savedNamesAt(userRoot),
		savedNamesAt(projectRoot),
	]);
	const names = [...new Set([...userNames, ...projectNames])].sort(
		(left, right) => {
			if (left < right) return -1;
			if (left > right) return 1;
			return 0;
		},
	);
	return Object.freeze(
		names.map((name) => {
			const user = userNames.has(name);
			const project = projectNames.has(name);
			return Object.freeze({ name, user, project, ambiguous: user && project });
		}),
	);
}

export async function resolveWorkflowDefinition(
	source: unknown,
	options: ResolveWorkflowDefinitionOptions,
): Promise<ResolvedWorkflowDefinitionV1> {
	assertBoundedSafeText(options.cwd, "cwd", maximumPathCodeUnits);
	assertBoundedSafeText(
		options.agentDir,
		"agent directory",
		maximumPathCodeUnits,
	);
	if (typeof options.allowPath !== "boolean")
		throw new Error("allowPath must be a boolean capability");
	const cwd = absolutePath(options.cwd);
	const agentDir = absolutePath(options.agentDir);
	const selector = strictSource(source);

	if (selector.kind === "inline") {
		const input = selector.value.definition;
		const definition = parseWorkflowDefinition(input);
		const safelyClonedInput = cloneSafeJson(input);
		const sourceText = canonicalJson(safelyClonedInput);
		const bytes = Buffer.from(sourceText, "utf8");
		return resolved(
			definition,
			"inline",
			"inline workflow definition",
			sourceText,
			bytes,
		);
	}

	if (selector.kind === "saved") {
		const name = selector.value.name;
		if (
			typeof name !== "string" ||
			!savedNamePattern.test(name) ||
			name === "." ||
			name === ".."
		) {
			throw new Error(
				"saved workflow name must match [a-z0-9][a-z0-9._-]{0,127}",
			);
		}
		const userPath = join(
			agentDir,
			"pi-subagents-workflows",
			"definitions",
			`${name}.workflow.json`,
		);
		const projectPath = join(cwd, ".pi", "workflows", `${name}.workflow.json`);
		const [userExists, projectExists] = await Promise.all([
			candidateExists(userPath),
			candidateExists(projectPath),
		]);
		if (userExists && projectExists) {
			throw new Error(
				`ambiguous saved workflow ${name}: both user and project definitions exist`,
			);
		}
		if (!userExists && !projectExists)
			throw new Error(`saved workflow not found: ${name}`);
		const selected = userExists
			? await readFileSource(
					userPath,
					"saved-user",
					`saved user workflow: ${name}`,
					options.testHooks,
				)
			: await readFileSource(
					projectPath,
					"saved-project",
					`saved project workflow: ${name}`,
					options.testHooks,
				);
		const [userStillExists, projectStillExists] = await Promise.all([
			candidateExists(userPath),
			candidateExists(projectPath),
		]);
		if (userStillExists && projectStillExists)
			throw new Error(
				`ambiguous saved workflow ${name}: both user and project definitions exist`,
			);
		if (
			(userExists && !userStillExists) ||
			(projectExists && !projectStillExists)
		)
			throw new Error(`saved workflow ${name} changed during resolution`);
		return selected;
	}

	if (!options.allowPath)
		throw new Error(
			"path sources are not allowed for this invocation capability",
		);
	const path = selector.value.path;
	assertBoundedSafeText(
		path,
		"workflow source path text",
		maximumPathCodeUnits,
	);
	const absolute = resolve(cwd, path);
	return readFileSource(absolute, "path", displayPath(path), options.testHooks);
}
