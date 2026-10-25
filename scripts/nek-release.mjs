#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = "packages/coding-agent/package.json";
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/;

function git(args) {
	const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
	if (result.status !== 0) throw new Error(result.stderr.trim() || result.error?.message || "git failed");
	return result.stdout.trim();
}

/** Numeric triple and prerelease identifiers of a release version, or undefined when it is not semver. */
function parseVersion(version) {
	const match = SEMVER_PATTERN.exec(version);
	if (!match) return undefined;
	return {
		numbers: match.slice(1, 4).map(Number),
		prerelease: match[4] === undefined ? [] : match[4].split("."),
	};
}

/** Compare one prerelease identifier: numeric ones numerically and below alphanumeric ones, which compare lexically. */
function compareIdentifier(left, right) {
	const leftNumeric = /^\d+$/.test(left);
	const rightNumeric = /^\d+$/.test(right);
	if (leftNumeric && rightNumeric) return Math.sign(Number(left) - Number(right));
	if (leftNumeric) return -1;
	if (rightNumeric) return 1;
	return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Semver precedence of two release versions: negative, zero, or positive. A release outranks its own prereleases, so
 * `0.3.2` is newer than `0.3.2-beta.1`, and `0.3.2-beta.2` is newer than `0.3.2-beta.1`.
 */
export function compareVersions(left, right) {
	const a = parseVersion(left);
	const b = parseVersion(right);
	if (!a || !b) throw new Error(`Not a semver version: ${!a ? left : right}`);
	for (let index = 0; index < 3; index++) {
		const difference = Math.sign(a.numbers[index] - b.numbers[index]);
		if (difference !== 0) return difference;
	}
	if (a.prerelease.length === 0 || b.prerelease.length === 0) {
		return Math.sign(b.prerelease.length - a.prerelease.length);
	}
	for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
		const leftIdentifier = a.prerelease[index];
		const rightIdentifier = b.prerelease[index];
		if (leftIdentifier === undefined) return -1;
		if (rightIdentifier === undefined) return 1;
		const difference = compareIdentifier(leftIdentifier, rightIdentifier);
		if (difference !== 0) return difference;
	}
	return 0;
}

/**
 * Version a bump asks for. `patch` and `minor` follow npm's `semver.inc`: from a prerelease they graduate to the
 * release of that same version (`0.3.2-beta.1` becomes `0.3.2`), otherwise they move to the next patch or minor.
 * An explicit version must be newer than the current one.
 */
export function nextReleaseVersion(current, bump) {
	const parsed = parseVersion(current);
	if (!parsed) throw new Error(`Current version ${current} must be semver.`);
	const [major, minor, patch] = parsed.numbers;
	const version =
		bump === "patch"
			? `${major}.${minor}.${parsed.prerelease.length > 0 ? patch : patch + 1}`
			: bump === "minor"
				? `${major}.${minor + 1}.0`
				: bump;
	if (!parseVersion(version)) throw new Error(`Invalid release version ${version}.`);
	if (compareVersions(version, current) <= 0) {
		throw new Error(`Release version ${version} must be newer than ${current}.`);
	}
	return version;
}

function release() {
	const [bump, ...rest] = process.argv.slice(2);
	if (rest.length || !bump || (bump !== "patch" && bump !== "minor" && !SEMVER_PATTERN.test(bump))) {
		throw new Error("Usage: node scripts/nek-release.mjs patch|minor|<x.y.z[-prerelease]>");
	}
	if (git(["branch", "--show-current"]) !== "nek") throw new Error("Releases require branch nek.");
	if (git(["status", "--porcelain"])) throw new Error("Releases require a clean working tree.");
	const path = resolve(root, manifestPath);
	const manifest = JSON.parse(readFileSync(path, "utf8"));
	const current = manifest.nekConfig?.version;
	if (typeof current !== "string") throw new Error("nekConfig.version must be semver.");
	const version = nextReleaseVersion(current, bump);
	const tag = `nek-v${version}`;
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
