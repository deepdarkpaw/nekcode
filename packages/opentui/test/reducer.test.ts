import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RpcEventRecord, UiRequest } from "../src/rpc/protocol.ts";
import { routeInput } from "../src/state/commands.ts";
import { formatAgo, formatElapsed, formatTokens } from "../src/state/format.ts";
import {
	type Action,
	createInitialState,
	isExpanded,
	parseSubagent,
	type ReducerState,
	reduce,
	runningSubagents,
} from "../src/state/reducer.ts";
import { describeToolCall, describeToolResult } from "../src/state/tool-display.ts";
import type { AssistantBlock, ToolBlock } from "../src/state/types.ts";

function run(actions: Action[], state: ReducerState = createInitialState("/work")): ReducerState {
	return actions.reduce(reduce, state);
}

function ev(event: RpcEventRecord, now = 1000): Action {
	return { type: "rpc_event", event, now };
}

function ui(request: Record<string, unknown>): Action {
	return { type: "ui_request", request: request as unknown as UiRequest, now: 1000 };
}

const assistantMessage = (content: unknown[], extra: Record<string, unknown> = {}) => ({
	role: "assistant",
	content,
	stopReason: "stop",
	usage: { input: 100, output: 20, cacheRead: 300, cacheWrite: 0, totalTokens: 420, cost: { total: 0.01 } },
	...extra,
});

describe("reducer: messages", () => {
	it("streams assistant text and thinking, then takes the final message", () => {
		const state = run([
			ev({ type: "agent_start" }),
			ev({ type: "message_end", message: { role: "user", content: "hi" } }),
			ev({ type: "message_start", message: { role: "assistant", content: [] } }),
			ev({
				type: "message_update",
				assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "hmm" },
			}),
			ev({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Hel" } }),
			ev({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "lo" } }),
		]);
		assert.equal(state.running, true);
		assert.equal(state.blocks[0].kind, "user");
		const streaming = state.blocks[1] as AssistantBlock;
		assert.equal(streaming.streaming, true);
		assert.deepEqual(
			streaming.parts.map((part) => [part.type, part.text]),
			[
				["thinking", "hmm"],
				["text", "Hello"],
			],
		);

		const final = run(
			[
				ev({
					type: "message_end",
					message: assistantMessage([
						{ type: "thinking", thinking: "hmm." },
						{ type: "text", text: "Hello!" },
					]),
				}),
				ev({ type: "agent_settled" }),
			],
			state,
		);
		const block = final.blocks[1] as AssistantBlock;
		assert.equal(block.streaming, false);
		assert.equal(block.parts[1].text, "Hello!");
		assert.equal(final.running, false);
		assert.equal(final.footer.inputTokens, 100);
		assert.equal(final.footer.outputTokens, 20);
		assert.equal(final.footer.contextTokens, 420);
	});

	it("keeps unchanged blocks by identity when another block updates", () => {
		const state = run([
			ev({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "a" }] } }),
			ev({ type: "message_start", message: { role: "assistant", content: [] } }),
		]);
		const next = reduce(
			state,
			ev({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" } }),
		);
		assert.equal(next.blocks[0], state.blocks[0]);
		assert.notEqual(next.blocks[1], state.blocks[1]);
	});

	it("records assistant errors", () => {
		const state = run([
			ev({ type: "message_start", message: { role: "assistant", content: [] } }),
			ev({
				type: "message_end",
				message: assistantMessage([], { stopReason: "error", errorMessage: "529 overloaded" }),
			}),
		]);
		assert.equal((state.blocks[0] as AssistantBlock).error, "529 overloaded");
	});
});

describe("reducer: tools", () => {
	it("tracks tool calls by id through start, update, and end", () => {
		const state = run([
			ev({ type: "message_start", message: { role: "assistant", content: [] } }),
			ev({
				type: "message_update",
				assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, id: "c1", toolName: "bash" },
			}),
			ev({
				type: "message_update",
				assistantMessageEvent: {
					type: "toolcall_end",
					contentIndex: 0,
					toolCall: { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } },
				},
			}),
			ev({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } }, 2000),
			ev({
				type: "tool_execution_update",
				toolCallId: "c1",
				toolName: "bash",
				args: {},
				partialResult: { content: [{ type: "text", text: "a" }] },
			}),
			ev(
				{
					type: "tool_execution_end",
					toolCallId: "c1",
					toolName: "bash",
					result: { content: [{ type: "text", text: "a\nb" }] },
					isError: false,
				},
				3000,
			),
		]);
		const tools = state.blocks.filter((block): block is ToolBlock => block.kind === "tool");
		assert.equal(tools.length, 1);
		assert.deepEqual(tools[0].args, { command: "ls" });
		assert.equal(tools[0].status, "done");
		assert.equal(tools[0].result?.text, "a\nb");
		assert.equal(tools[0].startedAt, 2000);
		assert.equal(tools[0].endedAt, 3000);
	});

	it("marks failed tools as errors", () => {
		const state = run([
			ev({ type: "tool_execution_start", toolCallId: "c2", toolName: "read", args: { path: "x" } }),
			ev({
				type: "tool_execution_end",
				toolCallId: "c2",
				toolName: "read",
				result: { content: [{ type: "text", text: "ENOENT" }] },
				isError: true,
			}),
		]);
		assert.equal((state.blocks[0] as ToolBlock).status, "error");
	});

	it("takes todos from todo_write results", () => {
		const state = run([
			ev({ type: "tool_execution_start", toolCallId: "t1", toolName: "todo_write", args: {} }),
			ev({
				type: "tool_execution_end",
				toolCallId: "t1",
				toolName: "todo_write",
				result: {
					content: [{ type: "text", text: "ok" }],
					details: {
						todos: [
							{ id: "1", content: "Read code", status: "completed" },
							{ id: "2", content: "Write tests", status: "in_progress" },
							{ id: "3", content: "bad", status: "weird" },
						],
						owner: "planning",
					},
				},
				isError: false,
			}),
		]);
		assert.deepEqual(
			state.todos.map((todo) => `${todo.id}:${todo.status}`),
			["1:completed", "2:in_progress"],
		);
	});

	it("tracks subagents from subagent and await details in the new and old record shapes", () => {
		const state = run([
			ev({
				type: "tool_execution_update",
				toolCallId: "s1",
				toolName: "subagent",
				args: {},
				partialResult: {
					content: [],
					details: {
						subagent: {
							id: "a",
							description: "explore",
							type: "explore",
							status: "running",
							startedAt: 10,
							model: "anthropic/claude",
							usage: { input: 12_000, output: 800 },
							lastActivityAt: 900,
							activity: "read src/x.ts",
						},
					},
				},
			}),
			ev({
				type: "tool_execution_end",
				toolCallId: "w1",
				toolName: "await",
				result: {
					content: [],
					details: {
						subagents: [],
						running: [
							{ id: "b", description: "old", type: "general", status: "running", startedAt: 5, tokens: 4200 },
						],
						timedOut: true,
					},
				},
				isError: false,
			}),
		]);
		const running = runningSubagents(state);
		assert.deepEqual(
			running.map((subagent) => subagent.id),
			["b", "a"],
		);
		assert.deepEqual(state.subagents.a.usage, { input: 12_000, output: 800 });
		assert.equal(state.subagents.b.totalTokens, 4200);
		assert.equal(state.subagents.b.usage, undefined);
	});

	it("parses subagent records defensively", () => {
		assert.equal(parseSubagent({ description: "no id" }), undefined);
		assert.equal(parseSubagent("x"), undefined);
		assert.equal(parseSubagent({ id: "a" })?.status, "running");
	});
});

describe("reducer: session and UI", () => {
	it("reads the mode badge from the nek.mode status", () => {
		const plan = run([
			ui({ type: "extension_ui_request", id: "1", method: "setStatus", statusKey: "nek.mode", statusText: "plan" }),
		]);
		assert.equal(plan.mode, "plan");
		assert.equal(plan.statuses["nek.mode"], "plan");
		const agent = reduce(
			plan,
			ui({ type: "extension_ui_request", id: "2", method: "setStatus", statusKey: "nek.mode" }),
		);
		assert.equal(agent.mode, "agent");
		assert.equal(agent.statuses["nek.mode"], undefined);
	});

	it("queues dialogs and removes them when answered", () => {
		const state = run([
			ui({ type: "extension_ui_request", id: "d1", method: "select", title: "Pick", options: ["a", "b"] }),
			ui({ type: "extension_ui_request", id: "d2", method: "confirm", title: "Sure?", message: "" }),
			ui({ type: "extension_ui_request", id: "n1", method: "notify", message: "Saved", notifyType: "info" }),
			ui({ type: "extension_ui_request", id: "w1", method: "setWidget", widgetKey: "k", widgetLines: ["x"] }),
		]);
		assert.deepEqual(
			state.dialogs.map((dialog) => dialog.id),
			["d1", "d2"],
		);
		assert.equal(state.toasts[0].text, "Saved");
		assert.deepEqual(state.widgets.k, { lines: ["x"], placement: "aboveEditor" });
		const next = reduce(state, { type: "dialog_closed", id: "d1" });
		assert.deepEqual(
			next.dialogs.map((dialog) => dialog.id),
			["d2"],
		);
	});

	it("tracks the queue, thinking level, model, and session stats", () => {
		const state = run([
			ev({ type: "queue_update", steering: ["now"], followUp: ["later", 3] }),
			{
				type: "session_state",
				state: {
					model: { id: "m1", provider: "p", contextWindow: 200_000 },
					thinkingLevel: "high",
					isStreaming: false,
				},
			},
			ev({ type: "thinking_level_changed", level: "low" }),
			{
				type: "session_stats",
				stats: {
					tokens: { input: 5, output: 6 },
					cost: 0.5,
					contextUsage: { tokens: 50_000, percent: 25, contextWindow: 200_000 },
				},
			},
		]);
		assert.deepEqual(state.queue, { steering: ["now"], followUp: ["later"] });
		assert.equal(state.footer.model, "m1");
		assert.equal(state.footer.thinkingLevel, "low");
		assert.equal(state.footer.contextPercent, 25);
		assert.equal(state.footer.inputTokens, 5);
	});

	it("rebuilds the transcript from history", () => {
		const state = run([
			{
				type: "history",
				now: 0,
				messages: [
					{ role: "user", content: "hello" },
					assistantMessage([
						{ type: "text", text: "Running" },
						{ type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } },
					]),
					{
						role: "toolResult",
						toolCallId: "c1",
						toolName: "read",
						content: [{ type: "text", text: "code" }],
						isError: false,
					},
					{ role: "custom", customType: "note", content: "hidden", display: false },
				],
			},
		]);
		assert.deepEqual(
			state.blocks.map((block) => block.kind),
			["user", "assistant", "tool"],
		);
		assert.equal((state.blocks[2] as ToolBlock).status, "done");
		assert.equal(state.footer.inputTokens, 0);
	});

	it("toggles expansion per block and globally", () => {
		let state = createInitialState("/");
		assert.equal(isExpanded(state, "x"), false);
		state = reduce(state, { type: "toggle_expanded", id: "x" });
		assert.equal(isExpanded(state, "x"), true);
		state = reduce(state, { type: "toggle_expand_all" });
		assert.equal(isExpanded(state, "x"), false);
		assert.equal(isExpanded(state, "y"), true);
	});
});

describe("tool rows", () => {
	it("uses display names and never snake_case", () => {
		assert.equal(describeToolCall("web_search", { query: "q" }, "/").name, "Web Search");
		assert.equal(describeToolCall("web_search", { query: "q" }, "/").nameTone, "link");
		assert.equal(describeToolCall("ast_grep", { pattern: "x" }, "/").name, "AST Search");
		assert.equal(describeToolCall("mcp__github__create_issue", { title: "t" }, "/").name, "github › create_issue");
		assert.equal(describeToolCall("my_custom_tool", {}, "/").name, "My Custom Tool");
		const grep = describeToolCall("grep", { pattern: "TODO", path: "/work/src", glob: "*.ts" }, "/work");
		assert.deepEqual([grep.name, grep.arg?.text, grep.meta], ["Search", "/TODO/", ["in src", "*.ts"]]);
	});

	it("previews web search results with a muted count and hostnames", () => {
		const block: ToolBlock = {
			kind: "tool",
			id: "w",
			name: "web_search",
			args: { query: "q" },
			status: "done",
			result: {
				text: "model text",
				details: {
					results: Array.from({ length: 7 }, (_, i) => ({
						title: `T${i + 1}`,
						url: `https://www.site${i + 1}.dev/a`,
					})),
				},
			},
		};
		const collapsed = describeToolResult(block, false);
		assert.equal(collapsed.hidden, 2);
		assert.equal(collapsed.lines.length, 6);
		assert.equal(collapsed.lines[0][0].text, "7 results");
		assert.deepEqual(
			collapsed.lines[1].map((segment) => segment.text),
			["1. ", "T1", " site1.dev"],
		);
		assert.equal(describeToolResult(block, true).lines.length, 8);
	});

	it("keeps the end of shell output and the start of other output", () => {
		const text = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n");
		const shell = describeToolResult(
			{ kind: "tool", id: "b", name: "bash", args: {}, status: "done", result: { text, details: undefined } },
			false,
		);
		assert.equal(shell.lines.at(-1)?.[0].text, "line20");
		assert.equal(shell.hidden, 15);
		const other = describeToolResult(
			{ kind: "tool", id: "o", name: "x", args: {}, status: "done", result: { text, details: undefined } },
			false,
		);
		assert.equal(other.lines[0][0].text, "line1");
	});
});

describe("formatting and input routing", () => {
	it("formats tokens with 1k = 1000", () => {
		assert.deepEqual([0, 999, 1000, 1250, 12_400, 999_999, 1_500_000, 25_000_000].map(formatTokens), [
			"0",
			"999",
			"1k",
			"1.3k",
			"12k",
			"1000k",
			"1.5M",
			"25M",
		]);
		assert.equal(formatElapsed(185_000), "3m 05s");
		assert.equal(formatAgo(4200), "4s ago");
	});

	it("routes slash commands", () => {
		assert.deepEqual(routeInput("hello"), { kind: "prompt", text: "hello" });
		assert.deepEqual(routeInput("/login"), { kind: "unsupported", name: "login" });
		assert.deepEqual(routeInput("/compact keep tests"), { kind: "rpc", command: "compact", arg: "keep tests" });
		assert.deepEqual(routeInput("/plan build it"), { kind: "prompt", text: "/plan build it" });
		assert.equal(routeInput("   "), undefined);
		assert.equal(routeInput("/thinking nope")?.kind, "usage");
	});
});
