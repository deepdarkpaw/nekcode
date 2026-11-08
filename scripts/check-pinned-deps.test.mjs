import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const checker = fileURLToPath(new URL("./check-pinned-deps.mjs", import.meta.url));

test("ignores temporary files and worktrees but checks real project manifests", (t) => {
	const temp = join(process.cwd(), ".tmp");
	mkdirSync(temp, { recursive: true });
	const root = mkdtempSync(join(temp, "pinned-deps-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { foo: "1.2.3" } }));
	for (const directory of [".tmp/foreign", ".worktree/foreign"]) {
		mkdirSync(join(root, directory), { recursive: true });
		writeFileSync(join(root, directory, "package.json"), JSON.stringify({ dependencies: { foo: "^1.0.0" } }));
	}
	const check = () => spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8" });
	assert.equal(check().status, 0);
	mkdirSync(join(root, "packages", "real"), { recursive: true });
	writeFileSync(join(root, "packages", "real", "package.json"), JSON.stringify({ dependencies: { bar: "^2.0.0" } }));
	const result = check();
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /dependencies\.bar must be pinned/u);
});
