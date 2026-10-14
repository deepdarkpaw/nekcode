import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type AssistantMessage, type FauxResponseStep, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import type { DurableEngine } from "../../src/core/durable/engine.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { Settings } from "../../src/core/settings-manager.ts";
import { createHarness, type Harness, type HarnessOptions } from "./harness.ts";

/** Which model answered a request, with its output budget. */
type Request = { provider: string; model: string; maxTokens: number | undefined };

const harnesses: Harness[] = [];
const directories: string[] = [];

afterEach(async () => {
	for (const harness of harnesses.splice(0)) {
		await harness.session.dispose();
		harness.faux.unregister();
		rmSync(harness.tempDir, { recursive: true, force: true });
	}
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function open(options: HarnessOptions): Promise<Harness> {
	const harness = await createHarness({ tools: [], ...options });
	harnesses.push(harness);
	return harness;
}

/** A main model with a small window and per-model budgets, and a separate summarizer. */
function compactionHarness(compaction: Settings["compaction"], summarizer = {}): Promise<Harness> {
	return open({
		models: [
			{ id: "main", contextWindow: 4000, maxTokens: 3000 },
			{ id: "summarizer", contextWindow: 100000, maxTokens: 5000, ...summarizer },
		],
		settings: {
			compaction: {
				reserveTokens: 10,
				...compaction,
				modelOverrides: {
					"faux/main": { reserveTokens: 2000, keepRecentTokens: 150 },
					// Never used: budgets resolve against the main model.
					"faux/summarizer": { reserveTokens: 50000, keepRecentTokens: 1 },
				},
			},
		},
	});
}

/** Two old turns with the given usage; returns the ID of the recent user message. */
function seedHistory(harness: Harness, totalTokens: number): string {
	const model = harness.session.model!;
	let recentUserId = "";
	for (const label of ["old", "recent"]) {
		recentUserId = harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: label.padEnd(400, "x") }],
			timestamp: Date.now() - 2000,
		});
		const assistant = fauxAssistantMessage(label.padEnd(400, "y"), { timestamp: Date.now() - 1000 });
		harness.sessionManager.appendMessage({
			...assistant,
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: { ...assistant.usage, input: totalTokens, totalTokens },
		});
	}
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	return recentUserId;
}

/** A faux step that records the answering model and returns `message`. */
function recorded(requests: Request[], message: AssistantMessage | string): FauxResponseStep {
	return (_context, options, _state, model) => {
		requests.push({ provider: model.provider, model: model.id, maxTokens: options?.maxTokens });
		return typeof message === "string" ? fauxAssistantMessage(message) : message;
	};
}

/** Register `noauth/summarizer`, served by the faux API, with no configured credentials. */
function registerUnauthenticatedSummarizer(harness: Harness): void {
	const summarizer = harness.getModel("summarizer")!;
	harness.session.modelRuntime.registerProvider("noauth", {
		baseUrl: summarizer.baseUrl,
		api: harness.faux.api,
		models: [
			{
				id: summarizer.id,
				name: summarizer.name,
				api: summarizer.api,
				reasoning: summarizer.reasoning,
				input: summarizer.input,
				cost: summarizer.cost,
				contextWindow: summarizer.contextWindow,
				maxTokens: summarizer.maxTokens,
			},
		],
	});
}

function compactionEntries(harness: Harness) {
	return harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
}

describe("AgentSession compaction.model", () => {
	it("summarizes manual compaction with the configured model while the main model stays selected", async () => {
		const harness = await compactionHarness({ model: "faux/summarizer" });
		const recentUserId = seedHistory(harness, 650);
		const requests: Request[] = [];
		harness.setResponses([recorded(requests, "configured summary")]);

		await harness.session.compact();

		// The output budget is 0.8 x the main model's reserveTokens (2000), within the summarizer's maxTokens.
		expect(requests).toEqual([{ provider: "faux", model: "summarizer", maxTokens: 1600 }]);
		expect(harness.session.model?.id).toBe("main");
		// The kept history follows the main model's keepRecentTokens (150), not the summarizer's override.
		expect(compactionEntries(harness)).toMatchObject([
			{ summary: "configured summary", firstKeptEntryId: recentUserId },
		]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("caps the summary output at the configured model's maxTokens", async () => {
		const harness = await compactionHarness({ model: "faux/summarizer" }, { maxTokens: 700 });
		seedHistory(harness, 650);
		const requests: Request[] = [];
		harness.setResponses([recorded(requests, "summary")]);

		await harness.session.compact();

		expect(requests).toEqual([{ provider: "faux", model: "summarizer", maxTokens: 700 }]);
	});

	it("summarizes with the main model when compaction.model is unset", async () => {
		const harness = await compactionHarness({});
		seedHistory(harness, 650);
		const requests: Request[] = [];
		harness.setResponses([recorded(requests, "main summary")]);

		await harness.session.compact();

		expect(requests).toEqual([{ provider: "faux", model: "main", maxTokens: 1600 }]);
	});

	it.each(["threshold", "overflow"] as const)("summarizes %s compaction with the configured model", async (path) => {
		const harness = await compactionHarness({ model: "faux/summarizer" });
		seedHistory(harness, path === "threshold" ? 2500 : 650);
		const requests: Request[] = [];
		harness.setResponses(
			path === "threshold"
				? [recorded(requests, "summary"), recorded(requests, "done")]
				: [
						recorded(
							requests,
							fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long" }),
						),
						// Omitting the failed attempt splits the last turn: a history summary and a turn-prefix summary.
						recorded(requests, "summary"),
						recorded(requests, "prefix summary"),
						recorded(requests, "recovered"),
					],
		);

		await harness.session.prompt("continue");
		await harness.session.waitForIdle();

		const models = requests.map((request) => request.model);
		expect(models).toEqual(
			path === "threshold" ? ["summarizer", "main"] : ["main", "summarizer", "summarizer", "main"],
		);
		expect(requests.find((request) => request.model === "summarizer")?.maxTokens).toBe(1600);
		expect(harness.eventsOfType("compaction_end")).toMatchObject([
			{ reason: path, aborted: false, result: { summary: expect.stringContaining("summary") } },
		]);
		expect(harness.session.model?.id).toBe("main");
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("resumes an interrupted manual compaction with the configured model", async () => {
		const directory = mkdtempSync(join(tmpdir(), "nek-compaction-model-"));
		directories.push(directory);
		const path = join(directory, "session.sqlite");
		const models = [{ id: "main" }, { id: "summarizer" }];
		const first = await open({
			models,
			sessionManager: SessionManager.open(path, dirname(path)),
			settings: { compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 1 } },
			responses: [fauxAssistantMessage("one"), fauxAssistantMessage("two")],
		});
		await first.session.prompt("first");
		await first.session.prompt("second");
		// A crash during `compact()` leaves this mark; the reopened session compacts again.
		const engine = await (first.session as unknown as { _engineOrThrow(): Promise<DurableEngine> })._engineOrThrow();
		await engine.markCompactionPending(undefined);
		await first.session.dispose();

		const requests: Request[] = [];
		const reopened = await open({
			models,
			sessionManager: SessionManager.open(path, dirname(path)),
			settings: {
				compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 1, model: "faux/summarizer" },
			},
			// The cut lands inside the last turn, so it summarizes the history and the turn prefix.
			responses: [recorded(requests, "resumed summary"), recorded(requests, "resumed prefix")],
		});
		await reopened.session.waitForIdle();

		expect(requests.map((request) => request.model)).toEqual(["summarizer", "summarizer"]);
		expect(reopened.session.messages.some((message) => message.role === "compactionSummary")).toBe(true);
		expect(reopened.session.model?.id).toBe("main");
	});

	it("lets an SDK custom stream function supply the configured model's auth", async () => {
		const harness = await compactionHarness({ model: "noauth/summarizer" });
		registerUnauthenticatedSummarizer(harness);
		harness.session.agent.streamFunction = (model, context, options) => streamSimple(model, context, options);
		seedHistory(harness, 650);
		const requests: Request[] = [];
		harness.setResponses([recorded(requests, "custom stream summary")]);

		await harness.session.compact();

		expect(requests).toEqual([{ provider: "noauth", model: "summarizer", maxTokens: 1600 }]);
		expect(compactionEntries(harness)).toMatchObject([{ summary: "custom stream summary" }]);
	});

	it("keeps an extension-supplied compaction instead of calling the configured model", async () => {
		const harness = await open({
			models: [{ id: "main" }, { id: "summarizer" }],
			settings: { compaction: { model: "faux/summarizer", keepRecentTokens: 150 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "extension summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
		});
		seedHistory(harness, 650);
		const requests: Request[] = [];
		harness.setResponses([recorded(requests, "unexpected summary")]);

		await harness.session.compact();

		expect(requests).toEqual([]);
		expect(compactionEntries(harness)).toMatchObject([{ summary: "extension summary", fromHook: true }]);
	});

	describe.each([
		{
			name: "an unknown model",
			setting: "faux/missing",
			summarizer: {},
			error: 'compaction.model "faux/missing" is not a known model',
		},
		{
			name: "a model without auth",
			setting: "noauth/summarizer",
			summarizer: {},
			error: 'compaction.model "noauth/summarizer" cannot authenticate: No API key found for noauth',
		},
		{
			name: "a context window too small for the summarization request",
			setting: "faux/summarizer",
			// The request's input alone (prompts plus about 800 characters of history) exceeds 300 tokens.
			summarizer: { contextWindow: 300, maxTokens: 100 },
			error: 'compaction.model "faux/summarizer" cannot fit the summarization request',
		},
	])("with $name", ({ setting, summarizer, error }) => {
		async function erroringHarness(): Promise<Harness> {
			const harness = await compactionHarness({ model: setting }, summarizer);
			registerUnauthenticatedSummarizer(harness);
			return harness;
		}

		it("fails manual compaction without a summary request", async () => {
			const harness = await erroringHarness();
			seedHistory(harness, 650);
			const requests: Request[] = [];
			harness.setResponses([recorded(requests, "unexpected summary")]);

			await expect(harness.session.compact()).rejects.toThrow(error);

			expect(requests).toEqual([]);
			expect(harness.getPendingResponseCount()).toBe(1);
			expect(compactionEntries(harness)).toEqual([]);
			expect(harness.eventsOfType("compaction_end")).toMatchObject([
				{ reason: "manual", errorMessage: expect.stringContaining(error) },
			]);
		});

		it("fails automatic compaction without a summary request to the main model", async () => {
			const harness = await erroringHarness();
			seedHistory(harness, 2500);
			const requests: Request[] = [];
			harness.setResponses([recorded(requests, "done")]);

			await harness.session.prompt("continue");
			await harness.session.waitForIdle();

			// The only request is the prompt's own answer.
			expect(requests.map((request) => request.model)).toEqual(["main"]);
			expect(harness.session.getLastAssistantText()).toBe("done");
			expect(compactionEntries(harness)).toEqual([]);
			expect(harness.eventsOfType("compaction_end")[0]).toMatchObject({
				reason: "threshold",
				errorMessage: expect.stringContaining(error),
			});
		});
	});
});

describe("AgentSession compaction.thinkingLevel", () => {
	/** Which model answered a summary request, with the thinking level it was sent. */
	type ThinkingRequest = { model: string; reasoning: string | undefined };

	/** A reasoning main model at `low`, and `deep/summarizer`, which also supports `max`. */
	async function thinkingHarness(compaction: Settings["compaction"]): Promise<Harness> {
		const harness = await open({
			models: [{ id: "main", reasoning: true, contextWindow: 4000, maxTokens: 3000 }],
			settings: { compaction: { reserveTokens: 2000, keepRecentTokens: 150, ...compaction } },
		});
		harness.session.setThinkingLevel("low");
		const main = harness.getModel("main")!;
		harness.session.modelRuntime.registerProvider("deep", {
			baseUrl: main.baseUrl,
			apiKey: "faux-key",
			api: harness.faux.api,
			models: [
				{
					id: "summarizer",
					name: "summarizer",
					api: main.api,
					reasoning: true,
					thinkingLevelMap: { max: "max" },
					input: main.input,
					cost: main.cost,
					contextWindow: 100000,
					maxTokens: 5000,
				},
			],
		});
		return harness;
	}

	function recordedThinking(requests: ThinkingRequest[]): FauxResponseStep {
		return (_context, options, _state, model) => {
			requests.push({ model: `${model.provider}/${model.id}`, reasoning: options?.reasoning });
			return fauxAssistantMessage("summary");
		};
	}

	it("summarizes at the configured level on the compaction model", async () => {
		const harness = await thinkingHarness({ model: "deep/summarizer", thinkingLevel: "max" });
		seedHistory(harness, 650);
		const requests: ThinkingRequest[] = [];
		harness.setResponses([recordedThinking(requests)]);

		await harness.session.compact();

		expect(requests).toEqual([{ model: "deep/summarizer", reasoning: "max" }]);
		expect(harness.session.thinkingLevel).toBe("low");
	});

	it("summarizes at the session's level when unset", async () => {
		const harness = await thinkingHarness({ model: "deep/summarizer" });
		seedHistory(harness, 650);
		const requests: ThinkingRequest[] = [];
		harness.setResponses([recordedThinking(requests)]);

		await harness.session.compact();

		expect(requests).toEqual([{ model: "deep/summarizer", reasoning: "low" }]);
	});

	it("fails without a summary request when the summarizing model lacks the level", async () => {
		// Without compaction.model the main model summarizes, and it has no `max` level.
		const harness = await thinkingHarness({ thinkingLevel: "max" });
		seedHistory(harness, 650);
		const requests: ThinkingRequest[] = [];
		harness.setResponses([recordedThinking(requests)]);

		await expect(harness.session.compact()).rejects.toThrow(
			'compaction.thinkingLevel "max" is not supported by faux/main',
		);

		expect(requests).toEqual([]);
		expect(compactionEntries(harness)).toEqual([]);
	});
});
