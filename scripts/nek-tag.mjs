#!/usr/bin/env node
/**
 * Resolve a nek release tag into the manifest version and release channel flags.
 *
 * Release workflows run this before building anything so a mislabeled tag (a
 * prerelease version under the stable namespace, or a version that disagrees
 * with package.json) fails immediately instead of publishing mixed artifacts.
 *
 * Usage:
 *   node scripts/nek-tag.mjs parse --tag <tag> [--manifest <path>] [--github-output <file>]
 */
import { appendFileSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Resolve from the source checkout: a workflow can build an older tag with the
// current workflow and its helpers without installing the control checkout.
const require = createRequire(resolve(process.cwd(), "package.json"));
const semver = require("semver");

const TAG_PATTERN = /^nek-(beta-)?v(.+)$/u;

/** Validate the tag namespace against semver prerelease precedence. */
export function parseNekTag(tag) {
	const match = TAG_PATTERN.exec(tag ?? "");
	if (!match) throw new Error(`Not a nek release tag: ${tag}`);
	const [, betaPrefix, version] = match;
	if (version.includes("+") || semver.valid(version) !== version) {
		throw new Error(`Tag ${tag} does not carry a canonical semver version`);
	}
	const prerelease = semver.prerelease(version) !== null;
	if (betaPrefix && !prerelease) throw new Error(`Tag ${tag} marks a stable version as a prerelease`);
	if (!betaPrefix && prerelease) throw new Error(`Prerelease ${version} must use the nek-beta-v namespace`);
	return { tag, version, prerelease };
}

/** The tag and package.json must describe the same release. */
export function verifyManifestVersion(version, manifest) {
	const declared = manifest?.nekConfig?.version;
	if (typeof declared !== "string") throw new Error("package.json is missing nekConfig.version");
	if (declared !== version) throw new Error(`Tag version ${version} does not match nekConfig.version ${declared}`);
	return declared;
}

function parseArgs(argv) {
	const [command, ...rest] = argv;
	if (command !== "parse") throw new Error("Usage: nek-tag.mjs parse --tag <tag> [--manifest <path>] [--github-output <file>]");
	const options = { manifest: "packages/coding-agent/package.json", githubOutput: undefined, tag: undefined };
	for (let index = 0; index < rest.length; index += 1) {
		const arg = rest[index];
		const value = rest[index + 1];
		if (value === undefined) throw new Error(`${arg} requires a value`);
		index += 1;
		switch (arg) {
			case "--tag":
				options.tag = value;
				break;
			case "--manifest":
				options.manifest = value;
				break;
			case "--github-output":
				options.githubOutput = value;
				break;
			default:
				throw new Error(`Unknown option ${arg}`);
		}
	}
	if (!options.tag) throw new Error("--tag is required");
	return options;
}

function main() {
	const options = parseArgs(process.argv.slice(2));
	const release = parseNekTag(options.tag);
	verifyManifestVersion(release.version, JSON.parse(readFileSync(options.manifest, "utf8")));
	const output = [`tag=${release.tag}`, `version=${release.version}`, `prerelease=${release.prerelease}`].join("\n");
	if (options.githubOutput) appendFileSync(options.githubOutput, `${output}\n`);
	console.log(output);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		main();
	} catch (error) {
		console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
