import { randomUUID } from "node:crypto";

import { createJiti } from "jiti";

import type { LeafRunner } from "../engine/index.ts";
import {
	createPiSubagentsLeafAdapterCore,
	type PiSubagentsV2Contract,
} from "./pi-subagents-core.ts";
import {
	isPiSubagentsV2UnavailableError,
	PiSubagentsV2UnavailableError,
	safeErrorMessage,
} from "./pi-subagents-errors.ts";

export interface DelegationEventBus {
	on(event: string, listener: (payload: unknown) => void): () => void;
	emit(event: string, payload: unknown): void;
}

export interface PiSubagentsLeafAdapterOptions {
	readonly events: DelegationEventBus;
	readonly cwd: string;
	readonly context?: "fresh" | "fork";
}

export interface PiSubagentsLeafAdapter {
	readonly leafRunner: LeafRunner;
	dispose(): void;
}

const PROVIDER_EXPORTS = {
	version: "SUBAGENT_DELEGATION_V2_PROTOCOL_VERSION",
	requestEvent: "SUBAGENT_DELEGATION_REQUEST_EVENT",
	startedEvent: "SUBAGENT_DELEGATION_STARTED_EVENT",
	updateEvent: "SUBAGENT_DELEGATION_UPDATE_EVENT",
	responseEvent: "SUBAGENT_DELEGATION_RESPONSE_EVENT",
	cancelEvent: "SUBAGENT_DELEGATION_CANCEL_EVENT",
} as const;

function ownExport(module: unknown, name: string): unknown {
	if (typeof module !== "object" || module === null) return undefined;
	try {
		const descriptor = Object.getOwnPropertyDescriptor(module, name);
		return descriptor && "value" in descriptor ? descriptor.value : undefined;
	} catch {
		return undefined;
	}
}

function providerContract(module: unknown): PiSubagentsV2Contract {
	const values: Record<string, unknown> = {};
	for (const [field, exportName] of Object.entries(PROVIDER_EXPORTS))
		values[field] = ownExport(module, exportName);
	if (values.version !== 2)
		throw new PiSubagentsV2UnavailableError(
			"pi-subagents/delegation does not provide delegation protocol version 2",
		);
	for (const field of [
		"requestEvent",
		"startedEvent",
		"updateEvent",
		"responseEvent",
		"cancelEvent",
	] as const) {
		if (typeof values[field] !== "string" || values[field].trim().length === 0)
			throw new PiSubagentsV2UnavailableError(
				`pi-subagents/delegation has a missing or malformed ${field} export`,
			);
	}
	return values as unknown as PiSubagentsV2Contract;
}

export async function createPiSubagentsLeafAdapter(
	options: PiSubagentsLeafAdapterOptions,
): Promise<PiSubagentsLeafAdapter> {
	try {
		const jiti = createJiti(import.meta.url);
		const providerSpecifier = ["pi-subagents", "delegation"].join("/");
		const module = await jiti.import(providerSpecifier);
		return createPiSubagentsLeafAdapterCore(
			options,
			providerContract(module),
			randomUUID,
		);
	} catch (error) {
		if (isPiSubagentsV2UnavailableError(error)) throw error;
		throw new PiSubagentsV2UnavailableError(
			`could not load pi-subagents delegation V2: ${safeErrorMessage(
				error,
				"provider load failure",
			)}`,
		);
	}
}

export { PiSubagentsV2UnavailableError } from "./pi-subagents-errors.ts";
