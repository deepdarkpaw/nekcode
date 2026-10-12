import { copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sidecarPath } from "../../src/core/durable/session-sidecar.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { JsonlSessionManager } from "../../src/core/session-manager-jsonl.ts";
import { assistant } from "./session-fixtures.ts";
import { tempDir } from "./support.ts";

/**
 * Listing speed of 200 sessions: JSONL listing (the previous `SessionManager`) against durable listing with fresh
 * sidecars and with no sidecars (every database read once). Run with `NEK_LISTING_BENCH=<result file>`.
 */
const RESULT_FILE = process.env.NEK_LISTING_BENCH;
const SESSIONS = 200;
const TURNS = 40;
const RUNS = 5;

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)]!;
}

async function time(run: () => Promise<unknown>): Promise<number> {
	const start = performance.now();
	await run();
	return performance.now() - start;
}

describe.runIf(RESULT_FILE !== undefined)("session listing benchmark", { timeout: 600_000 }, () => {
	it("lists 200 sessions", async () => {
		const { dir, cleanup } = tempDir("nek-listing-bench-");
		try {
			const jsonlDir = join(dir, "jsonl");
			const durableDir = join(dir, "durable");
			mkdirSync(jsonlDir);
			mkdirSync(durableDir);
			const text = "Some realistic message text. ".repeat(20);
			for (let session = 0; session < SESSIONS; session++) {
				const sm = JsonlSessionManager.create("/work/project", jsonlDir);
				for (let turn = 0; turn < TURNS; turn++) {
					sm.appendMessage({ role: "user", content: `${session}/${turn} ${text}`, timestamp: Date.now() });
					sm.appendMessage(assistant(text));
				}
			}
			for (const name of readdirSync(jsonlDir)) {
				copyFileSync(join(jsonlDir, name), join(durableDir, name));
				SessionManager.open(join(durableDir, name));
				rmSync(join(durableDir, name));
			}

			const jsonl: number[] = [];
			const warm: number[] = [];
			const cold: number[] = [];
			for (let run = 0; run < RUNS; run++) {
				jsonl.push(await time(() => JsonlSessionManager.list("/work/project", jsonlDir)));
				warm.push(await time(() => SessionManager.list("/work/project", durableDir)));
				for (const name of readdirSync(durableDir)) {
					if (name.endsWith(".sqlite")) rmSync(sidecarPath(join(durableDir, name)), { force: true });
				}
				cold.push(await time(() => SessionManager.list("/work/project", durableDir)));
			}
			const listed = await SessionManager.list("/work/project", durableDir);
			expect(listed).toHaveLength(SESSIONS);
			const result = {
				sessions: SESSIONS,
				messagesPerSession: TURNS * 2,
				jsonlMs: Math.round(median(jsonl)),
				durableWarmMs: Math.round(median(warm)),
				durableColdMs: Math.round(median(cold)),
			};
			writeFileSync(RESULT_FILE!, JSON.stringify(result));
		} finally {
			cleanup();
		}
	});
});
