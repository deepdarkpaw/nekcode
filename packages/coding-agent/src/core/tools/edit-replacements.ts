/** A replacement in LF-normalized content; ranges are sorted and disjoint. */
export interface TextReplacement {
	matchIndex: number;
	matchLength: number;
	newText: string;
}

/** Apply literal replacement ranges without interpreting replacement-string tokens. */
export function applyTextReplacements(content: string, replacements: TextReplacement[]): string {
	const parts: string[] = [];
	let position = 0;
	for (const replacement of replacements) {
		parts.push(content.slice(position, replacement.matchIndex), replacement.newText);
		position = replacement.matchIndex + replacement.matchLength;
	}
	parts.push(content.slice(position));
	return parts.join("");
}

/**
 * Splice LF-normalized replacement ranges into the original decoded text. Only CRLF normalization
 * changes offsets; untouched text retains its bytes and inserted lines use their replaced line's ending.
 */
export function applyReplacementsToOriginal(originalContent: string, replacements: TextReplacement[]): string {
	let crlfBefore = 0;
	let nextCrlf = originalContent.indexOf("\r\n");
	const toOriginal = (offset: number): number => {
		while (nextCrlf !== -1 && nextCrlf - crlfBefore < offset) {
			crlfBefore++;
			nextCrlf = originalContent.indexOf("\r\n", nextCrlf + 2);
		}
		return offset + crlfBefore;
	};

	const parts: string[] = [];
	let endsWithCr = false;
	const push = (part: string): void => {
		if (part.length === 0) return;
		// Keep two normalized line breaks when a kept/inserted CR meets an LF at a splice seam.
		// The added byte belongs to the replacement; no kept byte is changed or removed.
		if (endsWithCr && part[0] === "\n") parts.push("\n");
		parts.push(part);
		endsWithCr = part.at(-1) === "\r";
	};
	const readLineEnding = createLineEndingReader(originalContent);
	let position = 0;
	for (const replacement of replacements) {
		const start = toOriginal(replacement.matchIndex);
		push(originalContent.slice(position, start));
		const ending = readLineEnding(start);
		push(ending === "\n" ? replacement.newText : replacement.newText.replaceAll("\n", ending));
		position = toOriginal(replacement.matchIndex + replacement.matchLength);
	}
	push(originalContent.slice(position));
	return parts.join("");
}

/** Read local line endings at increasing offsets without rescanning long lines for every replacement. */
function createLineEndingReader(content: string): (offset: number) => "\r\n" | "\n" | "\r" {
	let lineFeed = content.indexOf("\n");
	if (lineFeed === -1) {
		const ending = content.includes("\r") ? "\r" : "\n";
		return () => ending;
	}
	let previous = lineFeed;
	return (offset) => {
		while (lineFeed !== -1 && lineFeed < offset) {
			previous = lineFeed;
			lineFeed = content.indexOf("\n", lineFeed + 1);
		}
		const selected = lineFeed === -1 ? previous : lineFeed;
		return content[selected - 1] === "\r" ? "\r\n" : "\n";
	};
}
