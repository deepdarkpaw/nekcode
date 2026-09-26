/**
 * Cursor TodoWrite description, verbatim from reference/cursor/cursor-tools-2026.json line 753
 * (identical in cursor-grok46-system-prompt-with-tools.txt).
 */
export const TODO_WRITE = "Use this tool to create and manage a structured task list for your current coding session.";

/**
 * Cursor SwitchMode description, verbatim from reference/cursor/cursor-tools-2026.json line 656 without the
 * "Debug Mode" and "Ask Mode" subsections (nek has only agent and plan).
 */
export const SWITCH_MODE = `Switch the interaction mode to better match the current task. Each mode is optimized for a specific type of work.

## When to Switch Modes

Switch modes proactively when:
1. **Task type changes** - User shifts from asking questions to requesting implementation, or vice versa
2. **Complexity emerges** - What seemed simple reveals architectural decisions or multiple approaches
3. **Debugging needed** - An error, bug, or unexpected behavior requires investigation
4. **Planning needed** - The task is large, ambiguous, or has significant trade-offs to discuss
5. **You're stuck** - Multiple attempts without progress suggest a different approach is needed

## When NOT to Switch

Do NOT switch modes for:
- Simple, clear tasks that can be completed quickly in current mode
- Mid-implementation when you're making good progress
- Minor clarifying questions (just ask them)
- Tasks where the current mode is working well

## Available Modes

### Agent Mode [switchable]
Default implementation mode with full access to all tools for making changes.

**Switch to Agent when:**
- You have a clear understanding of what to implement
- Planning/debugging is complete and you're ready to code
- The task is straightforward with an obvious implementation
- You've gathered enough context and are ready to execute

**Examples:**
- After planning: "I've designed the approach, ready to implement" → Switch to Agent
- After debugging: "Found the bug, it's a null check issue" → Switch to Agent
- Simple task: User asks to "Add a comment to this function" → Stay in Agent (no switch needed)

### Plan Mode [switchable]
Read-only collaborative mode for designing implementation approaches before coding.

**Switch to Plan when:**
- The task has multiple valid approaches with significant trade-offs
- Architectural decisions are needed (e.g., "Add caching" - Redis vs in-memory vs file-based)
- The task touches many files or systems (large refactors, migrations)
- Requirements are unclear and you need to explore before understanding scope
- You would otherwise ask multiple clarifying questions

**Examples:**
- User: "Add user authentication" → Switch to Plan (session vs JWT, storage, middleware decisions)
- User: "Refactor the database layer" → Switch to Plan (large scope, architectural impact)
- User: "Make the app faster" → Switch to Plan (need to profile, multiple optimization strategies)

## Important Notes

- **Be proactive**: Don't wait for the user to ask you to switch modes
- **Explain briefly**: When switching, briefly explain why in your \`explanation\` parameter
- **Don't over-switch**: If the current mode is working, stay in it
- **User approval required**: Mode switches require user consent`;

/**
 * Cursor CreatePlan description, verbatim from reference/cursor/cursor-tools-2026.json line 204.
 * `CreatePlan` and `AskQuestion` are renamed to `create_plan` and `ask_question`.
 */
export const CREATE_PLAN = `Use this tool to create or revise a concise plan for accomplishing the user's request. This tool should be called at the end of the planning phase to finalize and store the plan.

The plan you create should be properly formatted in markdown, using appropriate sections and headers. The plan should be very concise and actionable, providing the minimum amount of detail for the user to understand and action the plan. It may be helpful to identify the most important couple files you will change, and existing code you will leverage. Cite specific file paths and essential snippets of code. IMPORTANT: Do NOT use markdown tables in plan content (they cannot be rendered for the user); use bullet lists instead. The first line MUST BE A TITLE for the plan formatted as a level 1 markdown heading.

TASK ORGANIZATION:

Use 'todos' for organizing implementation tasks:
- Each todo should be a clear, specific, and actionable task
- Each todo needs a unique ID (e.g., "setup-auth") and descriptive content
- If the plan is simple, provide just a few high-level todos or none at all

UPDATING THE PLAN:
- The plan file URI will be returned in the tool result
- If a current plan already exists, call this tool with the complete revised plan and omit the name field
- Only the first create_plan call may include name; later calls must not include name and must not use name to rename or create a separate plan
- If the user asks for a separate new plan while a current plan exists, explain the limitation or ask how to proceed before calling create_plan again

Additional guidelines:
- Avoid asking clarifying questions in the plan itself. Ask them before calling this tool. Present these to the user using the ask_question tool.
- Todos help break down complex plans into manageable, trackable tasks
- Focus on high-level meaningful decisions rather than low-level implementation details
- A good plan is glanceable, not a wall of text.`;

/** Cursor AskQuestion description, verbatim from reference/cursor/cursor-tools-2026.json line 7. */
export const ASK_QUESTION = `Collect structured multiple-choice answers from the user. Use this tool only when you are blocked on a decision that is genuinely the user's to make: one you cannot resolve from the request, the code, or sensible defaults.

Usage notes:
- Each question should have at least 2 options for the user to choose from
- Users will always be able to select "Other" to provide custom text input
- Use allow_multiple: true to allow multiple answers to be selected for a question
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label

Prefer this tool over listing options in your final response text (as letters, numbers, bullet points, etc).`;
