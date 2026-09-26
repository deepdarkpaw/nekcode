import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildReadOutline, clearReadOutlineCache, renderReadOutline } from "../src/core/tools/read-outline.ts";
import { getToolPath } from "../src/utils/tools-manager.ts";

describe("read outline", () => {
	const directories: string[] = [];

	afterEach(() => {
		clearReadOutlineCache();
		for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	});

	it("returns no outline when ast-grep is unavailable", async () => {
		const outline = await buildReadOutline("missing.ts", "const value = 1;", {
			ensureBinary: async () => null,
		});

		expect(outline).toBeUndefined();
	});

	it.skipIf(!getToolPath("ast-grep"))("renders nested symbols and adjacent documentation", async () => {
		const directory = mkdtempSync(join(tmpdir(), "read-outline-"));
		directories.push(directory);
		const path = join(directory, "nested.ts");
		const content = [
			"/** The container. */",
			"class Container {",
			"  /** The method. */",
			"  method() {",
			"    return 1;",
			"  }",
			"}",
		].join("\n");
		writeFileSync(path, content);

		const outline = await buildReadOutline(path, content, {
			ensureBinary: async () => getToolPath("ast-grep"),
			cacheKey: path,
		});

		expect(outline).toBeDefined();
		expect(renderReadOutline(outline?.symbols ?? [])).toContain("(class) Container");
		expect(renderReadOutline(outline?.symbols ?? [])).toContain("    method() {");
		expect(outline?.text).toContain("DESCRIPTION:");
	});
});
