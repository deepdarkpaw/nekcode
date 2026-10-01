import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../../../core/extensions/types.ts";
import { ASK_QUESTION } from "../prompts/tool-descriptions.ts";
import { ASK_QUESTION_TOOL_NAME } from "../state/session-state.ts";
import type { AskQuestionData, QuestionAnswer } from "../types.ts";
import { askQuestion } from "../ui/question-dialog.ts";

const askQuestionSchema = Type.Object({
	questions: Type.Array(
		Type.Object({
			allow_multiple: Type.Optional(
				Type.Boolean({ description: "If true, user can select multiple options. Defaults to false." }),
			),
			id: Type.String({ description: "Unique identifier for this question" }),
			options: Type.Array(
				Type.Object({
					id: Type.String({ description: "Unique identifier for this option" }),
					label: Type.String({ description: "Display text for this option" }),
				}),
				{ description: "Array of answer options (minimum 2 required)", minItems: 2 },
			),
			prompt: Type.String({ description: "The question text to display to the user, without the options." }),
		}),
		{ description: "Array of questions to present to the user (minimum 1 required)", minItems: 1 },
	),
	title: Type.Optional(Type.String({ description: "Optional title for the questions form" })),
});

/** Validated ask_question arguments. */
export type AskQuestionToolInput = Static<typeof askQuestionSchema>;

/** Result text when no dialog UI is available (Codex default-mode semantics). */
export const NO_UI_ANSWER_TEXT =
	"No answers were collected (non-interactive). Proceed with the recommended option for each question and record it as an assumption.";

/** Result text when the user dismisses a question; the run ends so the user can respond. */
export const DISMISSED_ANSWER_TEXT = "User dismissed the questions.";

/** One line per answer, e.g. `q1: Redis, In-memory; other: use both`. */
export function formatAnswers(answers: readonly QuestionAnswer[]): string {
	return answers
		.map((answer) => {
			const parts = [...answer.labels];
			if (answer.other) parts.push(`other: ${answer.other}`);
			return `${answer.questionId}: ${parts.length > 0 ? parts.join(", ") : "(no selection)"}`;
		})
		.join("\n");
}

function textResult(text: string, answers: QuestionAnswer[], terminate = false) {
	return { content: [{ type: "text" as const, text }], details: { answers }, terminate };
}

/**
 * Cursor AskQuestion as `ask_question` (description and schema from reference/cursor/cursor-tools-2026.json). Asks
 * the questions one after another; a dismissed question ends the run. Without dialog UI the model is told to proceed
 * with the recommended options.
 */
export function createAskQuestionToolDefinition(): ToolDefinition<typeof askQuestionSchema, AskQuestionData> {
	return {
		name: ASK_QUESTION_TOOL_NAME,
		label: "ask_question",
		description: ASK_QUESTION,
		parameters: askQuestionSchema,
		executionMode: "sequential",
		async execute(_toolCallId, { questions, title }: AskQuestionToolInput, signal, _onUpdate, ctx) {
			signal?.throwIfAborted();
			if (!ctx.hasUI) return textResult(NO_UI_ANSWER_TEXT, []);
			const answers: QuestionAnswer[] = [];
			for (const question of questions) {
				const answer = await askQuestion(ctx, question, title, signal);
				signal?.throwIfAborted();
				if (!answer) return textResult(DISMISSED_ANSWER_TEXT, answers, true);
				answers.push(answer);
			}
			return textResult(formatAnswers(answers), answers);
		},
	};
}
