/** Event-bus contract for tool sources whose deferred tools are still loading. */
import type { EventBus } from "../../core/event-bus.ts";
import type { ToolNamespace } from "../../core/extensions/types.ts";

const COLLECT_SOURCES = "tool_search:collect_pending_sources";
export const PENDING_SOURCES_CHANGED = "tool_search:pending_sources_changed";
export const DEFAULT_SOURCE_WAIT_MS = 10_000;

export interface PendingDeferredSource {
	namespace: ToolNamespace;
	/** Settles only after tools are registered, or loading failed. */
	ready: Promise<unknown>;
}

interface PendingSourceRegistry {
	sources: Map<symbol, PendingDeferredSource>;
	dispose: () => void;
}

const registries = new WeakMap<EventBus, PendingSourceRegistry>();

/** Register before starting background loading; remove on completion, disable, or shutdown. */
export function registerPendingDeferredSource(events: EventBus, source: PendingDeferredSource): () => void {
	let registry = registries.get(events);
	if (!registry) {
		const sources = new Map<symbol, PendingDeferredSource>();
		const unsubscribe = events.on(COLLECT_SOURCES, (data) => {
			if (Array.isArray(data)) data.push(...sources.values());
		});
		const dispose = () => {
			sources.clear();
			unsubscribe();
			unsubscribeInvalidated();
			registries.delete(events);
		};
		const unsubscribeInvalidated = events.on("runtime_invalidated", () => {
			dispose();
			events.emit(PENDING_SOURCES_CHANGED, undefined);
		});
		registry = { sources, dispose };
		registries.set(events, registry);
	}
	const token = Symbol();
	registry.sources.set(token, source);
	const registered = registry;
	events.emit(PENDING_SOURCES_CHANGED, undefined);
	return () => {
		if (!registered.sources.delete(token)) return;
		if (registered.sources.size === 0) registered.dispose();
		events.emit(PENDING_SOURCES_CHANGED, undefined);
	};
}

/** Collection is synchronous, and works even when the discovery extension loads later. */
export function getPendingDeferredSources(events: EventBus): PendingDeferredSource[] {
	const sources: PendingDeferredSource[] = [];
	events.emit(COLLECT_SOURCES, sources);
	return sources;
}

/** Wait up to one overall deadline. A timeout leaves the sources discoverable for a later search. */
export async function waitForDeferredSources(events: EventBus, timeoutMs: number, signal?: AbortSignal): Promise<void> {
	signal?.throwIfAborted();
	const sources = getPendingDeferredSources(events);
	if (sources.length === 0) return;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	try {
		await Promise.race([
			Promise.allSettled(sources.map((source) => source.ready)),
			new Promise<void>((resolve, reject) => {
				timer = setTimeout(resolve, timeoutMs);
				onAbort = () => reject(signal?.reason ?? new Error("Tool discovery aborted"));
				signal?.addEventListener("abort", onAbort, { once: true });
			}),
		]);
	} finally {
		clearTimeout(timer);
		if (onAbort) signal?.removeEventListener("abort", onAbort);
	}
}
