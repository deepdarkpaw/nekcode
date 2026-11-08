#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import semver from "semver";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = "packages/coding-agent/package.json";

function git(args) {
	const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
	if (result.status !== 0) throw new Error(result.stderr.trim() || result.error?.message || "git failed");
	return result.stdout.trim();
}

/** Keep the CLI's canonical x.y.z[-prerelease] syntax; semver also accepts prefixes and build metadata. */
function isReleaseVersion(version) {
	return typeof version === "string" && !version.includes("+") && semver.valid(version) === version;
}

/** Semver precedence: a release outranks its prereleases; numeric identifiers compare numerically. */
export function compareVersions(left, right) {
	if (!isReleaseVersion(left) || !isReleaseVersion(right)) {
		throw new Error(`Not a semver version: ${!isReleaseVersion(left) ? left : right}`);
	}
	return semver.compare(left, right);
}

/** Follow npm's patch/minor graduation rules. An explicit version must be strictly newer. */
export function nextReleaseVersion(current, bump) {
	if (!isReleaseVersion(current)) throw new Error(`Current version ${current} must be semver.`);
	const version = bump === "patch" || bump === "minor" ? semver.inc(current, bump) : bump;
	if (!isReleaseVersion(version)) throw new Error(`Invalid release version ${version}.`);
	if (compareVersions(version, current) <= 0) {
		throw new Error(`Release version ${version} must be newer than ${current}.`);
	}
	return version;
}

/** Keep previews invisible to shipped clients that scan all nek-v* tags as stable. */
export function releaseTagForVersion(version) {
	if (!isReleaseVersion(version)) throw new Error(`Invalid release version ${version}.`);
	return `${semver.prerelease(version) === null ? "nek-v" : "nek-beta-v"}${version}`;
}

function release() {
	const [bump, ...rest] = process.argv.slice(2);
	if (rest.length || !bump || (bump !== "patch" && bump !== "minor" && !isReleaseVersion(bump))) {
		throw new Error("Usage: node scripts/nek-release.mjs patch|minor|<x.y.z[-prerelease]>");
	}
	if (git(["branch", "--show-current"]) !== "nek") throw new Error("Releases require branch nek.");
	if (git(["status", "--porcelain"])) throw new Error("Releases require a clean working tree.");
	const path = resolve(root, manifestPath);
	const manifest = JSON.parse(readFileSync(path, "utf8"));
	const current = manifest.nekConfig?.version;
	if (typeof current !== "string") throw new Error("nekConfig.version must be semver.");
	const version = nextReleaseVersion(current, bump);
	const tag = releaseTagForVersion(version);
	if (git(["tag", "--list", tag])) throw new Error(`Tag ${tag} already exists.`);
	manifest.nekConfig.version = version;
	writeFileSync(path, `${JSON.stringify(manifest, null, "\t")}\n`);
	git(["add", manifestPath]);
	git(["commit", "-m", `Release nek v${version}`]);
	git(["tag", "-a", tag, "-m", `Release nek v${version}`]);
	console.log(`Created ${tag}. Nothing was pushed.\n\nPush after review:\n  git push origin nek\n  git push origin ${tag}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		release();
	} catch (error) {
		console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
