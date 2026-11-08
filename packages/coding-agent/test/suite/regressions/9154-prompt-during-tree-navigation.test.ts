import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assistantMsg, userMsg } from "../../utilities.ts";
import { createHarness, getMessageText, getUserTexts, type Harness } from "../harness.ts";

function deferred() {
	return Promise.withResolvers<void>();
}

function seedHistory(harness: Harness): string {
	harness.sessionManager.appendMessage(userMsg("first prompt"));
	const targetId = harness.sessionManager.appendMessage(assistantMsg("first response"));
	harness.sessionManager.appendMessage(userMsg("second prompt"));
	harness.sessionManager.appendMessage(assistantMsg("second response"));
	harness.session.refreshContext();
	return targetId;
}

describe("issue #9154: prompt and tree navigation admission", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) {
			await harness.session.dispose();
			harness.cleanup();
		}
		vi.restoreAllMocks();
	});

	it.each([false, true])(
		"rejects all input and compaction during tree navigation (summarize=%s)",
		async (summarize) => {
			const started = deferred();
			const released = deferred();
			const harness = await createHarness({
				extensionFactories: [
					(pi) => {
						pi.on("session_before_tree", async () => {
							started.resolve();
							await released.promise;
							return { summary: { summary: "abandoned branch summary" } };
						});
					},
				],
			});
			harnesses.push(harness);
			const targetId = seedHistory(harness);
			const navigation = harness.session.navigateTree(targetId, { summarize });
			await started.promise;
			const preflightResult = vi.fn();
			try {
				await expect(harness.session.prompt("must wait", { preflightResult })).rejects.toThrow(
					"compaction is in progress",
				);
				await expect(harness.session.steer("must also wait")).rejects.toThrow("compaction is in progress");
				await expect(harness.session.followUp("must also wait")).rejects.toThrow("compaction is in progress");
				await expect(harness.session.compact()).rejects.toThrow("current compaction or tree navigation");
				await expect(harness.session.reload()).rejects.toThrow("compaction to finish before reloading");
				expect(preflightResult).not.toHaveBeenCalled();
				expect(harness.session.pendingMessageCount).toBe(0);
				expect(harness.eventsOfType("agent_start")).toEqual([]);
			} finally {
				released.resolve();
			}
			await navigation;
			expect(harness.session.isIdle).toBe(true);
			expect(
				harness.sessionManager
					.getEntries()
					.filter((entry) => entry.type === "message" && entry.message.role === "user"),
			).toHaveLength(2);
		},
	);

	it("cancels branch-summary auth without changing the leaf or retaining its controller", async () => {
		const started = deferred();
		const harness = await createHarness();
		harnesses.push(harness);
		const target = seedHistory(harness);
		const leaf = harness.sessionManager.getLeafId();
		vi.spyOn(harness.session.modelRuntime, "getAuth").mockImplementationOnce(async (_model, options) => {
			started.resolve();
			return new Promise<never>((_resolve, reject) => {
				options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
			});
		});
		const navigation = harness.session.navigateTree(target, { summarize: true });
		await started.promise;
		harness.session.abortBranchSummary();
		await expect(navigation).resolves.toMatchObject({ cancelled: true, aborted: true });
		expect(harness.sessionManager.getLeafId()).toBe(leaf);
		expect(harness.session.isIdle).toBe(true);
		expect(harness.faux.state.callCount).toBe(0);
	});

	it("allows a session_tree prompt on the selected sibling branch without leaking the abandoned context", async () => {
		const errors: string[] = [];
		let continueFromTree = false;
		const requests: string[][] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_tree", async () => {
						if (!continueFromTree) return;
						continueFromTree = false;
						await harness.session.sendUserMessage("continue on the selected branch");
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ onError: (error) => errors.push(error.error) });
		const forkPoint = seedHistory(harness);
		const originalLeaf = harness.sessionManager.getLeafId()!;
		await harness.session.navigateTree(forkPoint);
		harness.setResponses([fauxAssistantMessage("sibling response")]);
		await harness.session.prompt("sibling-only prompt");
		const siblingLeaf = harness.sessionManager.getLeafId()!;
		await harness.session.navigateTree(originalLeaf);
		harness.setResponses([
			(context) => {
				requests.push(context.messages.map(getMessageText));
				return fauxAssistantMessage("continued");
			},
		]);
		continueFromTree = true;
		await harness.session.navigateTree(siblingLeaf);
		expect(errors).toEqual([]);
		expect(getUserTexts(harness)).toEqual(["first prompt", "sibling-only prompt", "continue on the selected branch"]);
		expect(requests[0]).toContain("sibling response");
		expect(requests[0]).not.toContain("second prompt");
		expect(requests[0]).not.toContain("second response");
		expect(harness.session.getLastAssistantText()).toBe("continued");
	});

	it("does not clear the controller owned by a second navigation started from session_tree", async () => {
		const started = deferred();
		const released = deferred();
		let nextTargetId = "";
		let continuation: Promise<unknown> | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_tree", async (event) => {
						if (event.preparation.targetId === nextTargetId) {
							started.resolve();
							await released.promise;
						}
					});
					pi.on("session_tree", () => {
						continuation ??= harness.session.navigateTree(nextTargetId).then(
							() => undefined,
							(error: unknown) => error,
						);
					});
				},
			],
		});
		harnesses.push(harness);
		const targetId = seedHistory(harness);
		nextTargetId = harness.sessionManager.getLeafId()!;
		try {
			await harness.session.navigateTree(targetId);
			expect(continuation).toBeDefined();
			await Promise.race([started.promise, continuation]);
			expect(harness.session.isCompacting).toBe(true);
			await expect(harness.session.prompt("must wait for second navigation")).rejects.toThrow(
				"compaction is in progress",
			);
			await expect(harness.session.reload()).rejects.toThrow("compaction to finish");
			harness.session.abortBranchSummary();
		} finally {
			released.resolve();
		}
		expect(await continuation).toBeUndefined();
		// The abort belongs to the second controller even after the first navigation's finally ran.
		expect(harness.sessionManager.getLeafId()).toBe(targetId);
		expect(harness.session.isCompacting).toBe(false);
	});

	it.each(["command", "agent_settled"] as const)("allows navigation from an extension %s", async (event) => {
		let targetId = "";
		let navigated = false;
		const errors: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					const navigate = async () => {
						await harness.session.navigateTree(targetId);
						navigated = true;
					};
					if (event === "command") pi.registerCommand("rewind", { handler: navigate });
					else pi.on("agent_settled", navigate);
				},
			],
		});
		harnesses.push(harness);
		harness.session.extensionRunner.onError((error) => errors.push(error.error));
		targetId = seedHistory(harness);
		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.prompt(event === "command" ? "/rewind" : "finish then rewind");
		expect(errors).toEqual([]);
		expect(navigated).toBe(true);
		expect(harness.sessionManager.getLeafId()).toBe(targetId);
	});

	it("reserves manual compaction before its initial abort awaits, and releases before compaction_end", async () => {
		const started = deferred();
		const released = deferred();
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						started.resolve();
						await released.promise;
						return {
							compaction: {
								summary: "compacted",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		const target = seedHistory(harness);
		let continuation: Promise<void> | undefined;
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end" && !event.aborted)
				continuation = harness.session.prompt("after compaction");
		});
		harness.setResponses([fauxAssistantMessage("afterwards")]);
		const compaction = harness.session.compact();
		try {
			await expect(harness.session.prompt("during abort")).rejects.toThrow("compaction is in progress");
			await expect(harness.session.navigateTree(target)).rejects.toThrow("current compaction or tree navigation");
			await expect(harness.session.reload()).rejects.toThrow("compaction to finish");
			await started.promise;
		} finally {
			released.resolve();
		}
		await compaction;
		await continuation;
		expect(harness.session.getLastAssistantText()).toBe("afterwards");
		expect(harness.session.isIdle).toBe(true);
	});
});
