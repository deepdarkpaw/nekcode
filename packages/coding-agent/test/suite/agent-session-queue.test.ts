import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionError, InputEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getAssistantTexts, getMessageText, getUserTexts, type Harness } from "./harness.ts";

async function createWaitingHarness(
	options: {
		tools?: AgentTool[];
		extensionFactories?: Harness["session"]["extensionRunner"] extends never
			? never
			: Array<(pi: ExtensionAPI) => void>;
	} = {},
): Promise<{
	harness: Harness;
	releaseToolExecution: () => void;
	promptPromise: Promise<void>;
	waitForToolStart: Promise<void>;
}> {
	let releaseToolExecution: (() => void) | undefined;
	const toolRelease = new Promise<void>((resolve) => {
		releaseToolExecution = resolve;
	});
	const waitTool: AgentTool = {
		name: "wait",
		label: "Wait",
		description: "Wait for release",
		parameters: Type.Object({}),
		execute: async () => {
			await toolRelease;
			return {
				content: [{ type: "text", text: "released" }],
				details: {},
			};
		},
	};
	const harness = await createHarness({
		tools: [waitTool, ...(options.tools ?? [])],
		extensionFactories: options.extensionFactories,
	});

	const waitForToolStart = new Promise<void>((resolve) => {
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "tool_execution_start" && event.toolName === "wait") {
				unsubscribe();
				resolve();
			}
		});
	});

	return {
		harness,
		releaseToolExecution: () => releaseToolExecution?.(),
		promptPromise: harness.session.prompt("start"),
		waitForToolStart,
	};
}

describe("AgentSession queue characterization", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it.each(["prompt", "prompt-steer", "prompt-followUp", "steer", "followUp", "plan-steer", "plan-followUp"] as const)(
		"starts %s input once after an interrupted tool run settles",
		async (submission) => {
			const inputs: string[] = [];
			const errors: string[] = [];
			const waiting = await createWaitingHarness({
				extensionFactories: [
					(pi) => {
						pi.on("input", (event) => {
							inputs.push(event.text);
							return { action: "transform", text: `processed: ${event.text}` };
						});
						pi.registerCommand("plan", {
							handler: async (args) => {
								pi.sendUserMessage(args, {
									deliverAs: submission === "plan-followUp" ? "followUp" : "steer",
								});
							},
						});
					},
				],
			});
			const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
			harnesses.push(harness);
			harness.session.extensionRunner.onError((event) => errors.push(event.error));
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage("B response"),
			]);

			await waitForToolStart;
			const abort = harness.session.abort();
			const submitted =
				submission === "steer" || submission === "followUp"
					? harness.session[submission]("B")
					: harness.session.prompt(submission.startsWith("plan-") ? "/plan B" : "B", {
							streamingBehavior:
								submission === "prompt-steer"
									? "steer"
									: submission === "prompt-followUp"
										? "followUp"
										: undefined,
						});
			const accepted = submitted.then(
				() => undefined,
				(error: unknown) => (error instanceof Error ? error.message : String(error)),
			);
			try {
				expect(harness.faux.state.callCount).toBe(1);
				expect(harness.eventsOfType("agent_settled")).toEqual([]);
			} finally {
				releaseToolExecution();
			}
			await Promise.all([promptPromise, abort]);
			expect(await accepted).toBeUndefined();
			await harness.session.waitForIdle();

			expect(errors).toEqual([]);
			expect(inputs).toEqual(["start", "B"]);
			expect(getUserTexts(harness)).toEqual(["processed: start", "processed: B"]);
			expect(getAssistantTexts(harness)).toEqual(["", "B response"]);
			expect(harness.faux.state.callCount).toBe(2);
			expect(harness.session.pendingMessageCount).toBe(0);
			expect(
				harness.events
					.filter((event) => event.type === "agent_start" || event.type === "agent_settled")
					.map((event) => event.type),
			).toEqual(["agent_start", "agent_settled", "agent_start", "agent_settled"]);
		},
	);

	it.each(["prompt", "steer", "followUp"] as const)(
		"hands off %s input already being transformed when cancellation starts without processing it twice",
		async (submission) => {
			let startInput = () => {};
			const inputStarted = new Promise<void>((resolve) => {
				startInput = resolve;
			});
			let releaseInput = () => {};
			const inputRelease = new Promise<void>((resolve) => {
				releaseInput = resolve;
			});
			const inputs: string[] = [];
			const waiting = await createWaitingHarness({
				extensionFactories: [
					(pi) => {
						pi.on("input", async (event) => {
							inputs.push(event.text);
							if (event.text === "B") {
								startInput();
								await inputRelease;
							}
							return { action: "transform", text: `processed: ${event.text}` };
						});
					},
				],
			});
			const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
			harnesses.push(harness);
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage("B response"),
			]);

			await waitForToolStart;
			const submitted =
				submission === "prompt"
					? harness.session.prompt("B", { streamingBehavior: "followUp" })
					: harness.session[submission]("B");
			await inputStarted;
			const abort = harness.session.abort();
			releaseInput();
			try {
				await submitted;
			} finally {
				releaseToolExecution();
			}
			await Promise.all([promptPromise, abort]);

			expect(inputs).toEqual(["start", "B"]);
			expect(getUserTexts(harness)).toEqual(["processed: start", "processed: B"]);
			expect(getAssistantTexts(harness)).toEqual(["", "B response"]);
			expect(harness.session.pendingMessageCount).toBe(0);
		},
	);

	it("retains later user submissions when an earlier deferred submission fails", async () => {
		const errors: ExtensionError[] = [];
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);
		harness.session.extensionRunner.onError((event) => errors.push(event));
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("B response"),
			fauxAssistantMessage("C response"),
		]);

		await waitForToolStart;
		const abort = harness.session.abort();
		await harness.session.prompt("bad input", {
			preflightResult: () => {
				throw new Error("deferred input rejected");
			},
		});
		await harness.session.prompt("B");
		await harness.session.sendUserMessage("C");
		expect(harness.session.pendingMessageCount).toBe(3);
		const original = promptPromise.then(
			() => undefined,
			(error: unknown) => (error instanceof Error ? error.message : String(error)),
		);
		releaseToolExecution();
		await abort;

		expect(await original).toBeUndefined();
		expect(errors).toEqual([
			expect.objectContaining({
				extensionPath: "<runtime>",
				event: "send_user_message",
				error: "deferred input rejected",
				stack: expect.stringContaining("deferred input rejected"),
			}),
		]);
		expect(getUserTexts(harness)).toEqual(["start", "B", "C"]);
		expect(getAssistantTexts(harness)).toEqual(["", "B response", "C response"]);
		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.session.pendingMessageCount).toBe(0);
		expect(harness.eventsOfType("agent_settled").map((event) => event.outcome)).toEqual([
			"aborted",
			"completed",
			"completed",
		]);
	});

	it.each(["steer", "followUp"] as const)(
		"preserves automatic %s custom work queued during cancellation without restarting the run",
		async (deliverAs) => {
			const waiting = await createWaitingHarness();
			const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
			harnesses.push(harness);
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage("must not run"),
			]);

			await waitForToolStart;
			const abort = harness.session.abort();
			try {
				await harness.session.sendCustomMessage(
					{ customType: "automatic", content: "automatic work", display: false },
					{ triggerTurn: true, deliverAs },
				);
				expect(harness.session.pendingMessageCount).toBe(0);
			} finally {
				releaseToolExecution();
			}
			await Promise.all([promptPromise, abort]);

			expect(harness.faux.state.callCount).toBe(1);
			expect(harness.session.agent.peekQueuedMessages()).toEqual([
				expect.objectContaining({ role: "custom", customType: "automatic", content: "automatic work" }),
			]);
			expect(harness.eventsOfType("agent_settled")).toEqual([{ type: "agent_settled", outcome: "aborted" }]);
		},
	);

	it("dispatches extension commands immediately when prompted while idle", async () => {
		const commandRuns: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("testcmd", {
						description: "Test command",
						handler: async (args) => {
							commandRuns.push(args);
						},
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.prompt("/testcmd hello world");

		expect(commandRuns).toEqual(["hello world"]);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.session.messages).toEqual([]);
	});

	it("delivers extension-origin steering messages before the next LLM call", async () => {
		let extensionApi: ExtensionAPI | undefined;
		const waiting = await createWaitingHarness({
			extensionFactories: [
				(pi) => {
					extensionApi = pi;
				},
			],
		});
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			(context) => {
				const sawSteer = context.messages.some(
					(message) => message.role === "user" && getMessageText(message) === "steer now",
				);
				return fauxAssistantMessage(sawSteer ? "saw steer" : "missing steer");
			},
		]);

		await waitForToolStart;
		await new Promise((resolve) => setTimeout(resolve, 0));

		extensionApi?.sendUserMessage("steer now", { deliverAs: "steer" });
		releaseToolExecution();
		await promptPromise;

		expect(getUserTexts(harness)).toEqual(["start", "steer now"]);
		expect(getAssistantTexts(harness)).toContain("saw steer");
	});

	it("delivers follow-up messages only after the current run finishes", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);
		const assistantSeenBeforeFollowUp: string[] = [];

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			(context) => {
				assistantSeenBeforeFollowUp.push(
					...context.messages
						.filter((message) => message.role === "assistant")
						.map((message) =>
							message.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("\n"),
						),
				);
				return fauxAssistantMessage("follow-up response");
			},
		]);

		await waitForToolStart;
		await harness.session.followUp("after current run");
		releaseToolExecution();
		await promptPromise;

		expect(getUserTexts(harness)).toEqual(["start", "after current run"]);
		expect(assistantSeenBeforeFollowUp).toContain("");
		expect(getAssistantTexts(harness)).toContain("follow-up response");
	});

	// Regression test for #8718.
	it("runs direct steering and follow-up messages through input handlers", async () => {
		const inputEvents: Array<Pick<InputEvent, "text" | "source" | "streamingBehavior">> = [];
		const waiting = await createWaitingHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", (event) => {
						inputEvents.push({
							text: event.text,
							source: event.source,
							streamingBehavior: event.streamingBehavior,
						});
						if (event.text.startsWith("handle")) return { action: "handled" };
						return { action: "transform", text: `transformed: ${event.text}` };
					});
				},
			],
		});
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("steered"),
			fauxAssistantMessage("followed up"),
		]);

		await waitForToolStart;
		inputEvents.length = 0;
		try {
			await harness.session.steer("steer me", undefined, { source: "rpc" });
			await harness.session.steer("handle steer", undefined, { source: "rpc" });
			await harness.session.followUp("follow me", undefined, { source: "rpc" });
			await harness.session.followUp("handle follow", undefined, { source: "rpc" });

			expect(inputEvents).toEqual([
				{ text: "steer me", source: "rpc", streamingBehavior: "steer" },
				{ text: "handle steer", source: "rpc", streamingBehavior: "steer" },
				{ text: "follow me", source: "rpc", streamingBehavior: "followUp" },
				{ text: "handle follow", source: "rpc", streamingBehavior: "followUp" },
			]);
			expect(harness.session.getSteeringMessages()).toEqual(["transformed: steer me"]);
			expect(harness.session.getFollowUpMessages()).toEqual(["transformed: follow me"]);
		} finally {
			releaseToolExecution();
		}
		await promptPromise;
	});

	it("delivers multiple steering messages in order in one-at-a-time mode", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("handled steer 1"),
			fauxAssistantMessage("handled steer 2"),
		]);

		await waitForToolStart;
		await harness.session.steer("steer 1");
		await harness.session.steer("steer 2");
		releaseToolExecution();
		await promptPromise;

		expect(getUserTexts(harness)).toEqual(["start", "steer 1", "steer 2"]);
		expect(getAssistantTexts(harness)).toEqual(["", "handled steer 1", "handled steer 2"]);
	});

	it("delivers multiple follow-up messages in order in one-at-a-time mode", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("original turn complete"),
			fauxAssistantMessage("handled follow-up 1"),
			fauxAssistantMessage("handled follow-up 2"),
		]);

		await waitForToolStart;
		await harness.session.followUp("follow-up 1");
		await harness.session.followUp("follow-up 2");
		releaseToolExecution();
		await promptPromise;

		expect(getUserTexts(harness)).toEqual(["start", "follow-up 1", "follow-up 2"]);
		expect(getAssistantTexts(harness)).toEqual([
			"",
			"original turn complete",
			"handled follow-up 1",
			"handled follow-up 2",
		]);
	});

	it("delivers all steering messages in one batch in all mode", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);
		harness.session.setSteeringMode("all");
		let batchedUserMessages: string[] = [];

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			(context) => {
				batchedUserMessages = context.messages
					.filter((message) => message.role === "user")
					.map((message) => getMessageText(message));
				return fauxAssistantMessage("batched steer response");
			},
		]);

		await waitForToolStart;
		await harness.session.steer("steer 1");
		await harness.session.steer("steer 2");
		releaseToolExecution();
		await promptPromise;

		expect(batchedUserMessages).toEqual(["start", "steer 1", "steer 2"]);
		expect(getAssistantTexts(harness)).toEqual(["", "batched steer response"]);
	});

	it("delivers all follow-up messages in one batch in all mode", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);
		harness.session.setFollowUpMode("all");
		let batchedUserMessages: string[] = [];

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("original turn complete"),
			(context) => {
				batchedUserMessages = context.messages
					.filter((message) => message.role === "user")
					.map((message) => getMessageText(message));
				return fauxAssistantMessage("batched follow-up response");
			},
		]);

		await waitForToolStart;
		await harness.session.followUp("follow-up 1");
		await harness.session.followUp("follow-up 2");
		releaseToolExecution();
		await promptPromise;

		expect(batchedUserMessages).toEqual(["start", "follow-up 1", "follow-up 2"]);
		expect(getAssistantTexts(harness)).toEqual(["", "original turn complete", "batched follow-up response"]);
	});

	it("queues custom messages with deliverAs steer while streaming", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);
		let sawCustomMessage = false;

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			(context) => {
				sawCustomMessage = context.messages.some(
					(message) =>
						message.role === "user" &&
						typeof message.content !== "string" &&
						message.content.some((part) => part.type === "text" && part.text === "steer custom"),
				);
				return fauxAssistantMessage("done");
			},
		]);

		await waitForToolStart;
		await harness.session.sendCustomMessage(
			{ customType: "queue-test", content: "steer custom", display: true, details: { value: 1 } },
			{ deliverAs: "steer" },
		);
		releaseToolExecution();
		await promptPromise;

		expect(sawCustomMessage).toBe(true);
		expect(
			harness.session.messages.some((message) => message.role === "custom" && message.customType === "queue-test"),
		).toBe(true);
	});

	it("queues custom messages with deliverAs followUp while streaming", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);
		let sawCustomMessage = false;

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("original turn complete"),
			(context) => {
				sawCustomMessage = context.messages.some(
					(message) =>
						message.role === "user" &&
						typeof message.content !== "string" &&
						message.content.some((part) => part.type === "text" && part.text === "follow-up custom"),
				);
				return fauxAssistantMessage("done");
			},
		]);

		await waitForToolStart;
		await harness.session.sendCustomMessage(
			{ customType: "queue-test", content: "follow-up custom", display: true, details: { value: 1 } },
			{ deliverAs: "followUp" },
		);
		releaseToolExecution();
		await promptPromise;

		expect(sawCustomMessage).toBe(true);
		expect(
			harness.session.messages.some((message) => message.role === "custom" && message.customType === "queue-test"),
		).toBe(true);
	});

	it("injects nextTurn custom messages into the next prompt", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let sawCustomMessage = false;

		await harness.session.sendCustomMessage(
			{ customType: "next-turn", content: "carry this", display: true, details: {} },
			{ deliverAs: "nextTurn" },
		);

		harness.setResponses([
			(context) => {
				sawCustomMessage = context.messages.some(
					(message) =>
						message.role === "user" &&
						typeof message.content !== "string" &&
						message.content.some((part) => part.type === "text" && part.text === "carry this"),
				);
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("normal prompt");

		expect(sawCustomMessage).toBe(true);
		expect(harness.session.messages.map((message) => message.role)).toEqual([
			"system",
			"user",
			"custom",
			"assistant",
		]);
	});

	it("updates pendingMessageCount and removes queued text before message_start is emitted", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);
		const countsAtQueuedMessageStart: number[] = [];

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		harness.session.subscribe((event) => {
			if (
				event.type === "message_start" &&
				event.message.role === "user" &&
				getMessageText(event.message) === "queued"
			) {
				countsAtQueuedMessageStart.push(harness.session.pendingMessageCount);
			}
		});

		await waitForToolStart;
		await harness.session.steer("queued");
		expect(harness.session.pendingMessageCount).toBe(1);
		releaseToolExecution();
		await promptPromise;

		expect(countsAtQueuedMessageStart).toEqual([0]);
		expect(harness.session.pendingMessageCount).toBe(0);
	});

	it("throws when queueing an extension command with steer", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("testcmd", {
						description: "Test command",
						handler: async () => {},
					});
				},
			],
		});
		harnesses.push(harness);

		await expect(harness.session.steer("/testcmd queued")).rejects.toThrow(
			'Extension command "/testcmd" cannot be queued. Use prompt() or execute the command when not streaming.',
		);
	});

	it("throws when queueing an extension command with followUp", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("testcmd", {
						description: "Test command",
						handler: async () => {},
					});
				},
			],
		});
		harnesses.push(harness);

		await expect(harness.session.followUp("/testcmd queued")).rejects.toThrow(
			'Extension command "/testcmd" cannot be queued. Use prompt() or execute the command when not streaming.',
		);
	});

	it("delivers follow-ups queued during agent_end", async () => {
		let sent = false;
		const harness = await createHarness({
			extensionFactories: [
				(pi: ExtensionAPI) => {
					pi.on("agent_end", async () => {
						if (sent) return;
						sent = true;
						pi.sendUserMessage("conflict report", { deliverAs: "followUp" });
					});
				},
			],
		});
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("reply"), fauxAssistantMessage("follow-up reply")]);

		await harness.session.prompt("hello");
		await harness.session.agent.waitForIdle();

		expect(getUserTexts(harness)).toEqual(["hello", "conflict report"]);
	});
});
