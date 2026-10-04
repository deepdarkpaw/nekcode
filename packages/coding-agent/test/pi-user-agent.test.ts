import { describe, expect, it } from "vitest";
import { NEK_VERSION } from "../src/config.ts";
import { getPiUserAgent } from "../src/utils/pi-user-agent.ts";

describe("getPiUserAgent", () => {
	it("formats the user agent expected by pi.dev", () => {
		const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
		const userAgent = getPiUserAgent();

		expect(userAgent).toBe(`nek/${NEK_VERSION} (${process.platform}; ${runtime}; ${process.arch})`);
		expect(userAgent).toMatch(/^nek\/[^\s()]+ \([^;()]+;\s*[^;()]+;\s*[^()]+\)$/);
	});
});
