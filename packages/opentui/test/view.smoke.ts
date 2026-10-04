/**
 * View smoke test (Bun): drives the real App, RpcClient, and reducer with scripted backend records
 * over in-memory streams, renders offscreen, and checks the frame. Run with `bun test/view.smoke.ts`.
 * Not a `node --test` file: it imports OpenTUI, which needs Bun.
 */

import { PassThrough } from "node:stream";
import { createTestRenderer } from "@opentui/core/testing";
import { App } from "../src/app.ts";
import { RpcClient } from "../src/rpc/client.ts";
import { JsonlDecoder, parseRecord, serializeJsonLine } from "../src/rpc/jsonl.ts";
import { loadPalette } from "../src/theme/load.ts";

const stdin = new PassThrough();
const stdout = new PassThrough();
const decoder = new JsonlDecoder();
const now = Date.now();

function send(record: unknown): void {
	stdout.write(serializeJsonLine(record));
}

// A minimal backend: answers commands and records extension UI responses.
const uiResponses: Array<Record<string, unknown>> = [];
stdin.on("data", (chunk: Buffer) => {
	for (const line of decoder.push(chunk)) {
		const command = parseRecord(line);
		if (!command) continue;
		if (command.type === "extension_ui_response") {
			uiResponses.push(command);
			continue;
		}
		const data =
			command.type === "get_state"
				? {
						model: { id: "faux-1", provider: "faux", contextWindow: 200_000 },
						thinkingLevel: "medium",
						isStreaming: false,
					}
				: command.type === "get_messages"
					? { messages: [] }
					: command.type === "get_session_stats"
						? {
								tokens: { input: 12_400, output: 2_100 },
								cost: 0,
								contextUsage: { tokens: 46_000, percent: 23, contextWindow: 200_000 },
							}
						: undefined;
		send({ id: command.id, type: "response", command: command.type, success: true, data });
	}
});

let resolveExit: (value: { code: number | null; signal: string | null }) => void = () => {};
const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
	resolveExit = resolve;
});
stdin.on("finish", () => resolveExit({ code: 0, signal: null }));

const client = new RpcClient({ stdin, stdout, exited });
const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 110, height: 60 });
const app = new App({
	renderer,
	client,
	palette: loadPalette(undefined),
	cwd: "/work/repo",
	initialMessages: [],
	onExit: () => {},
});
await app.start();

const records: unknown[] = [
	{ type: "extension_ui_request", id: "s1", method: "setStatus", statusKey: "nek.mode", statusText: "plan" },
	{ type: "agent_start" },
	{ type: "message_end", message: { role: "user", content: "Find OpenTUI docs and list the repo" } },
	{ type: "message_start", message: { role: "assistant", content: [] } },
	{
		type: "message_update",
		assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Search first." },
	},
	{
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Searching **the web**." },
	},
	{
		type: "message_end",
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "Search first." },
				{ type: "text", text: "Searching **the web**." },
				{ type: "toolCall", id: "w1", name: "web_search", arguments: { query: "opentui scrollbox" } },
				{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "ls -la" } },
				{ type: "toolCall", id: "t1", name: "todo_write", arguments: { todos: [] } },
				{ type: "toolCall", id: "m1", name: "mcp__github__list_issues", arguments: { repo: "nekcode" } },
			],
			stopReason: "toolUse",
			usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150 },
		},
	},
	{ type: "tool_execution_start", toolCallId: "w1", toolName: "web_search", args: { query: "opentui scrollbox" } },
	{
		type: "tool_execution_end",
		toolCallId: "w1",
		toolName: "web_search",
		result: {
			content: [{ type: "text", text: "model-facing text" }],
			details: {
				query: "opentui scrollbox",
				results: Array.from({ length: 7 }, (_, i) => ({
					title: `OpenTUI result ${i + 1}`,
					url: `https://www.docs${i + 1}.example.com/x`,
				})),
			},
		},
		isError: false,
	},
	{ type: "tool_execution_start", toolCallId: "b1", toolName: "bash", args: { command: "ls -la" } },
	{
		type: "tool_execution_end",
		toolCallId: "b1",
		toolName: "bash",
		result: { content: [{ type: "text", text: Array.from({ length: 12 }, (_, i) => `file-${i + 1}`).join("\n") }] },
		isError: false,
	},
	{ type: "tool_execution_start", toolCallId: "t1", toolName: "todo_write", args: {} },
	{
		type: "tool_execution_end",
		toolCallId: "t1",
		toolName: "todo_write",
		result: {
			content: [{ type: "text", text: "ok" }],
			details: {
				todos: [
					{ id: "1", content: "Read the OpenTUI docs", status: "completed" },
					{ id: "2", content: "Build the transcript", status: "in_progress" },
					{ id: "3", content: "Write the smoke test", status: "pending" },
				],
			},
		},
		isError: false,
	},
	{ type: "tool_execution_start", toolCallId: "m1", toolName: "mcp__github__list_issues", args: { repo: "nekcode" } },
	{
		type: "tool_execution_end",
		toolCallId: "m1",
		toolName: "mcp__github__list_issues",
		result: { content: [{ type: "text", text: "rate limited" }] },
		isError: true,
	},
	{
		type: "tool_execution_update",
		toolCallId: "s9",
		toolName: "subagent",
		args: { description: "explore renderers" },
		partialResult: {
			content: [],
			details: {
				subagent: {
					id: "sa1",
					description: "explore renderers",
					type: "explore",
					status: "running",
					startedAt: now - 65_000,
					model: "anthropic/claude-sonnet",
					usage: { input: 12_300, output: 1_500 },
					activity: "read src/view/blocks.ts",
					lastActivityAt: now - 3_000,
				},
			},
		},
	},
	{ type: "queue_update", steering: ["also check CJK wrapping"], followUp: [] },
	{ type: "extension_ui_request", id: "n1", method: "notify", message: "Plan saved", notifyType: "info" },
];

async function frameAfter(batch: unknown[]): Promise<string> {
	for (const record of batch) send(record);
	await new Promise((resolve) => setTimeout(resolve, 100));
	app.sync();
	await renderOnce();
	return captureCharFrame();
}

const transcriptFrame = await frameAfter(records);
console.log(transcriptFrame);
const dialogFrame = await frameAfter([
	{
		type: "extension_ui_request",
		id: "d1",
		method: "select",
		title: "Approve the plan?",
		options: ["Approve", "Revise", "Cancel"],
	},
]);
const frame = `${transcriptFrame}\n${dialogFrame}`;

const expected = [
	"PLAN",
	"Find OpenTUI docs and list the repo",
	"Searching the web.",
	"Thought",
	"Web Search opentui scrollbox",
	"7 results",
	"1. OpenTUI result 1 docs1.example.com",
	"Bash ls -la",
	"file-12",
	"Todos",
	"Build the transcript",
	"github › list_issues",
	"rate limited",
	"Subagents",
	"claude-sonnet · explore · ↑12k ↓1.5k · 1m 05s",
	"read src/view/blocks.ts · 3s ago",
	"steer also check CJK wrapping",
	"Plan saved",
	"Approve the plan?",
	"› Approve",
	"faux-1",
	"% ctx",
	"7 earlier lines",
];
const missing = expected.filter((text) => !frame.includes(text));
const forbidden = ["web_search", "todo_write", "mcp__github", "https://"].filter((text) => frame.includes(text));

// Answer the dialog with the keyboard: down, enter → "Revise".
renderer.keyInput.processParsedKey({
	name: "down",
	ctrl: false,
	meta: false,
	shift: false,
	option: false,
	sequence: "",
	number: false,
	raw: "",
	eventType: "press",
	source: "raw",
});
renderer.keyInput.processParsedKey({
	name: "return",
	ctrl: false,
	meta: false,
	shift: false,
	option: false,
	sequence: "\r",
	number: false,
	raw: "\r",
	eventType: "press",
	source: "raw",
});
await new Promise((resolve) => setTimeout(resolve, 50));
const answered = uiResponses.some((response) => response.id === "d1" && response.value === "Revise");

app.dispose();
renderer.destroy();
await client.shutdown(1000);
if (missing.length > 0 || forbidden.length > 0 || !answered) {
	console.error(
		`view smoke FAILED\nmissing: ${JSON.stringify(missing)}\nforbidden: ${JSON.stringify(forbidden)}\ndialog answered: ${answered}`,
	);
	process.exit(1);
}
console.log(`view smoke ok: ${expected.length} expectations, dialog answered`);
process.exit(0);
