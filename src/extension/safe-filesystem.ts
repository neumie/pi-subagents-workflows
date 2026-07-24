import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { isAbsolute, parse, resolve, sep } from "node:path";

const unsafeTextPattern =
	/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

export interface PathComponentSnapshot {
	readonly path: string;
	readonly stats: BigIntStats;
}

export function assertBoundedSafeText(
	value: unknown,
	label: string,
	maximumCodeUnits: number,
	options: { readonly allowEmpty?: boolean } = {},
): asserts value is string {
	if (
		typeof value !== "string" ||
		(options.allowEmpty !== true && value.length === 0) ||
		value.length > maximumCodeUnits ||
		unsafeTextPattern.test(value) ||
		/[\ud800-\udfff]/u.test(value)
	) {
		throw new Error(`${label} must be bounded safe text`);
	}
}

export function absolutePath(path: string, base?: string): string {
	return isAbsolute(path)
		? resolve(path)
		: resolve(base ?? process.cwd(), path);
}

function components(path: string): string[] {
	const absolute = absolutePath(path);
	const root = parse(absolute).root;
	const remainder = absolute.slice(root.length);
	const names =
		remainder.length === 0 ? [] : remainder.split(sep).filter(Boolean);
	const output = [root];
	let current = root;
	for (const name of names) {
		current = resolve(current, name);
		output.push(current);
	}
	return output;
}

function byteLimitLabel(maximumBytes: number): string {
	return maximumBytes % (1024 * 1024) === 0
		? `${maximumBytes / (1024 * 1024)} MiB (${maximumBytes} bytes)`
		: `${maximumBytes} bytes`;
}

function isMissing(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "ENOENT"
	);
}

export async function inspectPathWithoutLinks(
	path: string,
): Promise<{
	readonly exists: boolean;
	readonly components: readonly PathComponentSnapshot[];
}> {
	const snapshots: PathComponentSnapshot[] = [];
	for (const component of components(path)) {
		let stats: BigIntStats;
		try {
			stats = await lstat(component, { bigint: true });
		} catch (error) {
			if (isMissing(error)) return { exists: false, components: snapshots };
			throw error;
		}
		if (stats.isSymbolicLink()) {
			throw new Error(
				`unsafe symbolic link or reparse-point path component: ${component}`,
			);
		}
		snapshots.push({ path: component, stats });
	}
	return { exists: true, components: snapshots };
}

export function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
	return (
		left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
	);
}

export function sameStableStats(
	left: BigIntStats,
	right: BigIntStats,
): boolean {
	return (
		sameIdentity(left, right) &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs
	);
}

export function assertSameSnapshots(
	before: readonly PathComponentSnapshot[],
	after: readonly PathComponentSnapshot[],
): void {
	if (before.length !== after.length)
		throw new Error("path changed during filesystem operation");
	for (let index = 0; index < before.length; index += 1) {
		const prior = before[index];
		const later = after[index];
		if (
			prior === undefined ||
			later === undefined ||
			prior.path !== later.path ||
			!sameIdentity(prior.stats, later.stats)
		) {
			throw new Error(
				"path component identity changed during filesystem operation",
			);
		}
	}
}

export async function ensureSafeDirectory(path: string): Promise<void> {
	const absolute = absolutePath(path);
	const root = parse(absolute).root;
	const names = absolute.slice(root.length).split(sep).filter(Boolean);
	let current = root;
	for (const name of names) {
		current = resolve(current, name);
		try {
			const stats = await lstat(current, { bigint: true });
			if (stats.isSymbolicLink())
				throw new Error(
					`unsafe symbolic link or reparse-point directory: ${current}`,
				);
			if (!stats.isDirectory())
				throw new Error(`store path component is not a directory: ${current}`);
		} catch (error) {
			if (!isMissing(error)) throw error;
			await mkdir(current, { mode: 0o700 });
			const stats = await lstat(current, { bigint: true });
			if (stats.isSymbolicLink() || !stats.isDirectory())
				throw new Error(`unsafe created store directory: ${current}`);
		}
	}
}

export async function readBoundedRegularFile(
	path: string,
	maximumBytes: number,
	hooks: {
		readonly afterOpen?: (path: string) => void | Promise<void>;
		readonly afterRead?: (path: string) => void | Promise<void>;
	} = {},
): Promise<{
	readonly bytes: Buffer;
	readonly canonicalPath: string;
	readonly stats: BigIntStats;
}> {
	if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0)
		throw new Error("maximum file size must be a nonnegative safe integer");
	const absolute = absolutePath(path);
	const before = await inspectPathWithoutLinks(absolute);
	if (!before.exists)
		throw new Error(`workflow source file not found: ${absolute}`);
	const pathStats = before.components.at(-1)?.stats;
	if (pathStats === undefined || !pathStats.isFile())
		throw new Error("workflow source must be a regular file");
	if (pathStats.size > BigInt(maximumBytes))
		throw new Error(`regular file exceeds ${byteLimitLabel(maximumBytes)}`);
	const canonicalBefore = await realpath(absolute);
	const noFollow =
		typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
	const handle = await open(absolute, constants.O_RDONLY | noFollow);
	try {
		const opened = await handle.stat({ bigint: true });
		if (!opened.isFile())
			throw new Error("workflow source must be a regular file");
		if (!sameIdentity(pathStats, opened))
			throw new Error("workflow source was replaced before open");
		if (opened.size > BigInt(maximumBytes))
			throw new Error(`regular file exceeds ${byteLimitLabel(maximumBytes)}`);
		await hooks.afterOpen?.(absolute);

		const chunks: Buffer[] = [];
		let total = 0;
		while (true) {
			const chunk = Buffer.allocUnsafe(
				Math.min(64 * 1024, maximumBytes + 1 - total),
			);
			const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
			if (bytesRead === 0) break;
			total += bytesRead;
			if (total > maximumBytes)
				throw new Error(
					`regular file grew beyond ${byteLimitLabel(maximumBytes)} while reading`,
				);
			chunks.push(chunk.subarray(0, bytesRead));
		}
		const bytes = Buffer.concat(chunks, total);
		await hooks.afterRead?.(absolute);

		const openedAfter = await handle.stat({ bigint: true });
		const after = await inspectPathWithoutLinks(absolute);
		if (!after.exists)
			throw new Error(
				"workflow source path was replaced or removed during read",
			);
		const pathAfter = after.components.at(-1)?.stats;
		if (pathAfter === undefined || !pathAfter.isFile())
			throw new Error("workflow source path changed during read");
		assertSameSnapshots(before.components, after.components);
		if (
			!sameStableStats(opened, openedAfter) ||
			!sameStableStats(pathStats, pathAfter)
		) {
			throw new Error(
				"workflow source changed, grew, or was truncated during read",
			);
		}
		if (
			!sameIdentity(openedAfter, pathAfter) ||
			openedAfter.size !== BigInt(total)
		) {
			throw new Error("workflow source identity or length changed during read");
		}
		const canonicalAfter = await realpath(absolute);
		if (canonicalBefore !== canonicalAfter)
			throw new Error("workflow source canonical path changed during read");
		return { bytes, canonicalPath: canonicalAfter, stats: openedAfter };
	} finally {
		await handle.close();
	}
}
