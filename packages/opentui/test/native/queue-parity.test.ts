import { describe, expect, test } from "bun:test";
import { InteractiveMode } from "@earendil-works/pi-coding-agent/modes/interactive/interactive-mode";
import { OpenTuiMode } from "../../src/mode/opentui-mode.ts";

type Queued = { text: string; mode: "steer" | "followUp" };

function adapter(queue: Queued[], fail?: string) {
	const trace: unknown[] = [];
	let text = "draft";
	const editor = {
		getText: () => text,
		setText: (value: string) => {
			text = value;
			trace.push(["editor", value]);
		},
		addToHistory: (value: string) => trace.push(["history", value]),
	};
	const send = (kind: string) => async (value: string, options?: unknown) => {
		trace.push([kind, value, options]);
		if (kind === fail) throw new Error("send failed");
	};
	const mode = {
		compactionQueuedMessages: queue.map((message) => ({ ...message })),
		editor,
		currentEditor: editor,
		session: {
			prompt: send("prompt"),
			steer: send("steer"),
			followUp: send("followUp"),
			clearQueue: () => {
				trace.push(["clear"]);
				return { steering: ["same", "same"], followUp: ["later"] };
			},
			abort: async () => {
				trace.push(["abort"]);
			},
			getSteeringMessages: () => ["same", "same"],
			getFollowUpMessages: () => ["later"],
		},
		isExtensionCommand: (value: string) => value.startsWith("/command"),
		updatePendingMessagesDisplay: () => trace.push(["changed"]),
		showError: (value: string) => trace.push(["error", value]),
		showStatus: (value: string) => trace.push(["status", value]),
	};
	return { mode, trace, text: () => text };
}

const cases: Queued[][] = [
	[],
	[
		{ text: "same", mode: "steer" },
		{ text: "same", mode: "steer" },
		{ text: "later", mode: "followUp" },
	],
	[
		{ text: "/command before", mode: "steer" },
		{ text: "request", mode: "followUp" },
		{ text: "/command after", mode: "steer" },
	],
	[
		{ text: "/command a", mode: "steer" },
		{ text: "/command b", mode: "followUp" },
	],
];

describe("native queue adapter parity", () => {
	for (const willRetry of [false, true])
		for (const [index, queue] of cases.entries()) {
			test(`same delivery order for case ${index}, retry=${willRetry}`, async () => {
				const left = adapter(queue);
				const right = adapter(queue);
				await Reflect.get(InteractiveMode.prototype, "flushCompactionQueue").call(left.mode, { willRetry });
				await Reflect.get(OpenTuiMode.prototype, "flushCompactionQueue").call(right.mode, { willRetry });
				await Promise.resolve();
				expect(right.trace).toEqual(left.trace);
				expect(right.mode.compactionQueuedMessages).toEqual([]);
				expect(left.mode.compactionQueuedMessages).toEqual([]);
				const deliveries = left.trace.filter(
					(item) => Array.isArray(item) && ["prompt", "steer", "followUp"].includes(item[0]),
				);
				expect(deliveries).toHaveLength(queue.length);
				const first = queue.findIndex((message) => !message.text.startsWith("/command"));
				expect(deliveries).toEqual(
					queue.map((message, position) => {
						if (message.text.startsWith("/command")) return ["prompt", message.text, undefined];
						if (!willRetry && position === first)
							return ["prompt", message.text, { streamingBehavior: message.mode }];
						return [message.mode, message.text, undefined];
					}),
				);
			});
		}
	for (const fail of ["prompt", "steer", "followUp"])
		test(`restores the same queue when ${fail} fails`, async () => {
			const queue = cases[1];
			const left = adapter(queue, fail);
			const right = adapter(queue, fail);
			await Reflect.get(InteractiveMode.prototype, "flushCompactionQueue").call(left.mode);
			await Reflect.get(OpenTuiMode.prototype, "flushCompactionQueue").call(right.mode);
			await Promise.resolve();
			expect(right.trace).toEqual(left.trace);
			expect(left.mode.compactionQueuedMessages).toEqual(queue);
			expect(right.mode.compactionQueuedMessages).toEqual(queue);
			expect(left.trace).toContainEqual(["error", "Failed to send queued messages: send failed"]);
		});
	test("restores duplicate inputs and draft in the same order and always routes abort", () => {
		const outputs = [];
		for (const prototype of [InteractiveMode.prototype, OpenTuiMode.prototype]) {
			const state = adapter([{ text: "compacted", mode: "steer" }]);
			const mode = Object.assign(state.mode, {
				clearAllQueues: () => Reflect.get(prototype, "clearAllQueues").call(state.mode),
			});
			const count = Reflect.get(prototype, "restoreQueuedMessagesToEditor").call(mode, { abort: true });
			expect(count).toBe(4);
			outputs.push(state.trace);
			expect(state.text()).toBe("same\n\nsame\n\ncompacted\n\nlater\n\ndraft");
		}
		expect(outputs[1]).toEqual(outputs[0]);
	});
	test("keeps history/editor/status order when input is queued during compaction", () => {
		const left = adapter([]);
		const right = adapter([]);
		Reflect.get(InteractiveMode.prototype, "queueCompactionMessage").call(left.mode, "queued", "followUp");
		Reflect.get(OpenTuiMode.prototype, "queueCompactionMessage").call(right.mode, "queued", "followUp");
		expect(right.trace).toEqual(left.trace);
		expect(right.mode.compactionQueuedMessages).toEqual([{ text: "queued", mode: "followUp" }]);
	});
});
