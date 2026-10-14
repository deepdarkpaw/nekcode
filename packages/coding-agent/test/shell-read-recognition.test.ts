import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type BashOperations, createBashTool } from "../src/core/tools/bash.ts";
import { createAllTools } from "../src/core/tools/index.ts";
import { createReadStateStore } from "../src/core/tools/read-state.ts";
import { recognizeBashRead, recognizePowerShellRead } from "../src/core/tools/shell-read-recognition.ts";

function successfulOperations(): BashOperations {
	return {
		exec: async (command, _cwd, options) => {
			options.onData(Buffer.from("file output\n"));
			return { exitCode: command.includes("false") ? 1 : 0 };
		},
	};
}

describe("shell read recognition", () => {
	const directories: string[] = [];

	afterEach(() => {
		for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	});

	it("accepts conservative bash reader forms", () => {
		expect(recognizeBashRead("cat file.txt")).toEqual({ path: "file.txt" });
		expect(recognizeBashRead("cat 'file with spaces.txt'")).toEqual({ path: "file with spaces.txt" });
		expect(recognizeBashRead('cat "file with spaces.txt"')).toEqual({ path: "file with spaces.txt" });
		expect(recognizeBashRead("head file.txt")).toEqual({ path: "file.txt" });
		expect(recognizeBashRead("tail file.txt")).toEqual({ path: "file.txt" });
		expect(recognizeBashRead("head -n 5 file.txt")).toEqual({ path: "file.txt", offset: 1, limit: 5 });
		expect(recognizeBashRead("tail -n5 file.txt")).toEqual({ path: "file.txt", offset: -5, limit: 5 });
		expect(recognizeBashRead("sed -n '2,4p' file.txt")).toEqual({ path: "file.txt", offset: 2, limit: 3 });
	});

	it("accepts conservative PowerShell reader forms", () => {
		expect(recognizePowerShellRead("Get-Content -LiteralPath 'file.txt'")).toEqual({ path: "file.txt" });
		expect(recognizePowerShellRead("gc file.txt -TotalCount 5")).toEqual({ path: "file.txt", offset: 1, limit: 5 });
		expect(recognizePowerShellRead("cat -Path file.txt -Tail 3")).toEqual({ path: "file.txt", offset: -3, limit: 3 });
		expect(recognizePowerShellRead("type file.txt")).toEqual({ path: "file.txt" });
		expect(recognizePowerShellRead('Get-Content "C:\\project\\file with spaces.txt" -Head 2')).toEqual({
			path: "C:\\project\\file with spaces.txt",
			offset: 1,
			limit: 2,
		});
		expect(recognizePowerShellRead("GET-CONTENT -TotalCount 2 -Path file.txt")).toEqual({
			path: "file.txt",
			offset: 1,
			limit: 2,
		});
	});

	it("rejects compound commands, unsafe paths, multiple files, and bash type", () => {
		for (const command of [
			"cat a.txt b.txt",
			"cat a.txt | head",
			"cat a.txt; echo done",
			"cat $FILE",
			"cat *.txt",
			"cat a.txt &",
			"type a.txt",
			"cat a.txt && echo done",
			"cat a.txt || echo done",
			"cat a.txt > output.txt",
			"cat $(pwd)/a.txt",
			"cat `pwd`/a.txt",
			"cat 'a*.txt'",
			'cat "$FILE"',
			"cat a?.txt",
			"cat a.txt\necho done",
			"cat 'unclosed",
			"cat a\\\\ b.txt",
		]) {
			expect(recognizeBashRead(command)).toBeUndefined();
		}
		for (const command of [
			"Get-Content a.txt; Write-Output done",
			"gc a.txt,b.txt",
			"gc a.txt b.txt",
			"gc $FILE",
			"gc *.txt",
			"'Get-Content' file.txt",
			"gc file.txt -Raw",
			"gc file.txt -Tail 2 -Head 3",
		]) {
			expect(recognizePowerShellRead(command)).toBeUndefined();
		}
	});

	it("shares shell reads with write and uses the actual execution cwd", async () => {
		const directory = mkdtempSync(join(tmpdir(), "shell-read-"));
		directories.push(directory);
		const path = join(directory, "file.txt");
		writeFileSync(path, "content\n");
		const tools = createAllTools(join(directory, "unused-cwd"), {
			bash: {
				operations: successfulOperations(),
				exposeSessionEnvironment: false,
				spawnHook: (ctx) => ({ ...ctx, cwd: directory }),
			},
			powershell: {
				operations: successfulOperations(),
				exposeSessionEnvironment: false,
				spawnHook: (ctx) => ({ ...ctx, cwd: directory }),
			},
		});
		await tools.bash.execute("bash-read", { command: "cat file.txt" });
		// A later external modification must not introduce a new live stale-file rejection.
		writeFileSync(path, "externally changed\n");
		utimesSync(path, new Date(), new Date(Date.now() + 10000));
		await tools.write.execute("write", { path, content: "replacement\n" });
		const powerPath = join(directory, "power.txt");
		writeFileSync(powerPath, "content\n");
		await tools.powershell.execute("power-read", { command: "Get-Content -Path power.txt -Head 1" });
		await tools.write.execute("power-write", { path: powerPath, content: "replacement\n" });
	});

	it.each(["aborted", "timeout:1"])("does not grant credit after %s", async (failure) => {
		const directory = mkdtempSync(join(tmpdir(), "shell-read-"));
		directories.push(directory);
		const path = join(directory, "file.txt");
		writeFileSync(path, "content\n");
		const store = createReadStateStore();
		const tool = createBashTool(directory, {
			operations: {
				exec: async () => {
					throw new Error(failure);
				},
			},
			readState: store,
			exposeSessionEnvironment: false,
		});
		await expect(tool.execute("read", { command: "cat file.txt" })).rejects.toThrow();
		expect(store.get(path)).toBeUndefined();
	});

	it("skips missing files, directories, and compound execution prefixes", async () => {
		const directory = mkdtempSync(join(tmpdir(), "shell-read-"));
		directories.push(directory);
		const path = join(directory, "file.txt");
		writeFileSync(path, "content\n");
		const store = createReadStateStore();
		const tool = createBashTool(directory, {
			operations: successfulOperations(),
			readState: store,
			exposeSessionEnvironment: false,
		});
		await tool.execute("missing", { command: "cat missing.txt" });
		await tool.execute("directory", { command: `cat '${directory.replaceAll("\\", "/")}'` });
		expect(store.get(directory)).toBeUndefined();
		const prefixed = createBashTool(directory, {
			operations: successfulOperations(),
			readState: store,
			exposeSessionEnvironment: false,
			commandPrefix: "echo setup",
		});
		const result = await prefixed.execute("prefix", { command: "cat file.txt" });
		expect(result.details?.readState).toBeUndefined();
		expect(store.get(path)).toBeUndefined();
	});

	it("records only a successful existing-file bash read", async () => {
		const directory = mkdtempSync(join(tmpdir(), "shell-read-"));
		directories.push(directory);
		const path = join(directory, "file.txt");
		writeFileSync(path, "content\n");
		const store = createReadStateStore();
		const tool = createBashTool(directory, {
			operations: successfulOperations(),
			readState: store,
			exposeSessionEnvironment: false,
		});

		const success = await tool.execute("read", { command: "cat file.txt" });
		expect(success.details?.readState?.path).toBe(path);
		expect(store.get(path)).toBeDefined();

		store.clear();
		const failed = createBashTool(directory, {
			operations: { exec: async () => ({ exitCode: 1 }) },
			readState: store,
			exposeSessionEnvironment: false,
		});
		await expect(failed.execute("failed", { command: "cat file.txt" })).rejects.toThrow("code 1");
		expect(store.get(path)).toBeUndefined();
	});
});
