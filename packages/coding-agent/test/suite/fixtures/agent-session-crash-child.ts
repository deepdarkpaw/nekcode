import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { ENV_AGENT_DIR } from "../../../src/config.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { DEFAULT_NEK_CONFIG } from "../../../src/extensions/nek/config.ts";
import { createNekExtension } from "../../../src/extensions/nek/index.ts";
import { testTool, untilAborted } from "../../durable/support.ts";
import { createHarness } from "../harness.ts";

const [path, scenario] = process.argv.slice(2);
if (path === undefined || scenario === undefined) throw new Error("usage: agent-session-crash-child <db> <scenario>");

function mark(name: string): void {
	process.stdout.write(`MARK ${name}\n`);
}

function hangingResponse(name: string) {
	return (_context: unknown, options?: { signal?: AbortSignal }) => {
		mark(name);
		return untilAborted(options?.signal);
	};
}

function waitTool(name: string): AgentTool {
	return testTool(
		name,
		async (signal) => {
			mark("tool");
			return await untilAborted(signal);
		},
		name === "probe_safe" ? { replay: "safe" } : {},
	);
}

/** Marker in every subagent request; routes the shared faux provider between parent and child. */
export const SUBAGENT_MARKER = "You are currently working inside a subagent.";

if (scenario === "subagent") {
	const agentDir = join(dirname(path), "agent-home");
	mkdirSync(agentDir, { recursive: true });
	process.env[ENV_AGENT_DIR] = agentDir;
}

const sessionManager = SessionManager.open(path, dirname(path));
const harness = await createHarness({
	sessionManager,
	tokensPerSecond: scenario === "stream" ? 40 : undefined,
	tokenSize: scenario === "stream" ? { min: 3, max: 3 } : undefined,
	settings: { compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 1 } },
	tools:
		scenario === "safe-tool"
			? [waitTool("probe_safe")]
			: scenario === "unsafe-tool"
				? [waitTool("probe_unsafe")]
				: [],
	extensionFactories:
		scenario === "subagent"
			? [createNekExtension({ role: "root", config: DEFAULT_NEK_CONFIG })]
			: scenario === "before-settle"
				? [
						(pi) => {
							pi.on("agent_before_settle", async () => {
								mark("before-settle");
								await new Promise<void>(() => {});
							});
						},
					]
				: [],
});

setInterval(() => {}, 1000);

if (scenario === "stream") {
	harness.setResponses([fauxAssistantMessage("word ".repeat(2000))]);
	harness.session.subscribe((event) => {
		if (event.type !== "message_update" || event.message.role !== "assistant") return;
		const first = event.message.content[0];
		if (first?.type === "text" && first.text.length > 0) mark("partial");
	});
	await harness.session.prompt("go");
} else if (scenario === "safe-tool" || scenario === "unsafe-tool") {
	const toolName = scenario === "safe-tool" ? "probe_safe" : "probe_unsafe";
	harness.setResponses([fauxAssistantMessage([fauxToolCall(toolName, {})], { stopReason: "toolUse" })]);
	harness.session.subscribe((event) => {
		if (event.type === "tool_execution_start") mark("tool");
	});
	await harness.session.prompt("go");
} else if (scenario === "queue") {
	harness.setResponses([hangingResponse("request")]);
	let started = false;
	harness.session.subscribe((event) => {
		if (event.type !== "turn_start" || started) return;
		started = true;
		void (async () => {
			await harness.session.steer("steer-1");
			await harness.session.followUp("follow-1");
			mark("queued");
		})();
	});
	await harness.session.prompt("go");
} else if (scenario === "compact") {
	harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
	await harness.session.prompt("first");
	await harness.session.prompt("second");
	harness.setResponses([hangingResponse("summarizing")]);
	await harness.session.compact();
} else if (scenario === "before-settle") {
	harness.setResponses([fauxAssistantMessage("initial")]);
	await harness.session.prompt("go");
} else if (scenario === "trigger") {
	harness.setResponses([hangingResponse("request")]);
	harness.session.subscribe((event) => {
		if (event.type === "entry_appended" && event.entry.type === "custom_message") mark("custom");
	});
	await harness.session.sendCustomMessage(
		{ customType: "crash-trigger", content: "triggered", display: false },
		{ triggerTurn: true },
	);
} else if (scenario === "subagent") {
	await harness.session.bindExtensions({ mode: "print" });
	// The parent starts a foreground subagent; the child's request never answers.
	const subagentCall = fauxAssistantMessage(
		fauxToolCall("subagent", { description: "Map files", prompt: "List the files.", subagent_type: "explorer" }),
		{ stopReason: "toolUse" },
	);
	harness.setResponses(
		Array.from({ length: 4 }, () => async (context: { messages: unknown[] }, options?: { signal?: AbortSignal }) => {
			if (JSON.stringify(context.messages).includes(SUBAGENT_MARKER)) {
				mark("child-request");
				return await untilAborted(options?.signal);
			}
			return subagentCall;
		}),
	);
	await harness.session.prompt("map the files");
} else {
	throw new Error(`unknown scenario: ${scenario}`);
}
