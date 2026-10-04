import { type FauxResponseStep, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession, AgentSessionEvent, AgentSessionEventListener } from "../src/core/agent-session.ts";
import { DEFAULT_NEK_CONFIG } from "../src/extensions/nek/config.ts";
import {
	ACTIVITY_MAX_CHARS,
	clampAwaitTimeout,
	type SubagentConfig,
	SubagentRegistry,
} from "../src/extensions/nek/services/subagent-registry.ts";
import type { SubagentRecord } from "../src/extensions/nek/types.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

interface Gate {
	promise: Promise<void>;
	open: () => void;
}

function createGate(): Gate {
	let open = () => {};
	const promise = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { promise, open };
}

/** Faux reply that waits for the gate (or the request's abort) before answering. */
function gatedReply(gate: Gate, text: string): FauxResponseStep {
	return async (_context, options) => {
		await new Promise<void>((resolve) => {
			void gate.promise.then(resolve);
			if (options?.signal?.aborted) resolve();
			options?.signal?.addEventListener("abort", () => resolve(), { once: true });
		});
		return fauxAssistantMessage(text);
	};
}

function config(overrides: Partial<SubagentConfig>): SubagentConfig {
	return { ...DEFAULT_NEK_CONFIG.subagent, ...overrides };
}

function fakeSession(events: AgentSessionEvent[]): AgentSession {
	let listener: AgentSessionEventListener | undefined;
	return {
		sessionId: "fake-subagent",
		sessionFile: undefined,
		model: undefined,
		messages: [],
		subscribe(next: AgentSessionEventListener) {
			listener = next;
			return () => {
				listener = undefined;
			};
		},
		prompt: async () => {
			for (const event of events) listener?.(event);
		},
		abort: async () => {},
		dispose: () => {},
		getLastAssistantText: () => undefined,
	} as unknown as AgentSession;
}

describe("SubagentRegistry", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	/** A faux-backed child session factory whose replies are queued up front. */
	async function child(responses: FauxResponseStep[]): Promise<Harness> {
		const harness = await createHarness();
		harness.setResponses(responses);
		harnesses.push(harness);
		return harness;
	}

	function startInput(harness: Harness, description: string, background = true) {
		return {
			description,
			type: "generalPurpose",
			prompt: `do ${description}`,
			background,
			createSession: async () => harness.session,
		};
	}

	it("collapses multiline tool arguments and assistant activity to bounded single lines", async () => {
		const assistantText = `${"prefix\n".repeat(20)}final assistant line\twith tabs`;
		const events = [
			{
				type: "tool_execution_start",
				toolCallId: "call-1",
				toolName: "bash",
				args: { command: "first line\n\tsecond line\rthird line" },
			} as unknown as AgentSessionEvent,
			{
				type: "message_update",
				message: fauxAssistantMessage(assistantText),
				assistantMessageEvent: {},
			} as unknown as AgentSessionEvent,
		];
		const activities: string[] = [];
		const registry = new SubagentRegistry(
			config({}),
			() => {},
			(record) => {
				if (record.activity) activities.push(record.activity);
			},
		);

		const record = await registry.start({
			description: "activity test",
			type: "generalPurpose",
			prompt: "run activity test",
			background: false,
			createSession: async () => fakeSession(events),
		});
		await registry.wait(record.id);

		// pi#nek-subagent-card-newlines
		expect(activities.length).toBeGreaterThanOrEqual(2);
		expect(activities[0]).toContain("first line second line third line");
		expect(activities[1]).toContain("final assistant line with tabs");
		for (const activity of activities) {
			expect(activity).not.toMatch(/[\n\r\t]/);
			expect(activity.length).toBeLessThanOrEqual(ACTIVITY_MAX_CHARS);
		}
	});

	it("sums input (with cache) and output tokens and stamps activity changes", async () => {
		const usageMessage = (input: number, output: number, cacheRead: number, cacheWrite: number) => {
			const message = fauxAssistantMessage("partial");
			message.usage = { ...message.usage, input, output, cacheRead, cacheWrite };
			return { type: "message_end", message } as unknown as AgentSessionEvent;
		};
		const events = [
			{ type: "tool_execution_start", toolCallId: "c", toolName: "read", args: {} } as unknown as AgentSessionEvent,
			usageMessage(100, 20, 1_000, 50),
			usageMessage(10, 5, 2_000, 0),
		];
		const snapshots: Array<Pick<SubagentRecord, "usage" | "lastActivityAt" | "activity">> = [];
		const registry = new SubagentRegistry(
			config({}),
			() => {},
			(record) =>
				snapshots.push({ usage: record.usage, lastActivityAt: record.lastActivityAt, activity: record.activity }),
		);
		const before = Date.now();
		const record = await registry.start({
			description: "usage test",
			type: "generalPurpose",
			prompt: "run usage test",
			background: false,
			createSession: async () => fakeSession(events),
		});
		await registry.wait(record.id);

		expect(registry.get(record.id)?.usage).toEqual({ input: 3_160, output: 25 });
		const first = snapshots.find((snapshot) => snapshot.activity?.startsWith("read"));
		expect(first?.lastActivityAt).toBeGreaterThanOrEqual(before);
		// Usage is replaced, not mutated, so earlier snapshots keep their totals.
		expect(snapshots.map((snapshot) => snapshot.usage?.input)).toContain(1_150);
	});

	it("clamps await timeouts to [1000, awaitMaxMs] and treats <= 0 as non-blocking", () => {
		const limits = config({ awaitDefaultMs: 30_000, awaitMaxMs: 60_000 });
		expect(clampAwaitTimeout(undefined, limits)).toBe(30_000);
		expect(clampAwaitTimeout(0, limits)).toBe(0);
		expect(clampAwaitTimeout(-5, limits)).toBe(0);
		expect(clampAwaitTimeout(10, limits)).toBe(1000);
		expect(clampAwaitTimeout(5_000, limits)).toBe(5_000);
		expect(clampAwaitTimeout(9_000_000, limits)).toBe(60_000);
	});

	it("rejects starts beyond maxConcurrent, including parallel starts", async () => {
		const gate = createGate();
		const registry = new SubagentRegistry(config({ maxConcurrent: 2 }), () => {});
		const children = await Promise.all([1, 2, 3].map(() => child([gatedReply(gate, "ok")])));

		const results = await Promise.allSettled(
			children.map((harness, index) => registry.start(startInput(harness, `t${index}`))),
		);

		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
		const rejected = results.find((result) => result.status === "rejected");
		expect(String(rejected?.status === "rejected" ? rejected.reason : "")).toContain(
			"Subagent limit reached (2 running). Wait for one to finish or cancel one with /subagents.",
		);
		gate.open();
		await registry.await(undefined, 5_000);
		expect(registry.runningCount()).toBe(0);
	});

	it("evicts the earliest finished observed record beyond maxRetained and disposes its session", async () => {
		const registry = new SubagentRegistry(config({ maxRetained: 2 }), () => {});
		const first = await child([fauxAssistantMessage("one")]);
		const disposeFirst = vi.spyOn(first.session, "dispose");
		const a = await registry.start(startInput(first, "a", false));
		await registry.wait(a.id);
		const b = await registry.start(startInput(await child([fauxAssistantMessage("two")]), "b", false));
		await registry.wait(b.id);

		const c = await registry.start(startInput(await child([fauxAssistantMessage("three")]), "c", false));
		await registry.wait(c.id);

		expect(registry.list().map((record) => record.description)).toEqual(["b", "c"]);
		expect(registry.get(a.id)).toBeUndefined();
		expect(disposeFirst).toHaveBeenCalled();
	});

	it("never evicts running or unobserved records", async () => {
		const gate = createGate();
		const registry = new SubagentRegistry(config({ maxRetained: 1 }), () => {});
		await registry.start(startInput(await child([gatedReply(gate, "a")]), "a"));
		await registry.start(startInput(await child([gatedReply(gate, "b")]), "b"));
		expect(registry.list()).toHaveLength(2);
		gate.open();
		await vi.waitFor(() => expect(registry.runningCount()).toBe(0));
		expect(registry.list()).toHaveLength(2);
	});

	it("await returns the first subagent that finishes and marks it observed", async () => {
		const slow = createGate();
		const fast = createGate();
		const registry = new SubagentRegistry(config({}), () => {});
		await registry.start(startInput(await child([gatedReply(slow, "slow result")]), "slow"));
		const fastRecord = await registry.start(startInput(await child([gatedReply(fast, "fast result")]), "fast"));

		const waiting = registry.await(undefined, 10_000);
		fast.open();
		const { done, timedOut } = await waiting;

		expect(timedOut).toBe(false);
		expect(done.map((record) => record.id)).toEqual([fastRecord.id]);
		expect(done[0]).toMatchObject({ status: "completed", finalText: "fast result", observed: true });
		slow.open();
	});

	it("await with a non-positive timeout is a non-blocking status check", async () => {
		const gate = createGate();
		const registry = new SubagentRegistry(config({}), () => {});
		await registry.start(startInput(await child([gatedReply(gate, "later")]), "pending"));
		const startedAt = Date.now();
		expect(await registry.await(undefined, 0)).toEqual({ done: [], timedOut: false });
		expect(await registry.await(undefined, -1)).toEqual({ done: [], timedOut: false });
		expect(Date.now() - startedAt).toBeLessThan(500);
		gate.open();
	});

	it("await clamps tiny timeouts up to one second and reports timed_out", async () => {
		const gate = createGate();
		const registry = new SubagentRegistry(config({}), () => {});
		await registry.start(startInput(await child([gatedReply(gate, "later")]), "pending"));
		const startedAt = Date.now();

		const result = await registry.await(undefined, 1);

		expect(result).toEqual({ done: [], timedOut: true });
		expect(Date.now() - startedAt).toBeGreaterThanOrEqual(950);
		gate.open();
	});

	it("resume of a running subagent fails without interrupt and replaces the run with interrupt", async () => {
		const gate = createGate();
		const harness = await child([gatedReply(gate, "first"), fauxAssistantMessage("second answer")]);
		const registry = new SubagentRegistry(config({}), () => {});
		const record = await registry.start(startInput(harness, "job", false));

		await expect(
			registry.resume({ id: record.id, prompt: "again", interrupt: false, background: false }),
		).rejects.toThrow(`Subagent ${record.id} is still running. Pass interrupt: true to replace its current run.`);

		await registry.resume({ id: record.id, prompt: "change course", interrupt: true, background: false });
		const done = await registry.wait(record.id);

		expect(done).toMatchObject({ status: "completed", finalText: "second answer" });
		const userTexts = harness.session.messages.filter((message) => message.role === "user");
		expect(userTexts).toHaveLength(2);
	});

	it("notifies once for an unobserved background finish, and drainUnobserved is idempotent", async () => {
		const notified: SubagentRecord[] = [];
		const registry = new SubagentRegistry(config({}), (record) => notified.push(record));
		const record = await registry.start(startInput(await child([fauxAssistantMessage("bg done")]), "bg"));
		await vi.waitFor(() => expect(notified).toHaveLength(1));

		expect(registry.drainUnobserved().map((drained) => drained.id)).toEqual([record.id]);
		expect(registry.drainUnobserved()).toEqual([]);
		expect(await registry.await(undefined, 0)).toEqual({ done: [], timedOut: false });
	});

	it("does not notify for a background subagent observed by await before it finishes", async () => {
		const gate = createGate();
		const notified: SubagentRecord[] = [];
		const registry = new SubagentRegistry(config({}), (record) => notified.push(record));
		await registry.start(startInput(await child([gatedReply(gate, "done")]), "bg"));

		const waiting = registry.await(undefined, 10_000);
		gate.open();
		expect((await waiting).done).toHaveLength(1);

		expect(notified).toEqual([]);
		expect(registry.drainUnobserved()).toEqual([]);
	});

	it("interrupts an await without stopping the background subagent", async () => {
		const gate = createGate();
		const registry = new SubagentRegistry(config({}), () => {});
		const record = await registry.start(startInput(await child([gatedReply(gate, "later")]), "pending"));

		const waiting = registry.await(undefined, 10_000);
		registry.interruptWaits();
		await expect(waiting).resolves.toMatchObject({ done: [], timedOut: false, interrupted: true });
		expect(registry.get(record.id)).toMatchObject({ status: "running", background: true });
		gate.open();
		await vi.waitFor(() => expect(registry.get(record.id)?.status).toBe("completed"));
	});

	it("detaches a foreground wait when interrupted", async () => {
		const gate = createGate();
		const registry = new SubagentRegistry(config({}), () => {});
		const record = await registry.start(startInput(await child([gatedReply(gate, "later")]), "foreground", false));

		const waiting = registry.wait(record.id);
		registry.interruptWaits();
		await expect(waiting).resolves.toMatchObject({ id: record.id, status: "running", background: true });
		gate.open();
		await vi.waitFor(() => expect(registry.get(record.id)?.status).toBe("completed"));
	});

	it("abort cancels a running subagent without a notice", async () => {
		const gate = createGate();
		const notified: SubagentRecord[] = [];
		const registry = new SubagentRegistry(config({}), (record) => notified.push(record));
		const record = await registry.start(startInput(await child([gatedReply(gate, "never")]), "cancel me"));

		await registry.abort(record.id);

		expect(registry.get(record.id)?.status).toBe("aborted");
		expect(notified).toEqual([]);
	});
});
