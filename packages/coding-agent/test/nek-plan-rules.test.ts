import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionEntry } from "../src/core/session-manager.ts";
import { modeReminder } from "../src/extensions/nek/prompts/plan-mode.ts";
import {
	formatPlanFile,
	planName,
	planPath,
	planTodos,
	slugify,
	writePlanFile,
} from "../src/extensions/nek/services/plan-store.ts";
import { checkModeToolCall, isMarkdownPath, modeToolNames } from "../src/extensions/nek/state/mode-rules.ts";
import { replayBranch } from "../src/extensions/nek/state/session-state.ts";
import type { PlanRecord, Todo } from "../src/extensions/nek/types.ts";

const plan: PlanRecord = {
	name: "Add auth",
	path: "/repo/.pi/plans/add-auth_abc123.plan.md",
	overview: "Add session auth.",
	todos: [
		{ id: "schema", content: "Add the schema" },
		{ id: "routes", content: "Add routes" },
	],
};
const todo: Todo = { id: "a", content: "First", status: "pending" };

function toolResultEntry(id: string, toolName: string, details: JsonValue, isError = false): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-09-26T00:00:00.000Z",
		message: {
			role: "toolResult",
			toolCallId: `call-${id}`,
			toolName,
			content: [{ type: "text", text: "ok" }],
			details,
			isError,
			timestamp: 0,
		},
	};
}

function customEntry(id: string, customType: string, data: unknown): SessionEntry {
	return { type: "custom", id, parentId: null, timestamp: "2026-09-26T00:00:00.000Z", customType, data };
}

describe("isMarkdownPath", () => {
	it("accepts .md and .markdown in any case", () => {
		expect(isMarkdownPath("docs/plan.md")).toBe(true);
		expect(isMarkdownPath("C:\\repo\\README.MD")).toBe(true);
		expect(isMarkdownPath("notes.markdown")).toBe(true);
	});

	it("rejects other files", () => {
		expect(isMarkdownPath("src/index.ts")).toBe(false);
		expect(isMarkdownPath("plan.md.ts")).toBe(false);
		expect(isMarkdownPath("md")).toBe(false);
		expect(isMarkdownPath("")).toBe(false);
	});
});

describe("checkModeToolCall", () => {
	it("blocks edit and write of non-markdown files in plan mode", () => {
		expect(checkModeToolCall("plan", "write", { path: "src/a.ts", content: "" })).toBe(
			'Plan mode: only markdown files can be edited. Call switch_mode with target_mode_id="agent" (requires user approval) before editing src/a.ts.',
		);
		expect(checkModeToolCall("plan", "edit", { file_path: "src/a.ts", old_string: "a", new_string: "b" })).toContain(
			"before editing src/a.ts.",
		);
		expect(checkModeToolCall("plan", "edit", { old_string: "a", new_string: "b" })).toContain("only markdown files");
		expect(checkModeToolCall("plan", "write", {})).toContain("only markdown files");
	});

	it("allows markdown targets in plan mode", () => {
		expect(checkModeToolCall("plan", "write", { path: ".pi/plans/x.plan.md" })).toBeUndefined();
		expect(checkModeToolCall("plan", "edit", { file_path: "README.markdown" })).toBeUndefined();
	});

	it("allows other tools in plan mode and everything in agent mode", () => {
		expect(checkModeToolCall("plan", "read", { path: "src/a.ts" })).toBeUndefined();
		expect(checkModeToolCall("plan", "bash", { command: "rm -rf x" })).toBeUndefined();
		expect(checkModeToolCall("agent", "write", { path: "src/a.ts" })).toBeUndefined();
		expect(checkModeToolCall("agent", "edit", { file_path: "src/a.ts" })).toBeUndefined();
	});
});

describe("modeToolNames", () => {
	it("adds create_plan and drops switch_mode in plan mode, keeping the rest", () => {
		expect(modeToolNames(["read", "switch_mode", "write"], "plan")).toEqual(["read", "write", "create_plan"]);
	});

	it("adds switch_mode and drops create_plan in agent mode", () => {
		expect(modeToolNames(["read", "create_plan"], "agent")).toEqual(["read", "switch_mode"]);
		expect(modeToolNames(["switch_mode"], "agent")).toEqual(["switch_mode"]);
	});
});

describe("modeReminder", () => {
	it("sends the enter notice once after a mode change and the still-in-plan notice afterwards", () => {
		expect(modeReminder("agent", false)).toBeUndefined();
		expect(modeReminder("agent", true)).toContain("You are now in Agent mode. You have EXITED your previous mode.");
		const entered = modeReminder("plan", true) ?? "";
		expect(entered).toContain("You are now in Plan mode.");
		expect(entered).toContain("Plan mode is active.");
		expect(entered).toContain("<plan_mode_guardrails>");
		expect(entered).not.toContain("You are still in **Plan Mode**");
		const still = modeReminder("plan", false) ?? "";
		expect(still).not.toContain("You are now in Plan mode.");
		expect(still).toContain("Plan mode is active.");
		expect(still).toContain("You are still in **Plan Mode**");
	});
});

describe("replayBranch with modes and plans", () => {
	it("replays mode entries, plans, and todos in branch order", () => {
		const entries = [
			customEntry("1", "nek.mode", { mode: "plan" }),
			toolResultEntry("2", "create_plan", { plan: { ...plan, overview: "First" } }),
			toolResultEntry("3", "create_plan", { plan: { ...plan } }),
			customEntry("4", "nek.mode", { mode: "agent" }),
			customEntry("5", "nek.todos", { todos: [todo] }),
		];
		expect(replayBranch(entries)).toEqual({ mode: "agent", todos: [todo], plan });
	});

	it("rebuilds the state of a truncated branch", () => {
		const entries = [
			customEntry("1", "nek.mode", { mode: "plan" }),
			toolResultEntry("2", "create_plan", { plan: { ...plan } }),
			customEntry("3", "nek.mode", { mode: "agent" }),
			customEntry("4", "nek.todos", { todos: [todo] }),
		];
		expect(replayBranch(entries.slice(0, 2))).toEqual({ mode: "plan", todos: [], plan });
		expect(replayBranch(entries.slice(0, 1))).toEqual({ mode: "plan", todos: [] });
	});

	it("ignores failed create_plan results and invalid mode entries", () => {
		const entries = [
			toolResultEntry("1", "create_plan", { plan: { ...plan } }, true),
			toolResultEntry("2", "create_plan", { plan: { name: "x" } }),
			customEntry("3", "nek.mode", { mode: "debug" }),
			customEntry("4", "nek.mode", undefined),
		];
		expect(replayBranch(entries)).toEqual({ mode: "agent", todos: [] });
	});
});

describe("plan store", () => {
	const dirs: string[] = [];

	afterEach(() => {
		while (dirs.length > 0) rmSync(dirs.pop() ?? "", { recursive: true, force: true });
	});

	function tempCwd(): string {
		const dir = mkdtempSync(join(tmpdir(), "nek-plan-"));
		dirs.push(dir);
		return dir;
	}

	it("slugifies names and falls back to the overview", () => {
		expect(slugify("Add OAuth 2.0 login!")).toBe("add-oauth-2-0-login");
		expect(slugify("---")).toBe("plan");
		expect(planName(undefined, "Refactor the database layer for speed")).toBe("Refactor the database layer");
		expect(planName("  Auth  ", "ignored")).toBe("Auth");
	});

	it("builds <cwd>/<dir>/<slug>_<id>.plan.md and never reuses an existing file", () => {
		const cwd = tempCwd();
		const dir = join(cwd, ".pi", "plans");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "add-auth_aaaaaa.plan.md"), "existing");
		const ids = ["aaaaaa", "bbbbbb"];
		const path = planPath(cwd, ".pi/plans", "Add auth", () => ids.shift() ?? "cccccc");
		expect(path).toBe(join(dir, "add-auth_bbbbbb.plan.md"));
		expect(readFileSync(join(dir, "add-auth_aaaaaa.plan.md"), "utf-8")).toBe("existing");
		expect(planPath(cwd, ".pi/plans", "Add auth")).toMatch(/add-auth_[0-9a-f]{6}\.plan\.md$/);
	});

	it("writes YAML frontmatter and the plan body", () => {
		const cwd = tempCwd();
		const record = { ...plan, path: join(cwd, "plans", "add-auth_abc123.plan.md") };
		writePlanFile(record, "# Add auth\n\n- step");
		const content = readFileSync(record.path, "utf-8");
		expect(content).toBe(formatPlanFile(record, "# Add auth\n\n- step"));
		expect(content).toMatch(/^---\nname: Add auth\noverview: Add session auth\.\ntodos:\n {2}- id: schema\n/);
		expect(content.endsWith("---\n\n# Add auth\n\n- step\n")).toBe(true);
	});

	it("turns plan todos into a list with the first item in progress", () => {
		expect(planTodos(plan).map((item) => item.status)).toEqual(["in_progress", "pending"]);
		expect(planTodos({ ...plan, todos: [] })).toEqual([]);
	});
});
