import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import * as Diff from "diff";
import { applyTextReplacements, type TextReplacement } from "./edit-replacements.ts";
import { getEditReplacements, validateEditText } from "./edit-validate.ts";
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
	const lineNumWidth = String(Math.max(countLines(oldContent), countLines(newContent))).length;
	const { output, firstChangedLine } = formatDisplayDiff(
		Diff.diffLines(oldContent, newContent),
		1,
		1,
		lineNumWidth,
		contextLines,
	);
	return { diff: output.join("\n"), firstChangedLine };
}

/** Count lines as `text.split("\n").length` does without allocating a file-sized array. */
function countLines(text: string): number {
	return countLineFeeds(text, 0, text.length) + 1;
}

function countLineFeeds(text: string, start: number, end: number): number {
	let count = 0;
	for (let index = text.indexOf("\n", start); index !== -1 && index < end; index = text.indexOf("\n", index + 1)) {
		count++;
	}
	return count;
}

/** Format jsdiff line parts using file-global line numbers for either full contents or an edit window. */
function formatDisplayDiff(
	parts: Diff.ChangeObject<string>[],
	oldStartLine: number,
	newStartLine: number,
	lineNumWidth: number,
	contextLines: number,
): { output: string[]; firstChangedLine: number | undefined } {
	const output: string[] = [];
	let oldLineNum = oldStartLine;
	let newLineNum = newStartLine;
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
	return { output, firstChangedLine };
}

function appendContext(output: string[], lines: string[], startLine: number, width: number): void {
	for (let index = 0; index < lines.length; index++) {
		output.push(` ${String(startLine + index).padStart(width, " ")} ${lines[index]}`);
	}
}

/** Display diff and unified patch computed before an edit is written. */
export interface EditDiff {
	diff: string;
	patch: string;
	firstChangedLine: number | undefined;
}

/** Extra unchanged lines let jsdiff align changes beyond the displayed context. */
const DIFF_WINDOW_MARGIN_LINES = 32;

/**
 * Diff only whole-line windows around known replacements. Memory follows the changed regions, not the
 * whole file. Repeated lines may align differently from a whole-file diff, but the patch is equivalent.
 */
export function generateEditDiff(
	path: string,
	baseContent: string,
	newContent: string,
	replacements: TextReplacement[],
	contextLines = 4,
): EditDiff {
	const lineNumWidth = String(Math.max(countLines(baseContent), countLines(newContent))).length;
	const skipMarker = ` ${"".padStart(lineNumWidth, " ")} ...`;
	const output: string[] = [];
	const hunks: Diff.StructuredPatchHunk[] = [];
	let firstChangedLine: number | undefined;
	const margin = Math.max(DIFF_WINDOW_MARGIN_LINES, contextLines + 1);
	for (const window of getDiffWindows(baseContent, replacements, margin)) {
		const oldText = baseContent.slice(window.oldStart, window.oldEnd);
		const newText = newContent.slice(window.newStart, window.newEnd);
		const shown = formatDisplayDiff(
			Diff.diffLines(oldText, newText),
			window.oldLine + 1,
			window.newLine + 1,
			lineNumWidth,
			contextLines,
		);
		firstChangedLine ??= shown.firstChangedLine;
		// Both windows mark the same skipped run; show it only once, as a whole-file diff would.
		if (output.at(-1) === skipMarker && shown.output[0] === skipMarker) shown.output.shift();
		// Avoid spreading large replacements, which can overflow the call stack.
		for (const line of shown.output) output.push(line);
		const patch = Diff.structuredPatch(path, path, oldText, newText, undefined, undefined, { context: contextLines });
		for (const hunk of patch.hunks) {
			hunks.push({ ...hunk, oldStart: hunk.oldStart + window.oldLine, newStart: hunk.newStart + window.newLine });
		}
	}
	const patch = Diff.formatPatch(
		{ oldFileName: path, newFileName: path, oldHeader: undefined, newHeader: undefined, hunks },
		Diff.FILE_HEADERS_ONLY,
	);
	return { diff: output.join("\n"), patch, firstChangedLine };
}

/** Matching ranges of old/new contents and their zero-based starting line numbers. */
interface DiffWindow {
	oldStart: number;
	oldEnd: number;
	oldLine: number;
	newStart: number;
	newEnd: number;
	newLine: number;
}

/** Start of the line containing an offset, including offset zero when the first character is LF. */
function lineStartBefore(text: string, offset: number): number {
	return offset === 0 ? 0 : text.lastIndexOf("\n", offset - 1) + 1;
}

/** Build and merge whole-line windows around sorted, disjoint replacements without indexing all lines. */
function getDiffWindows(baseContent: string, replacements: TextReplacement[], margin: number): DiffWindow[] {
	const windows: DiffWindow[] = [];
	let offsetDelta = 0;
	let lineDelta = 0;
	let cursorOffset = 0;
	let cursorLine = 0;
	for (const replacement of replacements) {
		const matchEnd = replacement.matchIndex + replacement.matchLength;
		let start = lineStartBefore(baseContent, replacement.matchIndex);
		for (let i = 0; i < margin && start > 0; i++) {
			start = lineStartBefore(baseContent, start - 1);
		}
		let end = matchEnd;
		for (let i = 0; i <= margin && end < baseContent.length; i++) {
			const lineFeed = baseContent.indexOf("\n", i === 0 ? Math.max(matchEnd - 1, replacement.matchIndex) : end);
			end = lineFeed === -1 ? baseContent.length : lineFeed + 1;
		}
		const replacementOffsetDelta = replacement.newText.length - replacement.matchLength;
		const replacementLineDelta =
			countLineFeeds(replacement.newText, 0, replacement.newText.length) -
			countLineFeeds(baseContent, replacement.matchIndex, matchEnd);
		const previous = windows.at(-1);
		if (previous && start <= previous.oldEnd) {
			previous.oldEnd = Math.max(previous.oldEnd, end);
			previous.newEnd = previous.oldEnd + offsetDelta + replacementOffsetDelta;
		} else {
			cursorLine += countLineFeeds(baseContent, cursorOffset, start);
			cursorOffset = start;
			windows.push({
				oldStart: start,
				oldEnd: end,
				oldLine: cursorLine,
				newStart: start + offsetDelta,
				newEnd: end + offsetDelta + replacementOffsetDelta,
				newLine: cursorLine + lineDelta,
			});
		}
		offsetDelta += replacementOffsetDelta;
		lineDelta += replacementLineDelta;
	}
	return windows;
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
		const replacements = getEditReplacements(
			metadata.content,
			validated.actualOldString,
			validated.newString,
			replaceAll,
		);
		const updated = applyTextReplacements(metadata.content, replacements);
		if (updated === metadata.content)
			throw new Error("No changes to make: old_string and new_string are exactly the same.");
		const { diff, firstChangedLine } = generateEditDiff(filePath, metadata.content, updated, replacements);
		return { diff, firstChangedLine };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}
