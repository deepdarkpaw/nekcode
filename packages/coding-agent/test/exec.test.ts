import { describe, expect, it } from "vitest";
import { execCommand } from "../src/core/exec.ts";

describe("extension command exit status", () => {
	it("does not report a timed-out command as successful", async () => {
		const result = await execCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], process.cwd(), {
			timeout: 100,
		});
		expect(result.killed).toBe(true);
		expect(result.code).not.toBe(0);
	});

	it("preserves explicit success and failure codes", async () => {
		for (const code of [0, 7]) {
			const result = await execCommand(process.execPath, ["-e", `process.exit(${code})`], process.cwd());
			expect(result).toMatchObject({ code, killed: false });
		}
	});
});
