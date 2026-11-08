import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runControlMode } from "../src/modes/rpc/control-mode.ts";

const state = vi.hoisted(() => ({ attached: false, settle: vi.fn(async () => {}) }));
vi.mock("../src/core/model-runtime.ts", () => ({
	ModelRuntime: { create: async () => ({ settleCredentialWrites: state.settle }) },
}));
vi.mock("../src/core/settings-manager.ts", () => ({
	SettingsManager: { create: () => ({ getGlobalSettings: () => ({}), getHttpIdleTimeoutMs: () => 1_000 }) },
}));
vi.mock("../src/core/http-dispatcher.ts", () => ({
	applyHttpProxySettings: vi.fn(),
	configureHttpDispatcher: vi.fn(),
}));
vi.mock("../src/core/output-guard.ts", () => ({
	flushRawStdout: async () => {},
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: async () => {},
	writeRawStdout: vi.fn(),
}));
vi.mock("../src/modes/rpc/gui/auth.ts", () => ({ cancelAuthLogins: vi.fn() }));
vi.mock("../src/modes/rpc/gui/context.ts", () => ({ createGuiContext: vi.fn() }));
vi.mock("../src/modes/rpc/gui/handlers.ts", () => ({ createGuiDeps: () => ({}), handleGuiCommand: vi.fn() }));
vi.mock("../src/modes/rpc/gui/ui-requests.ts", () => ({ createUiRequester: () => ({ cancelAll: vi.fn() }) }));
vi.mock("../src/modes/rpc/jsonl.ts", () => ({
	attachJsonlLineReader: () => {
		state.attached = true;
		return () => {};
	},
	serializeJsonLine: JSON.stringify,
}));

const signals: NodeJS.Signals[] = ["SIGTERM", "SIGHUP"];
let savedSignals: Array<[NodeJS.Signals, NodeJS.SignalsListener[]]> = [];
let savedEnds: Array<() => void> = [];
beforeEach(() => {
	state.attached = false;
	state.settle.mockReset();
	savedSignals = signals.map((signal) => [signal, process.listeners(signal)]);
	savedEnds = process.stdin.listeners("end") as Array<() => void>;
	for (const signal of signals) process.removeAllListeners(signal);
	process.stdin.removeAllListeners("end");
});
afterEach(() => {
	for (const signal of signals) process.removeAllListeners(signal);
	process.stdin.removeAllListeners("end");
	for (const [signal, listeners] of savedSignals) for (const listener of listeners) process.on(signal, listener);
	for (const listener of savedEnds) process.stdin.on("end", listener);
	vi.restoreAllMocks();
});

describe("control RPC credential writes during shutdown", () => {
	it.each(["eof-first", "signal-first", "repeated-signal"])(
		"waits for started writes before exit: %s",
		async (order) => {
			const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
			vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
			let finish!: () => void;
			const pending = new Promise<void>((resolve) => {
				finish = resolve;
			});
			state.settle.mockReturnValue(pending);
			const running = runControlMode();
			try {
				await Promise.race([running, vi.waitFor(() => expect(state.attached).toBe(true))]);
				if (order === "signal-first") process.emit("SIGTERM");
				else process.stdin.emit("end");
				await vi.waitFor(() => expect(state.settle).toHaveBeenCalledTimes(1));
				if (order === "signal-first") process.stdin.emit("end");
				else process.emit("SIGTERM");
				await Promise.resolve();
				expect(exit).not.toHaveBeenCalled();
				if (order === "repeated-signal") {
					process.emit("SIGTERM");
					expect(exit).toHaveBeenCalledWith(143);
				}
				finish();
				await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(order === "signal-first" ? 143 : 0));
				expect(state.settle).toHaveBeenCalledTimes(1);
			} finally {
				finish();
			}
		},
	);
});
