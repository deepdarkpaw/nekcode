import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { RpcClient, RpcCommandError, type RpcTransport } from "../src/rpc/client.ts";
import { JsonlDecoder, parseRecord, serializeJsonLine } from "../src/rpc/jsonl.ts";
import type { RpcEventRecord, UiRequest } from "../src/rpc/protocol.ts";

describe("JSONL framing", () => {
	it("splits on LF only and keeps U+2028/U+2029 inside records", () => {
		const decoder = new JsonlDecoder();
		const record = { type: "x", text: "a\u2028b\u2029c" };
		const lines = decoder.push(serializeJsonLine(record) + serializeJsonLine({ type: "y" }));
		assert.equal(lines.length, 2);
		assert.deepEqual(parseRecord(lines[0]), record);
	});

	it("joins records split across chunks, including multi-byte characters", () => {
		const decoder = new JsonlDecoder();
		const bytes = Buffer.from(serializeJsonLine({ type: "x", text: "猫猫" }));
		const cut = bytes.indexOf(Buffer.from("猫")) + 1;
		assert.deepEqual(decoder.push(bytes.subarray(0, cut)), []);
		const lines = decoder.push(bytes.subarray(cut));
		assert.deepEqual(parseRecord(lines[0]), { type: "x", text: "猫猫" });
	});

	it("strips CR before LF and flushes an unterminated last line", () => {
		const decoder = new JsonlDecoder();
		assert.deepEqual(decoder.push('{"a":1}\r\n{"b":'), ['{"a":1}']);
		assert.deepEqual(decoder.push("2}"), []);
		assert.deepEqual(decoder.end(), ['{"b":2}']);
	});

	it("ignores blank, malformed, and non-object lines", () => {
		assert.equal(parseRecord(""), undefined);
		assert.equal(parseRecord("{nope"), undefined);
		assert.equal(parseRecord("[1,2]"), undefined);
		assert.equal(parseRecord("42"), undefined);
	});
});

interface FakeBackend {
	transport: RpcTransport;
	/** Records the client wrote. */
	written: Array<Record<string, unknown>>;
	reply: (record: unknown) => void;
	exit: (code: number | null) => void;
}

function fakeBackend(): FakeBackend {
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const written: Array<Record<string, unknown>> = [];
	const decoder = new JsonlDecoder();
	stdin.on("data", (chunk: Buffer) => {
		for (const line of decoder.push(chunk)) {
			const record = parseRecord(line);
			if (record) written.push(record);
		}
	});
	let resolveExit: (value: { code: number | null; signal: string | null }) => void = () => {};
	const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
		resolveExit = resolve;
	});
	stdin.on("finish", () => resolveExit({ code: 0, signal: null }));
	return {
		transport: { stdin, stdout, stderr, exited },
		written,
		reply: (record) => stdout.write(serializeJsonLine(record)),
		exit: (code) => resolveExit({ code, signal: null }),
	};
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("RpcClient", () => {
	it("correlates responses by id regardless of order", async () => {
		const backend = fakeBackend();
		const client = new RpcClient(backend.transport);
		const state = client.request({ type: "get_state" });
		const stats = client.request({ type: "get_session_stats" });
		await tick();
		assert.equal(backend.written.length, 2);
		const [stateCmd, statsCmd] = backend.written;
		assert.notEqual(stateCmd.id, statsCmd.id);
		backend.reply({
			id: statsCmd.id,
			type: "response",
			command: "get_session_stats",
			success: true,
			data: { cost: 1 },
		});
		backend.reply({
			id: stateCmd.id,
			type: "response",
			command: "get_state",
			success: true,
			data: { sessionId: "s" },
		});
		assert.deepEqual(await stats, { cost: 1 });
		assert.deepEqual(await state, { sessionId: "s" });
	});

	it("rejects failed commands with the backend error", async () => {
		const backend = fakeBackend();
		const client = new RpcClient(backend.transport);
		const pending = client.request({ type: "set_model", provider: "x", modelId: "y" });
		await tick();
		backend.reply({
			id: backend.written[0].id,
			type: "response",
			command: "set_model",
			success: false,
			error: "Model not found",
		});
		await assert.rejects(
			pending,
			(error: unknown) => error instanceof RpcCommandError && error.message === "Model not found",
		);
	});

	it("times out requests without a response", async () => {
		const backend = fakeBackend();
		const client = new RpcClient(backend.transport, { requestTimeoutMs: 20 });
		await assert.rejects(client.request({ type: "get_state" }), /Timed out/);
	});

	it("delivers events, extension UI requests, and uncorrelated responses separately", async () => {
		const backend = fakeBackend();
		const client = new RpcClient(backend.transport);
		const events: RpcEventRecord[] = [];
		const requests: UiRequest[] = [];
		client.onEvent((event) => events.push(event));
		client.onUiRequest((request) => requests.push(request));
		backend.reply({ type: "agent_start" });
		backend.reply({ type: "extension_ui_request", id: "u1", method: "confirm", title: "Sure?", message: "" });
		backend.reply({ type: "response", command: "parse", success: false, error: "bad json" });
		await tick();
		assert.deepEqual(
			events.map((event) => event.type),
			["agent_start", "rpc_uncorrelated_response"],
		);
		assert.equal(requests[0]?.method, "confirm");
		client.respondUi({ type: "extension_ui_response", id: "u1", confirmed: true });
		await tick();
		assert.deepEqual(backend.written.at(-1), { type: "extension_ui_response", id: "u1", confirmed: true });
	});

	it("rejects pending requests when the backend exits and reports the exit", async () => {
		const backend = fakeBackend();
		const client = new RpcClient(backend.transport);
		let exit: { code: number | null; expected: boolean } | undefined;
		client.onExit((info) => {
			exit = info;
		});
		const pending = client.request({ type: "get_state" });
		backend.exit(3);
		await assert.rejects(pending, /exited/);
		assert.deepEqual(exit && { code: exit.code, expected: exit.expected }, { code: 3, expected: false });
		await assert.rejects(client.request({ type: "get_state" }), /exited/);
	});

	it("shuts down by closing stdin", async () => {
		const backend = fakeBackend();
		const client = new RpcClient(backend.transport);
		assert.equal(await client.shutdown(1000), 0);
		assert.equal(client.exited?.expected, true);
	});
});
