import { type FauxResponseStep, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { DurableEngine, DurableEngineOptions } from "../../src/core/durable/engine.ts";
import { type DurableTestSetup, durableSetup, openEngine, recordEvents } from "./support.ts";

const engines: DurableEngine[] = [];

afterEach(async () => {
	for (const engine of engines.splice(0)) await engine.close();
});

/** Two answered prompts with a main and a summarizer model, ready to compact. */
async function history(
	model: string,
	summary: FauxResponseStep,
	options: Partial<DurableEngineOptions> = {},
): Promise<{ setup: DurableTestSetup; engine: DurableEngine }> {
	const setup = durableSetup({
		models: [{ id: "main" }, { id: "summarizer" }],
		settings: { compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 1, model } },
	});
	setup.faux.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("second answer"), summary]);
	const engine = await openEngine(setup, undefined, options);
	engines.push(engine);
	await engine.prompt("first", { systemPrompt: "Test." });
	await engine.waitForIdle();
	await engine.prompt("second");
	await engine.waitForIdle();
	return { setup, engine };
}

describe("durable compaction with compaction.model", () => {
	it("summarizes with the configured model", async () => {
		const summaryModels: string[] = [];
		const { setup, engine } = await history("faux/summarizer", (_context, _options, _state, model) => {
			summaryModels.push(model.id);
			return fauxAssistantMessage("## Goal\nConfigured summary");
		});
		const events = recordEvents(engine);

		await engine.compact();

		expect(summaryModels).toEqual(["summarizer"]);
		const end = events.find((event) => event.type === "compaction_end");
		expect(end?.type === "compaction_end" ? end.result?.summary : undefined).toContain("Configured summary");
		expect((await engine.messages())[0]?.role).toBe("compactionSummary");
		expect(setup.reports).toEqual([]);
	});

	it.each([
		{
			name: "an unknown model",
			model: "faux/missing",
			error: 'compaction.model "faux/missing" is not a known model',
		},
		{
			name: "a model whose auth check fails",
			model: "faux/summarizer",
			error: 'compaction.model "faux/summarizer" cannot authenticate: no credentials',
		},
	])("declines without a summary request for $name", async ({ model, error }) => {
		const { setup, engine } = await history(model, fauxAssistantMessage("unexpected summary"), {
			compactionAuth: async () => {
				throw new Error("no credentials");
			},
		});

		await engine.compact();

		expect(setup.faux.getPendingResponseCount()).toBe(1);
		expect((await engine.messages()).some((message) => message.role === "compactionSummary")).toBe(false);
		expect(setup.reports.map((report) => (report instanceof Error ? report.message : String(report)))).toEqual([
			expect.stringContaining(error),
		]);
	});
});
