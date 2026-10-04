import { describe, expect, it } from "vitest";
import {
	compareVersions,
	parseRemoteRefs,
	parseUpdateArgs,
	selectHighestStableTag,
	updateIsAvailable,
} from "../src/cli/update.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("update command", () => {
	it("parses channel and check options", () => {
		expect(parseUpdateArgs(["--channel", "dev", "--check"])).toEqual({ channel: "dev", check: true, help: false });
		expect(parseUpdateArgs(["--channel=stable"])).toEqual({ channel: "stable", check: false, help: false });
	});

	it("rejects invalid update options", () => {
		expect(() => parseUpdateArgs(["--channel", "nightly"])).toThrow("--channel requires stable or dev");
		expect(() => parseUpdateArgs(["--unknown"])).toThrow("Unknown update option");
	});

	it("compares release and prerelease versions", () => {
		expect(compareVersions("1.0.2", "1.0.1")).toBeGreaterThan(0);
		expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBeGreaterThan(0);
		expect(compareVersions("1.0.0-alpha.2", "1.0.0-alpha.10")).toBeLessThan(0);
	});

	it("selects the highest valid nek stable tag", () => {
		expect(selectHighestStableTag(["nek-v0.9.0", "nek-v1.0.2", "nek-v1.0.1", "other-v9.0.0", "nek-vbad"])).toBe(
			"nek-v1.0.2",
		);
		expect(selectHighestStableTag([])).toBeUndefined();
		expect(selectHighestStableTag(["nek-v1.0.0-rc.10", "nek-v1.0.0-rc.2", "nek-v1.0.0", "nek-v01.2.3"])).toBe(
			"nek-v1.0.0",
		);
	});

	it("uses peeled annotated tag commits regardless of line order", () => {
		for (const output of [
			"tag-object refs/tags/nek-v0.1.0\ncommit refs/tags/nek-v0.1.0^{}",
			"commit refs/tags/nek-v0.1.0^{}\ntag-object refs/tags/nek-v0.1.0",
		]) {
			expect(parseRemoteRefs(output, "refs/tags/")).toEqual([{ name: "nek-v0.1.0", commit: "commit" }]);
		}
	});

	it("compares stable versions and dev commits without treating a matching commit as an update", () => {
		const target = { name: "nek-v0.2.0", commit: "target" };
		expect(updateIsAvailable("stable", { commit: "target" }, target)).toBe(false);
		expect(updateIsAvailable("stable", { commit: "old", tag: "nek-v0.1.0" }, target)).toBe(true);
		expect(updateIsAvailable("stable", { commit: "new", tag: "nek-v0.3.0" }, target)).toBe(false);
		expect(updateIsAvailable("stable", { commit: "old", tag: "nek-vbad" }, target)).toBe(true);
		expect(updateIsAvailable("dev", { commit: "old", tag: "nek-v0.3.0" }, target)).toBe(true);
	});

	it("does not offer a dev update when HEAD already contains the remote branch head", () => {
		const target = { name: "nek", commit: "remote" };
		expect(updateIsAvailable("dev", { commit: "local-ahead" }, target, true)).toBe(false);
		expect(updateIsAvailable("dev", { commit: "local-behind" }, target, false)).toBe(true);
	});

	it("persists the update channel in global settings", async () => {
		const settings = SettingsManager.inMemory();
		expect(settings.getUpdateChannel()).toBe("stable");
		settings.setUpdateChannel("dev");
		await settings.flush();
		expect(settings.getGlobalSettings().updateChannel).toBe("dev");
		expect(settings.getUpdateChannel()).toBe("dev");
	});
});
