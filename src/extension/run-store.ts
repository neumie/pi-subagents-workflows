import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { link, lstat, mkdir, open, opendir, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";

import type { WorkflowEventV1, WorkflowOutcomeV1 } from "../engine/index.ts";
import { canonicalJson, cloneSafeJson, validateJsonValue } from "../ir/json.ts";
import { parseWorkflowDefinition } from "../ir/index.ts";
import type { JsonValue, WorkflowDefinitionV1 } from "../ir/index.ts";
import { PACKAGE_VERSION } from "../version.ts";
import {
	decodeWorkflowEvent,
	projectWorkflowTerminal,
	type AuditCloneLimits,
	type WorkflowRunTerminalV1,
} from "./audit-codec.ts";
import {
	absolutePath,
	assertBoundedSafeText,
	assertSameSnapshots,
	ensureSafeDirectory,
	inspectPathWithoutLinks,
	secureWindowsDirectoryAcl,
	readBoundedRegularFile,
	sameIdentity,
	sameStableStats,
} from "./safe-filesystem.ts";
import type { PathComponentSnapshot } from "./safe-filesystem.ts";
import { decodeStrictUtf8Json } from "./strict-json.ts";
import {
	isResolvedWorkflowDefinition,
	type ResolvedWorkflowDefinitionV1,
} from "./workflow-source.ts";

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const noFollow =
	typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
const MIB = 1024 * 1024;
const MAX_SOURCE_BYTES = MIB;
const MAX_MANIFEST_BYTES = MIB;
const MAX_JOURNAL_EVENT_BYTES = 4 * MIB;
const MAX_JOURNAL_FILE_BYTES = 512 * MIB;
/**
 * Complete outcomes may repeat the selected step/group in `result.outcome`.
 * This ceiling covers the engine's 64 MiB retained payload budget, JSON escaping,
 * duplicated final projections, bounded provider metadata, and structural overhead.
 */
export const MAX_WORKFLOW_RESULT_FILE_BYTES = MIB;

const argumentLimits = {
	maximumBytes: MIB,
	maximumDepth: 32,
	maximumEntries: 20_000,
	sizeLabel: "1 MiB",
} as const;
const eventLimits: AuditCloneLimits = {
	maximumBytes: MAX_JOURNAL_EVENT_BYTES,
	maximumDepth: 64,
	maximumEntries: 100_000,
	sizeLabel: "4 MiB",
};
export interface WorkflowRunStoreTestHooks {
	readonly beforePublish?: (
		name: string,
		destination: string,
		temporary: string,
	) => void | Promise<void>;
	readonly afterJournalWrite?: (journalPath: string) => void | Promise<void>;
}

export interface CreateWorkflowRunStoreOptions {
	readonly agentDir: string;
	readonly sessionId: string;
	/** Deterministic filesystem-race seams for tests; production callers omit them. */
	readonly testHooks?: WorkflowRunStoreTestHooks;
}

export interface BeginWorkflowRunV1 {
	readonly event: Extract<
		WorkflowEventV1,
		{ readonly type: "workflow_started" }
	>;
	readonly source: ResolvedWorkflowDefinitionV1;
	readonly args: unknown;
	readonly invocation: "tool" | "command";
	readonly toolCallId?: string;
	readonly cwd: string;
}

export interface WorkflowRunManifestV1 {
	readonly version: 1;
	readonly runId: string;
	readonly workflowId: string;
	readonly sessionKey: string;
	readonly invocation: "tool" | "command";
	readonly toolCallId?: string;
	readonly cwd: string;
	readonly sourceKind: ResolvedWorkflowDefinitionV1["sourceKind"];
	readonly displaySource: string;
	readonly canonicalPath?: string;
	readonly sourceSha256: string;
	readonly packageVersion: string;
	readonly irVersion: 1;
	readonly executionMode: "foreground-only";
	readonly replayPolicy: "disabled";
}

export interface WorkflowRunInspectionV1 {
	readonly sessionKey: string;
	readonly relativeLocator: string;
	readonly runId: string;
	readonly workflowId: string;
	readonly invocation: "tool" | "command";
	readonly sourceKind: ResolvedWorkflowDefinitionV1["sourceKind"];
	readonly displaySource: string;
	readonly sourceSha256: string;
	readonly status: string;
	readonly running: false;
	readonly resumable: false;
	readonly resultPresent: boolean;
}

export interface WorkflowRunStore {
	readonly sessionKey: string;
	readonly runDirectory: string | undefined;
	beginRun(input: BeginWorkflowRunV1): Promise<void>;
	appendEvent(event: WorkflowEventV1): Promise<void>;
	finishRun(runId: string, outcome: WorkflowOutcomeV1): Promise<void>;
	close(): Promise<void>;
}

type JsonObject = { [key: string]: JsonValue };
type WorkflowTerminalEvent = Extract<
	WorkflowEventV1,
	{ readonly type: "workflow_terminal" }
>;

function assertTerminalAgreement(
	event: WorkflowTerminalEvent,
	terminal: WorkflowRunTerminalV1,
	label: string,
): void {
	const eventProjection = {
		status: event.status,
		error: event.error ?? null,
	};
	const resultProjection = {
		status: terminal.status,
		error: terminal.error ?? null,
	};
	if (
		canonicalJson(eventProjection as unknown as JsonValue) !==
		canonicalJson(resultProjection as unknown as JsonValue)
	)
		throw new Error(`${label} disagrees with workflow_terminal`);
}

function isRecord(value: unknown): value is JsonObject {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
	value: JsonObject,
	required: readonly string[],
	optional: readonly string[] = [],
): void {
	const allowed = new Set([...required, ...optional]);
	for (const key of Object.keys(value))
		if (!allowed.has(key))
			throw new Error(`unknown ${key} in stored audit value`);
	for (const key of required)
		if (!Object.hasOwn(value, key))
			throw new Error(`missing ${key} in stored audit value`);
}

function assertIdentifier(
	value: unknown,
	label: string,
): asserts value is string {
	if (typeof value !== "string" || !identifierPattern.test(value))
		throw new Error(`${label} must be a directory-safe identifier`);
}

function safeText(
	value: JsonValue | undefined,
	label: string,
	maximum = 4096,
): string {
	assertBoundedSafeText(value, label, maximum);
	return value;
}

function cloneValidatedArgs(
	definition: WorkflowDefinitionV1,
	args: unknown,
): Record<string, JsonValue> {
	const cloned = cloneSafeJson(args, {
		...argumentLimits,
		subject: "invocation arguments",
		rejectProxies: true,
	});
	if (!isRecord(cloned))
		throw new Error("invocation arguments must be a plain JSON object");
	for (const name of Object.keys(definition.args))
		if (!Object.hasOwn(cloned, name))
			throw new Error(`missing declared argument ${name}`);
	for (const name of Object.keys(cloned))
		if (!Object.hasOwn(definition.args, name))
			throw new Error(`unknown invocation argument ${name}`);
	for (const [name, schema] of Object.entries(definition.args)) {
		const argument = cloned[name];
		if (argument === undefined)
			throw new Error(`missing declared argument ${name}`);
		const issue = validateJsonValue(schema, argument, `$.${name}`);
		if (issue !== undefined) throw new Error(issue);
	}
	return cloned;
}

async function fsyncDirectory(path: string): Promise<void> {
	let handle: FileHandle | undefined;
	try {
		handle = await open(path, constants.O_RDONLY | noFollow);
		await handle.sync();
	} catch (error) {
		const code =
			typeof error === "object" && error !== null && "code" in error
				? (error as { code?: unknown }).code
				: undefined;
		const unsupportedOnWindows =
			process.platform === "win32" &&
			(code === "EINVAL" ||
				code === "ENOTSUP" ||
				code === "EISDIR" ||
				code === "EPERM");
		if (!unsupportedOnWindows) throw error;
	} finally {
		await handle?.close();
	}
}

function samePublishedContent(left: BigIntStats, right: BigIntStats): boolean {
	return (
		sameIdentity(left, right) &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs
	);
}

async function atomicWriteNew(
	directory: string,
	name: string,
	content: string | Uint8Array,
	hooks?: WorkflowRunStoreTestHooks,
): Promise<void> {
	const destination = join(directory, name);
	const temporary = join(directory, `.tmp-${randomUUID()}`);
	const handle = await open(
		temporary,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
		0o600,
	);
	let published = false;
	let publicationValid = false;
	let closed = false;
	try {
		await handle.writeFile(content);
		await handle.sync();
		const written = await handle.stat({ bigint: true });
		await hooks?.beforePublish?.(name, destination, temporary);
		const temporaryStats = await lstat(temporary, { bigint: true });
		if (!temporaryStats.isFile() || !sameStableStats(written, temporaryStats))
			throw new Error(`${name} temporary file was replaced before publication`);
		// Same-directory hard-link publication is atomic and fails with EEXIST.
		await link(temporary, destination);
		published = true;
		const destinationStats = await lstat(destination, { bigint: true });
		if (
			!destinationStats.isFile() ||
			!samePublishedContent(written, destinationStats)
		)
			throw new Error(`${name} publication identity is invalid`);
		publicationValid = true;
		await handle.close();
		closed = true;
		await rm(temporary);
		await fsyncDirectory(directory);
	} catch (error) {
		if (!closed) await handle.close().catch(() => undefined);
		await rm(temporary, { force: true }).catch(() => undefined);
		if (published && !publicationValid)
			await rm(destination, { force: true }).catch(() => undefined);
		throw error;
	}
}

function sessionKeyFor(sessionId: string): string {
	return createHash("sha256").update(sessionId, "utf8").digest("hex");
}

function validateManifest(
	input: unknown,
	expected: { readonly sessionKey: string; readonly runId: string },
): WorkflowRunManifestV1 {
	const cloned = cloneSafeJson(input, {
		...argumentLimits,
		subject: "run manifest",
		rejectProxies: true,
	});
	if (!isRecord(cloned))
		throw new Error("stored workflow manifest must be an object");
	exactKeys(
		cloned,
		[
			"version",
			"runId",
			"workflowId",
			"sessionKey",
			"invocation",
			"cwd",
			"sourceKind",
			"displaySource",
			"sourceSha256",
			"packageVersion",
			"irVersion",
			"executionMode",
			"replayPolicy",
		],
		["toolCallId", "canonicalPath"],
	);
	if (cloned.version !== 1 || cloned.irVersion !== 1)
		throw new Error("stored workflow manifest version is invalid");
	assertIdentifier(cloned.runId, "manifest run ID");
	assertIdentifier(cloned.workflowId, "manifest workflow ID");
	if (
		cloned.runId !== expected.runId ||
		cloned.sessionKey !== expected.sessionKey
	)
		throw new Error("stored workflow manifest identity is invalid");
	if (cloned.invocation !== "tool" && cloned.invocation !== "command")
		throw new Error("stored workflow manifest invocation is invalid");
	if (
		cloned.sourceKind !== "inline" &&
		cloned.sourceKind !== "saved-user" &&
		cloned.sourceKind !== "saved-project" &&
		cloned.sourceKind !== "path"
	)
		throw new Error("stored workflow manifest source kind is invalid");
	safeText(cloned.sessionKey, "manifest session key", 64);
	safeText(cloned.cwd, "manifest cwd");
	safeText(cloned.displaySource, "manifest display source", 1024);
	if (cloned.canonicalPath !== undefined)
		safeText(cloned.canonicalPath, "manifest canonical path", 4096);
	if (cloned.sourceKind === "inline" && cloned.canonicalPath !== undefined)
		throw new Error(
			"stored inline workflow manifest contains a canonical path",
		);
	if (cloned.sourceKind !== "inline" && cloned.canonicalPath === undefined)
		throw new Error(
			"stored file workflow manifest is missing its canonical path",
		);
	if (cloned.toolCallId !== undefined)
		safeText(cloned.toolCallId, "manifest tool call ID", 256);
	if (cloned.invocation === "command" && cloned.toolCallId !== undefined)
		throw new Error("stored command manifest contains a tool call ID");
	if (
		typeof cloned.sourceSha256 !== "string" ||
		!sha256Pattern.test(cloned.sourceSha256)
	)
		throw new Error("stored workflow manifest source hash is invalid");
	safeText(cloned.packageVersion, "manifest package version", 64);
	if (
		cloned.executionMode !== "foreground-only" ||
		cloned.replayPolicy !== "disabled"
	)
		throw new Error("stored workflow manifest policy is invalid");
	return cloned as unknown as WorkflowRunManifestV1;
}

async function assertAuditFileUnchanged(
	path: string,
	expected: BigIntStats,
	label: string,
): Promise<void> {
	const inspected = await inspectPathWithoutLinks(path);
	const current = inspected.components.at(-1)?.stats;
	if (
		!inspected.exists ||
		current === undefined ||
		!current.isFile() ||
		!sameStableStats(expected, current)
	)
		throw new Error(`${label} changed during run inspection`);
}

async function validateJournal(
	directory: string,
	manifest: WorkflowRunManifestV1,
	terminal: WorkflowRunTerminalV1 | undefined,
): Promise<BigIntStats> {
	const path = join(directory, "journal.jsonl");
	const inspectedBefore = await inspectPathWithoutLinks(path);
	const pathStats = inspectedBefore.components.at(-1)?.stats;
	if (!inspectedBefore.exists || pathStats === undefined || !pathStats.isFile())
		throw new Error("stored workflow journal is missing or invalid");
	if (pathStats.size > BigInt(MAX_JOURNAL_FILE_BYTES))
		throw new Error("stored workflow journal exceeds 512 MiB");
	const handle = await open(path, constants.O_RDONLY | noFollow);
	let lastSequence = 0;
	let records = 0;
	let terminalEvent: WorkflowTerminalEvent | undefined;
	let stableStats: BigIntStats | undefined;
	const pieces: Buffer[] = [];
	let lineBytes = 0;
	const consumeLine = (): void => {
		if (lineBytes === 0)
			throw new Error("stored workflow journal contains an empty line");
		const line = Buffer.concat(pieces, lineBytes);
		pieces.length = 0;
		lineBytes = 0;
		const parsed = decodeStrictUtf8Json(line, "stored workflow journal record");
		if (!isRecord(parsed as JsonValue))
			throw new Error("stored workflow journal record must be an object");
		const record = parsed as JsonObject;
		exactKeys(record, ["version", "eventSequence", "event"]);
		if (record.version !== 1 || !Number.isSafeInteger(record.eventSequence))
			throw new Error(
				"stored workflow journal record version or sequence is invalid",
			);
		if (canonicalJson(record) !== line.toString("utf8"))
			throw new Error("stored workflow journal record is not canonical JSON");
		const event = decodeWorkflowEvent(record.event, eventLimits);
		if (
			record.eventSequence !== event.sequence ||
			event.runId !== manifest.runId
		)
			throw new Error("stored workflow journal record identity is invalid");
		if (event.sequence <= lastSequence)
			throw new Error(
				"stored workflow journal sequence is duplicate or out of order",
			);
		if (records === 0) {
			if (
				event.type !== "workflow_started" ||
				event.sequence !== 1 ||
				event.workflowId !== manifest.workflowId
			)
				throw new Error(
					"stored workflow journal does not start with workflow_started",
				);
		} else if (terminalEvent !== undefined) {
			throw new Error(
				"stored workflow journal contains an event after workflow_terminal",
			);
		}
		if (event.type === "leaf_progress")
			throw new Error("stored workflow journal must not persist leaf_progress");
		if (event.type === "workflow_terminal") terminalEvent = event;
		lastSequence = event.sequence;
		records += 1;
	};
	try {
		const opened = await handle.stat({ bigint: true });
		if (!sameIdentity(opened, pathStats))
			throw new Error("stored workflow journal was replaced before open");
		const buffer = Buffer.allocUnsafe(64 * 1024);
		while (true) {
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;
			let start = 0;
			for (let index = 0; index < bytesRead; index += 1) {
				if (buffer[index] !== 0x0a) continue;
				const part = buffer.subarray(start, index);
				if (part.byteLength > 0) pieces.push(Buffer.from(part));
				lineBytes += part.byteLength;
				if (lineBytes > MAX_JOURNAL_EVENT_BYTES)
					throw new Error("stored workflow journal record exceeds 4 MiB");
				consumeLine();
				start = index + 1;
			}
			if (start < bytesRead) {
				const remainder = buffer.subarray(start, bytesRead);
				pieces.push(Buffer.from(remainder));
				lineBytes += remainder.byteLength;
				if (lineBytes > MAX_JOURNAL_EVENT_BYTES)
					throw new Error("stored workflow journal record exceeds 4 MiB");
			}
		}
		if (lineBytes !== 0)
			throw new Error("stored workflow journal has a torn final line");
		if (records === 0) throw new Error("stored workflow journal is empty");
		const openedAfter = await handle.stat({ bigint: true });
		const inspectedAfter = await inspectPathWithoutLinks(path);
		const pathAfter = inspectedAfter.components.at(-1)?.stats;
		if (
			!inspectedAfter.exists ||
			pathAfter === undefined ||
			!sameStableStats(opened, openedAfter) ||
			!sameStableStats(pathStats, pathAfter) ||
			!sameIdentity(openedAfter, pathAfter)
		)
			throw new Error("stored workflow journal changed during inspection");
		stableStats = openedAfter;
	} finally {
		await handle.close();
	}
	if (terminal !== undefined) {
		if (terminalEvent === undefined)
			throw new Error(
				"stored terminal result has no workflow_terminal journal record",
			);
		assertTerminalAgreement(terminalEvent, terminal, "stored terminal result");
	}
	if (stableStats === undefined)
		throw new Error("stored workflow journal inspection did not settle");
	return stableStats;
}

function decodeResultWrapper(
	input: unknown,
	manifest: WorkflowRunManifestV1,
	definition: WorkflowDefinitionV1,
): WorkflowRunTerminalV1 {
	if (!isRecord(input as JsonValue))
		throw new Error("stored workflow result must be an object");
	const wrapper = input as JsonObject;
	exactKeys(wrapper, ["version", "terminal"]);
	if (wrapper.version !== 1)
		throw new Error("stored workflow result version is invalid");
	if (!isRecord(wrapper.terminal))
		throw new Error("stored workflow terminal must be an object");
	const terminal = wrapper.terminal;
	exactKeys(
		terminal,
		[
			"version",
			"runId",
			"workflowId",
			"status",
			"resultRef",
			"usage",
			"counters",
		],
		["error"],
	);
	const decoded = projectWorkflowTerminal(
		{
			version: terminal.version,
			runId: terminal.runId,
			workflowId: terminal.workflowId,
			status: terminal.status,
			steps: [],
			result:
				terminal.resultRef === null
					? null
					: { ref: terminal.resultRef, outcome: {} },
			usage: terminal.usage,
			counters: terminal.counters,
			...(terminal.error === undefined ? {} : { error: terminal.error }),
		},
		definition,
	);
	if (
		decoded.runId !== manifest.runId ||
		decoded.workflowId !== manifest.workflowId
	)
		throw new Error("stored workflow result identity is invalid");
	return decoded;
}

class ForegroundWorkflowRunStore implements WorkflowRunStore {
	readonly sessionKey: string;
	private readonly agentDir: string;
	private readonly hooks: WorkflowRunStoreTestHooks | undefined;
	private directoryValue: string | undefined;
	private directorySnapshot: readonly PathComponentSnapshot[] | undefined;
	private journal: FileHandle | undefined;
	private journalIdentity: BigIntStats | undefined;
	private runId: string | undefined;
	private workflowId: string | undefined;
	private definition: WorkflowDefinitionV1 | undefined;
	private nextSequence = 1;
	private tail: Promise<void> = Promise.resolve();
	private failure: unknown;
	private beginRequested = false;
	private beginSettled: Promise<void> | undefined;
	private begun = false;
	private finishRequested = false;
	private terminalEvent: WorkflowTerminalEvent | undefined;
	private closed = false;

	constructor(options: CreateWorkflowRunStoreOptions) {
		assertBoundedSafeText(options.agentDir, "agent directory", 4096);
		assertBoundedSafeText(options.sessionId, "Pi session identity", 1024);
		this.agentDir = absolutePath(options.agentDir);
		this.sessionKey = sessionKeyFor(options.sessionId);
		this.hooks = options.testHooks;
	}

	get runDirectory(): string | undefined {
		return this.directoryValue;
	}

	async beginRun(input: BeginWorkflowRunV1): Promise<void> {
		if (this.closed) throw new Error("workflow run store is closed");
		if (this.beginRequested)
			throw new Error("workflow run store already began or is beginning a run");
		this.beginRequested = true;
		let settleBegin = (): void => undefined;
		this.beginSettled = new Promise<void>((resolve) => {
			settleBegin = resolve;
		});
		try {
			if (!isResolvedWorkflowDefinition(input.source))
				throw new Error("workflow source must come from the strict resolver");
			const event = decodeWorkflowEvent(input.event, eventLimits);
			if (event.type !== "workflow_started" || event.sequence !== 1)
				throw new Error(
					"beginRun requires the engine-issued workflow_started event at sequence 1",
				);
			assertIdentifier(event.runId, "run ID");
			if (event.workflowId !== input.source.definition.id)
				throw new Error(
					"started event workflow ID does not match the resolved definition",
				);
			if (input.invocation !== "tool" && input.invocation !== "command")
				throw new Error("invocation must be tool or command");
			assertBoundedSafeText(input.cwd, "cwd", 4096);
			if (input.toolCallId !== undefined)
				assertBoundedSafeText(input.toolCallId, "tool call ID", 256);
			if (input.invocation === "command" && input.toolCallId !== undefined)
				throw new Error("command invocation cannot include a tool call ID");
			const args = cloneValidatedArgs(input.source.definition, input.args);
			const sourceBytes = Buffer.from(input.source.sourceText, "utf8");
			if (
				sourceBytes.byteLength > MAX_SOURCE_BYTES ||
				sourceBytes.byteLength !== input.source.sourceByteLength ||
				createHash("sha256").update(sourceBytes).digest("hex") !==
					input.source.sha256
			)
				throw new Error("resolved workflow source provenance is inconsistent");

			const auditRoot = join(
				this.agentDir,
				"pi-subagents-workflows",
				"runs",
			);
			await ensureSafeDirectory(auditRoot);
			await secureWindowsDirectoryAcl(auditRoot);
			const sessionRoot = join(auditRoot, this.sessionKey);
			await ensureSafeDirectory(sessionRoot);
			await secureWindowsDirectoryAcl(sessionRoot);
			const directory = join(sessionRoot, event.runId);
			const absent = await inspectPathWithoutLinks(directory);
			if (absent.exists)
				throw new Error(`run directory already exists: ${event.runId}`);
			await mkdir(directory, { mode: 0o700 });
			const created = await inspectPathWithoutLinks(directory);
			if (!created.exists || !created.components.at(-1)?.stats.isDirectory())
				throw new Error("failed to create an exclusive safe run directory");
			await secureWindowsDirectoryAcl(directory);

			this.directoryValue = directory;
			this.directorySnapshot = created.components;
			this.runId = event.runId;
			this.workflowId = event.workflowId;
			this.definition = input.source.definition;
			this.nextSequence = 2;

			const manifest: WorkflowRunManifestV1 = {
				version: 1,
				runId: event.runId,
				workflowId: event.workflowId,
				sessionKey: this.sessionKey,
				invocation: input.invocation,
				...(input.toolCallId === undefined
					? {}
					: { toolCallId: input.toolCallId }),
				cwd: input.cwd,
				sourceKind: input.source.sourceKind,
				displaySource: input.source.displaySource,
				...(input.source.canonicalPath === undefined
					? {}
					: { canonicalPath: input.source.canonicalPath }),
				sourceSha256: input.source.sha256,
				packageVersion: PACKAGE_VERSION,
				irVersion: 1,
				executionMode: "foreground-only",
				replayPolicy: "disabled",
			};

			await this.assertDirectoryIdentity();
			await atomicWriteNew(
				directory,
				"manifest.json",
				canonicalJson(manifest as unknown as JsonValue),
				this.hooks,
			);
			await this.assertDirectoryIdentity();
			await atomicWriteNew(
				directory,
				"source.workflow.json",
				sourceBytes,
				this.hooks,
			);
			await this.assertDirectoryIdentity();
			await atomicWriteNew(
				directory,
				"args.json",
				canonicalJson(args),
				this.hooks,
			);
			await this.assertDirectoryIdentity();
			const journalPath = join(directory, "journal.jsonl");
			this.journal = await open(
				journalPath,
				constants.O_WRONLY |
					constants.O_APPEND |
					constants.O_CREAT |
					constants.O_EXCL |
					noFollow,
				0o600,
			);
			this.journalIdentity = await this.journal.stat({ bigint: true });
			await this.writeJournalRecord(event);
			await fsyncDirectory(directory);
			this.begun = true;
		} catch (error) {
			await this.journal?.close().catch(() => undefined);
			this.journal = undefined;
			throw error;
		} finally {
			settleBegin();
		}
	}

	appendEvent(input: WorkflowEventV1): Promise<void> {
		if (this.closed)
			return Promise.reject(new Error("workflow run store is closed"));
		if (!this.begun || this.runId === undefined)
			return Promise.reject(new Error("workflow run store has not begun"));
		if (this.finishRequested)
			return Promise.reject(
				new Error("workflow run store is already finishing"),
			);
		if (this.terminalEvent !== undefined)
			return Promise.reject(
				new Error("workflow terminal event must be the final event"),
			);
		let event: WorkflowEventV1;
		try {
			event = decodeWorkflowEvent(input, eventLimits);
			if (event.runId !== this.runId)
				throw new Error("workflow event belongs to the wrong run");
			if (event.sequence !== this.nextSequence)
				throw new Error(
					`workflow event sequence ${event.sequence} is out of order; expected ${this.nextSequence}`,
				);
			this.nextSequence += 1;
			if (event.type === "workflow_terminal")
				this.terminalEvent = event;
		} catch (error) {
			return Promise.reject(error);
		}
		return this.enqueue(async () => {
			if (event.type !== "leaf_progress") await this.writeJournalRecord(event);
		});
	}

	finishRun(runId: string, input: WorkflowOutcomeV1): Promise<void> {
		if (this.closed)
			return Promise.reject(new Error("workflow run store is closed"));
		if (
			!this.begun ||
			this.runId === undefined ||
			this.workflowId === undefined ||
			this.definition === undefined
		)
			return Promise.reject(new Error("workflow run store has not begun"));
		if (runId !== this.runId)
			return Promise.reject(new Error("cannot finish the wrong run"));
		if (this.finishRequested)
			return Promise.reject(
				new Error("workflow run is already finishing or finished"),
			);
		let terminal: WorkflowRunTerminalV1;
		let serialized: string;
		try {
			if (this.terminalEvent === undefined)
				throw new Error(
					"workflow result requires a recorded workflow_terminal event",
				);
			terminal = projectWorkflowTerminal(input, this.definition);
			if (terminal.runId !== this.runId)
				throw new Error("workflow outcome belongs to the wrong run");
			if (terminal.workflowId !== this.workflowId)
				throw new Error("workflow outcome belongs to the wrong workflow");
			assertTerminalAgreement(
				this.terminalEvent,
				terminal,
				"workflow outcome",
			);
			serialized = canonicalJson({
				version: 1,
				terminal,
			} as unknown as JsonValue);
			if (
				Buffer.byteLength(serialized, "utf8") > MAX_WORKFLOW_RESULT_FILE_BYTES
			)
				throw new Error("workflow terminal summary exceeds 1 MiB");
		} catch (error) {
			return Promise.reject(error);
		}
		const directory = this.directoryValue;
		if (directory === undefined)
			return Promise.reject(new Error("workflow run directory is unavailable"));
		this.finishRequested = true;
		return this.enqueue(async () => {
			await this.assertDirectoryIdentity();
			await atomicWriteNew(directory, "result.json", serialized, this.hooks);
		});
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await this.beginSettled;
		await this.tail;
		let closeError: unknown;
		try {
			await this.journal?.close();
		} catch (error) {
			closeError = error;
		} finally {
			this.journal = undefined;
		}
		if (this.failure !== undefined) throw this.failure;
		if (closeError !== undefined) throw closeError;
	}

	private enqueue(operation: () => Promise<void>): Promise<void> {
		const result = this.tail.then(async () => {
			if (this.failure !== undefined) throw this.failure;
			await operation();
		});
		this.tail = result.catch((error: unknown) => {
			this.failure ??= error;
		});
		return result;
	}

	private async assertDirectoryIdentity(): Promise<void> {
		if (
			this.directoryValue === undefined ||
			this.directorySnapshot === undefined
		)
			throw new Error("workflow run directory is unavailable");
		const current = await inspectPathWithoutLinks(this.directoryValue);
		if (!current.exists) throw new Error("workflow run directory was removed");
		assertSameSnapshots(this.directorySnapshot, current.components);
	}

	private async assertJournalIdentity(): Promise<void> {
		if (
			this.journal === undefined ||
			this.journalIdentity === undefined ||
			this.directoryValue === undefined
		)
			throw new Error("workflow journal is unavailable");
		await this.assertDirectoryIdentity();
		const inspected = await inspectPathWithoutLinks(
			join(this.directoryValue, "journal.jsonl"),
		);
		if (!inspected.exists)
			throw new Error("workflow journal was removed or replaced");
		const pathIdentity = inspected.components.at(-1)?.stats;
		const openIdentity = await this.journal.stat({ bigint: true });
		if (
			pathIdentity === undefined ||
			!sameIdentity(pathIdentity, this.journalIdentity) ||
			!sameIdentity(openIdentity, this.journalIdentity)
		)
			throw new Error("workflow journal identity was replaced");
	}

	private async writeJournalRecord(event: WorkflowEventV1): Promise<void> {
		await this.assertJournalIdentity();
		const journal = this.journal;
		const directory = this.directoryValue;
		if (journal === undefined || directory === undefined)
			throw new Error("workflow journal is unavailable");
		const record = canonicalJson({
			version: 1,
			eventSequence: event.sequence,
			event,
		} as unknown as JsonValue);
		if (Buffer.byteLength(record, "utf8") > MAX_JOURNAL_EVENT_BYTES)
			throw new Error("complete workflow journal record exceeds 4 MiB");
		await journal.writeFile(`${record}\n`);
		await journal.sync();
		await this.hooks?.afterJournalWrite?.(join(directory, "journal.jsonl"));
		await this.assertJournalIdentity();
	}
}

export function createWorkflowRunStore(
	options: CreateWorkflowRunStoreOptions,
): WorkflowRunStore {
	return new ForegroundWorkflowRunStore(options);
}

function runDirectoryFor(
	options: CreateWorkflowRunStoreOptions,
	runId: string,
): {
	readonly sessionKey: string;
	readonly directory: string;
} {
	assertBoundedSafeText(options.agentDir, "agent directory", 4096);
	assertBoundedSafeText(options.sessionId, "Pi session identity", 1024);
	assertIdentifier(runId, "run ID");
	const sessionKey = sessionKeyFor(options.sessionId);
	return {
		sessionKey,
		directory: join(
			absolutePath(options.agentDir),
			"pi-subagents-workflows",
			"runs",
			sessionKey,
			runId,
		),
	};
}

export async function inspectWorkflowRun(
	options: CreateWorkflowRunStoreOptions & { readonly runId: string },
): Promise<WorkflowRunInspectionV1> {
	const { sessionKey, directory } = runDirectoryFor(options, options.runId);
	const before = await inspectPathWithoutLinks(directory);
	if (!before.exists || !before.components.at(-1)?.stats.isDirectory())
		throw new Error(`stored workflow run not found: ${options.runId}`);
	const manifestRead = await readBoundedRegularFile(
		join(directory, "manifest.json"),
		MAX_MANIFEST_BYTES,
	);
	const manifest = validateManifest(
		decodeStrictUtf8Json(manifestRead.bytes, "stored workflow manifest"),
		{ sessionKey, runId: options.runId },
	);
	const sourceRead = await readBoundedRegularFile(
		join(directory, "source.workflow.json"),
		MAX_SOURCE_BYTES,
	);
	if (
		createHash("sha256").update(sourceRead.bytes).digest("hex") !==
		manifest.sourceSha256
	)
		throw new Error("stored workflow source hash does not match its manifest");
	const definition = parseWorkflowDefinition(
		decodeStrictUtf8Json(sourceRead.bytes, "stored workflow source"),
	);
	if (definition.id !== manifest.workflowId)
		throw new Error(
			"stored workflow source does not match its manifest workflow",
		);
	const argsRead = await readBoundedRegularFile(
		join(directory, "args.json"),
		MIB,
	);
	cloneValidatedArgs(
		definition,
		decodeStrictUtf8Json(argsRead.bytes, "stored workflow arguments"),
	);
	const resultPath = join(directory, "result.json");
	const result = await inspectPathWithoutLinks(resultPath);
	let status: string;
	let resultPresent: boolean;
	let terminal: WorkflowRunTerminalV1 | undefined;
	let resultStats: BigIntStats | undefined;
	if (!result.exists) {
		status = "incomplete (not running; rerun explicitly)";
		resultPresent = false;
	} else {
		const resultRead = await readBoundedRegularFile(
			resultPath,
			MAX_WORKFLOW_RESULT_FILE_BYTES,
		);
		resultStats = resultRead.stats;
		terminal = decodeResultWrapper(
			decodeStrictUtf8Json(resultRead.bytes, "stored workflow result"),
			manifest,
			definition,
		);
		status = terminal.status;
		resultPresent = true;
	}
	const journalStats = await validateJournal(directory, manifest, terminal);
	await Promise.all([
		assertAuditFileUnchanged(
			join(directory, "manifest.json"),
			manifestRead.stats,
			"stored workflow manifest",
		),
		assertAuditFileUnchanged(
			join(directory, "source.workflow.json"),
			sourceRead.stats,
			"stored workflow source",
		),
		assertAuditFileUnchanged(
			join(directory, "args.json"),
			argsRead.stats,
			"stored workflow arguments",
		),
		assertAuditFileUnchanged(
			join(directory, "journal.jsonl"),
			journalStats,
			"stored workflow journal",
		),
		...(resultStats === undefined
			? []
			: [
					assertAuditFileUnchanged(
						resultPath,
						resultStats,
						"stored workflow result",
					),
				]),
	]);
	const resultAfter = await inspectPathWithoutLinks(resultPath);
	if (resultStats === undefined && resultAfter.exists)
		throw new Error("stored workflow result appeared during inspection");
	const after = await inspectPathWithoutLinks(directory);
	if (!after.exists)
		throw new Error("stored workflow run changed during inspection");
	assertSameSnapshots(before.components, after.components);
	return Object.freeze({
		sessionKey,
		relativeLocator: `${sessionKey}/${options.runId}`,
		runId: options.runId,
		workflowId: manifest.workflowId,
		invocation: manifest.invocation,
		sourceKind: manifest.sourceKind,
		displaySource: manifest.displaySource,
		sourceSha256: manifest.sourceSha256,
		status,
		running: false,
		resumable: false,
		resultPresent,
	});
}

export async function listWorkflowRuns(
	options: CreateWorkflowRunStoreOptions,
): Promise<readonly WorkflowRunInspectionV1[]> {
	assertBoundedSafeText(options.agentDir, "agent directory", 4096);
	assertBoundedSafeText(options.sessionId, "Pi session identity", 1024);
	const sessionKey = sessionKeyFor(options.sessionId);
	const root = join(
		absolutePath(options.agentDir),
		"pi-subagents-workflows",
		"runs",
		sessionKey,
	);
	const inspected = await inspectPathWithoutLinks(root);
	if (!inspected.exists) return Object.freeze([]);
	if (!inspected.components.at(-1)?.stats.isDirectory())
		throw new Error("stored workflow session root is not a directory");
	const runIds: string[] = [];
	let entries = 0;
	for await (const entry of await opendir(root)) {
		entries += 1;
		if (entries > 10_000)
			throw new Error("stored workflow session exceeds 10,000 entries");
		if (entry.isSymbolicLink())
			throw new Error(`stored workflow entry is a link: ${entry.name}`);
		if (!entry.isDirectory() || !identifierPattern.test(entry.name)) continue;
		runIds.push(entry.name);
	}
	runIds.sort((left, right) => {
		if (left < right) return -1;
		if (left > right) return 1;
		return 0;
	});
	const records: WorkflowRunInspectionV1[] = [];
	for (const runId of runIds)
		records.push(await inspectWorkflowRun({ ...options, runId }));
	return Object.freeze(records);
}
