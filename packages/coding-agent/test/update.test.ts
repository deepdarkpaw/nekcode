import { describe, expect, it } from "vitest";
import { compareVersions, parseUpdateArgs, selectHighestStableTag } from "../src/cli/update.ts";

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
	});
});
