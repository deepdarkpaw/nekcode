import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentSessionEvent } from "../../src/core/agent-session.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness } from "./harness.ts";

async function progress(session: AgentSession): Promise<void> {
	const message = fauxAssistantMessage("partial");
	await Reflect.get(AgentSession.prototype, "_handleDurableEvent").call(session, {
		type: "message_update",
		message,
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "partial", partial: message },
	});
}

describe("incremental event synchronization", () => {
	it("runs the next prompt on the selected tree branch, not the abandoned conversation", async () => {
		const harness = await createHarness();
		try {
			harness.setResponses([fauxAssistantMessage("first answer")]);
			await harness.session.prompt("first question");
			const target = harness.sessionManager.getLeafId()!;
			harness.setResponses([fauxAssistantMessage("abandoned answer")]);
			await harness.session.prompt("abandoned question");
			const otherBranch = harness.sessionManager.getLeafId()!;
			await harness.session.navigateTree(target);
			harness.sessionManager.appendCustomMessageEntry("branch-note", "branch note", true);
			let request = "";
			harness.setResponses([
				(context) => {
					request = JSON.stringify(context.messages);
					return fauxAssistantMessage("branch answer");
				},
			]);
			await harness.session.prompt("branch question");
			expect(request).toContain("first question");
			expect(request).toContain("branch question");
			expect(request).toContain("branch note");
			expect(request).not.toContain("abandoned question");
			expect(JSON.stringify(harness.sessionManager.getBranch())).toContain("branch answer");
			await harness.session.navigateTree(otherBranch);
			harness.setResponses([
				(context) => {
					request = JSON.stringify(context.messages);
					return fauxAssistantMessage("other answer");
				},
			]);
			await harness.session.prompt("other question");
			expect(request).toContain("abandoned question");
			expect(request).not.toContain("branch question");
			harness.sessionManager.resetLeaf();
			harness.setResponses([
				(context) => {
					request = JSON.stringify(context.messages);
					return fauxAssistantMessage("fresh answer");
				},
			]);
			await harness.session.prompt("fresh question");
			expect(request).not.toContain("first question");
			expect(request).not.toContain("other question");
			expect(request).toContain("fresh question");
		} finally {
			harness.cleanup();
		}
	});
	it("reopens the committed branch without resuming the abandoned root conversation", async () => {
		const dir = mkdtempSync(join(tmpdir(), "branch-reopen-"));
		const first = await createHarness({
			sessionManager: SessionManager.create(dir, dir),
			resumeInterruptedWork: false,
		});
		try {
			first.setResponses([fauxAssistantMessage("first")]);
			await first.session.prompt("kept");
			const target = first.sessionManager.getLeafId()!;
			first.setResponses([fauxAssistantMessage("old branch")]);
			await first.session.prompt("discarded");
			await first.session.navigateTree(target);
			first.setResponses([fauxAssistantMessage("branch")]);
			await first.session.prompt("branch history");
			await first.session.dispose();
			const reopened = await createHarness({
				sessionManager: SessionManager.open(first.sessionManager.getSessionFile()!),
				resumeInterruptedWork: false,
			});
			try {
				let request = "";
				reopened.setResponses([
					(context) => {
						request = JSON.stringify(context.messages);
						return fauxAssistantMessage("resumed");
					},
				]);
				await reopened.session.prompt("next");
				expect(request).toContain("branch history");
				expect(request).not.toContain("discarded");
			} finally {
				await reopened.session.dispose();
				reopened.cleanup();
			}
		} finally {
			await first.session.dispose();
			first.cleanup();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not rebuild finalized context or discover entries through full history on pure progress", async () => {
		const harness = await createHarness();
		try {
			harness.setResponses([fauxAssistantMessage("ready")]);
			await harness.session.prompt("hello");
			const before = harness.session.agent.state.messages;
			const entries = vi.spyOn(harness.sessionManager, "getEntries");
			for (let index = 0; index < 20; index++) await progress(harness.session);
			expect(harness.session.agent.state.messages).toBe(before);
			expect(entries).not.toHaveBeenCalled();
		} finally {
			harness.cleanup();
		}
	});
	it("announces a committed entry once even if another consumer refreshed first", async () => {
		const harness = await createHarness();
		try {
			harness.setResponses([fauxAssistantMessage("ready")]);
			await harness.session.prompt("hello");
			const store = harness.sessionManager.durableStore();
			const durable = await store.pin();
			try {
				const root = await durable.root(BACKGROUND_CONTEXT);
				await root.commit(
					(tx) =>
						tx.appendEntry(root.id, {
							kind: "nek.custom",
							data: {
								entry: {
									type: "custom",
									id: "external-entry",
									parentId: harness.sessionManager.getLeafId(),
									timestamp: "2026-11-03T00:00:00.000Z",
									customType: "test",
									data: {},
								},
							},
						}),
					BACKGROUND_CONTEXT,
				);
				await harness.sessionManager.refresh();
				const events: AgentSessionEvent[] = [];
				const off = harness.session.subscribe((event) => events.push(event));
				await progress(harness.session);
				await progress(harness.session);
				off();
				expect(
					events.filter((event) => event.type === "entry_appended" && event.entry.id === "external-entry"),
				).toHaveLength(1);
			} finally {
				await store.unpin();
			}
		} finally {
			harness.cleanup();
		}
	});
});
