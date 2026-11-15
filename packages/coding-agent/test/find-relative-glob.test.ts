import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createFindToolDefinition } from "../src/core/tools/find.ts";

const temporaryRoot = fileURLToPath(new URL("../../../.tmp/", import.meta.url));
mkdirSync(temporaryRoot, { recursive: true });
const directory = mkdtempSync(join(temporaryRoot, "find-relative-"));
const project = join(directory, "src", "Upper[app]");
for (const name of ["src/a.ts", "src/deep/b.ts", "lib/c.ts", "pkg/src/d.ts"]) {
	mkdirSync(join(project, name, ".."), { recursive: true });
	writeFileSync(join(project, name), "");
}
afterAll(() => rmSync(directory, { recursive: true, force: true }));

async function paths(pattern: string): Promise<string[]> {
	const tool = createFindToolDefinition(project);
	const result = await tool.execute("find", { pattern }, undefined, undefined, undefined as never);
	const text = result.content[0]?.type === "text" ? result.content[0].text : "";
	if (text.startsWith("No files")) return [];
	let parent = "";
	const lines = text.split("\n");
	return lines
		.flatMap((line, index) => {
			if (!line || line.startsWith("[")) return [];
			if (line.startsWith("  ")) return [parent + line.slice(2)];
			if (lines[index + 1]?.startsWith("  ")) {
				parent = line;
				return [];
			}
			parent = "";
			return [line];
		})
		.sort();
}

describe("find path globs", () => {
	it("anchors relative paths without matching ancestors or nested same-name directories", async () => {
		expect(await paths("src/*.ts")).toEqual(["src/a.ts"]);
		expect(await paths("src/**/*.ts")).toEqual(["src/a.ts", "src/deep/b.ts"]);
		expect(await paths("./src/*.ts")).toEqual(["src/a.ts"]);
		expect(await paths("**/src/*.ts")).toEqual(["pkg/src/d.ts", "src/a.ts"]);
		expect(await paths("*.ts")).toHaveLength(4);
	});

	it.skipIf(process.platform !== "win32")("accepts native Windows separators", async () => {
		expect(await paths(String.raw`src\**\*.ts`)).toEqual(["src/a.ts", "src/deep/b.ts"]);
	});

	it("only reports a result limit when more matches exist", async () => {
		const tool = createFindToolDefinition(project, {
			operations: { exists: () => true, glob: () => ["a.ts", "b.ts"] },
		});
		const exact = await tool.execute("find", { pattern: "*.ts", limit: 2 }, undefined, undefined, undefined as never);
		expect(exact.details?.resultLimitReached).toBeUndefined();
		const limited = await tool.execute(
			"find",
			{ pattern: "*.ts", limit: 0 },
			undefined,
			undefined,
			undefined as never,
		);
		expect(limited.details?.resultLimitReached).toBe(1);
		expect(limited.content[0]).toMatchObject({ text: expect.not.stringContaining("b.ts") });
	});
});
