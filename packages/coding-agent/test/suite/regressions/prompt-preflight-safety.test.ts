import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SKILL_MENTION_MESSAGE_TYPE } from "../../../src/core/agent-session.ts";
import { DurableEngine } from "../../../src/core/durable/engine.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createSyntheticSourceInfo } from "../../../src/core/source-info.ts";
import { assistantMsg, userMsg } from "../../utilities.ts";
import { createHarness, getMessageText, getUserTexts, type Harness } from "../harness.ts";

function deferred() {
	return Promise.withResolvers<void>();
}

function seedHistory(harness: Harness): string {
	harness.sessionManager.appendMessage(userMsg("first prompt"));
	const target = harness.sessionManager.appendMessage(assistantMsg("first response"));
	harness.sessionManager.appendMessage(userMsg("second prompt"));
	harness.sessionManager.appendMessage(assistantMsg("second response"));
	harness.session.refreshContext();
	return target;
}

/** Pause only admission auth, not the later provider request's auth. */
function pauseAuth(harness: Harness, started: ReturnType<typeof deferred>, released: ReturnType<typeof deferred>) {
	const getAuth = harness.session.modelRuntime.getAuth.bind(harness.session.modelRuntime);
	return vi.spyOn(harness.session.modelRuntime, "getAuth").mockImplementationOnce(async (model, options) => {
		started.resolve();
		await released.promise;
		return getAuth(model, options);
	});
}

const harnesses: Harness[] = [];
const directories: string[] = [];
afterEach(async () => {
	for (const harness of harnesses.splice(0)) {
		await harness.session.dispose();
		harness.cleanup();
	}
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe("prompt preflight context reservation", () => {
	it.each(["input", "auth", "before_agent_start"] as const)(
		"blocks tree navigation, compaction and reload during %s, but releases before settlement callbacks",
		async (phase) => {
			const started = deferred();
			const released = deferred();
			const errors: string[] = [];
			let target = "";
			const harness = await createHarness({
				extensionFactories: [
					(pi) => {
						const pause = async () => {
							started.resolve();
							await released.promise;
						};
						if (phase === "input") pi.on("input", pause);
						if (phase === "before_agent_start") pi.on("before_agent_start", pause);
						pi.on("agent_settled", async () => {
							expect(harness.session.isIdle).toBe(true);
							await harness.session.navigateTree(target);
						});
					},
				],
			});
			harnesses.push(harness);
			harness.session.extensionRunner.onError((error) => errors.push(error.error));
			target = seedHistory(harness);
			if (phase === "auth") pauseAuth(harness, started, released);
			harness.setResponses([fauxAssistantMessage("done")]);
			const prompt = harness.session.prompt("reserved prompt");
			await started.promise;
			try {
				expect(harness.session.isIdle).toBe(false);
				expect(harness.session.isStreaming).toBe(phase === "before_agent_start");
				await expect(harness.session.navigateTree(target)).rejects.toThrow("current response to finish");
				if (phase !== "before_agent_start") {
					await expect(harness.session.compact()).rejects.toThrow("input processing to finish");
				}
				await expect(harness.session.reload()).rejects.toThrow("current response to finish before reloading");
			} finally {
				released.resolve();
			}
			await prompt;
			expect(errors).toEqual([]);
			expect(harness.sessionManager.getLeafId()).toBe(target);
			expect(harness.session.isIdle).toBe(true);
		},
	);

	it("reserves an unknown slash input before the first microtask", async () => {
		const started = deferred();
		const released = deferred();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", async () => {
						started.resolve();
						await released.promise;
						return { action: "handled" };
					});
				},
			],
		});
		harnesses.push(harness);
		const target = seedHistory(harness);
		const prompt = harness.session.prompt("/not-an-extension-command");
		try {
			await expect(harness.session.navigateTree(target)).rejects.toThrow("current response to finish");
			await started.promise;
		} finally {
			released.resolve();
		}
		await prompt;
		await expect(harness.session.navigateTree(target)).resolves.toMatchObject({ cancelled: false });
	});

	it("keeps the reservation when another prompt is handled first", async () => {
		const started = deferred();
		const released = deferred();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", async (event) => {
						if (event.text === "waiting") {
							started.resolve();
							await released.promise;
						}
						return { action: "handled" };
					});
				},
			],
		});
		harnesses.push(harness);
		const target = seedHistory(harness);
		const waiting = harness.session.prompt("waiting");
		await started.promise;
		try {
			await harness.session.prompt("handled immediately");
			await expect(harness.session.navigateTree(target)).rejects.toThrow("current response to finish");
			await expect(harness.session.reload()).rejects.toThrow("current response to finish");
		} finally {
			released.resolve();
		}
		await waiting;
		await expect(harness.session.navigateTree(target)).resolves.toMatchObject({ cancelled: false });
	});
});

describe("queued input during prompt admission", () => {
	it.each(["input", "auth", "before_agent_start", "durable admission"] as const)(
		"holds steering and follow-up through %s, delivering once with hidden skills and queue events",
		async (phase) => {
			const started = deferred();
			const released = deferred();
			const toolStarted = deferred();
			const toolReleased = deferred();
			const queued: Array<{ behavior: string; source: string }> = [];
			const harness = await createHarness({
				tools: [
					{
						name: "wait",
						label: "Wait",
						description: "Wait for test input",
						parameters: Type.Object({}),
						execute: async () => {
							toolStarted.resolve();
							await toolReleased.promise;
							return { content: [{ type: "text", text: "ok" }], details: {} };
						},
					},
				],
				extensionFactories: [
					(pi) => {
						const pause = async () => {
							started.resolve();
							await released.promise;
						};
						if (phase === "input")
							pi.on("input", async (event) => {
								if (event.text === "start") await pause();
							});
						if (phase === "before_agent_start") pi.on("before_agent_start", pause);
						pi.on("input_queued", (event) => {
							queued.push({ behavior: event.behavior, source: event.source });
						});
					},
				],
			});
			harnesses.push(harness);
			const skillPath = join(harness.tempDir, "SKILL.md");
			writeFileSync(skillPath, "Use the reserved skill.");
			vi.spyOn(harness.session.resourceLoader, "getSkills").mockReturnValue({
				skills: [
					{
						name: "reserved",
						description: "Reserved skill",
						filePath: skillPath,
						baseDir: harness.tempDir,
						disableModelInvocation: false,
						sourceInfo: createSyntheticSourceInfo(skillPath, {
							source: "local",
							scope: "project",
							origin: "top-level",
							baseDir: harness.tempDir,
						}),
					},
				],
				diagnostics: [],
			});
			if (phase === "auth") pauseAuth(harness, started, released);
			if (phase === "durable admission") {
				const admit = DurableEngine.prototype.prompt;
				vi.spyOn(DurableEngine.prototype, "prompt").mockImplementationOnce(async function (
					this: DurableEngine,
					content,
					options,
				) {
					started.resolve();
					await released.promise;
					return admit.call(this, content, options);
				});
			}
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage("steered"),
				fauxAssistantMessage("followed up"),
			]);
			const prompt = harness.session.prompt("start");
			await started.promise;
			try {
				await expect(harness.session.steer("use @skill:reserved", undefined, { source: "rpc" })).resolves.toBe(
					"queued",
				);
				await expect(harness.session.followUp("then finish", undefined, { source: "rpc" })).resolves.toBe("queued");
				expect(harness.faux.state.callCount).toBe(0);
				expect(harness.session.getSteeringMessages()).toEqual(["use @skill:reserved"]);
				expect(harness.session.getFollowUpMessages()).toEqual(["then finish"]);
				expect(queued).toEqual([
					{ behavior: "steer", source: "rpc" },
					{ behavior: "followUp", source: "rpc" },
				]);
				released.resolve();
				await toolStarted.promise;
			} finally {
				released.resolve();
				toolReleased.resolve();
			}
			await prompt;
			await harness.session.waitForIdle();
			expect(getUserTexts(harness)).toEqual(["start", "use @skill:reserved", "then finish"]);
			const userIndex = harness.session.messages.findIndex(
				(message) => getMessageText(message) === "use @skill:reserved",
			);
			expect(harness.session.messages[userIndex + 1]).toMatchObject({
				role: "custom",
				customType: SKILL_MENTION_MESSAGE_TYPE,
				display: false,
				content: expect.stringContaining("Use the reserved skill."),
			});
			expect(harness.faux.state.callCount).toBe(3);
			expect(harness.session.pendingMessageCount).toBe(0);
			expect(
				harness.sessionManager
					.getEntries()
					.filter((entry) => entry.type === "message" && entry.message.role === "user"),
			).toHaveLength(3);
		},
	);

	it.each(["handled", "auth failure", "cancel input", "cancel auth", "start callback failure"] as const)(
		"retains accepted queues after %s without auto-starting, then hands them to the next explicit prompt",
		async (outcome) => {
			const started = deferred();
			const released = deferred();
			const harness = await createHarness({
				extensionFactories: [
					(pi) => {
						pi.on("input", async (event) => {
							if (event.text !== "discarded" || outcome === "auth failure" || outcome === "cancel auth") return;
							started.resolve();
							await released.promise;
							if (outcome === "handled") return { action: "handled" };
						});
					},
				],
			});
			harnesses.push(harness);
			const target = seedHistory(harness);
			if (outcome === "auth failure") {
				vi.spyOn(harness.session.modelRuntime, "getAuth").mockImplementationOnce(async () => {
					started.resolve();
					await released.promise;
					return undefined;
				});
			}
			if (outcome === "cancel auth") pauseAuth(harness, started, released);
			const run = harness.session
				.prompt("discarded", {
					preflightResult:
						outcome === "start callback failure"
							? () => {
									throw new Error("start rejected");
								}
							: undefined,
				})
				.then(
					() => undefined,
					(error: unknown) => error,
				);
			await started.promise;
			await harness.session.steer("held steer");
			await harness.session.followUp("held follow-up");
			const aborted = outcome.startsWith("cancel") ? harness.session.abort() : undefined;
			released.resolve();
			const error = await run;
			await aborted;
			if (outcome === "handled") expect(error).toBeUndefined();
			else if (outcome === "auth failure")
				expect(error).toMatchObject({ message: expect.stringContaining("No API key") });
			else if (outcome === "start callback failure") expect(error).toMatchObject({ message: "start rejected" });
			else expect(error).toMatchObject({ name: "AbortError" });
			await harness.session.waitForIdle();
			expect(harness.session.isIdle).toBe(true);
			expect(harness.faux.state.callCount).toBe(0);
			expect(harness.eventsOfType("agent_start")).toEqual([]);
			expect(harness.session.getSteeringMessages()).toEqual(["held steer"]);
			expect(harness.session.getFollowUpMessages()).toEqual(["held follow-up"]);
			await harness.session.navigateTree(target);
			harness.setResponses([fauxAssistantMessage("fresh and steered"), fauxAssistantMessage("followed up")]);
			await harness.session.prompt("explicit next input");
			expect(getUserTexts(harness)).toEqual(["first prompt", "explicit next input", "held steer", "held follow-up"]);
			expect(harness.session.pendingMessageCount).toBe(0);
			expect(harness.faux.state.callCount).toBe(2);
		},
	);

	it.each(["handled", "start callback failure"] as const)(
		"protects cleanup writes after %s without leaking the reservation",
		async (outcome) => {
			const started = deferred();
			const released = deferred();
			const harness = await createHarness({
				extensionFactories: [
					(pi) => {
						pi.on("input", async () => {
							started.resolve();
							await released.promise;
							if (outcome === "handled") return { action: "handled" };
						});
					},
				],
			});
			harnesses.push(harness);
			const target = seedHistory(harness);
			const attempts: Promise<unknown>[] = [];
			harness.session.subscribe((event) => {
				if (event.type !== "message_end" || event.message.role !== "custom") return;
				attempts.push(harness.session.navigateTree(target).catch((error: unknown) => error));
				attempts.push(harness.session.reload().catch((error: unknown) => error));
			});
			const run = harness.session
				.prompt("not submitted", {
					preflightResult:
						outcome === "start callback failure"
							? () => {
									throw new Error("start rejected");
								}
							: undefined,
				})
				.catch((error: unknown) => error);
			await started.promise;
			await harness.session.sendCustomMessage(
				{ customType: "held", content: "cleanup context", display: false },
				{ triggerTurn: true },
			);
			released.resolve();
			await run;
			expect(attempts).toHaveLength(2);
			for (const attempt of attempts)
				expect(await attempt).toMatchObject({ message: expect.stringContaining("current response to finish") });
			expect(harness.session.messages.filter((message) => message.role === "custom")).toHaveLength(1);
			expect(harness.faux.state.callCount).toBe(0);
			await expect(harness.session.navigateTree(target)).resolves.toMatchObject({ cancelled: false });
			expect(harness.session.isIdle).toBe(true);
		},
	);

	it("does not resurrect a queue cleared while input_queued is awaited", async () => {
		const started = deferred();
		const released = deferred();
		const queued = deferred();
		const queueReleased = deferred();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", async (event) => {
						if (event.text === "start") {
							started.resolve();
							await released.promise;
						}
					});
					pi.on("input_queued", async () => {
						queued.resolve();
						await queueReleased.promise;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);
		const run = harness.session.prompt("start");
		await started.promise;
		const steering = harness.session.steer("withdrawn");
		await queued.promise;
		expect(harness.session.clearQueue()).toEqual({ steering: ["withdrawn"], followUp: [] });
		queueReleased.resolve();
		await steering;
		released.resolve();
		await run;
		expect(getUserTexts(harness)).toEqual(["start"]);
		expect(harness.session.pendingMessageCount).toBe(0);
	});

	it("retains a slow steering transform when its reserved prompt is handled first", async () => {
		const rootStarted = deferred();
		const rootReleased = deferred();
		const queueStarted = deferred();
		const queueReleased = deferred();
		const inputs: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", async (event) => {
						inputs.push(event.text);
						if (event.text === "handled") {
							rootStarted.resolve();
							await rootReleased.promise;
							return { action: "handled" };
						}
						if (event.text === "slow") {
							queueStarted.resolve();
							await queueReleased.promise;
							return { action: "transform", text: "processed slow" };
						}
					});
				},
			],
		});
		harnesses.push(harness);
		const target = seedHistory(harness);
		const root = harness.session.prompt("handled");
		await rootStarted.promise;
		const queue = harness.session.steer("slow");
		await queueStarted.promise;
		rootReleased.resolve();
		await root;
		try {
			await expect(harness.session.navigateTree(target)).rejects.toThrow("current response to finish");
		} finally {
			queueReleased.resolve();
		}
		await queue;
		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.session.clearQueue()).toEqual({ steering: ["processed slow"], followUp: [] });
		await harness.session.navigateTree(target);
		expect(inputs).toEqual(["handled", "slow"]);
		expect(harness.session.isIdle).toBe(true);
	});

	it("keeps a completed target alive until its slow preflight steering hook can join the continuation", async () => {
		const rootStarted = deferred();
		const rootReleased = deferred();
		const queueStarted = deferred();
		const queueReleased = deferred();
		const ended = deferred();
		const inputs: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", async (event) => {
						inputs.push(event.text);
						if (event.text === "start") {
							rootStarted.resolve();
							await rootReleased.promise;
						}
						if (event.text === "slow") {
							queueStarted.resolve();
							await queueReleased.promise;
							return { action: "transform", text: "processed slow" };
						}
					});
				},
			],
		});
		harnesses.push(harness);
		harness.session.subscribe((event) => {
			if (event.type === "agent_end") ended.resolve();
		});
		harness.setResponses([fauxAssistantMessage("first done"), fauxAssistantMessage("steering done")]);
		const root = harness.session.prompt("start");
		await rootStarted.promise;
		const queue = harness.session.steer("slow");
		await queueStarted.promise;
		try {
			rootReleased.resolve();
			await ended.promise;
			expect(harness.eventsOfType("agent_settled")).toEqual([]);
			expect(harness.session.isStreaming).toBe(true);
		} finally {
			rootReleased.resolve();
			queueReleased.resolve();
		}
		await queue;
		await root;
		expect(inputs).toEqual(["start", "slow"]);
		expect(getUserTexts(harness)).toEqual(["start", "processed slow"]);
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.pendingMessageCount).toBe(0);
		expect(harness.session.isIdle).toBe(true);
	});

	it.each(["prompt", "sendUserMessage"] as const)(
		"holds %s follow-up during input preflight without processing it twice",
		async (method) => {
			const started = deferred();
			const released = deferred();
			const inputs: string[] = [];
			const queued: string[] = [];
			const disposition = vi.fn();
			const harness = await createHarness({
				extensionFactories: [
					(pi) => {
						pi.on("input", async (event) => {
							inputs.push(event.text);
							if (event.text === "start") {
								started.resolve();
								await released.promise;
							}
							return { action: "transform", text: `processed ${event.text}` };
						});
						pi.on("input_queued", (event) => {
							queued.push(`${event.behavior}:${event.source}`);
						});
					},
				],
			});
			harnesses.push(harness);
			harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("follow-up")]);
			const run = harness.session.prompt("start");
			await started.promise;
			try {
				if (method === "prompt")
					await harness.session.prompt("injected", {
						streamingBehavior: "followUp",
						source: "rpc",
						preflightResult: disposition,
					});
				else await harness.session.sendUserMessage("injected", { deliverAs: "followUp" });
				expect(harness.faux.state.callCount).toBe(0);
				expect(harness.session.getFollowUpMessages()).toEqual(["processed injected"]);
			} finally {
				released.resolve();
			}
			await run;
			expect(getUserTexts(harness)).toEqual(["processed start", "processed injected"]);
			expect(inputs).toEqual(["start", "injected"]);
			expect(queued).toEqual([`followUp:${method === "prompt" ? "rpc" : "extension"}`]);
			if (method === "prompt") expect(disposition).toHaveBeenCalledExactlyOnceWith("queued");
		},
	);

	it.each(["steer", "followUp"] as const)("aligns idle %s admission with the selected branch", async (behavior) => {
		const harness = await createHarness();
		harnesses.push(harness);
		const target = seedHistory(harness);
		await harness.session.navigateTree(target);
		harness.setResponses([
			(context) => {
				expect(context.messages.map(getMessageText)).not.toContain("second prompt");
				return fauxAssistantMessage("on selected branch");
			},
		]);
		await expect(harness.session[behavior]("idle queued input")).resolves.toBe("queued");
		await harness.session.waitForIdle();
		expect(getUserTexts(harness)).toEqual(["first prompt", "idle queued input"]);
		expect(harness.session.isIdle).toBe(true);
	});

	it("does not keep or clear another run's starting marker when settlement wins the admission-return race", async () => {
		const settled = deferred();
		const admissionReturned = deferred();
		const secondStarted = deferred();
		const secondReleased = deferred();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async (event) => {
						if (event.messageType === "user" && event.prompt === "second") {
							secondStarted.resolve();
							await secondReleased.promise;
						}
					});
				},
			],
		});
		harnesses.push(harness);
		harness.session.subscribe((event) => {
			if (event.type === "agent_settled") settled.resolve();
		});
		const admit = DurableEngine.prototype.prompt;
		vi.spyOn(DurableEngine.prototype, "prompt").mockImplementationOnce(async function (
			this: DurableEngine,
			content,
			options,
		) {
			const submission = await admit.call(this, content, options);
			await submission.wait(BACKGROUND_CONTEXT);
			await settled.promise;
			await admissionReturned.promise;
			return submission;
		});
		harness.setResponses([fauxAssistantMessage("first done"), fauxAssistantMessage("second done")]);
		const first = harness.session.prompt("first");
		await settled.promise;
		expect(harness.session.isIdle).toBe(true);
		const second = harness.session.prompt("second");
		await secondStarted.promise;
		try {
			admissionReturned.resolve();
			await first;
			await harness.session.steer("joins second");
			expect(harness.faux.state.callCount).toBe(1);
			expect(harness.session.isStreaming).toBe(true);
		} finally {
			admissionReturned.resolve();
			secondReleased.resolve();
		}
		await second;
		expect(getUserTexts(harness)).toEqual(["first", "second", "joins second"]);
		expect(harness.session.pendingMessageCount).toBe(0);
		expect(harness.session.isIdle).toBe(true);
	});

	it("does not auto-run accepted preflight queues after CLI disposal and reopen", async () => {
		const directory = mkdtempSync(join(tmpdir(), "nek-preflight-cli-"));
		directories.push(directory);
		const started = deferred();
		const released = deferred();
		const first = await createHarness({
			resumeInterruptedWork: false,
			sessionManager: SessionManager.create(directory, directory),
			extensionFactories: [
				(pi) => {
					pi.on("input", async (event) => {
						if (event.text === "cancelled by shutdown") {
							started.resolve();
							await released.promise;
						}
					});
				},
			],
		});
		harnesses.push(first);
		await first.sessionManager.flush();
		const path = first.sessionManager.getSessionFile()!;
		const prompt = first.session.prompt("cancelled by shutdown").catch((error: unknown) => error);
		await started.promise;
		await first.session.steer("must not resume");
		await first.session.followUp("must not resume either");
		await first.session.dispose();
		released.resolve();
		expect(await prompt).toMatchObject({ name: "AbortError" });
		expect(first.faux.state.callCount).toBe(0);
		const reopened = await createHarness({
			resumeInterruptedWork: false,
			sessionManager: SessionManager.open(path, directory),
			responses: [fauxAssistantMessage("only on new input")],
		});
		harnesses.push(reopened);
		await reopened.session.bindExtensions({ mode: "tui" });
		await reopened.session.waitForIdle();
		expect(reopened.faux.state.callCount).toBe(0);
		expect(getUserTexts(reopened)).toEqual([]);
		await reopened.session.prompt("explicit after reopen");
		expect(getUserTexts(reopened)).toEqual(["explicit after reopen"]);
		expect(reopened.faux.state.callCount).toBe(1);
	});
});
