import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, renameSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { SessionLockedError } from "../../src/core/durable/lock.ts";
import { sidecarPath } from "../../src/core/durable/session-sidecar.ts";
import { convertToLlm } from "../../src/core/messages.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { JsonlSessionManager } from "../../src/core/session-manager-jsonl.ts";
import { assistant } from "./session-fixtures.ts";
import { tempDir } from "./support.ts";

const sourceResolverUrl = pathToFileURL(
	fileURLToPath(new URL("../../src/experimental/source-resolver.ts", import.meta.url)),
).href;
const childScript = fileURLToPath(new URL("./fixtures/session-child.ts", import.meta.url));

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function dir(): string {
	const made = tempDir("nek-store-");
	cleanups.push(made.cleanup);
	return made.dir;
}

function digest(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function spawnChild(mode: string, path: string): { child: ChildProcess; output: () => string } {
	const child = spawn(process.execPath, ["--no-warnings", "--import", sourceResolverUrl, childScript, mode, path], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		output += chunk.toString();
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		output += chunk.toString();
	});
	cleanups.push(() => {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	});
	return { child, output: () => output };
}

async function until(check: () => boolean, timeoutMs: number, describe: () => string): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`Timed out: ${describe()}`);
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}

async function kill(child: ChildProcess): Promise<void> {
	const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
	child.kill("SIGKILL");
	await exited;
}

/** A large linear JSONL session, so an import takes long enough to be killed in the middle. */
function largeJsonl(directory: string, turns: number): string {
	const sm = JsonlSessionManager.create("/work/project", directory);
	const padding = "x".repeat(2000);
	for (let index = 0; index < turns; index++) {
		sm.appendMessage({ role: "user", content: `question ${index} ${padding}`, timestamp: index * 2 + 1 });
		sm.appendMessage(assistant(`answer ${index} ${padding}`));
	}
	return sm.getSessionFile()!;
}

describe("durable session import", { timeout: 120_000 }, () => {
	it("survives a crash during import and imports again on the next open", async () => {
		const directory = dir();
		const jsonl = largeJsonl(directory, 6000);
		const before = digest(jsonl);
		const database = jsonl.replace(/\.jsonl$/, ".sqlite");

		const { child, output } = spawnChild("import", jsonl);
		const temporary = () => readdirSync(directory).some((name) => name.includes(".sqlite.tmp-"));
		await until(() => temporary() || output().includes("MARK imported"), 60_000, output);
		expect(output()).not.toContain("MARK imported");
		await kill(child);

		// The crash left a temporary database and no session database; the JSONL file is untouched.
		expect(temporary()).toBe(true);
		expect(existsSync(database)).toBe(false);
		expect(digest(jsonl)).toBe(before);

		const imported = SessionManager.open(jsonl);
		expect(imported.getSessionFile()).toBe(database);
		expect(temporary()).toBe(false);
		expect(digest(jsonl)).toBe(before);
		const reopened = SessionManager.open(database);
		const oracle = JsonlSessionManager.open(jsonl);
		expect(reopened.getEntries()).toHaveLength(12000);
		expect(reopened.getEntries()).toEqual(oracle.getEntries());
		expect(reopened.buildSessionContext()).toEqual(oracle.buildSessionContext());
	});
});

describe("durable session lock", { timeout: 60_000 }, () => {
	it("blocks writes from a second process while an engine holds the session, and reclaims a dead owner's lock", async () => {
		const directory = dir();
		const session = SessionManager.create("/work/project", directory);
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		const database = session.getSessionFile()!;

		const { child, output } = spawnChild("hold", database);
		await until(() => output().includes("MARK held"), 60_000, output);

		// Reading works; writing is refused while the owner lives.
		const second = SessionManager.open(database);
		expect(second.getEntries()).toHaveLength(1);
		expect(() => second.appendMessage({ role: "user", content: "blocked", timestamp: 2 })).toThrow(
			SessionLockedError,
		);

		await kill(child);
		const third = SessionManager.open(database);
		third.appendMessage({ role: "user", content: "after owner died", timestamp: 3 });
		expect(
			SessionManager.open(database)
				.getEntries()
				.map((entry) => entry.type === "message" && entry.message.role),
		).toEqual(["user", "user"]);
	});
});

describe("in-memory durable sessions", () => {
	it("stays off the filesystem and gives an engine a durable store with the same context", async () => {
		const session = SessionManager.inMemory("/work/project");
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendMessage(assistant("hi"));
		expect(session.getSessionFile()).toBeUndefined();

		const store = session.durableStore();
		const harness = await store.pin();
		cleanups.push(() => store.unpin());
		session.appendMessage({ role: "user", content: "later", timestamp: 3 });
		await session.flush();

		const conversation = await harness.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
		const view = await conversation!.context(BACKGROUND_CONTEXT);
		expect(view.messages).toEqual(convertToLlm(session.buildSessionContext().messages));
	});
});

describe("durable session listing", () => {
	function persisted(directory: string, text: string): string {
		const session = SessionManager.create("/work/project", directory);
		session.appendMessage({ role: "user", content: text, timestamp: Date.now() });
		session.appendMessage(assistant(`reply to ${text}`));
		return session.getSessionFile()!;
	}

	it("lists database sessions and JSONL sessions not imported yet, once each", async () => {
		const directory = dir();
		const first = persisted(directory, "first");
		persisted(directory, "second");
		const pending = JsonlSessionManager.create("/work/project", directory);
		pending.appendMessage({ role: "user", content: "jsonl only", timestamp: Date.now() });
		const imported = JsonlSessionManager.create("/work/project", directory);
		imported.appendMessage({ role: "user", content: "jsonl imported", timestamp: Date.now() });
		SessionManager.open(imported.getSessionFile()!);

		const sessions = await SessionManager.list("/work/project", directory);
		expect(sessions.map((session) => session.firstMessage).sort()).toEqual([
			"first",
			"jsonl imported",
			"jsonl only",
			"second",
		]);
		expect(sessions.find((session) => session.firstMessage === "first")?.path).toBe(first);
		expect(sessions.find((session) => session.firstMessage === "jsonl only")?.path).toBe(pending.getSessionFile());
	});

	it("reads a fresh sidecar instead of the database and rebuilds a stale one", async () => {
		const directory = dir();
		const database = persisted(directory, "real first message");
		const sidecar = sidecarPath(database);
		const cached = JSON.parse(readFileSync(sidecar, "utf8")) as Record<string, unknown>;

		// A fresh sidecar is trusted as it is.
		writeFileSync(sidecar, JSON.stringify({ ...cached, firstMessage: "from sidecar" }));
		expect((await SessionManager.list("/work/project", directory))[0]?.firstMessage).toBe("from sidecar");

		// A sidecar older than the database is rebuilt from it.
		const old = new Date(statSync(database).mtimeMs - 60_000);
		utimesSync(sidecar, old, old);
		expect((await SessionManager.list("/work/project", directory))[0]?.firstMessage).toBe("real first message");
		expect(JSON.parse(readFileSync(sidecar, "utf8")).firstMessage).toBe("real first message");

		// A missing sidecar is rebuilt too.
		renameSync(sidecar, `${sidecar}.gone`);
		expect((await SessionManager.list("/work/project", directory))[0]?.firstMessage).toBe("real first message");
		expect(existsSync(sidecar)).toBe(true);
	});

	it("describes the Harness's own commits in the sidecar written when the store closes", async () => {
		const directory = dir();
		const database = persisted(directory, "before the engine");
		const session = SessionManager.open(database);
		const store = session.durableStore();
		const harness = await store.pin();
		const conversation = await harness.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
		const user = { role: "user", content: "written by the engine", timestamp: Date.now() } as const;
		await conversation!.submit({ type: "write", entry: { kind: "pi.user", model: [user] } }, BACKGROUND_CONTEXT);
		await store.unpin();

		const [info] = await SessionManager.list("/work/project", directory);
		expect(info?.messageCount).toBe(3);
		expect(JSON.parse(readFileSync(sidecarPath(database), "utf8")).messageCount).toBe(3);
	});
});
