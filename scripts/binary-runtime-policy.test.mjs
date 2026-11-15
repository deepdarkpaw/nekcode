import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const packageJson = JSON.parse(readFileSync(join(root, "packages/coding-agent/package.json"), "utf8"));
const buildCommand = packageJson.scripts["build:binary"];
const flags = ["--no-compile-autoload-bunfig", "--no-compile-autoload-dotenv", "--compile-autoload-package-json"];

test("all binary build entrypoints isolate dotenv and resolve package main/exports", () => {
	const release = readFileSync(join(root, "scripts/build-binaries.sh"), "utf8");
	for (const command of [buildCommand, ...release.split("\n").filter((line) => line.includes("bun build --compile"))]) {
		for (const flag of flags) assert.ok(command.includes(flag), `missing ${flag}`);
	}
});

const hasBun = spawnSync("bun", ["--version"], { encoding: "utf8", timeout: 10000 }).status === 0;
test("compiled runtime ignores project dotenv and loads a package entrypoint", { skip: !hasBun, timeout: 45000 }, () => {
	const tempRoot = join(root, ".tmp");
	mkdirSync(tempRoot, { recursive: true });
	const dir = mkdtempSync(join(tempRoot, "binary-policy-"));
	try {
		const project = join(dir, "project");
		const dependency = join(project, "node_modules/fixture-package/lib");
		mkdirSync(dependency, { recursive: true });
		writeFileSync(join(project, ".env"), "NEK_BINARY_POLICY_FIXTURE=unexpected\n");
		writeFileSync(join(dependency, "../package.json"), JSON.stringify({ name: "fixture-package", main: "lib/index.cjs" }));
		writeFileSync(join(dependency, "index.cjs"), 'module.exports = "resolved";\n');
		const entry = join(dir, "entry.ts");
		writeFileSync(entry, `import {createRequire} from "node:module"; import {join} from "node:path"; const require = createRequire(join(process.cwd(), "loader.cjs")); console.log(JSON.stringify({env:process.env.NEK_BINARY_POLICY_FIXTURE ?? null, dependency: require("fixture-package")}));`);
		const executable = join(dir, process.platform === "win32" ? "probe.exe" : "probe");
		const compile = spawnSync("bun", ["build", "--compile", ...flags.filter((flag) => buildCommand.includes(flag)), "--external", "fixture-package", entry, "--outfile", executable], { cwd: dir, encoding: "utf8", timeout: 30000 });
		assert.equal(compile.status, 0, compile.stderr);
		const env = { ...process.env };
		delete env.NEK_BINARY_POLICY_FIXTURE;
		const run = spawnSync(executable, [], { cwd: project, env, encoding: "utf8", timeout: 10000 });
		assert.equal(run.status, 0, run.stderr);
		assert.deepEqual(JSON.parse(run.stdout), { env: null, dependency: "resolved" });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
