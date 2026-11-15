import type * as ChildProcess from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { createFindToolDefinition } from "../src/core/tools/find.ts";
import type * as PathUtils from "../src/core/tools/path-utils.ts";

const mocks = vi.hoisted(() => ({ controller: new AbortController(), spawn: vi.fn() }));
vi.mock("child_process", async (original) => ({ ...(await original<typeof ChildProcess>()), spawn: mocks.spawn }));
vi.mock("../src/utils/tools-manager.ts", () => ({ ensureTool: async () => "fd" }));
vi.mock("../src/core/tools/path-utils.ts", async (original) => ({
	...(await original<typeof PathUtils>()),
	pathExists: async (path: string) => {
		if (!path.endsWith(".git")) return true;
		mocks.controller.abort();
		return false;
	},
}));

describe("find cancellation while resolving the search root", () => {
	it("does not start an untracked fd after the caller has cancelled", async () => {
		const tool = createFindToolDefinition(process.cwd());
		await expect(
			tool.execute("find", { pattern: "*.ts" }, mocks.controller.signal, undefined, undefined as never),
		).rejects.toThrow("Operation aborted");
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(mocks.spawn).not.toHaveBeenCalled();
	});
});
