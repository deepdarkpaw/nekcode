import assert from "node:assert/strict";
import test from "node:test";
import { createTestMatrix, queryWorkspaces } from "./test-workspaces.mjs";

const codingAgent = { name: "@earendil-works/pi-coding-agent", scripts: { test: "vitest --run" } };

test("includes every test workspace once except the coding-agent shards", () => {
	const matrix = createTestMatrix([
		{ name: "@scope/z", scripts: { test: "node --test" } },
		codingAgent,
		{ name: "@scope/no-test", scripts: { build: "true" } },
		{ name: "@scope/a", scripts: { test: "vitest --run" } },
	]);
	assert.deepEqual(matrix.include.filter((item) => item.workspace === codingAgent.name).map((item) => item.shard), ["1/3", "2/3", "3/3"]);
	assert.deepEqual(matrix.include.filter((item) => item.workspace !== codingAgent.name).map((item) => item.workspace), ["@scope/a", "@scope/z"]);
});

test("rejects missing, duplicated and unsafe workspaces and unsupported shard commands", () => {
	assert.throws(() => createTestMatrix([]), /No workspace/u);
	assert.throws(() => createTestMatrix([{ name: "safe", scripts: { test: "true" } }]), /Coding-agent test suite missing/u);
	assert.throws(() => createTestMatrix([codingAgent, codingAgent]), /duplicate/u);
	assert.throws(() => createTestMatrix([codingAgent, { name: "bad;command", scripts: { test: "true" } }]), /Invalid/u);
	assert.throws(() => createTestMatrix([{ ...codingAgent, scripts: { test: "node --test" } }]), /review Vitest/u);
	assert.throws(() => createTestMatrix([codingAgent], 0), /Invalid shard/u);
});

test("npm workspace query and matrix agree with the real project", () => {
	const workspaces = queryWorkspaces(process.cwd());
	const expected = workspaces.filter((pkg) => typeof pkg.scripts?.test === "string").map((pkg) => pkg.name).sort();
	const entries = createTestMatrix(workspaces).include;
	assert.deepEqual([...new Set(entries.map((entry) => entry.workspace))].sort(), expected);
	assert.equal(entries.filter((entry) => entry.workspace === codingAgent.name).length, 3);
});
