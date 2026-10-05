/**
 * Rounded, raised dialog panel: the shared frame of every selector and dialog.
 *
 * Layout (top to bottom): title (bold, accent), optional subtitle (muted), body (caller content),
 * hint row (dim key hints). The panel uses the `raised` shade with a rounded border so it reads as
 * a layer above the transcript.
 */

import { BoxRenderable, type Renderable, TextAttributes, TextRenderable } from "@opentui/core";
import type { UiEnvironment } from "./environment.ts";

export interface DialogFrameOptions {
	title?: string;
	subtitle?: string;
	hint?: string;
	/** Use the accent border (prompts that need attention). Default: muted border. */
	emphasized?: boolean;
}

export class DialogFrame {
	readonly root: BoxRenderable;
	/** Caller content goes here (column layout). */
	readonly body: BoxRenderable;
	private readonly titleText: TextRenderable;
	private readonly subtitleText: TextRenderable;
	private readonly hintText: TextRenderable;

	constructor(env: UiEnvironment, options: DialogFrameOptions = {}) {
		const theme = env.uiTheme();
		this.root = new BoxRenderable(env.renderer, {
			flexDirection: "column",
			border: true,
			borderStyle: "rounded",
			borderColor: options.emphasized ? theme.borderAccent : theme.borderMuted,
			backgroundColor: theme.raised,
			paddingX: 2,
			paddingY: 1,
			flexShrink: 1,
		});
		this.titleText = new TextRenderable(env.renderer, {
			fg: theme.accent,
			attributes: TextAttributes.BOLD,
			wrapMode: "word",
			visible: Boolean(options.title),
			content: options.title ?? "",
		});
		this.subtitleText = new TextRenderable(env.renderer, {
			fg: theme.muted,
			wrapMode: "word",
			visible: Boolean(options.subtitle),
			content: options.subtitle ?? "",
		});
		this.body = new BoxRenderable(env.renderer, {
			flexDirection: "column",
			flexGrow: 1,
			flexShrink: 1,
			marginTop: options.title || options.subtitle ? 1 : 0,
		});
		this.hintText = new TextRenderable(env.renderer, {
			fg: theme.dim,
			wrapMode: "word",
			marginTop: 1,
			visible: Boolean(options.hint),
			content: options.hint ?? "",
		});
		this.root.add(this.titleText);
		this.root.add(this.subtitleText);
		this.root.add(this.body);
		this.root.add(this.hintText);
	}

	setTitle(title: string | undefined): void {
		this.titleText.content = title ?? "";
		this.titleText.visible = Boolean(title);
	}

	setSubtitle(subtitle: string | undefined): void {
		this.subtitleText.content = subtitle ?? "";
		this.subtitleText.visible = Boolean(subtitle);
	}

	setHint(hint: string | undefined): void {
		this.hintText.content = hint ?? "";
		this.hintText.visible = Boolean(hint);
	}

	/** Add a renderable to the body. */
	add(child: Renderable): void {
		this.body.add(child);
	}
}
