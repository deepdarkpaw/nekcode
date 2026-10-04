import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../../../core/extensions/types.ts";
import { TODO_WRITE } from "../prompts/tool-descriptions.ts";
import { TODO_WRITE_TOOL_NAME } from "../state/session-state.ts";
import { mergeTodos, summarizeTodos, TODO_STATUSES } from "../state/todos.ts";
import type { Todo, TodoListData } from "../types.ts";
import { todoWriteRenderers } from "../ui/renderers.ts";

const todoWriteSchema = Type.Object({
	merge: Type.Boolean({
		description:
			"Whether to merge the todos with the existing todos. If true, the todos will be merged into the existing todos based on the id field. You can leave unchanged properties undefined. If false, the new todos will replace the existing todos.",
	}),
	todos: Type.Array(
		Type.Object({
			id: Type.String({ description: "Unique identifier for the TODO item" }),
			content: Type.String({ description: "The description/content of the TODO item" }),
			status: StringEnum(TODO_STATUSES, { description: "The current status of the TODO item" }),
		}),
		{ minItems: 2, description: "Array of TODO items to update or create" },
	),
});

/** Validated todo_write arguments. */
export type TodoWriteToolInput = Static<typeof todoWriteSchema>;

/** Access to the branch-scoped todo list owned by the extension. */
export interface TodoWriteToolOptions {
	getTodos(): readonly Todo[];
	/** Ownership comes from the runtime, not from model-supplied tool arguments. */
	getOwner?(): TodoListData["owner"];
	/** Store the merged list and refresh the UI. */
	setTodos(todos: Todo[], ctx: ExtensionContext, owner: TodoListData["owner"]): void;
}

/**
 * Cursor TodoWrite as `todo_write` (description and schema from reference/cursor/cursor-tools-2026.json).
 * The result text is a short summary; the full list is in `details.todos`, which replayBranch() reads back.
 */
export function createTodoWriteToolDefinition(
	options: TodoWriteToolOptions,
): ToolDefinition<typeof todoWriteSchema, TodoListData | undefined> {
	return {
		name: TODO_WRITE_TOOL_NAME,
		label: "Todos",
		description: TODO_WRITE,
		parameters: todoWriteSchema,
		executionMode: "sequential",
		async execute(_toolCallId, { merge, todos }: TodoWriteToolInput, _signal, _onUpdate, ctx) {
			const next = mergeTodos(options.getTodos(), todos, merge);
			const owner = options.getOwner?.();
			options.setTodos(next, ctx, owner);
			return {
				content: [{ type: "text", text: summarizeTodos(next) }],
				details: { todos: next, ...(owner ? { owner } : {}) },
			};
		},
		...todoWriteRenderers,
	};
}
