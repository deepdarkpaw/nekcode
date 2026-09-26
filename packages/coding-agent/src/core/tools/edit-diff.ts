import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import * as Diff from "diff";
import { applyEditToFile, validateEditText } from "./edit-validate.ts";
import { decodeFileText } from "./file-text.ts";
import { resolveToCwd } from "./path-utils.ts";

/** Shared line-ending and diff utilities for the exact edit tool. */

/** Detect the dominant line ending in the first 4096 characters. */
export function detectLineEnding(content: string): "\r\n" | "\n" {
	const sample = content.slice(0, 4096);
	const crlfCount = (sample.match(/\r\n/g) ?? []).length;
	const lfCount = (sample.match(/(?<!\r)\n/g) ?? []).length;
	return crlfCount > lfCount ? "\r\n" : "\n";
}

/** Normalize all supported line endings to LF for matching and diffing. */
export function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** Restore a file's detected line ending after an edit. */
export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
	return ending === "\r\n" ? text.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n") : text;
}

/** Generate a standard unified patch. */
export function generateUnifiedPatch(path: string, oldContent: string, newContent: string, contextLines = 4): string {
	return Diff.createTwoFilesPatch(path, path, oldContent, newContent, undefined, undefined, {
		context: contextLines,
		headerOptions: Diff.FILE_HEADERS_ONLY,
	});
}

/** Generate a display-oriented diff string with context and the first changed line. */
export function generateDiffString(
	oldContent: string,
	newContent: string,
	contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
	const parts = Diff.diffLines(oldContent, newContent);
	const output: string[] = [];
	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");
	const lineNumWidth = String(Math.max(oldLines.length, newLines.length)).length;
	let oldLineNum = 1;
	let newLineNum = 1;
	let lastWasChange = false;
	let firstChangedLine: number | undefined;

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		const lines = part.value.split("\n");
		if (lines.at(-1) === "") lines.pop();
		if (part.added || part.removed) {
			if (firstChangedLine === undefined) firstChangedLine = newLineNum;
			for (const line of lines) {
				if (part.added) {
					output.push(`+${String(newLineNum).padStart(lineNumWidth, " ")} ${line}`);
					newLineNum++;
				} else {
					output.push(`-${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
					oldLineNum++;
				}
			}
			lastWasChange = true;
			continue;
		}

		const nextPartIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);
		if (lastWasChange && nextPartIsChange) {
			if (lines.length <= contextLines * 2) {
				for (const line of lines) {
					output.push(` ${String(oldLineNum).padStart(lineNumWidth, " ")} ${line}`);
					oldLineNum++;
					newLineNum++;
				}
			} else {
				appendContext(output, lines.slice(0, contextLines), oldLineNum, lineNumWidth);
				const skipped = lines.length - contextLines * 2;
				output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
				oldLineNum += contextLines + skipped;
				newLineNum += contextLines + skipped;
				appendContext(output, lines.slice(-contextLines), oldLineNum, lineNumWidth);
				oldLineNum += contextLines;
				newLineNum += contextLines;
			}
		} else if (lastWasChange) {
			appendContext(output, lines.slice(0, contextLines), oldLineNum, lineNumWidth);
			const skipped = Math.max(0, lines.length - contextLines);
			if (skipped > 0) output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
			oldLineNum += lines.length;
			newLineNum += lines.length;
		} else if (nextPartIsChange) {
			const skipped = Math.max(0, lines.length - contextLines);
			if (skipped > 0) output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
			oldLineNum += skipped;
			newLineNum += skipped;
			appendContext(output, lines.slice(skipped), oldLineNum, lineNumWidth);
			oldLineNum += lines.length - skipped;
			newLineNum += lines.length - skipped;
		} else {
			oldLineNum += lines.length;
			newLineNum += lines.length;
		}
		lastWasChange = false;
	}
	return { diff: output.join("\n"), firstChangedLine };
}

function appendContext(output: string[], lines: string[], startLine: number, width: number): void {
	for (let index = 0; index < lines.length; index++) {
		output.push(` ${String(startLine + index).padStart(width, " ")} ${lines[index]}`);
	}
}

/** Compute an exact edit preview without writing the file. */
export async function computeEditDiff(
	filePath: string,
	oldString: string,
	newString: string,
	replaceAll: boolean,
	cwd: string,
): Promise<{ diff: string; firstChangedLine: number | undefined } | { error: string }> {
	const absolutePath = resolveToCwd(filePath, cwd);
	try {
		await access(absolutePath, constants.R_OK);
		const metadata = decodeFileText(await readFile(absolutePath));
		const validated = validateEditText(metadata.content, {
			filePath,
			oldString,
			newString,
			replaceAll,
		});
		const updated = applyEditToFile(metadata.content, validated.actualOldString, validated.newString, replaceAll);
		if (updated === metadata.content)
			throw new Error("No changes to make: old_string and new_string are exactly the same.");
		return generateDiffString(metadata.content, updated);
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}
