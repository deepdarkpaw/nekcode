import { describe, expect, it } from "vitest";
import { toStrictJson } from "../src/core/durable/json.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";
import { DEFAULT_NEK_CONFIG } from "../src/extensions/nek/config.ts";
import { SubagentRegistry } from "../src/extensions/nek/services/subagent-registry.ts";
import { findBranchSubagentRecord } from "../src/extensions/nek/state/subagents.ts";
import { createAwaitToolDefinition } from "../src/extensions/nek/tools/await.ts";
import type { SubagentRecord } from "../src/extensions/nek/types.ts";

const child: SubagentRecord = {
	id: "saved-worker",
	type: "preset-worker",
	model: "test/reasoner",
	description: "Continue implementation",
	background: true,
	status: "running",
	startedAt: 1000,
	observed: false,
	usage: { input: 0, output: 0 },
};

function result(toolName: string, details: unknown): SessionEntry {
	return {
		id: "result",
		parentId: null,
		timestamp: new Date(1000).toISOString(),
		type: "message",
		message: {
			role: "toolResult",
			toolName,
			toolCallId: "call",
			content: [],
			details: toStrictJson(details),
			isError: false,
			timestamp: 1000,
		},
	};
}

const original = result("subagent", { subagent: child });

describe("saved subagent lookup", () => {
	it.each([
		{ name: "await", details: { subagents: [{ ...child, status: "completed" }], running: [] }, status: "completed" },
		{ name: "await", details: { subagents: [], running: [child] }, status: "running" },
		{ name: "stop_subagent", details: { subagent: { ...child, status: "aborted" } }, status: "aborted" },
	])("uses the latest $name result without mutating saved records", ({ name, details, status }) => {
		const entries = [original, result(name, details)];
		expect(findBranchSubagentRecord(entries, child.id)).toMatchObject({ id: child.id, type: child.type, status });
		expect(findBranchSubagentRecord([original], child.id)).toEqual(child);
		expect(child.status).toBe("running");
	});

	it("reads completion notices and ignores unrelated tools, malformed details and other ids", () => {
		const notice: SessionEntry = {
			...original,
			type: "message",
			message: {
				role: "custom",
				customType: "nek.subagent_notice",
				content: "done",
				display: true,
				timestamp: 2000,
				details: { subagent: { ...child, status: "completed" } },
			},
		};
		const entries = [
			original,
			notice,
			result("read", { subagent: child }),
			result("await", { subagents: [{ id: child.id }] }),
		];
		expect(findBranchSubagentRecord(entries, child.id)?.status).toBe("completed");
		expect(findBranchSubagentRecord(entries, "unknown")).toBeUndefined();
	});

	it("distinguishes a detached historical running snapshot from a live run, without adopting it", async () => {
		const registry = new SubagentRegistry(DEFAULT_NEK_CONFIG.subagent, () => {});
		const tool = createAwaitToolDefinition({
			getRegistry: () => registry,
			findBranchSubagent: (id) => findBranchSubagentRecord([original], id),
		});
		const ctx = {} as ExtensionContext;
		const checked = await tool.execute(
			"poll",
			{ subagent_id: child.id, block_until_ms: 0 },
			undefined,
			undefined,
			ctx,
		);
		expect(checked.details).toMatchObject({ subagents: [], running: [], detached: [child], timedOut: false });
		expect(JSON.stringify(checked.content)).toContain("historical snapshot, not a live status check");
		expect(registry.list()).toEqual([]);
		await expect(
			tool.execute("poll-unknown", { subagent_id: "unknown", block_until_ms: 0 }, undefined, undefined, ctx),
		).rejects.toThrow("Unknown subagent unknown");
	});
});
