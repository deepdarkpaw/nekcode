#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = "packages/coding-agent/package.json";

function git(args) {
	const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
	if (result.status !== 0) throw new Error(result.stderr.trim() || result.error?.message || "git failed");
	return result.stdout.trim();
}

function release() {
	const [bump, ...rest] = process.argv.slice(2);
	if (rest.length || !bump || (bump !== "patch" && bump !== "minor" && !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(bump))) {
		throw new Error("Usage: node scripts/nek-release.mjs patch|minor|<x.y.z>");
	}
	if (git(["branch", "--show-current"]) !== "nek") throw new Error("Releases require branch nek.");
	if (git(["status", "--porcelain"])) throw new Error("Releases require a clean working tree.");
	const path = resolve(root, manifestPath);
	const manifest = JSON.parse(readFileSync(path, "utf8"));
	const current = manifest.nekConfig?.version;
	if (typeof current !== "string" || !/^\d+\.\d+\.\d+$/.test(current)) throw new Error("nekConfig.version must be x.y.z.");
	const [major, minor, patch] = current.split(".").map(Number);
	const version = bump === "patch" ? `${major}.${minor}.${patch + 1}` : bump === "minor" ? `${major}.${minor + 1}.0` : bump;
	const next = version.split(".").map(Number);
	if (next[0] < major || (next[0] === major && next[1] < minor) || (next[0] === major && next[1] === minor && next[2] <= patch)) {
		throw new Error(`Release version ${version} must be newer than ${current}.`);
	}
	const tag = `nek-v${version}`;
	if (git(["tag", "--list", tag])) throw new Error(`Tag ${tag} already exists.`);
	manifest.nekConfig.version = version;
	writeFileSync(path, `${JSON.stringify(manifest, null, "\t")}\n`);
	git(["add", manifestPath]);
	git(["commit", "-m", `Release nek v${version}`]);
	git(["tag", "-a", tag, "-m", `Release nek v${version}`]);
	console.log(`Created ${tag}. Nothing was pushed.\n\nPush after review:\n  git push origin nek\n  git push origin ${tag}`);
}

try { release(); } catch (error) {
	console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
}
