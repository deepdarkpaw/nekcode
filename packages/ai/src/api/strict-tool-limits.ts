import { registerSessionResourceCleanup } from "../session-resources.ts";
import type { Tool } from "../types.ts";

const LIMIT_MESSAGES = [
	"The compiled grammar is too large",
	"Too many strict tools (",
	"Schemas contains too many parameters with union types (",
];
const MAX_SESSIONS = 10_000;
const sessionsOverLimit = new Set<string>();

/** Only preferred strict sampling can be renegotiated; required constraints must never be weakened. */
export function prefersStrictTools(tool: Tool | undefined): boolean {
	return (
		!!tool?.constrainedSampling &&
		tool.constrainedSampling.type === "json_schema" &&
		tool.constrainedSampling.strict === "prefer"
	);
}

/** Recognize provider grammar capacity errors, not arbitrary invalid tool definitions. */
export function isStrictToolLimitError(message: string): boolean {
	return LIMIT_MESSAGES.some((text) => message.includes(text));
}

export function hasExceededStrictToolLimits(sessionId: string | undefined): boolean {
	return sessionId !== undefined && sessionsOverLimit.has(sessionId);
}

/** Remember the negotiated mode until session cleanup, with a hard cap for unmanaged SDK callers. */
export function markStrictToolLimitsExceeded(sessionId: string | undefined): void {
	if (sessionId === undefined) return;
	sessionsOverLimit.add(sessionId);
	if (sessionsOverLimit.size > MAX_SESSIONS) {
		const oldest = sessionsOverLimit.values().next().value;
		if (oldest !== undefined) sessionsOverLimit.delete(oldest);
	}
}

registerSessionResourceCleanup((sessionId) => {
	if (sessionId === undefined) sessionsOverLimit.clear();
	else sessionsOverLimit.delete(sessionId);
});
