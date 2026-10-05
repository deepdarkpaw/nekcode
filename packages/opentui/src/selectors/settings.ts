import { DEFAULT_THINKING_LEVEL, THINKING_LEVEL_OPTIONS } from "@earendil-works/pi-coding-agent/core/defaults";
import {
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
} from "@earendil-works/pi-coding-agent/modes/interactive/components/settings-selector";
import type { ScrollViewScrollbar } from "@earendil-works/pi-tui";
import type { ModeContext } from "../mode/mode-context.ts";
import { openHosted } from "./hosted.ts";
import { defineSelector } from "./types.ts";

function refresh(ctx: ModeContext): void {
	ctx.applySettings();
	ctx.refreshAutocomplete();
	ctx.refreshChrome();
}

export const settingsSelector = defineSelector<void, void>({
	id: "settings",
	open(ctx) {
		const settings = ctx.settingsManager;
		const defaultProvider = settings.getDefaultProvider();
		const defaultModel = settings.getDefaultModel();
		const config: SettingsConfig = {
			autoCompact: ctx.session.autoCompactionEnabled,
			defaultModel: defaultProvider && defaultModel ? `${defaultProvider}/${defaultModel}` : "not set",
			currentModel: ctx.session.model,
			availableDefaultModels: ctx.session.modelRuntime.getAvailableSnapshot(),
			showImages: settings.getShowImages(),
			imageWidthCells: settings.getImageWidthCells(),
			autoResizeImages: settings.getImageAutoResize(),
			blockImages: settings.getBlockImages(),
			enableSkillCommands: settings.getEnableSkillCommands(),
			steeringMode: ctx.session.steeringMode,
			followUpMode: ctx.session.followUpMode,
			transport: settings.getTransport(),
			httpIdleTimeoutMs: settings.getHttpIdleTimeoutMs(),
			cacheWarmingMode: settings.getCacheWarmingMode(),
			thinkingLevel: settings.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL,
			availableThinkingLevels: [...THINKING_LEVEL_OPTIONS],
			modelThinkingLevels: settings.getAllModelThinkingLevels(),
			currentTheme: ctx.theme.getThemeSelection() ?? "dark",
			terminalTheme: ctx.theme.getTerminalTheme(),
			availableThemes: ctx.theme.availableThemes(),
			hideThinkingBlock: ctx.getHideThinkingBlock(),
			mermaidRenderingMode: settings.getMermaidRenderingMode(),
			showCacheMissNotices: settings.getShowCacheMissNotices(),
			collapseChangelog: settings.getCollapseChangelog(),
			enableInstallTelemetry: settings.getEnableInstallTelemetry(),
			doubleEscapeAction: settings.getDoubleEscapeAction(),
			treeFilterMode: settings.getTreeFilterMode(),
			showHardwareCursor: settings.getShowHardwareCursor(),
			editorPaddingX: settings.getEditorPaddingX(),
			outputPad: settings.getOutputPad(),
			autocompleteMaxVisible: settings.getAutocompleteMaxVisible(),
			quietStartup: settings.getQuietStartup(),
			defaultProjectTrust: settings.getDefaultProjectTrust(),
			clearOnShrink: settings.getClearOnShrink(),
			showTerminalProgress: settings.getShowTerminalProgress(),
			tuiMode: settings.getTuiMode(),
			fullscreenExitOutput: settings.getFullscreenExitOutput(),
			fullscreenScrollbar: settings.getFullscreenScrollbar(),
			fullscreenCopyOnSelect: settings.getFullscreenCopyOnSelect(),
			warnings: settings.getWarnings(),
		};
		const callbacks: SettingsCallbacks = {
			onAutoCompactChange: (enabled) => {
				ctx.session.setAutoCompactionEnabled(enabled);
				refresh(ctx);
			},
			onShowImagesChange: (enabled) => {
				settings.setShowImages(enabled);
				refresh(ctx);
			},
			onImageWidthCellsChange: (width) => {
				settings.setImageWidthCells(width);
				refresh(ctx);
			},
			onAutoResizeImagesChange: (enabled) => {
				settings.setImageAutoResize(enabled);
				refresh(ctx);
			},
			onBlockImagesChange: (enabled) => {
				settings.setBlockImages(enabled);
				refresh(ctx);
			},
			onEnableSkillCommandsChange: (enabled) => {
				settings.setEnableSkillCommands(enabled);
				refresh(ctx);
			},
			onSteeringModeChange: (mode) => {
				ctx.session.setSteeringMode(mode);
				refresh(ctx);
			},
			onFollowUpModeChange: (mode) => {
				ctx.session.setFollowUpMode(mode);
				refresh(ctx);
			},
			onTransportChange: (transport) => {
				settings.setTransport(transport);
				ctx.session.agent.transport = transport;
				refresh(ctx);
			},
			onHttpIdleTimeoutMsChange: (timeoutMs) => {
				settings.setHttpIdleTimeoutMs(timeoutMs);
				refresh(ctx);
			},
			onCacheWarmingModeChange: (mode) => {
				ctx.session.setCacheWarmingMode(mode);
				refresh(ctx);
			},
			onModelThinkingLevelChange: (provider, modelId, level) => {
				settings.setModelThinkingLevel(provider, modelId, level);
				if (ctx.session.model?.provider === provider && ctx.session.model.id === modelId)
					ctx.session.setThinkingLevel(level);
				refresh(ctx);
			},
			onModelThinkingLevelRemove: (provider, modelId) => {
				settings.removeModelThinkingLevel(provider, modelId);
				if (ctx.session.model?.provider === provider && ctx.session.model.id === modelId)
					ctx.session.setThinkingLevel(settings.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL);
				refresh(ctx);
			},
			onThemeChange: (setting) => {
				settings.setTheme(setting);
				void ctx.theme.setThemeSetting(setting);
				refresh(ctx);
			},
			onThemePreview: (name) => ctx.theme.preview(name),
			onHideThinkingBlockChange: (hidden) => {
				settings.setHideThinkingBlock(hidden);
				ctx.setHideThinkingBlock(hidden);
				refresh(ctx);
			},
			onMermaidRenderingModeChange: (mode) => {
				settings.setMermaidRenderingMode(mode);
				refresh(ctx);
			},
			onShowCacheMissNoticesChange: (shown) => {
				settings.setShowCacheMissNotices(shown);
				refresh(ctx);
			},
			onCollapseChangelogChange: (collapsed) => {
				settings.setCollapseChangelog(collapsed);
				refresh(ctx);
			},
			onEnableInstallTelemetryChange: (enabled) => {
				settings.setEnableInstallTelemetry(enabled);
				refresh(ctx);
			},
			onDoubleEscapeActionChange: (action) => {
				settings.setDoubleEscapeAction(action);
				refresh(ctx);
			},
			onTreeFilterModeChange: (mode) => {
				settings.setTreeFilterMode(mode);
				refresh(ctx);
			},
			onShowHardwareCursorChange: (enabled) => {
				settings.setShowHardwareCursor(enabled);
				refresh(ctx);
			},
			onEditorPaddingXChange: (padding) => {
				settings.setEditorPaddingX(padding);
				refresh(ctx);
			},
			onOutputPadChange: (padding) => {
				settings.setOutputPad(padding);
				refresh(ctx);
			},
			onAutocompleteMaxVisibleChange: (maxVisible) => {
				settings.setAutocompleteMaxVisible(maxVisible);
				refresh(ctx);
			},
			onQuietStartupChange: (enabled) => {
				settings.setQuietStartup(enabled);
				refresh(ctx);
			},
			onDefaultProjectTrustChange: (trust) => {
				settings.setDefaultProjectTrust(trust);
				refresh(ctx);
			},
			onClearOnShrinkChange: (enabled) => {
				settings.setClearOnShrink(enabled);
				refresh(ctx);
			},
			onShowTerminalProgressChange: (enabled) => {
				settings.setShowTerminalProgress(enabled);
				refresh(ctx);
			},
			onTuiModeChange: (mode) => {
				settings.setTuiMode(mode);
				refresh(ctx);
			},
			onFullscreenExitOutputChange: (output) => {
				settings.setFullscreenExitOutput(output);
				refresh(ctx);
			},
			onFullscreenScrollbarChange: (mode: ScrollViewScrollbar) => {
				settings.setFullscreenScrollbar(mode);
				refresh(ctx);
			},
			onFullscreenCopyOnSelectChange: (enabled) => {
				settings.setFullscreenCopyOnSelect(enabled);
				refresh(ctx);
			},
			onWarningsChange: (warnings) => {
				settings.setWarnings(warnings);
				refresh(ctx);
			},
			onCancel: () => {},
		};
		return openHosted<void>(
			ctx,
			(done, _tui) => new SettingsSelectorComponent(config, { ...callbacks, onCancel: () => done(undefined) }),
		);
	},
});
