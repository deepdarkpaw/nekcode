import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

/** Run only the embedded pure selector, without executing installation or accessing the network. */
function selectFromInstaller(file, tags) {
	const source = readFileSync(new URL(file, import.meta.url), "utf8");
	const pattern = file.endsWith(".ps1")
		? /\$selector = @'\r?\n([\s\S]*?)\r?\n'@/u
		: /\| node -e '\r?\n([\s\S]*?)\r?\n'\)"/u;
	const match = pattern.exec(source);
	assert.ok(match, `Missing embedded selector in ${file}`);
	const input = tags.map((tag) => `${"a".repeat(40)}\trefs/tags/${tag}`).join("\n");
	const result = spawnSync(process.execPath, ["-e", match[1]], { encoding: "utf8", input, timeout: 10_000 });
	assert.equal(result.status, 0, result.error?.message || result.stderr);
	return result.stdout.trim();
}

for (const file of ["./install.sh", "./install.ps1"]) {
	test(`${file}: stable ignores a higher prerelease and isolated beta namespace`, () => {
		assert.equal(
			selectFromInstaller(file, ["nek-v0.4.3", "nek-v0.5.0-beta.1", "nek-v1.0.0-rc.1", "nek-beta-v0.6.0-beta.1"]),
			"nek-v0.4.3",
		);
	});

	test(`${file}: no stable version when only previews are available`, () => {
		assert.equal(selectFromInstaller(file, ["nek-v0.5.0-beta.1", "nek-beta-v0.5.0-beta.2"]), "");
	});

	test(`${file}: stable keeps numeric semver ordering and rejects malformed tags`, () => {
		assert.equal(selectFromInstaller(file, ["nek-v0.4.9", "nek-v0.4.10", "nek-v01.5.0", "other-v9.0.0"]), "nek-v0.4.10");
	});
}
