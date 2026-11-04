import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execCommand } from "../src/core/exec.ts";
import type { ProjectTrustContext } from "../src/core/extensions/types.ts";
import { resolveProjectTrusted } from "../src/core/project-trust.ts";
import { sessionCwdMatches } from "../src/core/session-entries.ts";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";
import { Bm25Ranker, tokenize } from "../src/extensions/tool-search/tool.ts";
import { getPathComparisonKey, isPathWithin, pathsEqual } from "../src/utils/paths.ts";

const roots: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("exec output safety", () => {
	it("retains spawn errors", async () => {
		const result = await execCommand("nek-missing-executable-regression", [], process.cwd());
		expect(result.code).not.toBe(0);
		expect(result.stderr).toMatch(/ENOENT/);
	});
	it("decodes split UTF-8 without replacement characters", async () => {
		const script =
			'const b=Buffer.from("你好😀");let i=0;const t=setInterval(()=>{process.stdout.write(b.subarray(i,i+1));if(++i===b.length)clearInterval(t)},5)';
		const result = await execCommand(process.execPath, ["-e", script], process.cwd());
		expect(result).toMatchObject({ stdout: "你好😀", code: 0, killed: false, truncated: false });
	});
	it("bounds combined stdout/stderr and fails instead of reporting truncated success", async () => {
		const result = await execCommand(
			process.execPath,
			["-e", 'process.stdout.write("x".repeat(4096));setInterval(()=>{},1000)'],
			process.cwd(),
			{ maxBuffer: 100, timeout: 10000 },
		);
		expect(result).toMatchObject({ killed: true, truncated: true });
		expect(result.code).not.toBe(0);
		expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(100);
	});
	it("does not flush an incomplete UTF-8 suffix at the cap", async () => {
		const result = await execCommand(process.execPath, ["-e", 'process.stdout.write("你好");'], process.cwd(), {
			maxBuffer: 4,
		});
		expect(result.stdout).toBe("你");
		expect(result.truncated).toBe(true);
	});
	it.each([-1, 0.5, Number.NaN])("rejects invalid maxBuffer %s before spawn", async (maxBuffer) => {
		await expect(execCommand("not-run", [], process.cwd(), { maxBuffer })).rejects.toThrow(RangeError);
	});
});

describe("trust and Windows comparison", () => {
	it("honors a stored denial without project resources", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "nek-trust-regression-"));
		roots.push(cwd);
		const trustStore = new ProjectTrustStore(join(cwd, "agent"));
		trustStore.set(cwd, false);
		const select = vi.fn();
		const projectTrustContext = { ui: { select } } as unknown as ProjectTrustContext;
		expect(await resolveProjectTrusted({ cwd, trustStore, projectTrustContext })).toBe(false);
		expect(select).not.toHaveBeenCalled();
	});
	it("folds case only for Windows comparison, respecting segment boundaries", () => {
		vi.spyOn(process, "platform", "get").mockReturnValue("win32");
		expect(pathsEqual("C:\\Work\\Project", "c:/work/project")).toBe(true);
		expect(isPathWithin("C:/Work", "c:/work/project")).toBe(true);
		expect(isPathWithin("C:/Work", "C:/Worker")).toBe(false);
		expect(sessionCwdMatches("C:/Work/Project", "c:\\work\\project")).toBe(true);
		vi.spyOn(process, "platform", "get").mockReturnValue("linux");
		expect(getPathComparisonKey("/Work")).toBe("/Work");
		expect(pathsEqual("/Work", "/work")).toBe(false);
	});
});

describe("deferred tool discovery", () => {
	it("segments Chinese descriptions and preserves normalized accented words", () => {
		expect(tokenize("搜索文件").length).toBeGreaterThan(0);
		expect(tokenize("café")).toEqual(tokenize("cafe\u0301"));
		const matches = new Bm25Ranker().rank(
			"搜索",
			[
				{ name: "find", text: "搜索文件" },
				{ name: "other", text: "写入文件" },
			],
			8,
		);
		expect(matches.map((match) => match.name)).toEqual(["find"]);
	});
	it("prioritizes exact tool names, then coverage, then weighted names", () => {
		const ranker = new Bm25Ranker();
		const docs = [
			{ name: "mcp__app__window", text: "Window" },
			{ name: "capture", text: "Screenshot window" },
		];
		expect(ranker.rank("screenshot window", docs, 8)[0].name).toBe("capture");
		expect(ranker.rank("window", docs, 8)[0].name).toBe("mcp__app__window");
		expect(
			ranker.rank(
				"app window",
				[
					{ name: "mcp__app__window", text: "x ".repeat(500) },
					{ name: "noise", text: "app window ".repeat(100) },
				],
				8,
			)[0].name,
		).toBe("mcp__app__window");
	});
});
