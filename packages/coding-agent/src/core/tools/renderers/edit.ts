import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { renderDiff } from "../../../modes/interactive/components/diff.ts";
import type { ToolDefinition } from "../../extensions/types.ts";
import type { EditToolDetails } from "../edit.ts";
import { computeEditDiff } from "../edit-diff.ts";
import { renderToolPath, str } from "../render-utils.ts";

/** State retained by the edit renderer between the call and its result. */
export type EditRenderState = {
	preview?: { diff: string; firstChangedLine?: number } | { error: string };
	previewArgsKey?: string;
	previewPending?: boolean;
};

type EditArgs = {
	file_path?: string;
	old_string?: string;
	new_string?: string;
	replace_all?: boolean | "true" | "false";
};
type EditResult = { content: Array<{ type: string; text?: string }>; details?: EditToolDetails };
type EditPreview = { diff: string; firstChangedLine?: number } | { error: string };

function getPreviewInput(
	args: EditArgs | undefined,
): { filePath: string; oldString: string; newString: string; replaceAll: boolean } | null {
	if (
		!args ||
		typeof args.file_path !== "string" ||
		typeof args.old_string !== "string" ||
		typeof args.new_string !== "string"
	)
		return null;
	return {
		filePath: args.file_path,
		oldString: args.old_string,
		newString: args.new_string,
		replaceAll: args.replace_all === true || args.replace_all === "true",
	};
}

function formatPreview(
	preview: EditPreview,
	filePath: string,
	theme: Parameters<NonNullable<ToolDefinition<any, any>["renderCall"]>>[1],
): Container {
	const container = new Container();
	if ("error" in preview) {
		container.addChild(new Text(theme.fg("error", preview.error), 0, 0));
	} else {
		container.addChild(new Text(renderDiff(preview.diff, { filePath }), 0, 0));
	}
	return container;
}

function startPreview(
	args: EditArgs | undefined,
	context: Parameters<NonNullable<ToolDefinition<any, any>["renderCall"]>>[2],
	state: EditRenderState,
): void {
	const input = getPreviewInput(args);
	if (!context.argsComplete || !input || state.previewPending) return;
	const key = JSON.stringify(input);
	if (state.previewArgsKey === key && state.preview) return;
	state.previewArgsKey = key;
	state.previewPending = true;
	void computeEditDiff(input.filePath, input.oldString, input.newString, input.replaceAll, context.cwd).then(
		(preview) => {
			if (state.previewArgsKey !== key) return;
			state.preview = preview;
			state.previewPending = false;
			context.invalidate();
		},
	);
}

export const editRenderers: Pick<ToolDefinition<any, any>, "renderCall" | "renderResult"> = {
	renderCall(args, theme, context) {
		const typedArgs = args as EditArgs | undefined;
		const state = context.state as EditRenderState;
		startPreview(typedArgs, context, state);
		const container = new Container();
		container.addChild(
			new Text(
				`${theme.fg("toolTitle", theme.bold("edit"))} ${renderToolPath(str(typedArgs?.file_path), theme, context.cwd)}`,
				0,
				0,
			),
		);
		if (state.preview) {
			container.addChild(new Spacer(1));
			container.addChild(formatPreview(state.preview, typedArgs?.file_path ?? "", theme));
		}
		return container;
	},
	renderResult(result, _options, theme, context) {
		const typedResult = result as EditResult;
		const state = context.state as EditRenderState;
		const resultDiff = !context.isError ? typedResult.details?.diff : undefined;
		const existingPreviewDiff = state.preview && "diff" in state.preview ? state.preview.diff : undefined;
		if (resultDiff) state.preview = { diff: resultDiff };
		const component = new Container();
		if (context.isError) {
			const errorText = typedResult.content
				.filter((entry) => entry.type === "text")
				.map((entry) => entry.text ?? "")
				.join("\n");
			if (errorText && (!state.preview || "error" in state.preview))
				component.addChild(new Text(theme.fg("error", errorText), 0, 0));
			return component;
		}
		if (resultDiff && existingPreviewDiff !== resultDiff) {
			component.addChild(new Spacer(1));
			component.addChild(
				new Text(
					renderDiff(resultDiff, {
						filePath: str((context.args as EditArgs | undefined)?.file_path) ?? undefined,
					}),
					1,
					0,
				),
			);
		}
		return component;
	},
};
