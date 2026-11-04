import { describe, expect, test } from "bun:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent/core/session-manager";
import { sessionCommand } from "../../src/commands/session.ts";
import type { ModeContext } from "../../src/mode/mode-context.ts";

function entries(count: number): SessionEntry[] {
	return Array.from({ length: count }, (_, index) => ({
		type: "message",
		id: String(index),
		parentId: null,
		timestamp: "2026-11-03T00:00:00.000Z",
		message: {
			...fauxAssistantMessage("done"),
			provider: "faux",
			model: `model-${index}`,
			usage: {
				input: 10,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 12,
				cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
			},
		},
	}));
}

describe("OpenTUI session cost groups", () => {
	for (const count of [1, 2])
		test(`does not drop the first of ${count} cost groups`, async () => {
			let markdown = "";
			const ctx = {
				session: {
					getSessionStats: () => ({
						sessionId: "test",
						totalMessages: count,
						userMessages: 0,
						assistantMessages: count,
						toolCalls: 0,
						toolResults: 0,
						tokens: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, total: 12 },
						cost: 2 * count,
					}),
					modelRuntime: { getModel: () => undefined },
				},
				sessionManager: { getSessionName: () => undefined, getEntries: () => entries(count) },
				settingsManager: { getCacheWarmingMode: () => "off" },
				transcript: {
					appendMarkdown: (value: string) => {
						markdown = value;
					},
				},
			} as unknown as ModeContext;
			await sessionCommand.run(ctx, { name: "session", args: "", text: "/session" });
			for (let index = 0; index < count; index++) expect(markdown).toContain(`faux/model-${index}: $2.000`);
		});
});
