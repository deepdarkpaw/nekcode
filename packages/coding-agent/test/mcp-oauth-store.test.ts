import { describe, expect, it } from "vitest";
import { InMemoryAuthStorageBackend } from "../src/core/auth-storage.ts";
import { McpOAuthCredentialStore } from "../src/extensions/mcp/oauth.ts";

const SERVER_URL = "https://mcp.example.com/mcp";

function state(accessToken: string) {
	return { serverUrl: SERVER_URL, tokens: { access_token: accessToken, token_type: "Bearer" } };
}

describe("MCP OAuth credential store", () => {
	// https://github.com/earendil-works/pi/issues/10252
	it("keeps separate credentials for servers sharing a SERVER_URL", async () => {
		const store = new McpOAuthCredentialStore(new InMemoryAuthStorageBackend());
		await store.forServer("work", SERVER_URL).save(state("work-token"));
		await store.forServer("personal", SERVER_URL).save(state("personal-token"));

		expect((await store.forServer("work", SERVER_URL).load())?.tokens?.access_token).toBe("work-token");
		expect((await store.forServer("personal", SERVER_URL).load())?.tokens?.access_token).toBe("personal-token");

		expect(store.remove("work", SERVER_URL)).toBe(true);
		expect(await store.forServer("work", SERVER_URL).load()).toBeUndefined();
		expect(store.tokens("personal", SERVER_URL)?.access_token).toBe("personal-token");
	});

	it("keeps separate credentials when a server URL changes", async () => {
		const store = new McpOAuthCredentialStore(new InMemoryAuthStorageBackend());
		const otherUrl = "https://other.example/mcp";
		await store.forServer("work", SERVER_URL).save(state("old-token"));
		await store.forServer("work", otherUrl).save({ ...state("new-token"), serverUrl: otherUrl });
		expect(store.tokens("work", SERVER_URL)?.access_token).toBe("old-token");
		expect(store.tokens("work", otherUrl)?.access_token).toBe("new-token");
		expect(store.tokens("work", "https://third.example/mcp")).toBeUndefined();
	});
});
