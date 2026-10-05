import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { ThinkingSelectorComponent } from "@earendil-works/pi-coding-agent/modes/interactive/components/thinking-selector";
import { openHosted } from "./hosted.ts";
import { defineSelector } from "./types.ts";

export const thinkingSelector = defineSelector<void, ThinkingLevel>({
	id: "thinking",
	open(ctx) {
		return openHosted<ThinkingLevel>(
			ctx,
			(done, _tui) =>
				new ThinkingSelectorComponent(
					ctx.session.thinkingLevel,
					ctx.session.getAvailableThinkingLevels(),
					(level) => done(level),
					() => done(undefined),
					(level) => {
						ctx.settingsManager.setDefaultThinkingLevel(level);
						ctx.showStatus(`Default thinking level: ${level}`);
						done(undefined);
					},
					ctx.settingsManager.getDefaultThinkingLevel() ?? "off",
				),
		);
	},
});
