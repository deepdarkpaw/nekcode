/**
 * `StartupHost` on the shared renderer: gives pre-mode prompts (first-time setup, session picker,
 * trust prompts) a UI environment before `OpenTuiMode` exists.
 */

import type { SettingsManager } from "@earendil-works/pi-coding-agent/core/settings-manager";
import { initTheme, theme } from "@earendil-works/pi-coding-agent/modes/interactive/theme/theme";
import { getKeybindings } from "@earendil-works/pi-tui";
import { BoxRenderable } from "@opentui/core";
import type { StartupHost } from "../startup/types.ts";
import { createUiTheme } from "../theme/ui-theme.ts";
import type { UiEnvironment } from "../ui/environment.ts";
import { OverlayStack } from "../ui/overlay-stack.ts";
import type { RendererHost } from "./renderer-host.ts";

export function createStartupHost(rendererHost: RendererHost): StartupHost {
	let environment: UiEnvironment | undefined;
	return {
		async environment(settingsManager: SettingsManager): Promise<UiEnvironment> {
			if (environment && environment.renderer === rendererHost.current) return environment;
			initTheme(settingsManager.getTheme(), false);
			const renderer = await rendererHost.get();
			const layer = new BoxRenderable(renderer, {
				id: "startup-overlays",
				position: "absolute",
				top: 0,
				left: 0,
				width: "100%",
				height: "100%",
				backgroundColor: createUiTheme(theme).base,
			});
			renderer.root.add(layer);
			const overlays = new OverlayStack(renderer, layer);
			environment = {
				renderer,
				overlays,
				keybindings: getKeybindings(),
				uiTheme: () => createUiTheme(theme),
			};
			return environment;
		},
	};
}
