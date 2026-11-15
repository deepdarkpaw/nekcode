import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { OutputAccumulator } from "../src/core/tools/output-accumulator.ts";

const workspaceTmp = fileURLToPath(new URL("../../../.tmp/", import.meta.url));
mkdirSync(workspaceTmp, { recursive: true });
const directory = mkdtempSync(join(workspaceTmp, "output-tail-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe("bounded command output tail", () => {
	it("preserves the end of a single over-long retained line", async () => {
		for (const name of ["TMPDIR", "TMP", "TEMP"]) vi.stubEnv(name, directory);
		const output = new OutputAccumulator({ tempFilePrefix: "output" });
		try {
			const bytes = Buffer.from(`first line\n${"y".repeat(219_000)}END\n`);
			for (let i = 0; i < bytes.length; i += 8192) output.append(bytes.subarray(i, i + 8192));
			output.finish();
			const snapshot = output.snapshot();
			expect(snapshot.content).toContain("yyyyEND");
			expect(snapshot.truncation).toMatchObject({ truncated: true, lastLinePartial: true, totalLines: 2 });
		} finally {
			await output.closeTempFile();
			vi.unstubAllEnvs();
		}
	});
});
