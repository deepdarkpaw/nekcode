import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { stringify } from "yaml";
import type { PlanRecord, Todo } from "../types.ts";

/** Suffix of plan files. */
export const PLAN_FILE_SUFFIX = ".plan.md";

const SLUG_MAX_LENGTH = 48;
const NAME_FALLBACK_WORDS = 4;
const PATH_ATTEMPTS = 16;

/** Lowercase ASCII slug of a plan name, at most 48 characters; `plan` when nothing usable remains. */
export function slugify(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.slice(0, SLUG_MAX_LENGTH)
		.replace(/^-+|-+$/g, "");
	return slug || "plan";
}

/** Plan name for a first create_plan call: the given name, else the first four words of the overview. */
export function planName(name: string | undefined, overview: string): string {
	const trimmed = name?.trim();
	if (trimmed) return trimmed;
	return overview.trim().split(/\s+/).slice(0, NAME_FALLBACK_WORDS).join(" ");
}

/** Stable id derived from a plan filename, without the `.plan.md` suffix. */
export function planId(plan: PlanRecord | string): string {
	const path = typeof plan === "string" ? plan : plan.path;
	const file = basename(path.replaceAll("\\", "/"));
	return file.endsWith(PLAN_FILE_SUFFIX) ? file.slice(0, -PLAN_FILE_SUFFIX.length) : file;
}

/** Random 6-character hex id that keeps plan file names unique. */
export function createPlanFileId(): string {
	return randomBytes(3).toString("hex");
}

/**
 * Absolute path for a new plan: `<cwd>/<dir>/<slug>_<id>.plan.md`. Draws a new id while the file exists, so an
 * existing plan is never overwritten; throws after 16 attempts.
 */
export function planPath(cwd: string, dir: string, name: string, createId: () => string = createPlanFileId): string {
	const base = resolve(cwd, dir, slugify(name));
	for (let attempt = 0; attempt < PATH_ATTEMPTS; attempt++) {
		const path = `${base}_${createId()}${PLAN_FILE_SUFFIX}`;
		if (!existsSync(path)) return path;
	}
	throw new Error(`Could not find a free plan file name for ${base}${PLAN_FILE_SUFFIX}`);
}

/** Plan file content: YAML frontmatter with name, overview, and todos, then the plan markdown. */
export function formatPlanFile(record: PlanRecord, planMarkdown: string): string {
	const frontmatter = stringify({ name: record.name, overview: record.overview, todos: record.todos });
	return `---\n${frontmatter}---\n\n${planMarkdown.trimEnd()}\n`;
}

/** Write the plan file at `record.path`, creating its directory. Revisions overwrite the same file. */
export function writePlanFile(record: PlanRecord, planMarkdown: string): void {
	mkdirSync(dirname(record.path), { recursive: true });
	writeFileSync(record.path, formatPlanFile(record, planMarkdown), "utf-8");
}

/** Todo list that implements a plan: the first item in_progress, the rest pending. */
export function planTodos(plan: PlanRecord): Todo[] {
	return plan.todos.map((todo, index) => ({
		id: todo.id,
		content: todo.content,
		status: index === 0 ? "in_progress" : "pending",
	}));
}

/** Current plan markdown of a plan file without its frontmatter (the user may have edited it after create_plan). */
export function readPlanBody(record: PlanRecord): string {
	return readFileSync(record.path, "utf-8")
		.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")
		.trim();
}
