import type { ExtensionAPI } from "../../../core/extensions/types.ts";
import { SUBAGENT_INSTRUCTIONS_SECTION, SUBAGENT_REMINDER } from "../prompts/subagent.ts";

/** Custom message type of the hidden subagent reminder. */
export const SUBAGENT_REMINDER_TYPE = "nek.subagent_reminder";

/**
 * Prompt wiring of a child session (ARD section 3.3): the delegated agent type instructions as a system prompt
 * section and the Cursor subagent reminder before every submission. `task` and `await` are never registered in this
 * role, so delegation cannot nest.
 */
export function registerSubagentPrompts(pi: ExtensionAPI, instructions: string | undefined): void {
	pi.on("before_agent_start", (event) => {
		if (instructions) event.systemPromptOptions.sections[SUBAGENT_INSTRUCTIONS_SECTION] = instructions;
		return { message: { customType: SUBAGENT_REMINDER_TYPE, content: SUBAGENT_REMINDER, display: false } };
	});
}
