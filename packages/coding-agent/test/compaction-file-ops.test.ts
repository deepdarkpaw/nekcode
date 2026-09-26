import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { computeFileLists, createFileOps, extractFileOpsFromMessage } from "../src/core/compaction/utils.ts";

function assistantWithToolCalls(calls: Array<{ name: string; arguments: Record<string, unknown> }>): AgentMessage {
	return {
		role: "assistant",
		content: calls.map((call, index) => ({ type: "toolCall", id: `call-${index}`, ...call })),
	} as AgentMessage;
}

describe("extractFileOpsFromMessage", () => {
	it("tracks edit calls that use the Claude Code file_path argument", () => {
		const fileOps = createFileOps();
		extractFileOpsFromMessage(
			assistantWithToolCalls([
				{ name: "read", arguments: { path: "src/a.ts" } },
				{ name: "edit", arguments: { file_path: "src/b.ts", old_string: "x", new_string: "y" } },
				{ name: "write", arguments: { path: "src/c.ts", content: "" } },
			]),
			fileOps,
		);

		expect([...fileOps.edited]).toEqual(["src/b.ts"]);
		expect(computeFileLists(fileOps)).toEqual({ readFiles: ["src/a.ts"], modifiedFiles: ["src/b.ts", "src/c.ts"] });
	});
});
