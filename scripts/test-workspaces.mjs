#!/usr/bin/env node
/** Generate the GitHub Actions test matrix from npm's actual workspace graph. */
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const CODING_AGENT = "@earendil-works/pi-coding-agent";
const SAFE_PACKAGE_NAME = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/u;

/** Include every declared test suite; split the large coding-agent Vitest suite. */
export function createTestMatrix(packages, codingAgentShards = 3) {
	if (!Array.isArray(packages)) throw new Error("npm query did not return a workspace array");
	if (!Number.isSafeInteger(codingAgentShards) || codingAgentShards < 1) throw new Error("Invalid shard count");
	const selected = packages.filter((pkg) => typeof pkg.scripts?.test === "string");
	if (!selected.length) throw new Error("No workspace test scripts found");
	const names = new Set();
	const entries = [];
	for (const pkg of selected.sort((a, b) => String(a.name).localeCompare(String(b.name), "en"))) {
		if (typeof pkg.name !== "string" || !SAFE_PACKAGE_NAME.test(pkg.name) || names.has(pkg.name)) {
			throw new Error(`Invalid or duplicate workspace name: ${pkg.name}`);
		}
		names.add(pkg.name);
		if (pkg.name === CODING_AGENT) {
			if (!/^vitest\s+--run(?:\s|$)/u.test(pkg.scripts.test)) {
				throw new Error("Coding-agent test command changed; review Vitest shard arguments");
			}
			for (let shard = 1; shard <= codingAgentShards; shard++) {
				entries.push({ workspace: pkg.name, shard: `${shard}/${codingAgentShards}` });
			}
		} else {
			entries.push({ workspace: pkg.name, shard: "" });
		}
	}
	if (!names.has(CODING_AGENT)) throw new Error("Coding-agent test suite missing");
	return { include: entries };
}

/** Use npm's own workspace resolution, rather than duplicating workspace globs. */
export function queryWorkspaces(root) {
	const npm = process.platform === "win32" ? "npm.cmd" : "npm";
	const result = spawnSync(npm, ["query", ".workspace", "--json"], {
		cwd: root,
		encoding: "utf8",
		shell: process.platform === "win32",
		maxBuffer: 16 * 1024 * 1024,
	});
	if (result.status !== 0) throw new Error(`npm query failed: ${result.error?.message ?? result.stderr}`);
	return JSON.parse(result.stdout);
}

function main() {
	const [root = ".", output] = process.argv.slice(2);
	const matrix = JSON.stringify(createTestMatrix(queryWorkspaces(resolve(root))));
	if (output) appendFileSync(output, `matrix=${matrix}\n`);
	console.log(matrix);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		main();
	} catch (error) {
		console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
