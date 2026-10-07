import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type FauxResponseStep, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { DurableEngine } from "../../src/core/durable/engine.ts";
import type { DurableSessionEvent } from "../../src/core/durable/events.ts";
import { createHarness } from "../suite/harness.ts";
import { durableSetup, modelOf, openEngine, recordEvents, testTool, textOf, textResult } from "./support.ts";

const engines: DurableEngine[] = [];

afterEach(async () => {
	for (const engine of engines.splice(0)) await engine.close();
});

async function track(engine: Promise<DurableEngine>): Promise<DurableEngine> {
	const opened = await engine;
	engines.push(opened);
	return opened;
}

/** One line per event: message events carry the role, updates their stream event type; repeated deltas collapse. */
function normalize(events: readonly DurableSessionEvent[]): string[] {
	const lines: string[] = [];
	for (const event of events) {
		let line: string = event.type;
		if (event.type === "message_update") line = `${event.type}:${event.assistantMessageEvent.type}`;
		else if (event.type === "message_start" || event.type === "message_end")
			line = `${event.type}:${event.message.role}`;
		if (line.endsWith("_delta") && lines[lines.length - 1] === line) continue;
		lines.push(line);
	}
	return lines;
}

/** Pi's own `AgentSession` running the same script: the oracle for event order. */
async function oracle(responses: () => FauxResponseStep[], tools: AgentTool[], input: string): Promise<string[]> {
	const harness = await createHarness({ tools });
	try {
		harness.setResponses(responses());
		await harness.session.prompt(input);
		return normalize(harness.events);
	} finally {
		harness.cleanup();
	}
}

async function durable(responses: () => FauxResponseStep[], tools: AgentTool[], input: string): Promise<string[]> {
	const setup = durableSetup();
	setup.faux.setResponses(responses());
	const engine = await track(openEngine(setup, undefined, { tools }));
	const events = recordEvents(engine);
	await engine.prompt(input, { systemPrompt: "You are a test." });
	await engine.waitForIdle();
	expect(setup.reports).toEqual([]);
	return normalize(events);
}

describe("DurableEngine against pi's loop", () => {
	it("emits a plain turn like AgentSession", async () => {
		const responses = () => [fauxAssistantMessage("hello there")];
		expect(await durable(responses, [], "hi")).toEqual(await oracle(responses, [], "hi"));
	});

	it("emits a tool round like AgentSession", async () => {
		const responses = () => [
			fauxAssistantMessage([fauxText("reading"), fauxToolCall("probe", { path: "a" }, { id: "call-1" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		];
		const tools = [testTool("probe", async () => textResult("ok"))];
		expect(await durable(responses, tools, "go")).toEqual(await oracle(responses, tools, "go"));
	});
});

describe("DurableEngine", () => {
	it("keeps the system message ahead of the first input in the transcript", async () => {
		const setup = durableSetup();
		setup.faux.setResponses([fauxAssistantMessage("hello")]);
		const engine = await track(
			openEngine(setup, undefined, { tools: [testTool("probe", async () => textResult("ok"))] }),
		);
		await engine.prompt("hi", { systemPrompt: "You are a test." });
		await engine.waitForIdle();

		const roles = (await engine.entries()).map((entry) => modelOf(entry)?.role);
		expect(roles).toEqual(["system", "user", "assistant"]);
		const system = modelOf((await engine.entries())[0]!);
		expect(system?.role === "system" ? system.sections : undefined).toEqual({ nek: "You are a test." });
		expect(system?.role === "system" ? system.toolsAdded?.map((tool) => tool.name) : undefined).toEqual(["probe"]);
	});

	it("returns a tool's text exactly, without durable truncation or diagnostics", async () => {
		const setup = durableSetup();
		const long = Array.from({ length: 5000 }, (_, index) => `line ${index}`).join("\n");
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("probe", {}, { id: "call-1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const probe = testTool("probe", async () => textResult(long, { size: long.length }));
		const engine = await track(openEngine(setup, undefined, { tools: [probe] }));
		await engine.prompt("go");
		await engine.waitForIdle();

		const result = (await engine.entries()).map(modelOf).find((message) => message?.role === "toolResult");
		expect(textOf(result)).toBe(long);
		expect(result?.role === "toolResult" ? result.details : undefined).toEqual({ size: long.length });
	});

	it("publishes tool partials as pi tool_execution_update events", async () => {
		const setup = durableSetup();
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("probe", {}, { id: "call-1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const probe: AgentTool = {
			...testTool("probe", async () => textResult("final")),
			execute: async (_id, _args, _signal, onUpdate) => {
				onUpdate?.(textResult("partial 1"));
				await new Promise((resolve) => setTimeout(resolve, 250));
				return textResult("final");
			},
		};
		const engine = await track(openEngine(setup, undefined, { tools: [probe] }));
		const events = recordEvents(engine);
		await engine.prompt("go");
		await engine.waitForIdle();

		const updates = events.filter((event) => event.type === "tool_execution_update");
		expect(updates.map((event) => event.partialResult)).toEqual([textResult("partial 1")]);
	});

	it("passes pi messages to the context hook and sends its result for that request only", async () => {
		const setup = durableSetup();
		const seen: string[][] = [];
		const sent: string[][] = [];
		setup.faux.setResponses([
			(context) => {
				sent.push(context.messages.map((message) => message.role));
				return fauxAssistantMessage("first");
			},
			(context) => {
				sent.push(context.messages.map((message) => message.role));
				return fauxAssistantMessage("second");
			},
		]);
		const engine = await track(
			openEngine(setup, undefined, {
				hooks: {
					context: async (messages) => {
						seen.push(messages.map((message) => message.role));
						return messages.filter((message) => message.role !== "custom");
					},
				},
			}),
		);
		await engine.appendMessage({
			role: "custom",
			customType: "note",
			content: "remember this",
			display: true,
			timestamp: Date.now(),
		});
		await engine.prompt("hi", { systemPrompt: "Test." });
		await engine.waitForIdle();
		await engine.prompt("again");
		await engine.waitForIdle();

		expect(seen[0]).toEqual(["custom", "system", "user"]);
		expect(sent[0]).toEqual(["system", "user"]);
		// The stored transcript still holds the custom message.
		expect((await engine.messages()).map((message) => message.role)).toContain("custom");
		expect(seen[1]).toEqual(["custom", "system", "user", "assistant", "user"]);
	});

	it("blocks a tool call through the tool_call hook with pi's text", async () => {
		const setup = durableSetup();
		let ran = false;
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("probe", { path: "secret" }, { id: "call-1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("ok"),
		]);
		const probe = testTool("probe", async () => {
			ran = true;
			return textResult("ran");
		});
		const engine = await track(
			openEngine(setup, undefined, {
				tools: [probe],
				hooks: {
					toolCall: async (event) =>
						event.input.path === "secret" ? { block: true, reason: "No secrets" } : undefined,
				},
			}),
		);
		await engine.prompt("go");
		await engine.waitForIdle();

		const result = (await engine.entries()).map(modelOf).find((message) => message?.role === "toolResult");
		expect(ran).toBe(false);
		expect(textOf(result)).toBe("No secrets");
		expect(result?.role === "toolResult" ? result.isError : undefined).toBe(true);
	});

	it("applies tool_call argument edits and tool_result patches", async () => {
		const setup = durableSetup();
		const seenArgs: unknown[] = [];
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("probe", { path: "a" }, { id: "call-1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("ok"),
		]);
		const probe = testTool("probe", async (_signal, _id, args) => {
			seenArgs.push(args);
			return textResult("raw");
		});
		const engine = await track(
			openEngine(setup, undefined, {
				tools: [probe],
				hooks: {
					toolCall: async (event) => {
						event.input.path = "b";
						return undefined;
					},
					toolResult: async (event) => {
						const text = event.content.map((content) => (content.type === "text" ? content.text : "")).join("");
						return { content: [{ type: "text", text: `patched ${text}` }] };
					},
				},
			}),
		);
		await engine.prompt("go");
		await engine.waitForIdle();

		const result = (await engine.entries()).map(modelOf).find((message) => message?.role === "toolResult");
		expect(seenArgs).toEqual([{ path: "b" }]);
		expect(textOf(result)).toBe("patched raw");
	});

	it("compacts with pi's summarizer and keeps pi's details", async () => {
		const setup = durableSetup({
			settings: { compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 1 } },
		});
		const summaryRequests: number[] = [];
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "src/a.ts" }, { id: "call-1" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("read it"),
			fauxAssistantMessage("second answer"),
			(context) => {
				summaryRequests.push(context.messages.length);
				return fauxAssistantMessage("## Goal\nTest summary");
			},
		]);
		const read = testTool("read", async () => textResult("file text"));
		const engine = await track(openEngine(setup, undefined, { tools: [read] }));
		const events = recordEvents(engine);
		await engine.prompt("first", { systemPrompt: "Test." });
		await engine.waitForIdle();
		await engine.prompt("second");
		await engine.waitForIdle();
		await engine.compact();

		expect(summaryRequests).toHaveLength(1);
		const end = events.find((event) => event.type === "compaction_end");
		expect(end?.type === "compaction_end" ? end.result?.summary : undefined).toContain("Test summary");
		expect(end?.type === "compaction_end" ? end.result?.tokensBefore : undefined).toBeGreaterThan(0);
		expect(end?.type === "compaction_end" ? end.result?.details : undefined).toMatchObject({
			readFiles: ["src/a.ts"],
		});
		const messages = await engine.messages();
		expect(messages[0]?.role).toBe("compactionSummary");
		expect(setup.reports).toEqual([]);
	});
});
