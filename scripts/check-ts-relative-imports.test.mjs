import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const workspace = fileURLToPath(new URL("../", import.meta.url));
const checker = fileURLToPath(new URL("./check-ts-relative-imports.mjs", import.meta.url));

test("relative import check skips workspace scratch copies but still validates real source", () => {
	const parent = join(workspace, ".tmp");
	mkdirSync(parent, { recursive: true });
	const dir = mkdtempSync(join(parent, "import-check-"));
	try {
		writeFileSync(join(dir, "valid.ts"), "export const value = 1;\n");
		for (const name of [".tmp", ".worktree", ".artifacts"]) {
			mkdirSync(join(dir, name));
			writeFileSync(join(dir, name, "ignored.ts"), 'import "./ignored.js";\n');
		}
		const run = () => spawnSync(process.execPath, [checker], { cwd: dir, encoding: "utf8", timeout: 15000 });
		const clean = run();
		assert.equal(clean.status, 0, clean.stderr);
		writeFileSync(join(dir, "invalid.ts"), 'import "./invalid.js";\n');
		const invalid = run();
		assert.equal(invalid.status, 1);
		assert.match(invalid.stderr, /invalid\.ts:1:/);
		assert.doesNotMatch(invalid.stderr, /ignored\.ts/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
