import assert from "node:assert/strict";
import test from "node:test";
import { parseNekTag, verifyManifestVersion } from "./nek-tag.mjs";

test("accepts canonical stable and prerelease tags", () => {
	assert.deepEqual(parseNekTag("nek-v0.5.0"), { tag: "nek-v0.5.0", version: "0.5.0", prerelease: false });
	assert.deepEqual(parseNekTag("nek-beta-v0.5.0-beta.1"), {
		tag: "nek-beta-v0.5.0-beta.1",
		version: "0.5.0-beta.1",
		prerelease: true,
	});
	assert.equal(parseNekTag("nek-beta-v0.6.0-rc.2").prerelease, true);
});

test("rejects stable-namespace prereleases and mismatched namespaces", () => {
	assert.throws(() => parseNekTag("nek-v0.5.0-beta.1"), /must use the nek-beta-v namespace/u);
	assert.throws(() => parseNekTag("nek-beta-v0.5.0"), /marks a stable version as a prerelease/u);
	assert.throws(() => parseNekTag("v0.5.0"), /Not a nek release tag/u);
	assert.throws(() => parseNekTag("nek-v0.5"), /does not carry a canonical semver version/u);
	assert.throws(() => parseNekTag("nek-v0.5.0+build"), /canonical semver/u);
	assert.throws(() => parseNekTag("nek-beta-v0.5.0-beta.01"), /canonical semver/u);
	assert.throws(() => parseNekTag(undefined), /Not a nek release tag/u);
});

test("rejects tags that do not match their own canonical spelling", () => {
	assert.throws(() => parseNekTag("nek-v01.5.0"), /does not carry a canonical semver version/u);
	assert.throws(() => parseNekTag("nek-beta-v0.4.3"), /marks a stable version as a prerelease/u);
});

test("requires the manifest to declare the tagged version", () => {
	assert.equal(verifyManifestVersion("0.5.0-beta.1", { nekConfig: { version: "0.5.0-beta.1" } }), "0.5.0-beta.1");
	assert.throws(() => verifyManifestVersion("0.5.0", { nekConfig: { version: "0.4.3" } }), /does not match/u);
	assert.throws(() => verifyManifestVersion("0.5.0", {}), /missing nekConfig.version/u);
});
