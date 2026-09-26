/**
 * Plan implementation panel texts from Codex, reference/codex/codex-rs/tui/src/chatwidget/plan_implementation.rs
 * lines 9-19 and 73-106. "Default" becomes "Agent" and "thread" becomes "session" to match nek's naming.
 */

/** Panel title (plan_implementation.rs line 9). */
export const IMPLEMENT_TITLE = "Implement this plan?";

/** First option (line 10) and its description (line 85). */
export const IMPLEMENT_YES = "Yes, implement this plan";
/** Description of {@link IMPLEMENT_YES}. */
export const IMPLEMENT_YES_DESCRIPTION = "Switch to Agent and start coding";

/** Second option (line 11). */
export const IMPLEMENT_CLEAR_CONTEXT = "Yes, clear context and implement";

/** Third option (line 12). */
export const IMPLEMENT_NO = "No, stay in Plan mode";
/** Description of {@link IMPLEMENT_NO} (line 105). */
export const IMPLEMENT_NO_DESCRIPTION = "Continue planning with the model";

/** User message that starts implementation in the current session (line 13). */
export const IMPLEMENT_PLAN_MESSAGE = "Implement the plan.";

/** Prefix of the first user message of a fresh implementation session (lines 14-19). */
export const IMPLEMENT_FRESH_PREFIX =
	"A previous agent produced the plan below to accomplish the user's task. Implement the plan in a fresh context. Treat the plan as the source of user intent, re-read files as needed, and carry the work through implementation and verification.";

/** Description of {@link IMPLEMENT_CLEAR_CONTEXT}; the usage suffix is omitted when the percentage is unknown. */
export function clearContextDescription(percentUsed: number | undefined): string {
	if (percentUsed === undefined) return "Start a fresh session";
	return `Start a fresh session (current context: ${Math.round(percentUsed)}% used)`;
}

/** First user message of a fresh implementation session: the Codex prefix and the plan file content. */
export function freshImplementMessage(planMarkdown: string): string {
	return `${IMPLEMENT_FRESH_PREFIX}\n\n${planMarkdown}`;
}
