import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { buildBackendCommand, findBun, getOpenTuiEntryPath, stripUiFlag } from "../src/cli/opentui-launcher.ts";

function lookup(files: string[], env: NodeJS.ProcessEnv, platform: NodeJS.Platform = "linux") {
	const set = new Set(files);
	return { env, platform, home: "/home/me", exists: (path: string) => set.has(path) };
}

describe("--ui flag", () => {
	test("parses tui and opentui and rejects other values", () => {
		expect(parseArgs(["--ui", "opentui"]).ui).toBe("opentui");
		expect(parseArgs(["--ui=tui"]).ui).toBe("tui");
		expect(parseArgs(["--ui", "web"]).diagnostics[0]?.message).toContain("Invalid UI");
		expect(parseArgs(["--ui"]).diagnostics[0]?.message).toContain("--ui requires");
	});

	test("is removed from the forwarded backend arguments", () => {
		expect(stripUiFlag(["--model", "x", "--ui", "opentui", "-c"])).toEqual(["--model", "x", "-c"]);
		expect(stripUiFlag(["--ui=opentui", "--", "--ui", "literal"])).toEqual(["--", "--ui", "literal"]);
	});

	test("builds the backend command from the Node runtime and CLI path", () => {
		const command = buildBackendCommand(
			["--ui", "opentui", "--continue"],
			"/usr/bin/node",
			["--import", "./resolver.ts"],
			"/repo/cli.ts",
		);
		expect(command).toEqual([
			"/usr/bin/node",
			"--import",
			"./resolver.ts",
			"/repo/cli.ts",
			"--mode",
			"rpc",
			"--continue",
		]);
	});

	test("finds the frontend entry next to the coding-agent package", () => {
		expect(getOpenTuiEntryPath().replace(/\\/g, "/")).toMatch(/packages\/opentui\/src\/main\.ts$/);
	});
});

describe("findBun", () => {
	test("prefers NEK_BUN, then PATH, then ~/.bun/bin", () => {
		const fallback = join("/home/me", ".bun", "bin", "bun");
		const onPath = join("/opt/bin", "bun");
		expect(findBun(lookup(["/custom/bun", onPath, fallback], { NEK_BUN: "/custom/bun", PATH: "/opt/bin" }))).toBe(
			"/custom/bun",
		);
		expect(findBun(lookup([onPath, fallback], { PATH: `/usr/bin:/opt/bin` }))).toBe(onPath);
		expect(findBun(lookup([fallback], { PATH: "/usr/bin" }))).toBe(fallback);
		expect(findBun(lookup([], { PATH: "/usr/bin" }))).toBeUndefined();
	});

	test("does not fall back when NEK_BUN points to a missing file", () => {
		expect(findBun(lookup([join("/opt/bin", "bun")], { NEK_BUN: "/missing/bun", PATH: "/opt/bin" }))).toBeUndefined();
	});

	test("looks for bun.exe on Windows", () => {
		const exe = join("C:\\tools", "bun.exe");
		expect(findBun(lookup([exe], { Path: "C:\\tools" }, "win32"))).toBe(exe);
		const fallback = join("/home/me", ".bun", "bin", "bun.exe");
		expect(findBun(lookup([fallback], { Path: "" }, "win32"))).toBe(fallback);
	});
});
