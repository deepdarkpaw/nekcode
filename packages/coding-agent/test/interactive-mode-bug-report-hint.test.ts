import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, test, vi } from "vitest";
import { APP_NAME } from "../src/config.ts";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { formatCrashExtensionHint, InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

describe("InteractiveMode error completion after bug reporting removal", () => {
	test("identifies extensions with frames in a crash stack", () => {
		expect(formatCrashExtensionHint(["./crash.ts"])).toBe(
			`A stack frame came from loaded extension \`./crash.ts\`, which may be involved. Run \`${APP_NAME}\` without the matching \`-e\` option to confirm.`,
		);
		expect(formatCrashExtensionHint(undefined)).toBeUndefined();
	});

	test.each([
		{
			stopReason: "error" as const,
			failure: "Unexpected internal state",
			retryAttempt: 0,
			expected: "Unexpected internal state",
		},
		{
			stopReason: "error" as const,
			failure: "503 Service Unavailable",
			retryAttempt: 0,
			expected: "503 Service Unavailable",
		},
		{ stopReason: "aborted" as const, failure: undefined, retryAttempt: 0, expected: "Operation aborted" },
		{
			stopReason: "aborted" as const,
			failure: undefined,
			retryAttempt: 2,
			expected: "Aborted after 2 retry attempts",
		},
	])(
		"finishes $stopReason messages without calling the removed hint method",
		async ({ stopReason, failure, retryAttempt, expected }) => {
			const updateContent = vi.fn();
			const updateResult = vi.fn();
			const context = {
				isInitialized: true,
				footer: { invalidate: vi.fn() },
				ui: { requestRender: vi.fn() },
				session: { retryAttempt },
				streamingComponent: { updateContent } as { updateContent: typeof updateContent } | undefined,
				streamingMessage: undefined as AssistantMessage | undefined,
				pendingTools: new Map([["pending-call", { updateResult }]]),
			};
			const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
				this: typeof context,
				event: AgentSessionEvent,
			) => Promise<void>;
			const message = fauxAssistantMessage("", { stopReason, errorMessage: failure });

			await expect(handleEvent.call(context, { type: "message_end", message })).resolves.toBeUndefined();

			expect(updateContent).toHaveBeenCalledWith(message, false);
			expect(updateResult).toHaveBeenCalledWith({ content: [{ type: "text", text: expected }], isError: true });
			expect(context.pendingTools.size).toBe(0);
			expect(context.streamingComponent).toBeUndefined();
			expect(context.streamingMessage).toBeUndefined();
			expect(context.footer.invalidate).toHaveBeenCalledTimes(2);
			expect(context.ui.requestRender).toHaveBeenCalledOnce();
		},
	);

	test("does not dispatch the removed /bug command through a dangling reportBug handler", async () => {
		const editor = {
			setText: vi.fn(),
			addToHistory: vi.fn(),
			onSubmit: undefined as ((text: string) => Promise<void>) | undefined,
		};
		const context = {
			defaultEditor: editor,
			editor,
			session: { isCompacting: false, isStreaming: false },
			flushPendingBashComponents: vi.fn(),
			pendingUserInputs: [] as string[],
		};
		const setupSubmit = Reflect.get(InteractiveMode.prototype, "setupEditorSubmitHandler") as (
			this: typeof context,
		) => void;
		setupSubmit.call(context);

		await expect(editor.onSubmit?.("/bug details")).resolves.toBeUndefined();

		expect(context.pendingUserInputs).toEqual(["/bug details"]);
		expect(editor.addToHistory).toHaveBeenCalledWith("/bug details");
		expect(Reflect.get(InteractiveMode.prototype, "handleBugCommand")).toBeUndefined();
	});
});
