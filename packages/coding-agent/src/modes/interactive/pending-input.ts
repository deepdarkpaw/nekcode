export type QueuedInputMode = "steer" | "followUp";
export type CompactionQueuedMessage = { text: string; mode: QueuedInputMode };
export type PendingMessages = { steering: readonly string[]; followUp: readonly string[] };
export interface InputEditor {
	getText(): string;
	setText(text: string): void;
	addToHistory?(text: string): void;
}

/** Display/dequeue order remains steering first, followed by follow-ups; duplicates are intentional. */
export function collectPendingMessages(
	session: PendingMessages,
	compaction: readonly CompactionQueuedMessage[],
): { steering: string[]; followUp: string[] } {
	return {
		steering: [
			...session.steering,
			...compaction.filter((message) => message.mode === "steer").map((message) => message.text),
		],
		followUp: [
			...session.followUp,
			...compaction.filter((message) => message.mode === "followUp").map((message) => message.text),
		],
	};
}

/** Only rewrite the editor when there was queued input; the caller owns abort, focus and redraw. */
export function restorePendingInput(queues: PendingMessages, editor: InputEditor, currentText?: string): number {
	const queued = [...queues.steering, ...queues.followUp];
	if (queued.length > 0)
		editor.setText([queued.join("\n\n"), currentText ?? editor.getText()].filter((text) => text.trim()).join("\n\n"));
	return queued.length;
}

export function enqueueCompactionInput(
	queue: CompactionQueuedMessage[],
	message: CompactionQueuedMessage,
	editor: InputEditor,
): void {
	queue.push(message);
	editor.addToHistory?.(message.text);
	editor.setText("");
}

export function extensionCommandName(text: string): string | undefined {
	if (!text.startsWith("/")) return undefined;
	const space = text.indexOf(" ");
	return space === -1 ? text.slice(1) : text.slice(1, space);
}

interface PendingInputSession {
	prompt(text: string, options?: { streamingBehavior: QueuedInputMode }): Promise<unknown>;
	steer(text: string): Promise<unknown>;
	followUp(text: string): Promise<unknown>;
	clearQueue(): unknown;
}

/** A queue and narrow delivery/notification ports; no renderer or durable inbox ownership. */
export interface CompactionQueueAdapter {
	getMessages(): readonly CompactionQueuedMessage[];
	setMessages(messages: CompactionQueuedMessage[]): void;
	session: PendingInputSession;
	isCommand(text: string): boolean;
	changed(): void;
	failed(message: string): void;
}

/** Shared delivery order and failure restoration. The first prompt is deliberately not awaited before queuing the rest. */
export async function flushCompactionInput(
	target: CompactionQueueAdapter,
	options?: { willRetry?: boolean },
): Promise<void> {
	if (target.getMessages().length === 0) return;
	const messages = [...target.getMessages()];
	target.setMessages([]);
	target.changed();
	const restore = (error: unknown) => {
		target.session.clearQueue();
		target.setMessages(messages);
		target.changed();
		target.failed(
			`Failed to send queued message${messages.length > 1 ? "s" : ""}: ${error instanceof Error ? error.message : String(error)}`,
		);
	};
	const queue = async (message: CompactionQueuedMessage) => {
		if (target.isCommand(message.text)) await target.session.prompt(message.text);
		else if (message.mode === "followUp") await target.session.followUp(message.text);
		else await target.session.steer(message.text);
	};
	try {
		if (options?.willRetry) {
			for (const message of messages) await queue(message);
			target.changed();
			return;
		}
		const first = messages.findIndex((message) => !target.isCommand(message.text));
		if (first === -1) {
			for (const message of messages) await target.session.prompt(message.text);
			return;
		}
		for (const message of messages.slice(0, first)) await target.session.prompt(message.text);
		const prompt = messages[first]!;
		const pending = target.session.prompt(prompt.text, { streamingBehavior: prompt.mode }).catch(restore);
		for (const message of messages.slice(first + 1)) await queue(message);
		target.changed();
		void pending;
	} catch (error) {
		restore(error);
	}
}
