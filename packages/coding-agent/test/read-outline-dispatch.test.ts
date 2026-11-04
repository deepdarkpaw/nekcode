import { afterEach, describe, expect, it, vi } from "vitest";
import { createReadTool } from "../src/core/tools/read.ts";
import { buildReadOutline } from "../src/core/tools/read-outline.ts";
import { createReadStateStore } from "../src/core/tools/read-state.ts";

vi.mock("../src/core/tools/read-outline.ts", () => ({ buildReadOutline: vi.fn(async () => undefined) }));
afterEach(() => vi.clearAllMocks());

describe("read outline dispatch", () => {
	it.each([
		["x".repeat(9999), {}, 0],
		["中".repeat(10000), {}, 0],
		["x".repeat(10001), {}, 1],
		["x".repeat(10001), { offset: 1 }, 0],
		["x".repeat(10001), { limit: 0 }, 0],
		["x".repeat(10001), { offset: -1, limit: 1 }, 0],
	] as const)("parses only an unranged source above the UTF-16 threshold: %#", async (content, range, calls) => {
		const readState = createReadStateStore();
		const tool = createReadTool(process.cwd(), {
			readState,
			operations: {
				access: async () => {},
				readFile: async () => Buffer.from(content),
				stat: async () => ({ mtimeMs: 7 }),
			},
		});
		const result = await tool.execute("read", { path: "fixture.ts", ...range });
		expect(buildReadOutline).toHaveBeenCalledTimes(calls);
		expect(result.details?.representation).toBe(calls ? "50-line" : "full");
		expect(readState.get(`${process.cwd()}/fixture.ts`)?.content).toBe(content);
	});
});
