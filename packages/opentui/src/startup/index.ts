import { spawn } from "node:child_process";
import { getAgentDir, VERSION } from "@earendil-works/pi-coding-agent/config";
import { takeUnnotifiedCrash } from "@earendil-works/pi-coding-agent/core/crash-log";
import type { SessionListProgress } from "@earendil-works/pi-coding-agent/core/session-manager";
import { SettingsManager } from "@earendil-works/pi-coding-agent/core/settings-manager";
import {
	FirstTimeSetupComponent,
	type FirstTimeSetupResult,
} from "@earendil-works/pi-coding-agent/modes/interactive/components/first-time-setup";
import { SessionSelectorComponent } from "@earendil-works/pi-coding-agent/modes/interactive/components/session-selector";
import {
	getChangelogPath,
	getNewEntries,
	normalizeChangelogLinks,
	parseChangelog,
} from "@earendil-works/pi-coding-agent/utils/changelog";
import type { Component } from "@earendil-works/pi-tui";
import { ComponentHostRenderable } from "../bridge/component-host.ts";
import { FacadeTui } from "../bridge/facade-tui.ts";
import { openDialog, showConfirmDialog, showInputDialog, showSelectDialog } from "../ui/dialogs.ts";
import type { UiEnvironment } from "../ui/environment.ts";
import type { CreateStartupUiHooks, ModeStartupFlow } from "./types.ts";

function startupFacade(env: UiEnvironment): FacadeTui {
	const tui = new FacadeTui({ size: () => ({ columns: env.renderer.width, rows: env.renderer.height }) });
	tui.bind({
		onRenderRequest: () => env.renderer.requestRender(),
		showOverlay: () => {
			throw new Error("Nested startup overlays are not supported");
		},
		hideTopOverlay: () => {},
		hasOverlay: () => false,
		onFocusRequest: () => {},
		onInvalidate: () => env.renderer.requestRender(),
	});
	tui.start();
	return tui;
}

async function tmuxKeyboardWarning(): Promise<string | undefined> {
	if (!process.env.TMUX) return undefined;
	const query = (option: string): Promise<string | undefined> =>
		new Promise((resolve) => {
			const processHandle = spawn("tmux", ["show", "-gv", option], { stdio: ["ignore", "pipe", "ignore"] });
			let output = "";
			const timer = setTimeout(() => {
				processHandle.kill();
				resolve(undefined);
			}, 2_000);
			processHandle.stdout?.on("data", (data: Buffer) => {
				output += data.toString();
			});
			processHandle.once("error", () => {
				clearTimeout(timer);
				resolve(undefined);
			});
			processHandle.once("close", (code) => {
				clearTimeout(timer);
				resolve(code === 0 ? output.trim() : undefined);
			});
		});
	const [extendedKeys, format] = await Promise.all([query("extended-keys"), query("extended-keys-format")]);
	if (extendedKeys === undefined) return undefined;
	if (extendedKeys !== "on" && extendedKeys !== "always")
		return "tmux extended-keys is off. Modified Enter keys may not work. Add `set -g extended-keys on` to ~/.tmux.conf and restart tmux.";
	if (format === "xterm")
		return "tmux extended-keys-format is xterm. nek works best with csi-u. Add `set -g extended-keys-format csi-u` to ~/.tmux.conf and restart tmux.";
	return undefined;
}

function hostStartupComponent<T>(
	env: UiEnvironment,
	build: (done: (value: T | undefined) => void, tui: FacadeTui) => Component,
): Promise<T | undefined> {
	return openDialog<T>(
		env,
		(controller) => {
			const tui = startupFacade(env);
			const component = build((value) => controller.resolve(value), tui);
			const host = new ComponentHostRenderable(env.renderer, { component, tui, focusable: true });
			return { root: host, focusTarget: host, dispose: () => tui.stop() };
		},
		{ layout: { width: "90%", maxHeight: "90%" } },
	);
}

export const createStartupUiHooks: CreateStartupUiHooks = (host) => {
	let lastSettingsManager: SettingsManager | undefined;
	const environmentFor = async (settingsManager: SettingsManager): Promise<UiEnvironment> => {
		lastSettingsManager = settingsManager;
		return host.environment(settingsManager);
	};
	return {
		select: async (settingsManager, title, options) =>
			showSelectDialog(await environmentFor(settingsManager), {
				title,
				filter: true,
				items: options.map((option) => ({ value: option.value, label: option.label })),
			}),
		input: async (settingsManager, title, placeholder) =>
			showInputDialog(await environmentFor(settingsManager), { title, placeholder }),
		confirm: async (settingsManager, message) =>
			showConfirmDialog(await environmentFor(settingsManager), { title: "Confirm", message }),
		firstTimeSetup: async (settingsManager) => {
			const env = await environmentFor(settingsManager);
			const result = await hostStartupComponent<FirstTimeSetupResult>(
				env,
				(done) =>
					new FirstTimeSetupComponent({
						detectedTheme: settingsManager.getTheme() === "light" ? "light" : "dark",
						onThemePreview: () => {},
						onSubmit: (value) => done(value),
						onCancel: () => done(undefined),
					}),
			);
			if (result) {
				settingsManager.setTheme(result.theme);
				settingsManager.setEnableAnalytics(result.shareAnalytics);
				await settingsManager.flush();
			}
		},
		selectSession: async (currentLoader, allLoader, settingsManager) => {
			const env = await environmentFor(settingsManager);
			const current = (onProgress?: SessionListProgress, signal?: AbortSignal) => currentLoader(onProgress, signal);
			const all = (onProgress?: SessionListProgress, signal?: AbortSignal) => allLoader(onProgress, signal);
			const selected = await hostStartupComponent<string>(
				env,
				(done) =>
					new SessionSelectorComponent(
						current,
						all,
						(path) => done(path),
						() => done(undefined),
						() => done(undefined),
						() => env.renderer.requestRender(),
						{ showRenameHint: false },
						undefined,
					),
			);
			return selected ?? null;
		},
		showDeprecationWarnings: async (warnings) => {
			const settings = lastSettingsManager ?? SettingsManager.create(process.cwd(), getAgentDir());
			const env = await environmentFor(settings);
			await showConfirmDialog(env, { title: "Deprecation warnings", message: warnings.join("\n") });
		},
	};
};

export const MODE_STARTUP_FLOWS: readonly ModeStartupFlow[] = [
	{
		id: "startup-diagnostics",
		phase: "ready",
		run: (ctx, options) => {
			for (const diagnostic of options.startupDiagnostics ?? []) {
				if (diagnostic.type === "error") ctx.showError(diagnostic.message);
				else if (diagnostic.type === "warning") ctx.showWarning(diagnostic.message);
				else ctx.showStatus(diagnostic.message);
			}
			if (options.migratedProviders?.length)
				ctx.showWarning(`Migrated credentials to auth.json: ${options.migratedProviders.join(", ")}`);
			const modelsError = ctx.session.modelRuntime.getError();
			if (modelsError) ctx.showError(`models.json error: ${modelsError}`);
			if (options.modelFallbackMessage) ctx.showWarning(options.modelFallbackMessage);
			const crash = takeUnnotifiedCrash();
			if (crash) ctx.showWarning(`nek crashed on ${new Date(crash.timestamp).toLocaleString()} (${crash.message}).`);
		},
	},
	{
		id: "changelog",
		phase: "ready",
		run: (ctx) => {
			if (ctx.session.state.messages.length > 0) return;
			const last = ctx.settingsManager.getLastChangelogVersion();
			if (!last) {
				ctx.settingsManager.setLastChangelogVersion(VERSION);
				return;
			}
			const entries = getNewEntries(parseChangelog(getChangelogPath()), last);
			if (entries.length === 0) return;
			ctx.settingsManager.setLastChangelogVersion(VERSION);
			if (ctx.settingsManager.getCollapseChangelog())
				ctx.showStatus(`Updated to v${VERSION}. Use /changelog to view full changelog.`);
			else
				ctx.transcript.appendMarkdown(
					entries.map((entry) => normalizeChangelogLinks(entry.content, entry)).join("\n\n"),
					{ title: "What's New", bordered: true },
				);
		},
	},
	{ id: "model-auth-warning", phase: "run", run: (ctx) => ctx.maybeWarnAboutAnthropicSubscriptionAuth() },
	{
		id: "tmux-keyboard-check",
		phase: "run",
		run: async (ctx) => {
			const warning = await tmuxKeyboardWarning();
			if (warning) ctx.showWarning(warning);
		},
	},
	{
		id: "model-catalog-refresh",
		phase: "run",
		run: async (ctx) => {
			if (process.env.NEK_OFFLINE) return;
			const result = await ctx.session.modelRuntime.refresh({ signal: AbortSignal.timeout(15_000) });
			if (result.errors.size > 0)
				ctx.showWarning(`Could not refresh ${[...result.errors.keys()].join(", ")}; using cached models.`);
			ctx.refreshChrome();
		},
	},
];
