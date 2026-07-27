import assert from "node:assert/strict";
import {
	chmodSync,
	copyFileSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

const marker = "PACKED_REAL_PROVIDER_WORKFLOW_OK";
const workRoot = process.env.PI_WORKFLOWS_E2E_ROOT;
const consumerExtension = process.env.PI_WORKFLOWS_E2E_CONSUMER_EXTENSION;
const providerExtension = process.env.PI_WORKFLOWS_E2E_PROVIDER_EXTENSION;
const childSource = process.env.PI_WORKFLOWS_E2E_CHILD_SOURCE;
if (!workRoot || !consumerExtension || !providerExtension || !childSource)
	throw new Error("the packed workflow E2E environment is incomplete");

const fixtureRoot = dirname(fileURLToPath(import.meta.url));
const cwd = join(workRoot, "project");
const agentDir = join(workRoot, "agent");
const fakePiRoot = join(fixtureRoot, "fake-pi-package");
const childCli = join(fakePiRoot, "dist", "cli.mjs");
mkdirSync(join(cwd, ".pi", "agents"), { recursive: true, mode: 0o700 });
mkdirSync(agentDir, { recursive: true, mode: 0o700 });
mkdirSync(join(fakePiRoot, "dist"), { recursive: true, mode: 0o700 });
copyFileSync(childSource, childCli);
chmodSync(childCli, 0o755);
writeFileSync(
	join(fakePiRoot, "package.json"),
	JSON.stringify({
		name: "@earendil-works/pi-coding-agent",
		type: "module",
		bin: { pi: "dist/cli.mjs" },
	}),
);
writeFileSync(
	join(cwd, ".pi", "agents", "worker.md"),
	`---
name: worker
description: Deterministic packed workflow E2E worker
tools: read
completionGuard: false
---
Return the requested marker exactly.
`,
);

const definition = {
	version: 1,
	id: "packedRealProvider",
	args: {},
	limits: { concurrency: 1, maxCalls: 1, maxItems: 1 },
	steps: [
		{
			type: "agent",
			id: "child",
			agent: "worker",
			prompt: { template: "Return the deterministic marker.", values: {} },
			output: { mode: "text" },
			limits: { timeoutMs: 30_000, maxTurns: 2, maxToolCalls: 0 },
		},
	],
	result: { ref: "step", stepId: "child" },
};

function contentText(content) {
	if (!Array.isArray(content)) return "";
	return content
		.map((part) =>
			part && typeof part === "object" && part.type === "text"
				? String(part.text ?? "")
				: "",
		)
		.join("");
}

function workflowToolResult(messages) {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role === "toolResult" && message.toolName === "pi_workflow")
			return message;
	}
	return undefined;
}

function collectNamedFiles(root, name, output = []) {
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) collectNamedFiles(path, name, output);
		else if (entry.isFile() && entry.name === name) output.push(path);
	}
	return output;
}

const previous = new Map(
	[
		"HOME",
		"USERPROFILE",
		"PI_CODING_AGENT_DIR",
		"PI_SUBAGENT_PI_BINARY",
		"PI_SUBAGENT_CHILD",
		"PI_SUBAGENT_FANOUT_CHILD",
		"PI_SUBAGENT_DEPTH",
		"PI_SUBAGENT_MAX_DEPTH",
		"PI_SUBAGENT_PARENT_SESSION",
		"PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT",
		"PI_WORKFLOWS_E2E_CHILD_MARKER",
	].map((name) => [name, process.env[name]]),
);
const previousArgv1 = process.argv[1];
let session;
try {
	process.env.HOME = agentDir;
	process.env.USERPROFILE = agentDir;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_WORKFLOWS_E2E_CHILD_MARKER = marker;
	delete process.env.PI_SUBAGENT_PI_BINARY;
	delete process.env.PI_SUBAGENT_CHILD;
	delete process.env.PI_SUBAGENT_FANOUT_CHILD;
	delete process.env.PI_SUBAGENT_DEPTH;
	delete process.env.PI_SUBAGENT_MAX_DEPTH;
	delete process.env.PI_SUBAGENT_PARENT_SESSION;
	delete process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT;
	process.argv[1] = childCli;

	const provider = fauxProvider({
		provider: "workflow-e2e-parent",
		models: [{ id: "parent", contextWindow: 200_000 }],
	});
	const respond = (context) => {
		const toolResult = workflowToolResult(context.messages);
		if (toolResult === undefined) {
			assert.ok(
				(context.tools ?? []).some((tool) => tool.name === "pi_workflow"),
				"packed workflow extension did not register pi_workflow",
			);
			assert.ok(
				(context.tools ?? []).some((tool) => tool.name === "subagent"),
				"packed provider extension did not register subagent",
			);
			return fauxAssistantMessage(
				fauxToolCall(
					"pi_workflow",
					{
						source: { kind: "inline", definition },
						args: {},
					},
					{ id: "packed-real-workflow-call" },
				),
				{ stopReason: "toolUse" },
			);
		}
		const text = contentText(toolResult.content);
		return fauxAssistantMessage(
			fauxText(text.includes(marker) ? `Parent observed ${marker}` : "MARKER_MISSING"),
			{ stopReason: "stop" },
		);
	};
	provider.setResponses(Array.from({ length: 4 }, () => respond));
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: null,
		allowModelNetwork: false,
	});
	modelRuntime.registerProvider(provider.provider.id, {
		name: provider.provider.name,
		api: provider.api,
		apiKey: "faux",
		streamSimple: provider.provider.streamSimple,
		models: [...provider.models],
	});
	const model = modelRuntime.getModel(provider.provider.id, "parent");
	if (!model) throw new Error("faux parent model was not registered");
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false },
	});
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		additionalExtensionPaths: [providerExtension, consumerExtension],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt:
			"Call pi_workflow exactly once, then report whether its result contains the marker.",
	});
	await loader.reload();
	const sessionManager = SessionManager.inMemory(cwd);
	const created = await createAgentSession({
		cwd,
		agentDir,
		model,
		modelRuntime,
		resourceLoader: loader,
		sessionManager,
		settingsManager,
	});
	session = created.session;
	await session.bindExtensions({});
	let promptTimer;
	try {
		await Promise.race([
			session.prompt("Run the packed workflow E2E.", {
				expandPromptTemplates: false,
			}),
			new Promise((_, reject) => {
				promptTimer = setTimeout(
					() => reject(new Error("packed real-provider workflow E2E timed out")),
					60_000,
				);
			}),
		]);
	} finally {
		if (promptTimer !== undefined) clearTimeout(promptTimer);
	}

	const workflowResults = session.messages.filter(
		(message) => message?.role === "toolResult" && message.toolName === "pi_workflow",
	);
	assert.equal(workflowResults.length, 1);
	const result = workflowToolResult(session.messages);
	assert.ok(result, "parent session did not record a pi_workflow tool result");
	assert.match(contentText(result.content), new RegExp(marker));
	assert.equal(result.isError, false);
	assert.equal(result.details?.terminal?.status, "succeeded");
	assert.equal(result.details?.pointer?.runId, result.details?.terminal?.runId);
	assert.equal(JSON.stringify(result.details).includes(marker), false);
	assert.match(session.getLastAssistantText() ?? "", new RegExp(marker));

	const pointerEntries = sessionManager
		.getBranch()
		.filter(
			(entry) =>
				entry.type === "custom" &&
				entry.customType === "pi-subagents-workflows.run",
		);
	assert.equal(pointerEntries.length, 2);
	assert.equal(pointerEntries[0]?.data?.phase, "started");
	assert.equal(pointerEntries[1]?.data?.phase, "terminal");
	assert.equal(pointerEntries[1]?.data?.status, "succeeded");

	const auditRoot = join(agentDir, "pi-subagents-workflows", "runs");
	const results = collectNamedFiles(auditRoot, "result.json");
	assert.equal(results.length, 1);
	const storedResult = JSON.parse(readFileSync(results[0], "utf8"));
	assert.equal(storedResult.terminal?.status, "succeeded");
	assert.equal(storedResult.terminal?.runId, result.details.terminal.runId);
	assert.equal(collectNamedFiles(auditRoot, "journal.jsonl").length, 1);

	await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	process.stdout.write(
		JSON.stringify({
			status: "ok",
			marker,
			runId: result.details.terminal.runId,
			modelCalls: provider.state.callCount,
		}) + "\n",
	);
} finally {
	try {
		session?.dispose();
	} catch {}
	for (const [name, value] of previous) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	if (previousArgv1 === undefined) delete process.argv[1];
	else process.argv[1] = previousArgv1;
	if (process.env.PI_WORKFLOWS_E2E_KEEP !== "1")
		rmSync(workRoot, { recursive: true, force: true });
}
