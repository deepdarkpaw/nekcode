/** Styled-text helpers: map tones from the state layer to palette colors. */

import { bold as boldChunk, fg, italic as italicChunk, StyledText, type TextChunk } from "@opentui/core";
import type { Line, Segment, Tone } from "../state/tool-display.ts";
import type { Palette } from "../theme/palette.ts";

export function toneColor(palette: Palette, tone: Tone): string {
	switch (tone) {
		case "text":
			return palette.text;
		case "output":
			return palette.toolOutput;
		case "muted":
			return palette.muted;
		case "dim":
			return palette.dim;
		case "accent":
			return palette.accent;
		case "link":
			return palette.link;
		case "error":
			return palette.error;
		case "success":
			return palette.diffAdded;
		case "warning":
			return palette.warning;
	}
}

export interface ChunkStyle {
	color: string;
	bold?: boolean;
	italic?: boolean;
}

export function chunk(text: string, style: ChunkStyle): TextChunk {
	let result = fg(style.color)(text);
	if (style.bold) result = boldChunk(result);
	if (style.italic) result = italicChunk(result);
	return result;
}

export function styled(chunks: TextChunk[]): StyledText {
	return new StyledText(chunks);
}

export function segmentChunks(palette: Palette, segments: readonly Segment[]): TextChunk[] {
	return segments.map((segment) =>
		chunk(segment.text, { color: toneColor(palette, segment.tone), bold: segment.bold }),
	);
}

export function lineText(palette: Palette, line: Line): StyledText {
	return styled(segmentChunks(palette, line));
}
