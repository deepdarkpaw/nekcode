import type { CommandDefinition } from "./registry.ts";

export const sessionCommand: CommandDefinition = {
	name: "session",
	acceptsArgs: false,
	clearEditor: "after",
	run: (ctx) => {
		const stats = ctx.session.getSessionStats();
		const name = ctx.sessionManager.getSessionName();
		const { input, cacheRead, cacheWrite, output, total } = stats.tokens;
		const promptTokens = input + cacheRead + cacheWrite;
		const markdown = [
			"## Session Info",
			name ? `**Name:** ${name}` : "",
			`**File:** ${stats.sessionFile ?? "In-memory"}`,
			`**ID:** ${stats.sessionId}`,
			"",
			"## Messages",
			`- Total: ${stats.totalMessages}`,
			`- User: ${stats.userMessages}`,
			`- Assistant: ${stats.assistantMessages}`,
			`- Tools: ${stats.toolCalls} calls, ${stats.toolResults} results`,
			"",
			"## Tokens",
			`- Input: ${promptTokens.toLocaleString()}`,
			`- Cached: ${cacheRead.toLocaleString()}${promptTokens > 0 ? ` (${((cacheRead / promptTokens) * 100).toFixed(1)}%)` : ""}`,
			`- Cache writes: ${cacheWrite.toLocaleString()}`,
			`- Output: ${output.toLocaleString()}`,
			`- Total: ${total.toLocaleString()}`,
			"",
			"## Cost",
			`- Total: $${stats.cost.toFixed(3)}`,
		]
			.filter((line) => line.length > 0)
			.join("\n");
		ctx.transcript.appendMarkdown(markdown, { title: "Session Info", bordered: true });
	},
};
