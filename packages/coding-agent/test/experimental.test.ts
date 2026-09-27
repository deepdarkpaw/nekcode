import { afterEach, describe, expect, it } from "vitest";
import { areExperimentalFeaturesEnabled } from "../src/core/experimental.ts";

describe("areExperimentalFeaturesEnabled", () => {
	const originalPiExperimental = process.env.NEK_EXPERIMENTAL;

	afterEach(() => {
		if (originalPiExperimental === undefined) {
			delete process.env.NEK_EXPERIMENTAL;
		} else {
			process.env.NEK_EXPERIMENTAL = originalPiExperimental;
		}
	});

	it("returns false when NEK_EXPERIMENTAL is unset", () => {
		delete process.env.NEK_EXPERIMENTAL;

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when NEK_EXPERIMENTAL is empty", () => {
		process.env.NEK_EXPERIMENTAL = "";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns true when NEK_EXPERIMENTAL is set to 1", () => {
		process.env.NEK_EXPERIMENTAL = "1";

		expect(areExperimentalFeaturesEnabled()).toBe(true);
	});

	it("returns false when NEK_EXPERIMENTAL is set to 0", () => {
		process.env.NEK_EXPERIMENTAL = "0";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when NEK_EXPERIMENTAL is set to a non-1 value", () => {
		process.env.NEK_EXPERIMENTAL = "true";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});
});
