/**
 * `<mode_selection>` section body, condensed from reference/cursor/cursor-opus5-agent-system-prompt.txt lines 258-264
 * (the section tag is added by the system prompt builder), without Cursor's push for proactive switching. The detailed
 * rules live in the `switch_mode` description.
 */
export const MODE_SELECTION = `Stay in the current mode unless it clearly does not fit. Propose Plan with \`switch_mode\` when the user asks for a plan, or when the request leaves open decisions that only the user can make and that would substantially change the implementation; a large task with a clear goal stays in Agent. Reassess when the goal changes or repeated attempts are not converging.`;
