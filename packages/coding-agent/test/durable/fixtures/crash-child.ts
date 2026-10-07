/**
 * Child process for the durable crash tests. Opens an engine on the database given as the first argument, drives the
 * scenario given as the second, and prints `MARK <name>` lines at the points where the parent kills it. It never
 * exits on its own; the parent kills it with SIGKILL, which on Windows terminates the process at once.
 */
import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { DurableEngine } from "../../../src/core/durable/engine.ts";
import { durableSetup, openEngine, testTool, untilAborted } from "../support.ts";

const [path, scenario] = process.argv.slice(2);
if (path === undefined || scenario === undefined) throw new Error("usage: crash-child <db> <scenario>");

function mark(name: string): void {
	process.stdout.write(`MARK ${name}\n`);
}

/** A faux response that marks the request and then never answers. */
function hanging(name: string): FauxResponseStep {
	return (_context, options) => {
		mark(name);
		return untilAborted(options?.signal);
	};
}

const toolCall = (name: string) =>
	fauxAssistantMessage([fauxToolCall(name, { path: "a" }, { id: "call-1" })], { stopReason: "toolUse" });

/** Tools that mark their start and then run until killed. */
const tools = [
	testTool(
		"probe_safe",
		async (signal) => {
			mark("tool");
			return untilAborted(signal);
		},
		{ replay: "safe" },
	),
	testTool("probe_unsafe", async (signal) => {
		mark("tool");
		return untilAborted(signal);
	}),
];

const scenarios: Record<string, (engine: DurableEngine, setup: ReturnType<typeof durableSetup>) => Promise<void>> = {
	/** Kill once a streaming partial is committed. */
	stream: async (engine) => {
		let marked = false;
		engine.subscribe((event) => {
			if (event.type !== "message_update" || event.message.role !== "assistant" || marked) return;
			const block = event.message.content[0];
			if (block?.type !== "text" || block.text === "") return;
			marked = true;
			mark("partial");
		});
		await engine.prompt("go", { systemPrompt: "Test." });
	},
	"safe-tool": async (engine, setup) => {
		setup.faux.setResponses([toolCall("probe_safe")]);
		await engine.prompt("go", { systemPrompt: "Test." });
	},
	"unsafe-tool": async (engine, setup) => {
		setup.faux.setResponses([toolCall("probe_unsafe")]);
		await engine.prompt("go", { systemPrompt: "Test." });
	},
	/** Kill with a steer and a follow-up queued behind a request that never answers. */
	queue: async (engine, setup) => {
		setup.faux.setResponses([hanging("request")]);
		let requested!: () => void;
		const reached = new Promise<void>((resolve) => {
			requested = resolve;
		});
		engine.subscribe((event) => {
			if (event.type === "turn_start") requested();
		});
		await engine.prompt("go", { systemPrompt: "Test." });
		await reached;
		await engine.steer("steer-1");
		await engine.followUp("follow-1");
		mark("queued");
	},
	/** Kill while pi's summarizer waits for the model. */
	compact: async (engine, setup) => {
		setup.faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), hanging("summarizing")]);
		await engine.prompt("first", { systemPrompt: "Test." });
		await engine.waitForIdle();
		await engine.prompt("second");
		await engine.waitForIdle();
		await engine.compact();
	},
	/** Hold the session open. */
	lock: async () => {
		mark("open");
	},
};

const run = scenarios[scenario];
if (run === undefined) throw new Error(`Unknown scenario ${scenario}`);
const setup = durableSetup({
	...(scenario === "stream" ? { tokensPerSecond: 40 } : {}),
	settings: { compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 1 } },
});
if (scenario === "stream") setup.faux.setResponses([fauxAssistantMessage("word ".repeat(2000))]);
const engine = await openEngine(setup, path, { tools });
// Keep the process alive until it is killed.
setInterval(() => {}, 1000);
await run(engine, setup);
