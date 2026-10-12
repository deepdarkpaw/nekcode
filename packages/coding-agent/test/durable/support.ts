import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	type Api,
	createModels,
	type FauxProviderHandle,
	fauxProvider,
	type Message,
	type Model,
	type Models,
	type RegisterFauxProviderOptions,
} from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { DurableEngine, type DurableEngineOptions } from "../../src/core/durable/engine.ts";
import type { DurableSessionEvent } from "../../src/core/durable/events.ts";
import { type Settings, SettingsManager } from "../../src/core/settings-manager.ts";

/** Faux model access and settings that survive a close and reopen, like a host process's own objects. */
export type DurableTestSetup = {
	readonly faux: FauxProviderHandle;
	readonly models: Models;
	readonly model: Model<Api>;
	readonly settingsManager: SettingsManager;
	readonly reports: unknown[];
};

export function durableSetup(
	options: RegisterFauxProviderOptions & { readonly settings?: Partial<Settings> } = {},
): DurableTestSetup {
	const { settings, ...fauxOptions } = options;
	const faux = fauxProvider(fauxOptions);
	const models = createModels();
	models.setProvider(faux.provider);
	return {
		faux,
		models,
		model: faux.getModel() as Model<Api>,
		settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, ...settings }),
		reports: [],
	};
}

/** Open an engine on `path` with the setup's model and settings. */
export function openEngine(
	setup: DurableTestSetup,
	path: string | undefined,
	options: Partial<DurableEngineOptions> = {},
): Promise<DurableEngine> {
	return DurableEngine.open({
		path,
		models: setup.models,
		settingsManager: setup.settingsManager,
		tools: [],
		model: setup.model,
		onReport: (error) => setup.reports.push(error),
		...options,
	});
}

/** Collect every event an engine emits. */
export function recordEvents(engine: DurableEngine): DurableSessionEvent[] {
	const events: DurableSessionEvent[] = [];
	engine.subscribe((event) => {
		events.push(event);
	});
	return events;
}

/** Event types with consecutive `message_update`s collapsed, the shape compared against pi's own loop. */
export function eventShape(events: readonly { readonly type: string }[]): string[] {
	const shape: string[] = [];
	for (const event of events) {
		if (event.type === "message_update" && shape[shape.length - 1] === "message_update") continue;
		shape.push(event.type);
	}
	return shape;
}

/** A tool with an empty schema that runs `run`. */
export function testTool(
	name: string,
	run: (
		signal: AbortSignal | undefined,
		id: string,
		args: Record<string, unknown>,
	) => Promise<AgentToolResult<unknown>>,
	options: { readonly replay?: "safe" | "never" } = {},
): AgentTool {
	return {
		name,
		label: name,
		description: `Test tool ${name}`,
		parameters: Type.Object({ path: Type.Optional(Type.String()) }),
		...(options.replay === undefined ? {} : { replay: options.replay }),
		execute: (id, args, signal) => run(signal, id, args as Record<string, unknown>),
	};
}

/** Text tool result. */
export function textResult(text: string, details: unknown = {}): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details };
}

/** Resolve when `signal` aborts; never otherwise. */
export function untilAborted(signal: AbortSignal | undefined): Promise<never> {
	return new Promise((_, reject) => {
		signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
	});
}

/** First text of a model message. */
export function textOf(message: Message | undefined): string | undefined {
	if (message === undefined || message.role === "system") return undefined;
	if (typeof message.content === "string") return message.content;
	const text = message.content.find((content) => content.type === "text");
	return text?.type === "text" ? text.text : undefined;
}

/** The model message of an entry. */
export function modelOf(entry: EntryRecord): Message | undefined {
	return entry.model?.[0];
}

/** A temp directory removed by the returned cleanup. */
export function tempDir(prefix: string): { readonly dir: string; readonly cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Entries that would be duplicates: the same user text twice in a row, two answers for one request, or two results
 * for one tool call.
 */
export function duplicateEntries(entries: readonly EntryRecord[]): string[] {
	const problems: string[] = [];
	const results = new Set<string>();
	const calls = new Set<string>();
	for (const entry of entries) {
		const message = modelOf(entry);
		if (message?.role === "toolResult") {
			if (results.has(message.toolCallId)) problems.push(`two results for ${message.toolCallId}`);
			results.add(message.toolCallId);
		}
		if (message?.role === "assistant" && message.stopReason !== "aborted") {
			for (const content of message.content) {
				if (content.type !== "toolCall") continue;
				if (calls.has(content.id)) problems.push(`two calls ${content.id}`);
				calls.add(content.id);
			}
		}
	}
	for (let index = 1; index < entries.length; index++) {
		const previous = modelOf(entries[index - 1]!);
		const current = modelOf(entries[index]!);
		if (previous?.role === "user" && current?.role === "user" && textOf(previous) === textOf(current)) {
			problems.push(`user input "${textOf(current)}" twice`);
		}
		if (
			previous?.role === "assistant" &&
			current?.role === "assistant" &&
			previous.stopReason !== "aborted" &&
			current.stopReason !== "aborted"
		) {
			problems.push(`two answers in a row: ${entries[index - 1]!.id}, ${entries[index]!.id}`);
		}
	}
	return problems;
}
