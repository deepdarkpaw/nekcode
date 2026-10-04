import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { openaiCodexOAuth } from "../src/auth/oauth/openai-codex.ts";

describe("OpenAI OAuth callback port", () => {
	// Upstream eeac84ca9, adapted to the fork's OpenAI Codex browser flow.
	it("rejects an occupied callback port before showing the browser URL", async () => {
		const server = createServer();
		await new Promise<void>((resolve, reject) => server.once("error", reject).listen(1455, "127.0.0.1", resolve));
		const notify = vi.fn();
		try {
			await expect(
				openaiCodexOAuth.login({
					signal: new AbortController().signal,
					prompt: async () => "browser",
					notify,
				}),
			).rejects.toThrow("Port 1455 is in use");
			expect(notify).not.toHaveBeenCalled();
		} finally {
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		}
	});
});
