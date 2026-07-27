import { execFile } from "node:child_process";
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


const WINDOWS_ACL_TIMEOUT_MS = 10_000;
const WINDOWS_ACL_MAX_BUFFER_BYTES = 64 * 1024;
const windowsAclScript = String.raw`
$ErrorActionPreference = 'Stop'
$path = $env:PI_SUBAGENTS_WORKFLOWS_ACL_PATH
$acl = [System.IO.Directory]::GetAccessControl($path)
$acl.SetAccessRuleProtection($true, $false)
$existingRules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
foreach ($rule in @($existingRules)) {
  [void]$acl.RemoveAccessRuleSpecific($rule)
}
$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$systemSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$administratorsSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
$propagation = [System.Security.AccessControl.PropagationFlags]::None
$allow = [System.Security.AccessControl.AccessControlType]::Allow
$fullControl = [System.Security.AccessControl.FileSystemRights]::FullControl
$acl.SetOwner($currentSid)
foreach ($sid in @($currentSid, $systemSid, $administratorsSid)) {
  [void]$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid, $fullControl, $inheritance, $propagation, $allow))
}
[System.IO.Directory]::SetAccessControl($path, $acl)
$verified = [System.IO.Directory]::GetAccessControl($path)
if (-not $verified.AreAccessRulesProtected) {
  throw 'Windows audit DACL inheritance remains enabled'
}
$verifiedOwner = $verified.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
if ($verifiedOwner -ne $currentSid.Value) {
  throw 'Windows audit directory owner is not the current user'
}
$expected = @{}
foreach ($sid in @($currentSid, $systemSid, $administratorsSid)) {
  $expected[$sid.Value] = $false
}
$verifiedRules = $verified.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
if ($verifiedRules.Count -ne $expected.Count) {
  throw 'Windows audit DACL has an unexpected rule count'
}
foreach ($rule in @($verifiedRules)) {
  $sid = $rule.IdentityReference.Value
  if ($rule.IsInherited) {
    throw 'Windows audit DACL contains an inherited rule'
  }
  if ($rule.AccessControlType -ne $allow) {
    throw 'Windows audit DACL contains a deny rule'
  }
  if (-not $expected.ContainsKey($sid)) {
    throw 'Windows audit DACL contains an unexpected principal'
  }
  if ($rule.FileSystemRights -ne $fullControl) {
    throw 'Windows audit DACL principal does not have exact full control'
  }
  if ($rule.InheritanceFlags -ne $inheritance) {
    throw 'Windows audit DACL rule has unexpected inheritance flags'
  }
  if ($rule.PropagationFlags -ne $propagation) {
    throw 'Windows audit DACL rule has unexpected propagation flags'
  }
  if ($expected[$sid]) {
    throw 'Windows audit DACL contains a duplicate principal'
  }
  $expected[$sid] = $true
}
foreach ($sid in @($expected.Keys)) {
  if (-not $expected[$sid]) {
    throw 'Windows audit DACL is missing a required principal'
  }
}
`;

export async function secureWindowsDirectoryAcl(path: string): Promise<void> {
	if (process.platform !== "win32") return;
	const absolute = absolutePath(path);
	assertBoundedSafeText(absolute, "Windows ACL path", 4096);
	const before = await inspectPathWithoutLinks(absolute);
	const target = before.components.at(-1)?.stats;
	if (!before.exists || !target?.isDirectory())
		throw new Error("Windows ACL target must be an existing safe directory");

	const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
	assertBoundedSafeText(systemRoot, "Windows system root", 4096);
	if (!isAbsolute(systemRoot))
		throw new Error("Windows system root must be absolute");
	const executable = resolve(
		systemRoot,
		"System32",
		"WindowsPowerShell",
		"v1.0",
		"powershell.exe",
	);
	const executableInspection = await inspectPathWithoutLinks(executable);
	if (
		!executableInspection.exists ||
		!executableInspection.components.at(-1)?.stats.isFile()
	)
		throw new Error("trusted Windows PowerShell executable is unavailable");

	const environment: NodeJS.ProcessEnv = {
		SystemRoot: systemRoot,
		WINDIR: systemRoot,
		PI_SUBAGENTS_WORKFLOWS_ACL_PATH: absolute,
	};
	for (const name of ["ComSpec", "TEMP", "TMP"] as const) {
		const value = process.env[name];
		if (value !== undefined) environment[name] = value;
	}
	await new Promise<void>((resolvePromise, rejectPromise) => {
		execFile(
			executable,
			[
				"-NoLogo",
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				windowsAclScript,
			],
			{
				encoding: "utf8",
				env: environment,
				maxBuffer: WINDOWS_ACL_MAX_BUFFER_BYTES,
				timeout: WINDOWS_ACL_TIMEOUT_MS,
				windowsHide: true,
			},
			(error) => {
				if (error) {
					rejectPromise(
						new Error("failed to establish restrictive Windows audit ACL", {
							cause: error,
						}),
					);
					return;
				}
				resolvePromise();
			},
		);
	});
	const after = await inspectPathWithoutLinks(absolute);
	if (!after.exists)
		throw new Error("Windows ACL target disappeared during hardening");
	assertSameSnapshots(before.components, after.components);
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
