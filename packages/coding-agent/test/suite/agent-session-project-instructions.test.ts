import { type Context, fauxAssistantMessage, getCurrentSystemPrompt, type Message } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ResourceLoader } from "../../src/core/resource-loader.ts";
import { createTestResourceLoader } from "../utilities.ts";
import { createHarness, type Harness } from "./harness.ts";

const GLOBAL_FILE = { path: "/home/u/.nek/agent/AGENTS.md", content: "Global rule: answer briefly." };
const PROJECT_FILE = { path: "/repo/AGENTS.md", content: "Project rule: run npm run check." };

function loaderWithAgentsFiles(files: Array<{ path: string; content: string }>): ResourceLoader {
	return { ...createTestResourceLoader(), getAgentsFiles: () => ({ agentsFiles: files }) };
}

function messageText(message: Message | undefined): string {
	if (!message || message.role === "system") return "";
	const content = message.content;
	if (typeof content === "string") return content;
	return content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

describe("project instructions message", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("sends AGENTS.md files as a request-only message after the system prompt", async () => {
		const harness = await createHarness({ resourceLoader: loaderWithAgentsFiles([GLOBAL_FILE, PROJECT_FILE]) });
		harnesses.push(harness);
		const requests: Context[] = [];
		const capture = (context: Context) => {
			requests.push(structuredClone(context));
			return fauxAssistantMessage("ok");
		};
		harness.setResponses([capture, capture]);

		await harness.session.prompt("first");
		await harness.session.prompt("second");

		expect(requests).toHaveLength(2);
		for (const request of requests) {
			expect(request.messages[0]?.role).toBe("system");
			const instructions = request.messages[1];
			expect(instructions?.role).toBe("user");
			const text = messageText(instructions);
			expect(text.startsWith("<project_instructions>")).toBe(true);
			expect(text.indexOf(GLOBAL_FILE.content)).toBeLessThan(text.indexOf(PROJECT_FILE.content));
			// The conversation follows the instructions message.
			expect(messageText(request.messages[2])).toBe("first");
			const systemPrompt = getCurrentSystemPrompt(request.messages);
			expect(systemPrompt).not.toContain(PROJECT_FILE.content);
			expect(systemPrompt).toContain("Follow the <project_instructions> message as standing user instructions");
		}
		// The cached prefix is identical across requests: same system message, same instructions message.
		expect(JSON.stringify(requests[1]?.messages.slice(0, 2))).toBe(JSON.stringify(requests[0]?.messages.slice(0, 2)));
		// Never persisted: the transcript holds only the conversation.
		expect(JSON.stringify(harness.sessionManager.getBranch())).not.toContain(PROJECT_FILE.content);
	});

	it("adds no message when there are no context files", async () => {
		const harness = await createHarness({ resourceLoader: loaderWithAgentsFiles([]) });
		harnesses.push(harness);
		let request: Context | undefined;
		harness.setResponses([
			(context) => {
				request = structuredClone(context);
				return fauxAssistantMessage("ok");
			},
		]);

		await harness.session.prompt("hello");

		expect(JSON.stringify(request?.messages)).not.toContain("<project_instructions>");
		expect(messageText(request?.messages[1])).toBe("hello");
	});
});
