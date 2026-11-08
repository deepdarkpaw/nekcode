/**
 * Control RPC mode: `nek --mode rpc --control`.
 *
 * The control process owns no session and loads no extensions or MCP servers. It exists so a desktop GUI can
 * read and edit configuration, sessions, credentials, and models without creating a session or paying for a
 * session's startup work. Only `NEK_CONTROL_COMMANDS` are accepted; every other command is answered with
 * `Command not available in control mode: <type>`.
 */

import { getAgentDir } from "../../config.ts";
import { applyHttpProxySettings, configureHttpDispatcher } from "../../core/http-dispatcher.ts";
import { ModelRuntime } from "../../core/model-runtime.ts";
import {
	flushRawStdout,
	takeOverStdout,
	waitForRawStdoutBackpressure,
	writeRawStdout,
} from "../../core/output-guard.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { cancelAuthLogins } from "./gui/auth.ts";
import { createGuiContext, type GuiContext } from "./gui/context.ts";
import { createGuiDeps, type GuiDeps, handleGuiCommand } from "./gui/handlers.ts";
import { NEK_CONTROL_COMMANDS } from "./gui/protocol.ts";
import { guiError } from "./gui/response.ts";
import { createUiRequester } from "./gui/ui-requests.ts";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.ts";
import type { RpcExtensionUIResponse } from "./rpc-types.ts";

/**
 * The one pre-existing command the control process answers: it needs models and auth but no session, and the
 * settings page lists the available models through it.
 */
const CONTROL_AVAILABLE_COMMANDS: ReadonlySet<string> = new Set(NEK_CONTROL_COMMANDS);

/** Whether a command type is accepted by the control process. */
export function isControlCommand(type: string): boolean {
	return CONTROL_AVAILABLE_COMMANDS.has(type);
}

/** Error message for a command the control process does not accept. */
export function controlModeError(type: string): string {
	return `Command not available in control mode: ${type}`;
}

/**
 * Answer one control-mode command record. Commands outside `NEK_CONTROL_COMMANDS` are refused with the
 * documented message, so a client learns its mistake instead of waiting for a response.
 */
export async function handleControlCommand(
	record: { id?: string; type: string },
	ctx: GuiContext,
	deps: GuiDeps,
): Promise<object> {
	if (!isControlCommand(record.type)) return guiError(record.id, record.type, controlModeError(record.type));
	if (record.type === "get_available_models") {
		return {
			id: record.id,
			type: "response",
			command: "get_available_models",
			success: true,
			data: { models: ctx.modelRuntime.getAvailableSnapshot() },
		};
	}
	const response = await handleGuiCommand(record, ctx, deps);
	return response ?? guiError(record.id, record.type, `Unknown command: ${record.type}`);
}

/** Run the control process until stdin closes. */
export async function runControlMode(): Promise<never> {
	takeOverStdout();
	const output = (record: object): void => {
		writeRawStdout(serializeJsonLine(record));
	};

	const cwd = process.cwd();
	const agentDir = getAgentDir();
	// A control process reads project settings only for the directories a command names, so this manager is
	// never trusted for an arbitrary cwd.
	const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	applyHttpProxySettings(settingsManager.getGlobalSettings().httpProxy);
	configureHttpDispatcher(settingsManager.getHttpIdleTimeoutMs());
	const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });

	const ui = createUiRequester(output);
	const guiContext = (): GuiContext =>
		createGuiContext({
			mode: "control",
			cwd,
			agentDir,
			settingsManager,
			modelRuntime,
			emit: output,
			requestStructured: (kind, payload, options) => ui.requestStructured(kind, payload, options),
		});
	const guiDeps = createGuiDeps(guiContext, () => false);

	const handleLine = async (line: string): Promise<void> => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (error: unknown) {
			output(
				guiError(
					undefined,
					"parse",
					`Failed to parse command: ${error instanceof Error ? error.message : String(error)}`,
				),
			);
			await waitForRawStdoutBackpressure();
			return;
		}
		if (typeof parsed !== "object" || parsed === null || !("type" in parsed)) {
			output(guiError(undefined, "parse", "Command must be a JSON object with a type"));
			await waitForRawStdoutBackpressure();
			return;
		}
		const record = parsed as { id?: string; type: string };
		if (record.type === "extension_ui_response") {
			ui.respond(parsed as RpcExtensionUIResponse);
			return;
		}
		output(await handleControlCommand(record, guiContext(), guiDeps));
		await waitForRawStdoutBackpressure();
	};

	const detachJsonl = attachJsonlLineReader(process.stdin, (line) => {
		void handleLine(line);
	});

	const detachInput = (): void => {
		detachJsonl();
		process.stdin.off("end", onInputEnd);
	};

	let shuttingDown = false;
	let signalCount = 0;
	const shutdown = async (exitCode = 0): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		cancelAuthLogins();
		ui.cancelAll();
		detachInput();
		process.stdin.pause();
		await modelRuntime.settleCredentialWrites();
		await flushRawStdout();
		process.exit(exitCode);
	};

	function onInputEnd(): void {
		void shutdown();
	}
	process.stdin.on("end", onInputEnd);
	const signals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGTERM"] : ["SIGTERM", "SIGHUP"];
	for (const signal of signals) {
		process.on(signal, () => {
			const exitCode = signal === "SIGHUP" ? 129 : 143;
			if (++signalCount > 1) process.exit(exitCode);
			void shutdown(exitCode);
		});
	}

	return new Promise<never>(() => {});
}
