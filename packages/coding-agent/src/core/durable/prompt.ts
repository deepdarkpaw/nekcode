import type { SystemMessage, Tool, ToolReference } from "@earendil-works/pi-ai";
import { declarationsEqual, getCurrentTools, toToolDeclaration } from "@earendil-works/pi-ai/utils/transcript";
import { type ContextEdit, type ContextView, SystemEntry, type TypedEntryDraft } from "@earendil-works/pi-durable";
import type { PromptSection } from "./registry.ts";

type SystemDraft = TypedEntryDraft<never>;
type ToolChanges = { readonly toolsRemoved: ToolReference[]; readonly toolsAdded: Tool[] };

/**
 * The `pi.system` entries durable's generation preparation would append for `prompt` and `tools`, planned the same way
 * (durable `harness/prompt.ts`, `planSystemEntries`) for the engine's prompt sections. The engine appends them
 * before the run's input, so the system message precedes the user message as in pi's loop; preparation then finds the
 * prompt and tools already in effect and appends nothing.
 *
 * Kept in step with durable's planner: if they ever disagree, preparation appends its own correcting entry after the
 * input, and the request is still right.
 */
export function planSystemEntries(
	view: ContextView,
	prompt: readonly PromptSection[],
	tools: readonly Tool[],
	timestamp: number,
): SystemDraft[] {
	const desired = new Map<string, string>(prompt.map((part) => [part.key, part.value]));
	const head = view.head;
	if (head !== undefined && !view.entries.some((entry) => SystemEntry.is(entry) && entry.id > head.id)) {
		const edits: ContextEdit[] = view.entries
			.filter((entry) => SystemEntry.is(entry))
			.map((entry) => ({ target: entry.id, action: "omit" }));
		const baseline = systemEntry(
			Object.fromEntries(desired),
			{ toolsRemoved: [], toolsAdded: tools.map(toToolDeclaration) },
			timestamp,
		);
		return [edits.length === 0 ? baseline : { ...baseline, edits }];
	}
	const sections = planSections(replaySections(view.messages), desired);
	const changes = planTools(getCurrentTools(view.messages), tools);
	if (changes.toolsRemoved.length === 0 && changes.toolsAdded.length === 0) {
		return sections.map((patch) => systemEntry(patch, undefined, timestamp));
	}
	if (sections.length === 0) return [systemEntry(undefined, changes, timestamp)];
	return sections.map((patch, index) =>
		systemEntry(patch, index === sections.length - 1 ? changes : undefined, timestamp),
	);
}

function replaySections(messages: ContextView["messages"]): Map<string, string> {
	const shown = new Map<string, string>();
	for (const message of messages) {
		if (message.role !== "system" || message.sections === undefined) continue;
		for (const [key, value] of Object.entries(message.sections)) {
			if (value === null) shown.delete(key);
			else shown.set(key, value);
		}
	}
	return shown;
}

function planTools(offered: readonly Tool[], desired: readonly Tool[]): ToolChanges {
	const wanted = new Map(desired.map((tool) => [tool.name, tool]));
	const kept = offered.filter((tool) => {
		const next = wanted.get(tool.name);
		return next !== undefined && declarationsEqual(tool, next);
	});
	const keptNames = new Set(kept.map((tool) => tool.name));
	const added = desired.filter((tool) => !keptNames.has(tool.name));
	const replayed = [...kept, ...added];
	if (replayed.some((tool, index) => tool.name !== desired[index]!.name)) {
		return { toolsRemoved: offered.map((tool) => ({ name: tool.name })), toolsAdded: desired.map(toToolDeclaration) };
	}
	return {
		toolsRemoved: offered.filter((tool) => !keptNames.has(tool.name)).map((tool) => ({ name: tool.name })),
		toolsAdded: added.map(toToolDeclaration),
	};
}

function planSections(
	shown: ReadonlyMap<string, string>,
	desired: ReadonlyMap<string, string>,
): Record<string, string | null>[] {
	const patchedOrder = [
		...[...shown.keys()].filter((key) => desired.has(key)),
		...[...desired.keys()].filter((key) => !shown.has(key)),
	];
	const desiredOrder = [...desired.keys()];
	if (patchedOrder.some((key, index) => key !== desiredOrder[index])) {
		return [Object.fromEntries([...shown.keys()].map((key) => [key, null])), Object.fromEntries(desired)];
	}
	const patch: Record<string, string | null> = {};
	for (const [key, value] of shown) {
		const next = desired.get(key);
		if (next !== value) patch[key] = next ?? null;
	}
	for (const [key, value] of desired) if (!shown.has(key)) patch[key] = value;
	return Object.keys(patch).length === 0 ? [] : [patch];
}

function systemEntry(
	sections: Record<string, string | null> | undefined,
	tools: ToolChanges | undefined,
	timestamp: number,
): SystemDraft {
	const message: SystemMessage = {
		role: "system",
		content: "",
		...(sections === undefined ? {} : { sections }),
		...(tools === undefined || tools.toolsRemoved.length === 0 ? {} : { toolsRemoved: tools.toolsRemoved }),
		...(tools === undefined || tools.toolsAdded.length === 0 ? {} : { toolsAdded: tools.toolsAdded }),
		timestamp,
	};
	return { model: [message] };
}
