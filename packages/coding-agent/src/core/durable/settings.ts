import type {
	CompactionPolicy,
	ConversationRetryPolicy,
	ConversationStreamOptions,
	HarnessSettings,
	ProgressPolicy,
	QueueMode,
} from "@earendil-works/pi-durable";
import type { SettingsManager } from "../settings-manager.ts";

/**
 * Minimum pause between commits of a streaming answer. Durable's default is 100 ms; 50 ms keeps the TUI at about 20
 * updates per second. Each commit is one SQLite transaction in WAL mode with `synchronous = NORMAL`, which appends a
 * small Chord delta and does not fsync, so 20 commits per second per streaming conversation is cheap.
 */
export const DURABLE_PARTIAL_INTERVAL_MS = 50;

/** Minimum pause between commits of running tool progress; durable also paces large commits by size. */
export const DURABLE_TOOL_PROGRESS_INTERVAL_MS = 100;

/** Largest timeout `setTimeout` accepts; pi uses it for "no idle timeout". */
const MAX_TIMEOUT_MS = 2147483647;

/** The model whose compaction overrides apply; durable settings are global, so the host names the current one. */
export type CurrentModel = () => { readonly provider: string; readonly id: string } | undefined;

/**
 * `HarnessSettings` read live from pi's `SettingsManager`. Durable resolves settings at every use and pins the
 * request-relevant parts into checkpoints, so every getter returns strict JSON (no `undefined` fields).
 */
export function createHarnessSettings(
	settings: SettingsManager,
	currentModel: CurrentModel,
	options: { readonly autoCompaction?: boolean } = {},
): HarnessSettings {
	const autoCompaction = options.autoCompaction ?? true;
	return {
		get stream(): ConversationStreamOptions {
			const provider = settings.getProviderRetrySettings();
			const idle = settings.getHttpIdleTimeoutMs();
			const timeoutMs = provider.timeoutMs ?? (idle === 0 ? MAX_TIMEOUT_MS : idle);
			return {
				transport: settings.getTransport(),
				timeoutMs,
				...(provider.maxRetries === undefined ? {} : { maxRetries: provider.maxRetries }),
				maxRetryDelayMs: provider.maxRetryDelayMs,
			};
		},
		get retry(): ConversationRetryPolicy {
			return settings.getRetrySettings();
		},
		get compaction(): CompactionPolicy {
			const model = currentModel();
			// Pi compacts only at the blocking threshold, so durable's background compaction stays off. A host that runs
			// pi's own automatic compaction turns durable's off entirely; manual compaction ignores `enabled`.
			const compaction = { ...settings.getCompactionSettings(model), backgroundTokens: 0 };
			return autoCompaction ? compaction : { ...compaction, enabled: false };
		},
		get progress(): ProgressPolicy {
			return {
				partialIntervalMs: DURABLE_PARTIAL_INTERVAL_MS,
				outputIntervalMs: DURABLE_TOOL_PROGRESS_INTERVAL_MS,
			};
		},
		get steeringMode(): QueueMode {
			return settings.getSteeringMode();
		},
		get followUpMode(): QueueMode {
			return settings.getFollowUpMode();
		},
		toolExecution: "parallel",
		// Pi's texts for calls the model made to tools it was not offered, and for calls an abort left unstarted.
		toolErrorText: (code, toolName) =>
			code === "aborted"
				? "Operation aborted"
				: code === "truncated"
					? `Tool call "${toolName}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`
					: `Tool ${toolName} not found`,
	};
}
