import { types as utilTypes } from "node:util";

import type { JsonValue, SchemaV1 } from "./types.ts";

const encoder = new TextEncoder();
const forbiddenNames = new Set(["__proto__", "prototype", "constructor"]);

export class JsonBoundaryError extends Error {
	constructor(path: string, reason: string) {
		super(`Workflow definition error at ${path}: ${reason}`);
		this.name = "WorkflowDefinitionError";
	}
}

function childPath(path: string, key: string): string {
	return /^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(key)
		? `${path}.${key}`
		: `${path}[${JSON.stringify(key)}]`;
}

function reject(path: string, reason: string): never {
	throw new JsonBoundaryError(path, reason);
}

function hasUnpairedSurrogate(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (!Number.isFinite(next) || next < 0xdc00 || next > 0xdfff) return true;
			index += 1;
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			return true;
		}
	}
	return false;
}

export function utf8Bytes(value: string): number {
	return encoder.encode(value).byteLength;
}

export function assertSafeString(value: string, path: string): void {
	if (hasUnpairedSurrogate(value))
		reject(path, "string contains an unpaired surrogate");
}

const rootDefinitionDepth = 1;

export interface SafeJsonCloneLimits {
	readonly maximumBytes: number;
	readonly maximumDepth: number;
	readonly maximumEntries: number;
	readonly subject: string;
	readonly sizeLabel: string;
	readonly rejectProxies?: boolean;
}

const definitionCloneLimits: SafeJsonCloneLimits = {
	maximumBytes: 256 * 1024,
	maximumDepth: 32,
	maximumEntries: 20_000,
	subject: "definition",
	sizeLabel: "256 KiB",
};

interface CloneState {
	bytes: number;
	entries: number;
	readonly active: WeakSet<object>;
	readonly limits: SafeJsonCloneLimits;
}

function addBytes(state: CloneState, bytes: number): void {
	state.bytes += bytes;
	if (state.bytes > state.limits.maximumBytes) {
		reject(
			"$",
			`canonical ${state.limits.subject} size exceeds ${state.limits.sizeLabel}`,
		);
	}
}

function addJsonStringBytes(state: CloneState, value: string): void {
	addBytes(state, 1);
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (
			code === 0x22 ||
			code === 0x5c ||
			code === 0x08 ||
			code === 0x09 ||
			code === 0x0a ||
			code === 0x0c ||
			code === 0x0d
		) {
			addBytes(state, 2);
		} else if (code <= 0x1f || (code >= 0xd800 && code <= 0xdfff)) {
			if (code >= 0xd800 && code <= 0xdbff) {
				const next = value.charCodeAt(index + 1);
				if (next >= 0xdc00 && next <= 0xdfff) {
					addBytes(state, 4);
					index += 1;
					continue;
				}
			}
			addBytes(state, 6);
		} else if (code <= 0x7f) {
			addBytes(state, 1);
		} else if (code <= 0x7ff) {
			addBytes(state, 2);
		} else {
			addBytes(state, 3);
		}
	}
	addBytes(state, 1);
}

export function cloneSafeJson(
	input: unknown,
	limits: SafeJsonCloneLimits = definitionCloneLimits,
): JsonValue {
	const state: CloneState = {
		bytes: 0,
		entries: 0,
		active: new WeakSet<object>(),
		limits,
	};

	const visit = (value: unknown, path: string, depth: number): JsonValue => {
		if (depth > limits.maximumDepth) {
			reject(
				path,
				`${limits.subject} nesting depth exceeds ${limits.maximumDepth}`,
			);
		}
		if (value === null) {
			addBytes(state, 4);
			return value;
		}
		if (typeof value === "boolean") {
			addBytes(state, value ? 4 : 5);
			return value;
		}
		if (typeof value === "string") {
			assertSafeString(value, path);
			addJsonStringBytes(state, value);
			return value;
		}
		if (typeof value === "number") {
			if (!Number.isFinite(value)) reject(path, "number must be finite");
			const normalized = Object.is(value, -0) ? 0 : value;
			addBytes(state, JSON.stringify(normalized).length);
			return normalized;
		}
		if (typeof value !== "object") {
			reject(path, `${typeof value} is not a JSON value`);
		}

		const object = value as object;
		if (state.limits.rejectProxies && utilTypes.isProxy(object))
			reject(path, "proxy values are not allowed");
		if (state.active.has(object)) reject(path, "cyclic values are not allowed");
		state.active.add(object);
		try {
			let prototype: object | null;
			let keys: (string | symbol)[];
			try {
				prototype = Object.getPrototypeOf(object) as object | null;
				keys = Reflect.ownKeys(object);
			} catch {
				reject(path, "object cannot be safely inspected");
			}

			if (Array.isArray(object)) {
				if (prototype !== Array.prototype)
					reject(path, "array must use Array.prototype");
				let lengthDescriptor: PropertyDescriptor | undefined;
				try {
					lengthDescriptor = Object.getOwnPropertyDescriptor(object, "length");
				} catch {
					reject(path, "array length cannot be safely inspected");
				}
				if (
					lengthDescriptor === undefined ||
					!("value" in lengthDescriptor) ||
					typeof lengthDescriptor.value !== "number" ||
					!Number.isInteger(lengthDescriptor.value) ||
					lengthDescriptor.value < 0 ||
					lengthDescriptor.value > 0xffff_ffff
				) {
					reject(
						`${path}.length`,
						"array length must be an own numeric data property",
					);
				}
				const length = lengthDescriptor.value;
				const output: JsonValue[] = [];
				addBytes(state, 1);
				for (const key of keys) {
					if (typeof key === "symbol")
						reject(path, "symbol properties are not allowed");
					assertSafeString(key, path);
					if (key === "length") continue;
					if (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= length) {
						reject(childPath(path, key), "array has an unexpected property");
					}
				}
				for (let index = 0; index < length; index += 1) {
					const descriptor = Object.getOwnPropertyDescriptor(
						object,
						String(index),
					);
					if (descriptor === undefined)
						reject(`${path}[${index}]`, "sparse arrays are not allowed");
					if (!("value" in descriptor) || !descriptor.enumerable) {
						reject(
							`${path}[${index}]`,
							"array entries must be enumerable data properties",
						);
					}
					state.entries += 1;
					if (state.entries > limits.maximumEntries) {
						reject(
							path,
							`${limits.subject} entries exceed ${limits.maximumEntries}`,
						);
					}
					if (index > 0) addBytes(state, 1);
					output.push(visit(descriptor.value, `${path}[${index}]`, depth + 1));
				}
				addBytes(state, 1);
				return output;
			}

			if (prototype !== Object.prototype && prototype !== null) {
				reject(path, "object must be plain or have a null prototype");
			}
			const output: Record<string, JsonValue> = {};
			addBytes(state, 1);
			let entryIndex = 0;
			for (const key of keys) {
				if (typeof key === "symbol")
					reject(path, "symbol properties are not allowed");
				assertSafeString(key, path);
				let descriptor: PropertyDescriptor | undefined;
				try {
					descriptor = Object.getOwnPropertyDescriptor(object, key);
				} catch {
					reject(childPath(path, key), "property cannot be safely inspected");
				}
				if (
					descriptor === undefined ||
					!("value" in descriptor) ||
					!descriptor.enumerable
				) {
					reject(
						childPath(path, key),
						"object properties must be enumerable data properties",
					);
				}
				state.entries += 1;
				if (state.entries > limits.maximumEntries) {
					reject(
						path,
						`${limits.subject} entries exceed ${limits.maximumEntries}`,
					);
				}
				if (entryIndex > 0) addBytes(state, 1);
				addJsonStringBytes(state, key);
				addBytes(state, 1);
				entryIndex += 1;
				Object.defineProperty(output, key, {
					value: visit(descriptor.value, childPath(path, key), depth + 1),
					enumerable: true,
					configurable: true,
					writable: true,
				});
			}
			addBytes(state, 1);
			return output;
		} catch (error) {
			if (error instanceof JsonBoundaryError) throw error;
			reject(path, "object cannot be safely inspected");
		} finally {
			state.active.delete(object);
		}
	};

	return visit(input, "$", rootDefinitionDepth);
}

function compareCodePoints(left: string, right: string): number {
	const a = Array.from(left, (value) => value.codePointAt(0) ?? 0);
	const b = Array.from(right, (value) => value.codePointAt(0) ?? 0);
	for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
		if (a[index] !== b[index]) return (a[index] ?? 0) - (b[index] ?? 0);
	}
	return a.length - b.length;
}

function utf8BytesUpTo(value: string, maximumBytes: number): number {
	let bytes = 0;
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code <= 0x7f) bytes += 1;
		else if (code <= 0x7ff) bytes += 2;
		else if (
			code >= 0xd800 &&
			code <= 0xdbff &&
			index + 1 < value.length &&
			value.charCodeAt(index + 1) >= 0xdc00 &&
			value.charCodeAt(index + 1) <= 0xdfff
		) {
			bytes += 4;
			index += 1;
		} else bytes += 3;
		if (bytes > maximumBytes) return bytes;
	}
	return bytes;
}

class BoundedCanonicalSink {
	private bytes = 0;
	private readonly parts: string[] = [];
	private readonly maximumBytes: number;

	constructor(maximumBytes: number) {
		this.maximumBytes = maximumBytes;
	}

	append(value: string): boolean {
		const bytes = utf8BytesUpTo(value, this.maximumBytes - this.bytes);
		if (this.bytes + bytes > this.maximumBytes) return false;
		this.bytes += bytes;
		this.parts.push(value);
		return true;
	}

	finish(): string {
		return this.parts.join("");
	}
}

function appendCanonicalString(
	value: string,
	sink: BoundedCanonicalSink,
): boolean {
	if (!sink.append('"')) return false;
	let chunkStart = 0;
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		let escaped: string | undefined;
		if (code === 0x22) escaped = '\\"';
		else if (code === 0x5c) escaped = "\\\\";
		else if (code === 0x08) escaped = "\\b";
		else if (code === 0x09) escaped = "\\t";
		else if (code === 0x0a) escaped = "\\n";
		else if (code === 0x0c) escaped = "\\f";
		else if (code === 0x0d) escaped = "\\r";
		else if (code <= 0x1f) escaped = `\\u${code.toString(16).padStart(4, "0")}`;
		if (escaped !== undefined) {
			if (chunkStart < index && !sink.append(value.slice(chunkStart, index)))
				return false;
			if (!sink.append(escaped)) return false;
			chunkStart = index + 1;
		} else if (
			index - chunkStart >= 4095 &&
			!(
				code >= 0xd800 &&
				code <= 0xdbff &&
				index + 1 < value.length &&
				value.charCodeAt(index + 1) >= 0xdc00 &&
				value.charCodeAt(index + 1) <= 0xdfff
			)
		) {
			if (!sink.append(value.slice(chunkStart, index + 1))) return false;
			chunkStart = index + 1;
		}
	}
	return (
		(chunkStart >= value.length || sink.append(value.slice(chunkStart))) &&
		sink.append('"')
	);
}

function appendCanonical(
	value: JsonValue,
	sink: BoundedCanonicalSink,
): boolean {
	if (
		value === null ||
		typeof value === "boolean" ||
		typeof value === "number"
	) {
		return sink.append(JSON.stringify(value));
	}
	if (typeof value === "string") return appendCanonicalString(value, sink);
	if (Array.isArray(value)) {
		if (!sink.append("[")) return false;
		for (let index = 0; index < value.length; index += 1) {
			if (index > 0 && !sink.append(",")) return false;
			if (!appendCanonical(value[index] as JsonValue, sink)) return false;
		}
		return sink.append("]");
	}
	if (!sink.append("{")) return false;
	const keys = Object.keys(value).sort(compareCodePoints);
	for (let index = 0; index < keys.length; index += 1) {
		const key = keys[index]!;
		if (index > 0 && !sink.append(",")) return false;
		if (!appendCanonicalString(key, sink) || !sink.append(":")) return false;
		if (!appendCanonical(value[key] as JsonValue, sink)) return false;
	}
	return sink.append("}");
}

export function boundedCanonicalJson(
	value: JsonValue,
	maximumBytes: number,
): string | undefined {
	const sink = new BoundedCanonicalSink(maximumBytes);
	return appendCanonical(value, sink) ? sink.finish() : undefined;
}

export function canonicalJson(value: JsonValue): string {
	const serialized = boundedCanonicalJson(value, Number.MAX_SAFE_INTEGER);
	if (serialized === undefined) throw new Error("canonical JSON size overflow");
	return serialized;
}

export function isForbiddenName(name: string): boolean {
	return forbiddenNames.has(name);
}

function validateArrayValue(
	schema: Extract<SchemaV1, { type: "array" }>,
	value: JsonValue,
	path: string,
): string | undefined {
	if (!Array.isArray(value)) return `${path}: expected array`;
	if (schema.minItems !== undefined && value.length < schema.minItems)
		return `${path}: array has too few items`;
	if (value.length > schema.maxItems) return `${path}: array has too many items`;
	for (let index = 0; index < value.length; index += 1) {
		const issue = validateJsonValue(
			schema.items,
			value[index] as JsonValue,
			`${path}[${index}]`,
		);
		if (issue !== undefined) return issue;
	}
	return undefined;
}

function validateObjectValue(
	schema: Extract<SchemaV1, { type: "object" }>,
	value: JsonValue,
	path: string,
): string | undefined {
	if (value === null || Array.isArray(value) || typeof value !== "object")
		return `${path}: expected object`;
	const keys = Object.keys(value);
	for (const required of schema.required) {
		if (!Object.hasOwn(value, required))
			return `${path}: missing required property ${required}`;
	}
	for (const key of keys) {
		const propertySchema = schema.properties[key];
		if (propertySchema === undefined) return `${path}: unknown property ${key}`;
		const issue = validateJsonValue(
			propertySchema,
			value[key] as JsonValue,
			childPath(path, key),
		);
		if (issue !== undefined) return issue;
	}
	return undefined;
}

export function validateJsonValue(
	schema: SchemaV1,
	value: JsonValue,
	path = "$",
): string | undefined {
	switch (schema.type) {
		case "string":
			if (typeof value !== "string") return `${path}: expected string`;
			if (
				schema.minLength !== undefined &&
				Array.from(value).length < schema.minLength
			)
				return `${path}: string is too short`;
			if (
				schema.maxLength !== undefined &&
				Array.from(value).length > schema.maxLength
			)
				return `${path}: string is too long`;
			if (schema.enum !== undefined && !schema.enum.includes(value))
				return `${path}: value is not in enum`;
			return undefined;
		case "number":
		case "integer":
			if (
				typeof value !== "number" ||
				(schema.type === "integer" && !Number.isSafeInteger(value))
			)
				return `${path}: expected ${schema.type}`;
			if (schema.minimum !== undefined && value < schema.minimum)
				return `${path}: number is below minimum`;
			if (schema.maximum !== undefined && value > schema.maximum)
				return `${path}: number is above maximum`;
			if (schema.enum !== undefined && !schema.enum.includes(value))
				return `${path}: value is not in enum`;
			return undefined;
		case "boolean":
			return typeof value === "boolean"
				? undefined
				: `${path}: expected boolean`;
		case "null":
			return value === null ? undefined : `${path}: expected null`;
		case "array":
			return validateArrayValue(schema, value, path);
		case "object":
			return validateObjectValue(schema, value, path);
	}
}

export function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		for (const child of Object.values(value)) deepFreeze(child);
		Object.freeze(value);
	}
	return value;
}
