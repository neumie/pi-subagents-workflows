import { types as utilTypes } from "node:util";

const MAX_ERROR_BYTES = 1024;
const unavailableErrors = new WeakSet<object>();

function boundedMessage(message: string): string {
	if (Buffer.byteLength(message, "utf8") <= MAX_ERROR_BYTES) return message;
	const characters: string[] = [];
	let usedBytes = 0;
	for (const character of message) {
		const characterBytes = Buffer.byteLength(character, "utf8");
		if (usedBytes + characterBytes > MAX_ERROR_BYTES - 3) break;
		characters.push(character);
		usedBytes += characterBytes;
	}
	return `${characters.join("")}...`;
}

export function safeErrorMessage(error: unknown, fallback: string): string {
	if (typeof error === "string") return boundedMessage(error);
	if (typeof error !== "object" || error === null || utilTypes.isProxy(error))
		return fallback;
	try {
		const descriptor = Object.getOwnPropertyDescriptor(error, "message");
		return descriptor &&
			"value" in descriptor &&
			typeof descriptor.value === "string"
			? boundedMessage(descriptor.value)
			: fallback;
	} catch {
		return fallback;
	}
}

export function isPiSubagentsV2UnavailableError(
	error: unknown,
): error is PiSubagentsV2UnavailableError {
	return (
		typeof error === "object" && error !== null && unavailableErrors.has(error)
	);
}

export class PiSubagentsV2UnavailableError extends Error {
	constructor(message: string = "pi-subagents delegation V2 is unavailable") {
		super(
			boundedMessage(
				typeof message === "string"
					? message
					: "pi-subagents delegation V2 is unavailable",
			),
		);
		this.name = "PiSubagentsV2UnavailableError";
		unavailableErrors.add(this);
	}
}
