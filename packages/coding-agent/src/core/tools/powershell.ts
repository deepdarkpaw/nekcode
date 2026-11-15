import { win32 } from "node:path";
import { getPowerShellConfig } from "../../utils/shell.ts";
import {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	type createBashTool,
	createLocalShellOperations,
	createShellToolDefinition,
	type ShellToolConfig,
} from "./bash.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const UTF8_OUTPUT_PREFIX = "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n";

export const powershellToolSystemPromptContribution = {
	snippet: "Run PowerShell commands: builds, tests, git, package managers, scripts",
	guidelines: [
		"Use PowerShell for commands that need a shell (builds, tests, git, package managers); use the file tools for reading, searching, and editing files when they are available",
		"You can inspect NEK_* environment variables for current model and session details.",
	],
} as const;

export type PowerShellOperations = BashOperations;
export type PowerShellSpawnContext = BashSpawnContext;
export type PowerShellSpawnHook = BashSpawnHook;
export type PowerShellToolDetails = BashToolDetails;
export type PowerShellToolInput = BashToolInput;

export interface PowerShellToolOptions
	extends Pick<BashToolOptions, "operations" | "exposeSessionEnvironment" | "spawnHook" | "readState"> {}

/** PowerShell 5.1 treats redirected native stderr as failure even when the native process succeeded. */
const WINDOWS_POWERSHELL_EXIT_SUFFIX =
	'\n;\nif ($?) { exit 0 }\nif (($LASTEXITCODE -eq 0) -and ("$($Error[0].FullyQualifiedErrorId)" -like "NativeCommandError*")) { exit 0 }\nexit 1';

export function createLocalPowerShellOperations(): PowerShellOperations {
	return {
		exec: async (command, cwd, options) => {
			const config = getPowerShellConfig();
			// Do not turn an unfinished command into executable input by appending a continuation.
			const suffix =
				win32.basename(config.shell).toLowerCase() === "powershell.exe" && !command.endsWith("`")
					? WINDOWS_POWERSHELL_EXIT_SUFFIX
					: "";
			return createLocalShellOperations("PowerShell", () => config).exec(
				`${UTF8_OUTPUT_PREFIX}${command}${suffix}`,
				cwd,
				options,
			);
		},
	};
}

const powershellToolConfig: ShellToolConfig = {
	name: "powershell",
	label: "powershell",
	shellName: "PowerShell",
	prompt: "PS>",
	promptSnippet: powershellToolSystemPromptContribution.snippet,
	promptGuidelines: powershellToolSystemPromptContribution.guidelines,
	tempFilePrefix: "nek-powershell",
};

export function createPowerShellToolDefinition(
	cwd: string,
	options?: PowerShellToolOptions,
): ReturnType<typeof createShellToolDefinition> {
	return createShellToolDefinition(cwd, powershellToolConfig, {
		...options,
		operations: options?.operations ?? createLocalPowerShellOperations(),
	});
}

export function createPowerShellTool(cwd: string, options?: PowerShellToolOptions): ReturnType<typeof createBashTool> {
	return wrapToolDefinition(createPowerShellToolDefinition(cwd, options));
}
