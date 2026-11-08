import { beforeEach, describe, expect, it, vi } from "vitest";
import { resizeImage } from "../src/utils/image-resize.ts";

const state = vi.hoisted(() => ({
	onTerminating: () => {},
	finishTermination: undefined as (() => void) | undefined,
	fail: false,
	resizeInProcess: vi.fn(() => null),
}));

vi.mock("../src/utils/image-resize-core.ts", () => ({ resizeImageInProcess: state.resizeInProcess }));
vi.mock("node:worker_threads", () => ({
	Worker: class {
		private listeners = new Map<string, (message: unknown) => void>();

		once(name: string, listener: (message: unknown) => void) {
			this.listeners.set(name, listener);
			return this;
		}

		postMessage() {
			queueMicrotask(() => {
				this.listeners.get("message")?.(state.fail ? { error: "resize failed" } : { result: null });
			});
		}

		terminate(): Promise<number> {
			state.onTerminating();
			return new Promise((resolve) => {
				state.finishTermination = () => resolve(0);
			});
		}
	},
}));

beforeEach(() => {
	state.fail = false;
	state.finishTermination = undefined;
	state.resizeInProcess.mockClear();
});

describe("image worker cleanup", () => {
	it.each([false, true])("waits for termination before returning or recovering (worker fails: %s)", async (fail) => {
		state.fail = fail;
		let terminating!: () => void;
		const terminationStarted = new Promise<void>((resolve) => {
			terminating = resolve;
		});
		state.onTerminating = terminating;
		let finished = false;
		const resizing = resizeImage(new Uint8Array([1, 2, 3]), "image/png").then((result) => {
			finished = true;
			return result;
		});
		try {
			await terminationStarted;
			expect(finished).toBe(false);
			expect(state.resizeInProcess).not.toHaveBeenCalled();
		} finally {
			state.finishTermination?.();
		}
		await expect(resizing).resolves.toBeNull();
		expect(state.resizeInProcess).toHaveBeenCalledTimes(fail ? 1 : 0);
	});
});
