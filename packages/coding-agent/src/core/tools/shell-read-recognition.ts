import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { readStateKey } from "./read-state.ts";

/** File and optional line range of one recognized literal shell reader. */
export interface ShellReadEvidence {
	path: string;
	offset?: number;
	limit?: number;
}

function tokenize(command: string, shell: "bash" | "powershell"): string[] | undefined {
	if (/[;|&<>$`*?()[\]{}\n\r]/u.test(command)) return undefined;
	const tokens: string[] = [];
	let token = "";
	let quote: string | undefined;
	let started = false;
	let closedQuote = false;
	for (const character of command.trim()) {
		if (quote) {
			if (shell === "bash" && quote === '"' && character === "\\") return undefined;
			if (character === quote) {
				quote = undefined;
				closedQuote = true;
			} else token += character;
			continue;
		}
		if (/\s/u.test(character)) {
			if (started) tokens.push(token);
			token = "";
			started = false;
			closedQuote = false;
			continue;
		}
		if (closedQuote) return undefined;
		if (character === "'" || character === '"') {
			if (started || tokens.length === 0) return undefined;
			quote = character;
			started = true;
			continue;
		}
		if (character === "#" || character === "~" || (shell === "bash" && character === "\\")) return undefined;
		token += character;
		started = true;
	}
	if (quote) return undefined;
	if (started) tokens.push(token);
	return tokens.length > 0 ? tokens : undefined;
}

function parseCount(value: string | undefined): number | undefined {
	if (value === undefined || !/^\d+$/u.test(value)) return undefined;
	const count = Number(value);
	return Number.isSafeInteger(count) ? count : undefined;
}

/** Parse only cat, head/tail with optional -n N, or sed -n 'A[,B]p', each with one literal path. */
export function recognizeBashRead(command: string): ShellReadEvidence | undefined {
	const tokens = tokenize(command, "bash");
	if (!tokens) return undefined;
	const reader = tokens[0];
	if (reader === "cat" || reader === "head" || reader === "tail") {
		if (tokens.length === 2 && tokens[1] && !tokens[1].startsWith("-")) return { path: tokens[1] };
		if (reader === "cat" || (tokens.length !== 3 && tokens.length !== 4)) return undefined;
		let countToken: string | undefined;
		let path: string | undefined;
		if (tokens.length === 3 && tokens[1]?.startsWith("-n")) {
			countToken = tokens[1].slice(2);
			path = tokens[2];
		} else if (tokens.length === 4 && tokens[1] === "-n") {
			countToken = tokens[2];
			path = tokens[3];
		}
		const count = parseCount(countToken);
		if (count === undefined || !path || path.startsWith("-")) return undefined;
		return { path, offset: reader === "head" ? 1 : -count, limit: count };
	}
	if (reader !== "sed" || tokens.length !== 4 || tokens[1] !== "-n") return undefined;
	const match = tokens[2]?.match(/^(\d+)(?:,(\d+))?p$/u);
	const path = tokens[3];
	if (!match || !path || path.startsWith("-")) return undefined;
	const start = Number(match[1]);
	const end = match[2] === undefined ? start : Number(match[2]);
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) return undefined;
	return { path, offset: start, limit: end - start + 1 };
}

/** Parse Get-Content or its standard aliases with one path and optional path/count parameters. */
export function recognizePowerShellRead(command: string): ShellReadEvidence | undefined {
	const tokens = tokenize(command, "powershell");
	if (!tokens) return undefined;
	const reader = tokens[0]?.toLowerCase();
	if (reader !== "get-content" && reader !== "gc" && reader !== "cat" && reader !== "type") return undefined;
	let path: string | undefined;
	let offset: number | undefined;
	let limit: number | undefined;
	for (let index = 1; index < tokens.length; index++) {
		const token = tokens[index]!;
		const option = token.toLowerCase();
		if (option === "-path" || option === "-literalpath") {
			if (path !== undefined || index + 1 >= tokens.length) return undefined;
			path = tokens[++index];
		} else if (option === "-totalcount" || option === "-head" || option === "-tail") {
			if (limit !== undefined || index + 1 >= tokens.length) return undefined;
			const count = parseCount(tokens[++index]);
			if (count === undefined) return undefined;
			offset = option === "-tail" ? -count : 1;
			limit = count;
		} else {
			if (token.startsWith("-") || path !== undefined) return undefined;
			path = token;
		}
	}
	if (!path || path.startsWith("-") || path.includes(",")) return undefined;
	return { path, ...(offset === undefined ? {} : { offset }), ...(limit === undefined ? {} : { limit }) };
}

/**
 * Require a regular local file at the literal path relative to the actual execution cwd.
 * Reader aliases/functions and custom remote operations are not output-verified: successful execution is evidence
 * only for this conservative command shape. Compound prefixes and rewrites are intentionally not recognized.
 */
export async function resolveShellRead(
	command: string,
	shell: "bash" | "powershell",
	cwd: string,
): Promise<ShellReadEvidence | undefined> {
	const parsed = shell === "bash" ? recognizeBashRead(command) : recognizePowerShellRead(command);
	if (!parsed) return undefined;
	const path = resolve(cwd, parsed.path);
	try {
		if (!(await stat(path)).isFile()) return undefined;
	} catch (error) {
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			(error.code === "ENOENT" || error.code === "ENOTDIR")
		)
			return undefined;
		throw error;
	}
	return { ...parsed, path: readStateKey(path) };
}
