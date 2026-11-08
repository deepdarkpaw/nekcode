import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { queryWorkspaces } from "./test-workspaces.mjs";

test("Docker dependency layer includes every npm workspace manifest before npm ci", () => {
	const dockerfile = readFileSync("packages/evals/docker/Dockerfile", "utf8");
	const beforeInstall = dockerfile.split("RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts")[0];
	assert.notEqual(beforeInstall, dockerfile, "Dockerfile must install from the dependency cache layer");
	assert.match(beforeInstall, /COPY package\.json package-lock\.json \./u);
	for (const workspace of queryWorkspaces(process.cwd())) {
		const path = `${workspace.location.replaceAll("\\", "/")}/package.json`;
		assert.ok(beforeInstall.includes(`COPY ${path} ${path}`), `Missing Docker dependency manifest: ${path}`);
	}
	assert.ok(dockerfile.indexOf("COPY . .") > dockerfile.indexOf("npm ci --ignore-scripts"));
});
