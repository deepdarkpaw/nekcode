import type { JsonValue } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../src/core/session-manager.ts";
import { replayBranch } from "../src/extensions/nek/state/session-state.ts";
import { mergeTodos, openTodos, summarizeTodos } from "../src/extensions/nek/state/todos.ts";
import type { Todo } from "../src/extensions/nek/types.ts";

const a = { id: "a", content: "First", status: "completed" } satisfies Todo;
const b = { id: "b", content: "Second", status: "in_progress" } satisfies Todo;
const c = { id: "c", content: "Third", status: "pending" } satisfies Todo;

function toolResultEntry(id: string, toolName: string, details: JsonValue, isError = false): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-09-26T00:00:00.000Z",
		message: {
			role: "toolResult",
			toolCallId: `call-${id}`,
			toolName,
			content: [{ type: "text", text: "ok" }],
			details,
			isError,
			timestamp: 0,
		},
	};
}

function customEntry(id: string, customType: string, data: unknown): SessionEntry {
	return { type: "custom", id, parentId: null, timestamp: "2026-09-26T00:00:00.000Z", customType, data };
}

describe("mergeTodos", () => {
	it("replaces the list when merge is false", () => {
		expect(mergeTodos([a, b], [c], false)).toEqual([c]);
	});

	it("overrides existing items by id and keeps their order", () => {
		const merged = mergeTodos(
			[a, b, c],
			[
				{ ...c, status: "completed" },
				{ ...a, content: "First (edited)" },
			],
			true,
		);
		expect(merged).toEqual([{ ...a, content: "First (edited)" }, b, { ...c, status: "completed" }]);
	});

	it("appends new ids at the end in call order", () => {
		const d: Todo = { id: "d", content: "Fourth", status: "pending" };
		expect(mergeTodos([b, a], [d, c, { ...b, status: "completed" }], true).map((todo) => todo.id)).toEqual([
			"b",
			"a",
			"d",
			"c",
		]);
	});

	it("does not mutate its inputs", () => {
		const current = [{ ...a }];
		mergeTodos(current, [{ ...a, status: "cancelled" }], true);
		expect(current).toEqual([a]);
	});
});

describe("todo summaries", () => {
	it("lists pending and in_progress items as open", () => {
		expect(openTodos([a, b, c, { id: "x", content: "Dropped", status: "cancelled" }])).toEqual([b, c]);
	});

	it("reports completed count and in-progress ids", () => {
		expect(summarizeTodos([a, b, c])).toBe("Todos updated: 1/3 completed. In progress: b");
		expect(summarizeTodos([a, c])).toBe("Todos updated: 1/2 completed.");
	});
});

describe("replayBranch", () => {
	it("starts in agent mode with no todos", () => {
		expect(replayBranch([])).toEqual({ mode: "agent", todos: [], plans: [] });
	});

	it("takes the last todo_write details or nek.todos entry on the branch", () => {
		const entries = [
			toolResultEntry("1", "todo_write", { todos: [a, b] }),
			customEntry("2", "nek.todos", { todos: [c] }),
			toolResultEntry("3", "read", { todos: [a] }),
			customEntry("4", "other", { todos: [a] }),
		];
		expect(replayBranch(entries).todos).toEqual([c]);
		expect(replayBranch(entries.slice(0, 1)).todos).toEqual([a, b]);
	});

	it("ignores failed and malformed todo_write results", () => {
		const entries = [
			toolResultEntry("1", "todo_write", { todos: [a] }),
			toolResultEntry("2", "todo_write", { todos: [b] }, true),
			toolResultEntry("3", "todo_write", { todos: [{ id: "x", content: "Bad", status: "done" }] }),
			customEntry("4", "nek.todos", undefined),
		];
		expect(replayBranch(entries).todos).toEqual([a]);
	});
});
