import { existsSync } from "node:fs";
import { win32 } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalPowerShellOperations, createPowerShellTool } from "../src/core/tools/powershell.ts";
import type * as Shell from "../src/utils/shell.ts";

const shellOverride = vi.hoisted(() => ({ path: undefined as string | undefined }));
vi.mock("../src/utils/shell.ts", async (original) => {
	const actual = await original<typeof Shell>();
	return {
		...actual,
		getPowerShellConfig: () =>
			shellOverride.path
				? { shell: shellOverride.path, args: [...actual.POWERSHELL_ARGS] }
				: actual.getPowerShellConfig(),
	};
});
afterEach(() => {
	shellOverride.path = undefined;
});

import { getPowerShellConfig, POWERSHELL_ARGS } from "../src/utils/shell.ts";

function getTextOutput(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((content) => content.type === "text")
		.map((content) => content.text ?? "")
		.join("\n");
}

describe("powershell tool", () => {
	const windowsShell = win32.join(
		process.env.SystemRoot ?? "C:\\Windows",
		"System32",
		"WindowsPowerShell",
		"v1.0",
		"powershell.exe",
	);
	it.skipIf(process.platform !== "win32" || !existsSync(windowsShell))(
		"distinguishes native stderr from failure and leaves unfinished input unexecuted",
		async () => {
			shellOverride.path = windowsShell;
			const operations = createLocalPowerShellOperations();
			for (const [command, expected] of [
				['cmd /c "echo progress 1>&2 & exit 0" 2>&1 | Select-Object -Last 3', 0],
				['cmd /c "echo progress 1>&2 & exit 7" 2>&1 | Select-Object -Last 3', 1],
				['throw "failure"', 1],
				["exit 5", 5],
			] as const) {
				expect((await operations.exec(command, process.cwd(), { onData: () => {} })).exitCode, command).toBe(
					expected,
				);
			}
			for (const ending of ["Write-Output done `", "Get-ChildItem |", "$x ="]) {
				let output = "";
				const result = await operations.exec(`Write-Output ("audit-" + "ran"); ${ending}`, process.cwd(), {
					onData: (data) => {
						output += data.toString();
					},
				});
				expect(result.exitCode).toBe(1);
				expect(output).not.toContain("audit-ran");
			}
		},
		30_000,
	);

	it("uses process-local execution policy bypass", () => {
		expect(POWERSHELL_ARGS).toEqual(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"]);
	});

	it.skipIf(process.platform !== "win32")("executes PowerShell commands with UTF-8 output", async () => {
		const config = getPowerShellConfig();
		expect(config.args).toEqual(POWERSHELL_ARGS);

		const tool = createPowerShellTool(process.cwd());
		const result = await tool.execute("powershell-test", {
			command: "Write-Output 'héllo €'; Get-ExecutionPolicy -Scope Process",
		});
		const output = getTextOutput(result);

		expect(output).toContain("héllo €");
		expect(output).toContain("Bypass");
	});
});
