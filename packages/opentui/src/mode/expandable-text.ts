/**
 * Text with a collapsed and an expanded form, toggled by `app.tools.expand` (startup header,
 * resource listing). Same behavior as the interactive mode's `ExpandableText`.
 */

import { Text } from "@earendil-works/pi-tui";

export interface Expandable {
	setExpanded(expanded: boolean): void;
}

export function isExpandable(value: unknown): value is Expandable {
	return (
		typeof value === "object" &&
		value !== null &&
		"setExpanded" in value &&
		typeof (value as { setExpanded: unknown }).setExpanded === "function"
	);
}

export class ExpandableText extends Text implements Expandable {
	private readonly getCollapsedText: () => string;
	private readonly getExpandedText: () => string;

	constructor(
		getCollapsedText: () => string,
		getExpandedText: () => string,
		expanded = false,
		paddingX = 0,
		paddingY = 0,
	) {
		super(expanded ? getExpandedText() : getCollapsedText(), paddingX, paddingY);
		this.getCollapsedText = getCollapsedText;
		this.getExpandedText = getExpandedText;
	}

	setExpanded(expanded: boolean): void {
		this.setText(expanded ? this.getExpandedText() : this.getCollapsedText());
	}
}
