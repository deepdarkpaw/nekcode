import { statSync } from "node:fs";
import { access, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEditTool } from "../src/core/tools/edit.ts";
import { withFileMutationQueue } from "../src/core/tools/file-mutation-queue.ts";
import { createReadStateStore } from "../src/core/tools/read-state.ts";
import { createWriteTool } from "../src/core/tools/write.ts";

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return { promise, resolve };
}

async function resolvesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
	return Promise.race([promise.then(() => true), delay(ms).then(() => false)]);
}

const tempDirs: string[] = [];
function seedReadState(store: ReturnType<typeof createReadStateStore>, path: string, content: string): void {
	store.set(path, { content, timestamp: Math.floor(statSync(path).mtimeMs), offset: undefined, limit: undefined });
}
async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-file-mutation-queue-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("withFileMutationQueue", () => {
	it("serializes operations for the same file", async () => {
		const order: string[] = [];
		const first = withFileMutationQueue("/tmp/file-mutation-queue-same", async () => {
			order.push("first:start");
			await delay(30);
			order.push("first:end");
		});
		const second = withFileMutationQueue("/tmp/file-mutation-queue-same", async () => {
			order.push("second:start");
			order.push("second:end");
		});
		await Promise.all([first, second]);
		expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"]);
	});

	it("allows different files to proceed in parallel", async () => {
		const order: string[] = [];
		await Promise.all([
			withFileMutationQueue("/tmp/file-mutation-queue-a", async () => {
				order.push("a:start");
				await delay(30);
				order.push("a:end");
			}),
			withFileMutationQueue("/tmp/file-mutation-queue-b", async () => {
				order.push("b:start");
				await delay(30);
				order.push("b:end");
			}),
		]);
		expect(order.indexOf("a:start")).toBeLessThan(order.indexOf("a:end"));
		expect(order.indexOf("b:start")).toBeLessThan(order.indexOf("b:end"));
		expect(order.indexOf("b:start")).toBeLessThan(order.indexOf("a:end"));
	});

	it.skipIf(process.platform === "win32")("uses the same queue for symlink aliases", async () => {
		const dir = await createTempDir();
		const targetPath = join(dir, "target.txt");
		const symlinkPath = join(dir, "alias.txt");
		await writeFile(targetPath, "hello\n", "utf8");
		await symlink(targetPath, symlinkPath);
		const order: string[] = [];
		await Promise.all([
			withFileMutationQueue(targetPath, async () => {
				order.push("target:start");
				await delay(30);
				order.push("target:end");
			}),
			withFileMutationQueue(symlinkPath, async () => {
				order.push("alias:start");
				order.push("alias:end");
			}),
		]);
		expect(order).toEqual(["target:start", "target:end", "alias:start", "alias:end"]);
	});
});

describe("built-in edit and write tools", () => {
	it("preserves both parallel edits on the same file", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "parallel-edit.txt");
		await writeFile(filePath, "alpha\nbeta\ngamma\n", "utf8");
		const readState = createReadStateStore();
		seedReadState(readState, filePath, "alpha\nbeta\ngamma\n");
		const editTool = createEditTool(dir, {
			readState,
			operations: {
				access,
				readFile: async (path) => {
					const buffer = await readFile(path);
					await delay(30);
					return buffer;
				},
				writeFile: async (path, content) => {
					await delay(30);
					await writeFile(path, content, "utf8");
				},
			},
		});
		await Promise.all([
			editTool.execute("call-1", { file_path: filePath, old_string: "alpha", new_string: "ALPHA" }),
			editTool.execute("call-2", { file_path: filePath, old_string: "beta", new_string: "BETA" }),
		]);
		expect(await readFile(filePath, "utf8")).toBe("ALPHA\nBETA\ngamma\n");
	});

	it("shares the queue between edit and write", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "mixed.txt");
		await writeFile(filePath, "original\n", "utf8");
		const readState = createReadStateStore();
		seedReadState(readState, filePath, "original\n");
		const editTool = createEditTool(dir, {
			readState,
			operations: {
				access,
				readFile: async (path) => {
					const buffer = await readFile(path);
					await delay(30);
					return buffer;
				},
				writeFile: async (path, content) => {
					await delay(30);
					await writeFile(path, content, "utf8");
				},
			},
		});
		const writeTool = createWriteTool(dir, {
			readState,
			operations: {
				mkdir: async () => {},
				writeFile: async (path, content) => {
					await delay(10);
					await writeFile(path, content, "utf8");
				},
			},
		});
		const editPromise = editTool.execute("call-1", {
			file_path: filePath,
			old_string: "original",
			new_string: "edited",
		});
		await delay(5);
		const writePromise = writeTool.execute("call-2", { path: filePath, content: "replacement\n" });
		await Promise.all([editPromise, writePromise]);
		expect(await readFile(filePath, "utf8")).toBe("replacement\n");
	});

	it("keeps write queue locked while an aborted write is still in flight", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "abort-write.txt");
		await writeFile(filePath, "initial\n", "utf8");
		const readState = createReadStateStore();
		seedReadState(readState, filePath, "initial\n");
		const firstWriteStarted = createDeferred();
		const finishFirstWrite = createDeferred();
		const secondWriteStarted = createDeferred();
		let firstWriteSettled = false;
		const writeTool = createWriteTool(dir, {
			readState,
			operations: {
				mkdir: async () => {},
				writeFile: async (path, content) => {
					if (content === "first\n") {
						firstWriteStarted.resolve();
						await finishFirstWrite.promise;
						await writeFile(path, content, "utf8");
						firstWriteSettled = true;
						return;
					}
					if (content === "second\n") {
						expect(firstWriteSettled).toBe(true);
						secondWriteStarted.resolve();
					}
					await writeFile(path, content, "utf8");
				},
			},
		});
		const controller = new AbortController();
		const firstWrite = writeTool.execute("call-1", { path: filePath, content: "first\n" }, controller.signal);
		await firstWriteStarted.promise;
		controller.abort();
		const secondWrite = writeTool.execute("call-2", { path: filePath, content: "second\n" });
		expect(await resolvesWithin(secondWriteStarted.promise, 20)).toBe(false);
		finishFirstWrite.resolve();
		await expect(firstWrite).rejects.toThrow("Operation aborted");
		await secondWrite;
		expect(await readFile(filePath, "utf8")).toBe("second\n");
	});

	it("keeps edit queue locked while an aborted edit write is still in flight", async () => {
		const dir = await createTempDir();
		const filePath = join(dir, "abort-edit.txt");
		await writeFile(filePath, "alpha\nbeta\n", "utf8");
		const readState = createReadStateStore();
		seedReadState(readState, filePath, "alpha\nbeta\n");
		const firstWriteStarted = createDeferred();
		const finishFirstWrite = createDeferred();
		const secondWriteStarted = createDeferred();
		let firstWriteSettled = false;
		const editTool = createEditTool(dir, {
			readState,
			operations: {
				access,
				readFile,
				writeFile: async (path, content) => {
					if (content === "ALPHA\nbeta\n") {
						firstWriteStarted.resolve();
						await finishFirstWrite.promise;
						await writeFile(path, content, "utf8");
						firstWriteSettled = true;
						return;
					}
					if (content === "ALPHA\nBETA\n") {
						expect(firstWriteSettled).toBe(true);
						secondWriteStarted.resolve();
					}
					await writeFile(path, content, "utf8");
				},
			},
		});
		const controller = new AbortController();
		const firstEdit = editTool.execute(
			"call-1",
			{ file_path: filePath, old_string: "alpha", new_string: "ALPHA" },
			controller.signal,
		);
		await firstWriteStarted.promise;
		controller.abort();
		const secondEdit = editTool.execute("call-2", { file_path: filePath, old_string: "beta", new_string: "BETA" });
		expect(await resolvesWithin(secondWriteStarted.promise, 20)).toBe(false);
		finishFirstWrite.resolve();
		await expect(firstEdit).rejects.toThrow("Operation aborted");
		await secondEdit;
		expect(await readFile(filePath, "utf8")).toBe("ALPHA\nBETA\n");
	});
});
