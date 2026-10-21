import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";

/** What `rebindCurrentSession` and `showResumedRunStatus` read from the mode. */
type RebindContext = {
	session: { isStreaming: boolean };
	workingVisible: boolean;
	activeStatusIndicator: { kind: string } | undefined;
	settingsManager: { getShowTerminalProgress: () => boolean };
	ui: { requestRender: () => void; terminal: { setProgress: (active: boolean) => void } };
	showWorkingStatusIndicator: () => void;
	unsubscribe?: () => void;
	applyRuntimeSettings: () => void;
	renderCurrentSessionState: () => void;
	bindCurrentSessionExtensions: () => Promise<void>;
	subscribeToAgent: () => void;
	showResumedRunStatus: () => void;
	updateAvailableProviderCount: () => Promise<void>;
	updateEditorBorderColor: () => void;
	updateTerminalTitle: () => void;
};

type InteractiveModePrototype = {
	rebindCurrentSession(this: RebindContext, options?: { renderBeforeBind?: boolean }): Promise<void>;
	showResumedRunStatus(this: RebindContext): void;
};

const prototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

/** A mode whose session binding resumes a run (`resumes`), as reopening a session stopped mid-run does. */
function createContext(resumes: boolean, workingVisible = true): RebindContext {
	const context: RebindContext = {
		session: { isStreaming: false },
		workingVisible,
		activeStatusIndicator: undefined,
		settingsManager: { getShowTerminalProgress: () => true },
		ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		showWorkingStatusIndicator: vi.fn(() => {
			context.activeStatusIndicator = { kind: "working" };
		}),
		applyRuntimeSettings: () => {},
		renderCurrentSessionState: () => {},
		bindCurrentSessionExtensions: async () => {
			context.session.isStreaming = resumes;
		},
		subscribeToAgent: () => {},
		showResumedRunStatus: () => prototype.showResumedRunStatus.call(context),
		updateAvailableProviderCount: async () => {},
		updateEditorBorderColor: () => {},
		updateTerminalTitle: () => {},
	};
	return context;
}

describe("resumed run status after session binding", () => {
	it.each([{ renderBeforeBind: false }, { renderBeforeBind: true }])(
		"shows Working for a run resumed while binding (%o)",
		async (options) => {
			const context = createContext(true);

			await prototype.rebindCurrentSession.call(context, options);

			expect(context.showWorkingStatusIndicator).toHaveBeenCalledTimes(1);
			expect(context.ui.terminal.setProgress).toHaveBeenCalledWith(true);
		},
	);

	it("shows nothing when no run was resumed", async () => {
		const context = createContext(false);

		await prototype.rebindCurrentSession.call(context);

		expect(context.showWorkingStatusIndicator).not.toHaveBeenCalled();
		expect(context.ui.terminal.setProgress).not.toHaveBeenCalled();
	});

	it("keeps a hidden working indicator hidden", async () => {
		const context = createContext(true, false);

		await prototype.rebindCurrentSession.call(context);

		expect(context.showWorkingStatusIndicator).not.toHaveBeenCalled();
		expect(context.ui.terminal.setProgress).toHaveBeenCalledWith(true);
	});
});
