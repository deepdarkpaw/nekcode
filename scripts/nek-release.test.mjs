import assert from "node:assert/strict";
import test from "node:test";
import { compareVersions, nextReleaseVersion, releaseTagForVersion } from "./nek-release.mjs";

test("keeps prerelease tags out of legacy stable scans", () => {
	assert.equal(releaseTagForVersion("0.4.3"), "nek-v0.4.3");
	assert.equal(releaseTagForVersion("0.5.0-beta.1"), "nek-beta-v0.5.0-beta.1");
	assert.equal(releaseTagForVersion("0.5.0-rc.1"), "nek-beta-v0.5.0-rc.1");
	const tags = ["0.4.3", "0.5.0-beta.1", "0.6.0-alpha.1"].map(releaseTagForVersion);
	assert.deepEqual(tags.filter((tag) => tag.startsWith("nek-v")), ["nek-v0.4.3"]);
	assert.throws(() => releaseTagForVersion("0.5.0+build"), /Invalid release version/);
});

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

test("minor graduates only a prerelease at the minor boundary", () => {
	assert.equal(nextReleaseVersion("0.4.0-beta.1", "minor"), "0.4.0");
	assert.equal(nextReleaseVersion("0.3.2-beta.1", "minor"), "0.4.0");
});

test("rejects invalid identifiers and does not widen the release CLI syntax", () => {
	for (const version of ["0.4.0-01", "0.4.0-beta..1", "0.4.0-.", "v0.4.0", "=0.4.0", " 0.4.0", "0.4.0+build"]) {
		assert.throws(() => nextReleaseVersion("0.3.2", version), /Invalid release version/);
		assert.throws(() => compareVersions("0.3.2", version), /Not a semver version/);
	}
	assert.equal(nextReleaseVersion("0.3.2", "0.4.0-beta-01"), "0.4.0-beta-01");
});

test("rejects versions that are not newer than the current one", () => {
	assert.throws(() => nextReleaseVersion("0.3.2", "0.3.2"), /must be newer/);
	assert.throws(() => nextReleaseVersion("0.3.2", "0.3.2-beta.2"), /must be newer/);
	assert.throws(() => nextReleaseVersion("0.3.2-beta.1", "0.3.1"), /must be newer/);
	assert.throws(() => nextReleaseVersion("0.3.2", "not-a-version"), /Invalid release version/);
	assert.throws(() => nextReleaseVersion("0.3", "patch"), /must be semver/);
});
