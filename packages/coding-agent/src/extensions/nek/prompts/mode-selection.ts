/**
 * Cursor `<mode_selection>` section body, verbatim from
 * reference/cursor/cursor-opus5-agent-system-prompt.txt lines 258-264 (body lines 259-263; the section tag is added
 * by the system prompt builder). Only `SwitchMode` is renamed to `switch_mode`.
 */
export const MODE_SELECTION = `Choose the best interaction mode for the user's current goal before proceeding. Reassess when the goal changes or you're stuck. If another mode would work better, call \`switch_mode\` now and include a brief explanation.

- **Plan**: user asks for a plan, or the task is large/ambiguous or has meaningful trade-offs

Consult the \`switch_mode\` tool description for detailed guidance on each mode and when to use it. Be proactive about switching to the optimal mode—this significantly improves your ability to help the user.`;
