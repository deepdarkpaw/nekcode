import assert from "node:assert/strict";
import test from "node:test";
import { compareVersions, nextReleaseVersion } from "./nek-release.mjs";

test("orders releases and their prereleases by semver precedence", () => {
	assert.ok(compareVersions("0.3.2", "0.3.2-beta.1") > 0);
	assert.ok(compareVersions("0.3.2-beta.1", "0.3.2") < 0);
	assert.ok(compareVersions("0.3.2-beta.2", "0.3.2-beta.1") > 0);
	assert.ok(compareVersions("0.3.2-alpha.1", "0.3.2-beta.1") < 0);
	assert.ok(compareVersions("0.3.2-beta.10", "0.3.2-beta.9") > 0);
	assert.ok(compareVersions("0.3.2-beta", "0.3.2-beta.1") < 0);
	assert.ok(compareVersions("0.4.0", "0.3.9") > 0);
	assert.equal(compareVersions("0.3.2", "0.3.2"), 0);
	assert.throws(() => compareVersions("0.3", "0.3.1"));
});

test("graduates a prerelease to its release and moves past a release", () => {
	assert.equal(nextReleaseVersion("0.3.2-beta.1", "patch"), "0.3.2");
	assert.equal(nextReleaseVersion("0.3.1", "patch"), "0.3.2");
	assert.equal(nextReleaseVersion("0.3.2", "minor"), "0.4.0");
	assert.equal(nextReleaseVersion("0.3.2-beta.1", "0.3.2"), "0.3.2");
	assert.equal(nextReleaseVersion("0.3.2-beta.1", "0.3.2-beta.2"), "0.3.2-beta.2");
});

test("rejects versions that are not newer than the current one", () => {
	assert.throws(() => nextReleaseVersion("0.3.2", "0.3.2"), /must be newer/);
	assert.throws(() => nextReleaseVersion("0.3.2", "0.3.2-beta.2"), /must be newer/);
	assert.throws(() => nextReleaseVersion("0.3.2-beta.1", "0.3.1"), /must be newer/);
	assert.throws(() => nextReleaseVersion("0.3.2", "not-a-version"), /Invalid release version/);
	assert.throws(() => nextReleaseVersion("0.3", "patch"), /must be semver/);
});
