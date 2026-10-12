import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

/** `session.agent` holds state only on the durable engine; these are the parts of it that still act. */
describe("AgentSession agent compatibility", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("delivers loop events to agent.subscribe listeners and awaits them", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("hello")]);
		const seen: string[] = [];
		let pending = 0;
		harness.session.agent.subscribe(async (event) => {
			pending++;
			await new Promise((resolve) => setTimeout(resolve, 1));
			seen.push(event.type);
			pending--;
		});

		await harness.session.prompt("hi");

		expect(seen).toContain("agent_start");
		expect(seen).toContain("message_end");
		expect(seen.at(-1)).toBe("agent_end");
		expect(seen).not.toContain("agent_settled");
		expect(pending).toBe(0);
	});

	it("sends requests with the agent's transport", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const transports: unknown[] = [];
		harness.setResponses([
			(_context, options) => {
				transports.push(options?.transport);
				return fauxAssistantMessage("ok");
			},
		]);
		harness.session.agent.transport = "websocket";

		await harness.session.prompt("hi");

		expect(transports).toEqual(["websocket"]);
	});
});
