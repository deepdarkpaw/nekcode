/**
 * nek: child process for the boundary kill tests. It opens a SQLite Harness, drives one mode to its kill point, prints
 * `KILL-POINT`, and then holds every later Storage commit, so the parent's kill lands exactly there.
 *
 * - `yield` / `tools`: the `onYield` / `afterTools` decision was pinned; the commit consuming it never lands.
 * - `trigger-busy`: a triggered write was admitted to a busy conversation's inbox; its placement never lands.
 * - `trigger-idle`: a triggered write and the run it started were committed; nothing after that lands.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	type Message,
	Type,
} from "@earendil-works/pi-ai";
import {
	createRegistry,
	defineExtension,
	defineTool,
	GenerationTask,
	Harness,
	hook,
	type Storage,
	type StorageWrite,
} from "../../src/index.ts";
import { openNodeSqliteStorage } from "../../src/storage/sqlite/node.ts";

const [mode, path] = process.argv.slice(2);
if (mode === undefined || path === undefined) throw new Error("usage: nek-boundary-child <mode> <path>");
const context = BACKGROUND_CONTEXT;

let killPoint: ((writes: readonly StorageWrite[]) => boolean) | undefined;
let held = false;

/** Storage whose commits stop landing after the kill point. */
function holding(storage: Storage): Storage {
	return new Proxy(storage, {
		get(target, property) {
			const value = Reflect.get(target, property, target);
			if (property !== "commit" || typeof value !== "function") {
				return typeof value === "function" ? value.bind(target) : value;
			}
			return async (...args: unknown[]) => {
				if (held) return new Promise(() => {});
				const seq = await value.apply(target, args);
				if (killPoint?.(args[0] as readonly StorageWrite[]) === true) {
					held = true;
					process.stdout.write("KILL-POINT\n");
				}
				return seq;
			};
		},
	});
}

/** Whether `writes` pin the memo `name` on a task. */
function pins(name: string): (writes: readonly StorageWrite[]) => boolean {
	return (writes) =>
		writes.some((write) => write.type === "task" && write.value.memos !== undefined && name in write.value.memos);
}

const reminder: Message = { role: "user", content: "reminder", timestamp: 1 };
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const registry = createRegistry();
const work = defineTool({
	name: "work",
	description: "work tool",
	parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text", text: "worked" }] }),
});
registry.install(defineExtension({ name: "tools", tools: [work] }));
if (mode === "yield") {
	const onYield = () => ({ continue: true, entries: [{ kind: "nek.reminder", model: [reminder] }] }) as const;
	registry.install(defineExtension({ name: "yield", hooks: [hook(GenerationTask, { onYield })] }));
	killPoint = pins("pi.hook.onYield");
	faux.setResponses([fauxAssistantMessage([fauxText("first")])]);
} else if (mode === "tools") {
	const afterTools = () => ({ entries: [{ kind: "nek.notice", model: [reminder] }] });
	registry.install(defineExtension({ name: "tools-hook", hooks: [hook(GenerationTask, { afterTools })] }));
	killPoint = pins("pi.hook.afterTools");
	faux.setResponses([fauxAssistantMessage([fauxToolCall("work", {}, { id: "c1" })], { stopReason: "toolUse" })]);
} else if (mode === "trigger-busy") {
	// The first response never ends, so the conversation stays busy.
	faux.setResponses([() => new Promise(() => {})]);
} else if (mode === "trigger-idle") {
	killPoint = (writes) => writes.some((write) => write.type === "submission" && write.value.type === "write");
	faux.setResponses([() => new Promise(() => {})]);
} else {
	throw new Error(`Unknown mode ${mode}`);
}

const harness = await Harness.open(holding(await openNodeSqliteStorage(path)), { models, registry }, context);
const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
const write = { type: "write", trigger: true, entry: { kind: "nek.message", model: [reminder] } } as const;
if (mode === "trigger-busy") {
	await root.submit({ type: "input", content: "go" }, context);
	await root.submit(write, context);
	process.stdout.write("KILL-POINT\n");
	held = true;
} else if (mode === "trigger-idle") {
	await root.submit(write, context);
} else {
	await root.submit({ type: "input", content: "go" }, context);
}
setInterval(() => {}, 1000);
