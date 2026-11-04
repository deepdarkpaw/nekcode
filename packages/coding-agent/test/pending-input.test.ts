import { describe, expect, it, vi } from "vitest";
import {
	collectPendingMessages,
	extensionCommandName,
	restorePendingInput,
} from "../src/modes/interactive/pending-input.ts";

describe("shared pending input data", () => {
	it("keeps duplicates and mode-local FIFO without mutating either queue", () => {
		const session = { steering: ["a", "a"], followUp: ["b"] };
		const compaction = [
			{ text: "c", mode: "followUp" as const },
			{ text: "a", mode: "steer" as const },
		];
		expect(collectPendingMessages(session, compaction)).toEqual({ steering: ["a", "a", "a"], followUp: ["b", "c"] });
		expect(session.steering).toEqual(["a", "a"]);
		expect(compaction).toHaveLength(2);
	});
	it("leaves an editor untouched for an empty queue and honors an explicit current draft", () => {
		const editor = { getText: vi.fn(() => "original"), setText: vi.fn() };
		expect(restorePendingInput({ steering: [], followUp: [] }, editor)).toBe(0);
		expect(editor.getText).not.toHaveBeenCalled();
		expect(editor.setText).not.toHaveBeenCalled();
		expect(restorePendingInput({ steering: ["a", "a"], followUp: [] }, editor, "replacement")).toBe(2);
		expect(editor.setText).toHaveBeenCalledWith("a\n\na\n\nreplacement");
	});
	it.each([
		["/command arg", "command"],
		["/command", "command"],
		[" /command", undefined],
		["message", undefined],
		["/command\targ", "command\targ"],
	])("preserves command parsing for %s", (text, name) => {
		expect(extensionCommandName(text!)).toBe(name);
	});
});
