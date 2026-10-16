#!/usr/bin/env node
/**
 * Publish the built manual (docs/.vitepress/dist) to the gh-pages branch, which GitHub Pages serves.
 *
 * The branch history is kept: the script clones gh-pages, replaces its content, commits, and pushes a
 * fast-forward. It never force-pushes. Run `npm run build` first, or use `npm run deploy`, which builds.
 *
 * Environment:
 * - DEPLOY_REMOTE: push URL, default the `origin` URL of the enclosing repository.
 * - DEPLOY_BRANCH: target branch, default `gh-pages`.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const siteDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(siteDir, "docs", ".vitepress", "dist");
const branch = process.env.DEPLOY_BRANCH ?? "gh-pages";

/** Run git and return trimmed stdout; output is inherited when `quiet` is false. */
function git(args, cwd, quiet = true) {
	const output = execFileSync("git", args, { cwd, encoding: "utf8", stdio: quiet ? "pipe" : "inherit" });
	return (output ?? "").trim();
}

/** Clone the existing deploy branch, or start an empty repository when the branch does not exist yet. */
function prepareWorkdir(remote) {
	const workdir = mkdtempSync(join(tmpdir(), "nek-docs-deploy-"));
	const remoteHasBranch = git(["ls-remote", "--heads", remote, branch], siteDir) !== "";
	if (remoteHasBranch) {
		git(["clone", "--quiet", "--depth", "1", "--branch", branch, remote, workdir], siteDir);
		return workdir;
	}
	git(["init", "--quiet", "-b", branch], workdir);
	git(["remote", "add", "origin", remote], workdir);
	return workdir;
}

/** Replace everything except .git with the build output, plus .nojekyll so Pages serves `assets/` as is. */
function replaceContent(workdir) {
	for (const name of readdirSync(workdir)) {
		if (name !== ".git") rmSync(join(workdir, name), { recursive: true, force: true });
	}
	cpSync(distDir, workdir, { recursive: true });
	writeFileSync(join(workdir, ".nojekyll"), "");
}

function main() {
	if (!existsSync(join(distDir, "index.html"))) {
		console.error(`No build output at ${distDir}. Run "npm run build" first.`);
		process.exit(1);
	}
	const remote = process.env.DEPLOY_REMOTE ?? git(["remote", "get-url", "origin"], siteDir);
	const sourceCommit = git(["rev-parse", "--short", "HEAD"], siteDir);
	const author = {
		name: git(["config", "user.name"], siteDir) || "nek-docs",
		email: git(["config", "user.email"], siteDir) || "nek-docs@users.noreply.github.com",
	};

	const workdir = prepareWorkdir(remote);
	try {
		replaceContent(workdir);
		git(["-c", "core.autocrlf=false", "add", "-A"], workdir);
		if (git(["status", "--porcelain"], workdir) === "") {
			console.log("Site is already up to date.");
			return;
		}
		git(
			["-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`, "commit", "--quiet", "-m", `docs: deploy user manual from ${sourceCommit}`],
			workdir,
		);
		git(["push", "origin", `HEAD:${branch}`], workdir, false);
		console.log(`Published ${sourceCommit} to ${branch}.`);
	} finally {
		rmSync(workdir, { recursive: true, force: true });
	}
}

main();
