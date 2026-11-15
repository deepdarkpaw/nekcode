import { fauxAssistantMessage, registerSessionResourceCleanup } from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { chatSetup, openChat } from "./chat-support.ts";
import { context } from "./session-support.ts";

describe("Harness provider resource ownership", () => {
	it("cleans only identities actually used by the closing harness", async () => {
		const cleaned: Array<string | undefined> = [];
		const used: string[] = [];
		const unregister = registerSessionResourceCleanup((id) => cleaned.push(id));
		const setup = chatSetup();
		setup.faux.setResponses(
			[0, 1].map(() => (_ctx, options) => {
				used.push(options!.sessionId!);
				return fauxAssistantMessage("ok");
			}),
		);
		const first = await openChat(new MemoryStorage(), setup);
		const second = await openChat(new MemoryStorage(), setup);
		try {
			for (const { root } of [first, second]) {
				await (await root.submit({ type: "input", content: "fixture" }, context)).wait(context);
				await root.waitForIdle(context);
			}
			expect(used).toHaveLength(2);
			expect(used[0]).not.toBe(used[1]);
			await first.harness.close(context);
			expect(cleaned).toEqual([used[0]]);
			await second.harness.close(context);
			expect(cleaned).toEqual(used);
		} finally {
			await first.harness.close(context);
			await second.harness.close(context);
			unregister();
		}
	});

	it("reports cleanup failures without preventing storage closure", async () => {
		const setup = chatSetup();
		setup.faux.setResponses([fauxAssistantMessage("ok")]);
		const storage = new MemoryStorage();
		const { harness, root } = await openChat(storage, setup);
		const unregister = registerSessionResourceCleanup(() => {
			throw new Error("cleanup failed");
		});
		try {
			await (await root.submit({ type: "input", content: "fixture" }, context)).wait(context);
			await root.waitForIdle(context);
			await harness.close(context);
			expect(setup.reports).toContainEqual(
				expect.objectContaining({ message: "Failed to cleanup session resources" }),
			);
			await expect(storage.task(1 as never, context)).rejects.toThrow();
		} finally {
			unregister();
			await harness.close(context);
		}
	});
});
