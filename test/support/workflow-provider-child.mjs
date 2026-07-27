#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

function readText(path) {
	return readFileSync(path, "utf8");
}

function parseArguments(argv) {
	const parsed = {
		extensions: [],
		appendSystemPrompts: [],
		tools: undefined,
		noSkills: false,
		prompt: "",
	};
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--extension") {
			const path = argv[index + 1];
			if (path) parsed.extensions.push(path);
			index += 1;
			continue;
		}
		if (argument === "--tools") {
			parsed.tools = (argv[index + 1] ?? "")
				.split(",")
				.map((value) => value.trim())
				.filter(Boolean);
			index += 1;
			continue;
		}
		if (argument === "--no-tools") {
			parsed.tools = [];
			continue;
		}
		if (argument === "--no-skills") {
			parsed.noSkills = true;
			continue;
		}
		if (argument === "--system-prompt") {
			const path = argv[index + 1];
			if (path) parsed.systemPrompt = readText(path);
			index += 1;
			continue;
		}
		if (argument === "--append-system-prompt") {
			const path = argv[index + 1];
			if (path) parsed.appendSystemPrompts.push(readText(path));
			index += 1;
			continue;
		}
		if (
			argument === "--mode" ||
			argument === "--model" ||
			argument === "--session" ||
			argument === "--session-dir"
		) {
			index += 1;
			continue;
		}
		if (
			argument === "-p" ||
			argument === "--print" ||
			argument === "--no-session" ||
			argument === "--no-extensions"
		)
			continue;
		if (argument?.startsWith("--")) continue;
		parsed.prompt = argument ?? "";
	}
	if (parsed.prompt.startsWith("@")) parsed.prompt = readText(parsed.prompt.slice(1));
	return parsed;
}

async function main() {
	const parsed = parseArguments(process.argv.slice(2));
	const cwd = process.cwd();
	const agentDir = process.env.PI_CODING_AGENT_DIR;
	if (!agentDir) throw new Error("PI_CODING_AGENT_DIR is required by the E2E child");
	const marker = process.env.PI_WORKFLOWS_E2E_CHILD_MARKER ?? "WORKFLOW_CHILD_OK";
	const provider = fauxProvider({
		provider: "workflow-e2e-child",
		models: [{ id: "child", contextWindow: 200_000 }],
	});
	provider.setResponses([
		() => fauxAssistantMessage(fauxText(marker), { stopReason: "stop" }),
	]);
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
	const model = modelRuntime.getModel(provider.provider.id, "child");
	if (!model) throw new Error("faux child model was not registered");
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false },
	});
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		additionalExtensionPaths: parsed.extensions,
		noSkills: parsed.noSkills,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: parsed.systemPrompt,
		appendSystemPrompt: parsed.appendSystemPrompts,
	});
	await loader.reload();
	const created = await createAgentSession({
		cwd,
		agentDir,
		model,
		modelRuntime,
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager,
		...(parsed.tools === undefined ? {} : { tools: parsed.tools }),
	});
	const session = created.session;
	session.subscribe((event) => {
		if (
			event.type === "message_end" ||
			event.type === "tool_execution_start" ||
			event.type === "tool_execution_end" ||
			event.type === "tool_result_end"
		)
			process.stdout.write(`${JSON.stringify(event)}\n`);
	});
	try {
		await session.bindExtensions({});
		await session.prompt(parsed.prompt, { expandPromptTemplates: false });
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	} finally {
		session.dispose();
	}
}

main().catch((error) => {
	process.stderr.write(
		`${error instanceof Error ? error.stack || error.message : String(error)}\n`,
	);
	process.exitCode = 1;
});
